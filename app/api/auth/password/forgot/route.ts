/**
 * POST /api/auth/password/forgot  { email } → { ok: true } (always)
 *
 * Emails a single-use 7-digit reset code (15 min TTL). Only the SHA-256 of the
 * code is stored (in password_reset_tokens.token), so a DB leak reveals no
 * usable codes. Always returns ok so an attacker can't probe which emails
 * exist. Without RESEND_API_KEY the code is logged server-side in dev.
 * An address with no password account that belongs to a Google or X login gets
 * a mail pointing to that platform's own password reset instead.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { numericCode, sha256 } from "@/lib/password-reset";
import { sendMail } from "@/lib/mailer";
import { emailLookupHash } from "@/lib/auth/oauth";
import { createErrorResponse } from "../../../../middleware/validation";

const RESET_TTL_MS = 15 * 60 * 1000;
const bodySchema = z.object({ email: z.string().email().max(320) });

export async function POST(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "auth:forgot:ip"), 10, 10 * 60 * 1000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  // Checked before the email lookup, so this fires identically for every
  // request regardless of whether the email exists — it answers "is the
  // feature configured", never "does this email have an account" (the
  // dev-mode console-log fallback below is an intentional exception, not a
  // silent production failure).
  if (process.env.NODE_ENV === "production" && !process.env.RESEND_API_KEY?.trim()) {
    return createErrorResponse("Password reset email is not configured on this environment", 503);
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: true });
  const email = parsed.data.email.trim().toLowerCase();

  const supabase = getSupabaseServerClient();
  const { data: cred, error: credErr } = await supabase
    .from("password_credentials")
    .select("user_id")
    .eq("email", email)
    .maybeSingle();
  if (cred) {
    // One live code per user, so guessing windows don't stack. The new code is stored first and the account's other codes
    // go only once its mail is out, as the confirm route does (DEC-2026-11-07-04): of racing requests at most one code is
    // left, and a mail that fails leaves the code already in the inbox working.
    const code = numericCode(7);
    const token = sha256(code);
    const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
    const { error: insertErr } = await supabase
      .from("password_reset_tokens")
      .insert({ token, user_id: cred.user_id, expires_at: expiresAt });
    if (insertErr) {
      console.error("[auth/forgot] code not stored:", insertErr.message);
      return NextResponse.json({ ok: true });
    }

    const mail = await sendMail({
      to: email,
      subject: `${code} is your Enki Art reset code`,
      text:
        `Your Enki Art password reset code is:\n\n    ${code}\n\n` +
        `Enter it on the reset page within 15 minutes. If you didn't ask for this, you can ignore this email — nothing changes without the code.`,
    }).catch(() => ({ ok: false }));
    // Outside production a developer reads the code in the server log: that is its delivery.
    const delivered = mail.ok || process.env.NODE_ENV !== "production";
    if (!mail.ok && delivered) console.log(`[auth/forgot] email not configured — reset code for ${email}: ${code}`);
    const clear = supabase.from("password_reset_tokens").delete().eq("user_id", cred.user_id);
    const { error: clearErr } = await (delivered ? clear.neq("token", token) : clear.eq("token", token));
    if (clearErr) console.error("[auth/forgot] codes not cleared:", clearErr.message);
  } else if (!credErr) {
    await mailPlatformReset(supabase, email).catch((e) => console.error("[auth/forgot] platform notice failed:", e instanceof Error ? e.message : e));
  }

  return NextResponse.json({ ok: true });
}

// The platforms' own password reset, as their help pages give it (read 2026-11-07, DEC-2026-11-07-18).
const PLATFORM_RESET: Record<string, [string, string]> = {
  google: ["Google", "https://accounts.google.com/signin/recovery"],
  x: ["X", "https://help.x.com/en/managing-your-account/forgotten-or-lost-password-reset"],
};

/**
 * An address with no password account that belongs to an account signing in only with Google or X (an identity's email,
 * or the email on users a Google login wrote): that address hears that Enki has no password for it, and where the
 * platform resets its own (Kev, 2026-11-07: "wir verweisen am besten dann auf die reset pw funktion der plattform").
 * Anything else hears nothing, and the answer on screen is the same. Throws on a failed read.
 */
async function mailPlatformReset(supabase: ReturnType<typeof getSupabaseServerClient>, email: string): Promise<void> {
  const [byIdentity, byUsers] = await Promise.all([
    // ilike: a provider may keep the address's case. zod's email check lets "_" through, LIKE's one-character wildcard.
    supabase.from("auth_identities").select("user_id").ilike("email", email.replace(/_/g, "\\_")),
    supabase.from("users").select("id").eq("email_lookup_hash", emailLookupHash(email)),
  ]);
  if (byIdentity.error) throw byIdentity.error;
  if (byUsers.error) throw byUsers.error;
  const ids = [...new Set([...(byIdentity.data ?? []).map((r) => String(r.user_id)), ...(byUsers.data ?? []).map((r) => String(r.id))])];
  if (!ids.length) return;
  const [logins, live, passwords] = await Promise.all([
    supabase.from("auth_identities").select("user_id, provider").in("user_id", ids),
    supabase.from("users").select("id").in("id", ids).is("deleted_at", null),
    supabase.from("password_credentials").select("user_id").in("user_id", ids),
  ]);
  if (logins.error) throw logins.error;
  if (live.error) throw live.error;
  if (passwords.error) throw passwords.error;
  // Only an account that has no password at all: one with a password elsewhere resets that one.
  const signsInWith = (uid: string) => (live.data ?? []).some((u) => u.id === uid) && !(passwords.data ?? []).some((p) => p.user_id === uid);
  const platforms = Object.keys(PLATFORM_RESET).filter((p) => (logins.data ?? []).some((l) => l.provider === p && signsInWith(String(l.user_id))));
  if (!platforms.length) return;
  const names = platforms.map((p) => PLATFORM_RESET[p][0]).join(" and ");
  const mail = await sendMail({
    to: email,
    subject: `Your Enki account signs in with ${names}`,
    text:
      `Someone asked to reset the Enki password for this address (${new Date().toUTCString()}). Your Enki account signs in with ${names}, ` +
      `so Enki has no password for it, and nothing was changed.\n\n` +
      platforms.map((p) => `If you cannot sign in to ${PLATFORM_RESET[p][0]}, reset your ${PLATFORM_RESET[p][0]} password there: ${PLATFORM_RESET[p][1]}`).join("\n") +
      `\n\nIf you did not ask for this, you can ignore this email: nothing changes.`,
  }).catch(() => ({ ok: false }));
  if (!mail.ok) console.error("[auth/forgot] platform notice not sent");
}
