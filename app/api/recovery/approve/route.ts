/**
 * POST /api/recovery/approve  { requestId, guardianId, code } → { ok, approved, threshold }
 *
 * A guardian redeems their emailed 7-digit code. At the threshold the request
 * flips to 'approved' and the OWNER can set a new password (complete route).
 * Brute force: 5 tries per request+guardian per window + code is hash-stored.
 *
 * A guardian's yes to removing a friend's lost factor (lib/mfa-recovery.ts approveGuardianAsk) comes here too, from /guardian:
 *   GET  ?factor=&g=                                   → what the page shows
 *   POST { requestId, guardianId, token | signature }  → { ok, approved, needed, done }
 * A factor's request has no owner key, so the code path above never counts or completes it.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { sha256 } from "@/lib/password-reset";
import { recoveryThreshold } from "@/lib/recovery/threshold";
import { approveGuardianAsk, guardianAskInfo, recoveryFailure, stampReachable } from "@/lib/mfa-recovery";

const bodySchema = z.object({
  requestId: z.string().uuid(),
  guardianId: z.string().uuid(),
  code: z.string().regex(/^\d{7}$/),
});
const factorSchema = z.object({
  requestId: z.string().uuid(),
  guardianId: z.string().uuid(),
  token: z.string().min(1).max(200).optional(),
  signature: z.string().min(1).max(200).optional(),
});

export async function GET(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "recovery:approve-factor:get"), 20, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
  const ids = z.object({ factor: z.string().uuid(), g: z.string().uuid() }).safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!ids.success) return NextResponse.json({ error: "This link isn't valid." }, { status: 404 });
  try {
    const info = await guardianAskInfo(getSupabaseServerClient(), ids.data.factor, ids.data.g);
    return info ? NextResponse.json(info) : NextResponse.json({ error: "This link isn't valid." }, { status: 404 });
  } catch (e) {
    return recoveryFailure(e, "guardian ask read");
  }
}

async function approveFactor(req: NextRequest, body: unknown) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "recovery:approve-factor"), 20, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
  const parsed = factorSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { requestId, guardianId, token, signature } = parsed.data;
  try {
    const out = await approveGuardianAsk(getSupabaseServerClient(), requestId, guardianId, { token, signature });
    if (out.result === "counted") return NextResponse.json({ ok: true, approved: out.approved, needed: out.needed, done: out.approved >= out.needed });
    if (out.result === "inactive") return NextResponse.json({ error: "This request is no longer open." }, { status: 400 });
    if (out.result === "unsigned") return NextResponse.json({ error: "The signature doesn't match the guardian's wallet. Sign with the exact wallet that was invited." }, { status: 403 });
    return NextResponse.json({ error: "This link isn't valid." }, { status: 404 });
  } catch (e) {
    return recoveryFailure(e, "guardian yes");
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body && typeof body === "object" && ("token" in body || "signature" in body)) return approveFactor(req, body);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { requestId, guardianId, code } = parsed.data;

  const limit = checkRequestRateLimit(
    rateLimitKey(req, "recovery:approve", `${requestId}:${guardianId}`),
    5,
    15 * 60 * 1000,
  );
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const { data: request } = await supabase
    .from("recovery_requests")
    .select("id, user_id, status, expires_at, owner_key_hash")
    .eq("id", requestId)
    .maybeSingle();
  if (!request || !request.owner_key_hash || request.status !== "pending" ||
      (request.expires_at && new Date(request.expires_at).getTime() <= Date.now())) {
    return NextResponse.json({ error: "This recovery request isn't active" }, { status: 400 });
  }

  const { data: approval } = await supabase
    .from("recovery_approvals")
    .select("code_hash, approved_at")
    .eq("request_id", requestId)
    .eq("guardian_id", guardianId)
    .maybeSingle();
  if (!approval) return NextResponse.json({ error: "Wrong code" }, { status: 400 });
  if (!approval.approved_at) {
    if (approval.code_hash !== sha256(code)) {
      return NextResponse.json({ error: "Wrong code" }, { status: 400 });
    }
    await supabase
      .from("recovery_approvals")
      .update({ approved_at: new Date().toISOString() })
      .eq("request_id", requestId)
      .eq("guardian_id", guardianId);
    // Their approval answers the yearly check too (lib/recovery/guardian-check.ts).
    await stampReachable(supabase, guardianId);
  }

  const [{ count: approved }, threshold] = await Promise.all([
    supabase
      .from("recovery_approvals")
      .select("guardian_id", { count: "exact", head: true })
      .eq("request_id", requestId)
      .not("approved_at", "is", null),
    recoveryThreshold(supabase, request.user_id),
  ]);

  if ((approved ?? 0) >= threshold) {
    await supabase.from("recovery_requests").update({ status: "approved" }).eq("id", requestId).eq("status", "pending");
  }

  return NextResponse.json({ ok: true, approved: approved ?? 0, threshold });
}
