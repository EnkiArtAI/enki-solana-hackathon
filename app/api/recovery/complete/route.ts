/**
 * POST /api/recovery/complete  { requestId, ownerKey, password } → session
 *
 * After enough guardians approved: the OWNER (proven by the ownerKey their
 * browser kept from starting the request) sets the new password and is logged
 * in. One-shot — the request flips to 'completed'.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { completePasswordReset, sha256 } from "@/lib/password-reset";
import { deletedRefusal } from "@/lib/password-login";

const bodySchema = z.object({
  requestId: z.string().uuid(),
  ownerKey: z.string().min(16).max(128),
  password: z.string().min(8).max(200),
});

export async function POST(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "recovery:complete:ip"), 10, 15 * 60 * 1000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { requestId, ownerKey, password } = parsed.data;

  const supabase = getSupabaseServerClient();

  // It ends in a login too, so a deleted account is refused here. Before the claim: a read that fails must not burn
  // an approved recovery, the owner would have to go through the guardians again.
  const { data: open, error: openErr } = await supabase
    .from("recovery_requests")
    .select("user_id")
    .eq("id", requestId)
    .eq("owner_key_hash", sha256(ownerKey))
    .maybeSingle();
  if (openErr) {
    console.error("[recovery/complete] read failed:", openErr.message);
    return NextResponse.json({ error: "Could not complete recovery" }, { status: 500 });
  }
  if (open) {
    const gone = await deletedRefusal(supabase, open.user_id, "Recovery not approved yet (or link expired)", 400);
    if (gone) return gone;
  }

  // One-shot claim: only an APPROVED, unexpired request with the matching
  // owner key flips to completed — and only the flipping request resets.
  const { data: claimed, error } = await supabase
    .from("recovery_requests")
    .update({ status: "completed" })
    .eq("id", requestId)
    .eq("status", "approved")
    .eq("owner_key_hash", sha256(ownerKey))
    .gt("expires_at", new Date().toISOString())
    .select("user_id")
    .maybeSingle();
  if (error) {
    console.error("[recovery/complete] claim failed:", error.message);
    return NextResponse.json({ error: "Could not complete recovery" }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json({ error: "Recovery not approved yet (or link expired)" }, { status: 400 });
  }

  const result = await completePasswordReset(supabase, claimed.user_id, password);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json(result);
}
