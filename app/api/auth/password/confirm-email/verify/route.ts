/**
 * POST /api/auth/password/confirm-email/verify { code } -> { confirmed: true }
 *
 * The emailed 7 digit code confirms the signed-in account's login email: every other session of the account is signed
 * out, then email_verified_at is set (the password and must_change_password stay). The code is spent first, as the
 * reset-code route spends its own.
 * lib/confirm-email.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRequestRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { sha256 } from "@/lib/password-reset";
import { dbUnavailableResponse } from "@/lib/db-error";
import { TOO_MANY_TRIES, nothingToConfirm, signedInLogin, tooMany } from "@/lib/confirm-email";

const bodySchema = z.object({ code: z.string().regex(/^\d{7}$/) });

export async function POST(req: NextRequest) {
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "auth:confirmemail:verify:ip"), 20, 15 * 60 * 1000);
  if (!ipLimit.allowed) return tooMany(TOO_MANY_TRIES, ipLimit.retryAfterSeconds);
  const who = await signedInLogin(req);
  if (who instanceof NextResponse) return who;
  const done = nothingToConfirm(who.login);
  if (done) return done;
  const { supabase, userId } = who;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter the 7 digit code from the email." }, { status: 400 });
  // Five tries per account in 15 minutes, in a bucket of its own: the reset-code route's per address needs no session, so a
  // stranger who knows the address could otherwise keep the owner out of this window (DEC-2026-11-07-22).
  const accountLimit = checkRequestRateLimit(rateLimitKey(req, "auth:confirmemail:verify", userId), 5, 15 * 60 * 1000);
  if (!accountLimit.allowed) return tooMany(TOO_MANY_TRIES, accountLimit.retryAfterSeconds);

  const { data: codes, error } = await supabase.from("password_reset_tokens").select("token, expires_at").eq("user_id", userId);
  if (error) return dbUnavailableResponse();
  if (!codes?.length) return NextResponse.json({ error: "No code is waiting. Request a new code." }, { status: 400 });
  const hit = codes.find((c) => c.token === sha256(parsed.data.code));
  if (!hit) return NextResponse.json({ error: "Wrong code. Check the email and try again." }, { status: 400 });
  if (new Date(hit.expires_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: "This code has expired. Request a new code." }, { status: 400 });
  }

  // One-shot: every code of the account is spent before the email counts as confirmed.
  const { error: spendErr } = await supabase.from("password_reset_tokens").delete().eq("user_id", userId);
  if (spendErr) return dbUnavailableResponse();
  // Every other session of the account goes before the confirm lands, as a reset signs out (lib/password-reset.ts, the same
  // keys: users.id before a wallet is attached, each live wallet address after): a session stolen before the confirm must
  // not get the wallet it opens. The one that typed the code stays. A failure confirms nothing (DEC-2026-11-07-21).
  const { data: wallets, error: walletsErr } = await supabase.from("user_wallets").select("address").eq("user_id", userId).is("removed_at", null);
  if (walletsErr) return dbUnavailableResponse();
  const { error: outErr } = await supabase
    .from("auth_sessions")
    .delete()
    .in("wallet_address", [userId, ...(wallets ?? []).map((w) => w.address)])
    .neq("token", req.headers.get("X-Session-Token") ?? "");
  if (outErr) return dbUnavailableResponse();
  const { error: updErr } = await supabase
    .from("password_credentials")
    .update({ email_verified_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("email_verified_at", null);
  if (updErr) return dbUnavailableResponse();
  return NextResponse.json({ confirmed: true });
}
