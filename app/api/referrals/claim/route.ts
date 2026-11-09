/**
 * An author's claim on what their posts earn (lib/referral/claim.ts).
 *
 *   GET  → { x, prompts, open, claimed, vaultUsd }   x null: no X account connected
 *   POST → { claimed }                               409 without a connected X account
 *
 * A suspended account claims nothing and reads nothing, like the referral routes.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { claimAuthorShares, claimState } from "@/lib/referral/claim";

async function answer(req: NextRequest, run: (supabase: ReturnType<typeof getSupabaseServerClient>, userId: string) => Promise<NextResponse>) {
  const supabase = getSupabaseServerClient();
  try {
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Sign in to claim." }, { status: 401 });
    return await run(supabase, userId);
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[referrals/claim]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not read your claim. Try again." }, { status: 503 });
  }
}

export async function GET(req: NextRequest) {
  return answer(req, async (supabase, userId) => NextResponse.json(await claimState(supabase, userId)));
}

export async function POST(req: NextRequest) {
  return answer(req, async (supabase, userId) => {
    const limit = checkRequestRateLimit(rateLimitKey(req, "referrals:claim", userId), 10, 10 * 60_000);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
    const done = await claimAuthorShares(supabase, userId);
    if (!done) return NextResponse.json({ error: "Connect your X account first." }, { status: 409 });
    return NextResponse.json(done);
  });
}
