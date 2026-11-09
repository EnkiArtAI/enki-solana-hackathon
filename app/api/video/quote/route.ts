/**
 * POST /api/video/quote: what one video would cost, read-only, for the chip and the menus around it. Body: one ask, or
 * { items: [...] } for a picker's options at once, as /api/payments/generation/quote takes them. The client sends identifiers
 * and settings, never an amount; v3's intent calls the same function.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authRefusal, checkRateLimit, requireAuth } from "@/lib/auth";
import { refusalBody } from "@/lib/db-error";
import { PRICING_POLICY, splitToBreakdown } from "@/lib/payments/generation-pricing";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { quoteVideo, videoAskSchema, type VideoAsk } from "@/lib/video/quote";

const batchSchema = z.object({ items: z.array(videoAskSchema).min(1).max(24) }).strict();

async function quoteOne(supabase: SupabaseClient, ask: VideoAsk, user: { userId: string; sessionToken: string | null }): Promise<{ status: number; body: { quote?: unknown; error?: string; code?: string } }> {
  const q = await quoteVideo(supabase, ask, { buyer: user.userId, sessionToken: user.sessionToken });
  if (!q.ok) return { status: q.status, body: refusalBody(q) };
  return {
    status: 200,
    body: {
      quote: {
        promptId: ask.promptId ?? null,
        modelId: ask.modelId,
        settings: q.settings,
        available: q.available,
        expiresAt: new Date(Date.now() + PRICING_POLICY.quoteTtlSeconds * 1000).toISOString(),
        breakdown: splitToBreakdown(q.split),
      },
    },
  };
}

export async function POST(req: NextRequest) {
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "video:quote:ip"), 120, 60_000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  let user;
  try {
    user = { ...(await requireAuth(req)), sessionToken: req.headers.get("X-Session-Token") };
  } catch (e) {
    return authRefusal(e);
  }
  if (!checkRateLimit(user.userId, "video:quote", 60, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const supabase = getSupabaseServerClient();
  const batch = batchSchema.safeParse(body);
  if (batch.success) {
    const results = await Promise.all(batch.data.items.map((item) => quoteOne(supabase, item, user)));
    return NextResponse.json({ quotes: results.map((r) => (r.status === 200 ? r.body.quote : { error: r.body.error })) });
  }
  const parsed = videoAskSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  const one = await quoteOne(supabase, parsed.data, user);
  return NextResponse.json(one.body, { status: one.status });
}
