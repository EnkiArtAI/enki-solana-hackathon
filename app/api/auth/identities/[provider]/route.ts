/**
 * DELETE /api/auth/identities/[provider] (session) → { removed }
 *
 * Disconnects a Google or X account. Refused when it is the last way to sign
 * in: the user would be locked out of their own account. With a factor, every
 * factor confirms it, as a factor's removal does, and every address hears, the
 * leaving one included: a stolen session must not drop an address from the
 * recovery mails unheard (DEC-2026-11-05-40 point 1).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { loginMethods } from "@/lib/auth/login-methods";
import { isProvider } from "@/lib/auth/oauth";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { requireAllFactors } from "@/lib/webauthn";
import { everyAddress, mailEach } from "@/lib/security-notice";
import { RESET_ADVICE, enrolledFactors } from "@/lib/mfa";
import { waysBesideMail } from "@/lib/mfa-recovery";

const LAST_WAY_IN = "This is the only way to sign in to this account. Connect another account first.";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  if (!isProvider(provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const supabase = getSupabaseServerClient();
  try {
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const { identities, loginMethodCount } = await loginMethods(supabase, userId);
    if (!identities.some((i) => i.provider === provider)) {
      return NextResponse.json({ error: "That account is not connected" }, { status: 404 });
    }
    if (loginMethodCount <= 1) return NextResponse.json({ error: LAST_WAY_IN }, { status: 409 });
    const blocked = await requireAllFactors(req, userId, `disconnect:${provider}`);
    if (blocked) return blocked;
    // Before the delete, so the address leaving hears too. A failed read removes nothing.
    const told = await everyAddress(supabase, userId);
    const { data: removed, error } = await supabase.from("auth_identities").delete().eq("user_id", userId).eq("provider", provider).select();
    if (error) throw error;
    // Two disconnects at once can both pass the count above: read again, and put this one back when nothing is left.
    if ((await loginMethods(supabase, userId)).loginMethodCount < 1 && removed?.length) {
      // Not onto an account deleted meanwhile: deletion removes its identities for good.
      const { data: account, error: accountErr } = await supabase.from("users").select("deleted_at").eq("id", userId).maybeSingle();
      if (accountErr) throw accountErr;
      if (account?.deleted_at) return NextResponse.json({ removed: provider });
      const { error: backErr } = await supabase.from("auth_identities").insert(removed);
      if (backErr) throw backErr;
      return NextResponse.json({ error: LAST_WAY_IN }, { status: 409 });
    }
    const name = provider === "google" ? "Google" : "X";
    // With a factor, the owner hears when this left fewer than the two addresses the mail path needs (lib/mfa-recovery.ts tooFew),
    // and which other ways the account has (DEC-2026-11-07-30). Read after the delete and best effort: a failed read, or recovery
    // before SQL 74 ran, drops only this sentence, never the mail.
    const ways = await Promise.all([everyAddress(supabase, userId), enrolledFactors(supabase, userId), waysBesideMail(supabase, userId)]).then(
      ([left, factors, besides]) => (left.length < 2 && factors.length > 0 ? besides : null),
      () => null,
    );
    const lostFactor = !ways ? ""
      : ways.codes || ways.guardians ? ` a lost factor can be removed only with ${ways.codes && ways.guardians ? "a recovery code or your guardians" : ways.codes ? "a recovery code" : "your guardians"}.`
      : " a lost factor cannot be removed: no recovery code is left and fewer than two guardians can be asked.";
    await mailEach(
      told,
      `${name} was disconnected from your Enki account`,
      `${name} was disconnected from your Enki account (${new Date().toUTCString()}). It can no longer be used to sign in to it.` +
        (ways ? ` This account now has fewer than two email addresses, so until it has a second,${lostFactor}` : "") +
        ` If that was you, there is nothing to do.\n\n` +
        `If it was not, someone is using your session: ${RESET_ADVICE}`,
    );
    return NextResponse.json({ removed: provider });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}
