/**
 * A signed-in password account confirms its login email with a code (lib/confirm-email.ts).
 *
 *   GET  -> { needed, email }: needed only while the login email waits for its code, email masked then (null otherwise)
 *   POST -> { sent: true }, or { confirmed: true } when it is confirmed already and nothing is sent. The code goes to the
 *           account's own login email, never to an address from the request.
 *
 * Then POST ./verify { code } confirms it.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkRequestRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { numericCode, sha256 } from "@/lib/password-reset";
import { sendMail } from "@/lib/mailer";
import { dbUnavailableResponse } from "@/lib/db-error";
import { CODE_TTL_MS, maskEmail, nothingToConfirm, signedInLogin, tooMany } from "@/lib/confirm-email";

const SLOW_DOWN = "Too many codes asked for. Try again in a few minutes.";

export async function GET(req: NextRequest) {
  const who = await signedInLogin(req);
  if (who instanceof NextResponse) return who;
  const needed = who.login?.state === "needed";
  return NextResponse.json({ needed, email: needed ? maskEmail(who.login!.email) : null });
}

export async function POST(req: NextRequest) {
  // As tight as the forgot route's limit per network, and three codes per account on top.
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "auth:confirmemail:ip"), 10, 10 * 60 * 1000);
  if (!ipLimit.allowed) return tooMany(SLOW_DOWN, ipLimit.retryAfterSeconds);
  const who = await signedInLogin(req);
  if (who instanceof NextResponse) return who;
  const done = nothingToConfirm(who.login);
  if (done) return done;
  const { supabase, userId } = who;
  const email = who.login!.email;
  const accountLimit = checkRequestRateLimit(rateLimitKey(req, "auth:confirmemail", userId), 3, 15 * 60 * 1000);
  if (!accountLimit.allowed) return tooMany(SLOW_DOWN, accountLimit.retryAfterSeconds);

  // The new code is stored first, and the account's other codes go only once its mail is out: a mail that fails leaves the
  // code already in the inbox working, and of racing requests at most one code is left (DEC-2026-11-07-04). Then this
  // replaces a reset code, and a later reset request this one.
  const code = numericCode(7);
  const token = sha256(code);
  const { error: insertErr } = await supabase
    .from("password_reset_tokens")
    .insert({ token, user_id: userId, expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
  if (insertErr) return dbUnavailableResponse();

  const mail = await sendMail({
    to: email,
    subject: `${code} is your Enki code to confirm your email`,
    text:
      `Your code to confirm this email address for your Enki account is:\n\n    ${code}\n\n` +
      `Enter it in the "Confirm your email" window within 15 minutes. It opens your wallet.\n\n` +
      `This code also resets your password, so never give it to anyone: Enki never asks for it.\n\n` +
      `If you did not ask for it, someone is signed in to your account: reset your password right away. A reset signs you out on every device.`,
  }).catch(() => ({ ok: false }));
  if (!mail.ok) {
    // Nobody got this code, so it goes; should that fail too, it is a code nobody holds, and it expires.
    await supabase.from("password_reset_tokens").delete().eq("token", token).eq("user_id", userId);
    // As the forgot route: with no mail set up, a developer reads the code in the server log.
    if (process.env.NODE_ENV !== "production") console.log(`[auth/confirm-email] email not sent — code for ${email}: ${code}`);
    return NextResponse.json({ error: "The code could not be sent. Try again in a minute." }, { status: 502 });
  }
  const { error: clearErr } = await supabase.from("password_reset_tokens").delete().eq("user_id", userId).neq("token", token);
  if (clearErr) return dbUnavailableResponse();
  return NextResponse.json({ sent: true });
}
