/**
 * GET /api/auth/oauth/[provider]/callback?code=&state=
 *
 * Verifies the state cookie, exchanges the code, verifies the identity with
 * the provider, resolves it to a user (lib/auth/oauth) and mints the ordinary
 * app session. The token never enters a URL: it leaves in the short lived
 * hand over cookie, and /auth/complete collects it with a POST to
 * /api/auth/oauth/complete. Only the return path and a refusal code ride in
 * the URL fragment. Every answer clears the state cookie: it is single use.
 */
import { NextRequest, NextResponse, after } from "next/server";
import {
  appUrl,
  completeAuth,
  HANDOVER_COOKIE,
  HANDOVER_TTL_S,
  isProvider,
  linkSessionAlive,
  MissingTableError,
  OAuthError,
  readState,
  resolveIdentity,
  signHandover,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
  type OAuthErrorCode,
} from "@/lib/auth/oauth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { mintUserSession } from "@/lib/user-session";
import { admitAllowlisted, grantGateCookie, revokeGateCookie } from "@/lib/allowlist";
import { grantTrialCookie, trialAdmission, trialPassCode, trialSessionMs } from "@/lib/trial";
import { getClientIp, hashIp, isIpBanned } from "@/lib/ip-hash";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { mailProviderConnected } from "@/lib/security-notice";

type Ctx = { params: Promise<{ provider: string }> };

function done(res: NextResponse): NextResponse {
  res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
  return res;
}
const complete = (fragment: Record<string, string>) =>
  done(NextResponse.redirect(`${appUrl()}/auth/complete#${new URLSearchParams(fragment)}`, 302));
const refuse = (code: OAuthErrorCode) => complete({ error: code });

export async function GET(req: NextRequest, ctx: Ctx) {
  const { provider } = await ctx.params;
  if (!isProvider(provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const limit = checkRequestRateLimit(rateLimitKey(req, "auth:oauth:callback:ip"), 20, 10 * 60 * 1000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const claims = await readState(req.cookies.get(STATE_COOKIE)?.value, provider);
  const q = req.nextUrl.searchParams;
  if (!claims || !q.get("state") || q.get("state") !== claims.state) return refuse("state_mismatch");
  // A link started in Settings goes back there with the refusal; a login goes to /auth/complete.
  const linkTo = claims.intent.kind === "link" ? claims.next : null;
  const deny = (c: OAuthErrorCode) =>
    linkTo ? done(NextResponse.redirect(`${appUrl()}${linkTo}#connect_error=${c}`, 302)) : refuse(c);
  const code = q.get("code");
  // Cancelled at the provider (Google and X answer error=access_denied): back to where it started, no error page
  // (Kev, 2026-10-17): a login to the open login window, a Settings link to Settings.
  if (!code && q.get("error") === "access_denied") {
    return done(NextResponse.redirect(`${appUrl()}${linkTo ?? "/?login=1"}`, 302));
  }
  if (!code) return deny("provider_error"); // the provider sent another ?error=, or nothing

  const supabase = getSupabaseServerClient();
  const ipHash = hashIp(getClientIp(req));
  try {
    if (await isIpBanned(supabase, ipHash)) return deny("network_blocked");
    // A link dies with the session that started it (a reset, a logout): checked before the provider is asked.
    if (claims.intent.kind === "link" && !(await linkSessionAlive(supabase, claims.intent))) return deny("state_mismatch");
    const identity = await completeAuth(claims, code);
    const { userId, banned, allowlisted, inserted } = await resolveIdentity(supabase, identity, claims.intent, !!trialPassCode(req));
    // A link from Settings keeps the session it came from: back to where it started, no new login.
    if (claims.intent.kind === "link") {
      // Asked again after the provider round trip: a reset, a logout or a deletion that ran meanwhile ended the session
      // that started this link, so the row goes too; a row this call did not write stays (review, 2026-10-17).
      // A check that failed takes the row back too: the retry inserts it again and mails, a row left standing never would.
      const undo = async () => {
        if (!inserted) return;
        const { error: undoErr } = await supabase.from("auth_identities").delete().eq("provider", provider).eq("subject", identity.subject).eq("user_id", userId);
        if (undoErr) throw undoErr;
      };
      const alive = await linkSessionAlive(supabase, claims.intent).catch(async (e) => { await undo(); throw e; });
      if (!alive) {
        await undo();
        return deny("state_mismatch");
      }
      // The link stands now. A touch of an identity it already held tells nobody; the mail never holds up the redirect.
      if (inserted) after(mailProviderConnected(supabase, userId, provider));
      return done(NextResponse.redirect(`${appUrl()}${claims.next}`, 302));
    }
    // Off the access list: the code this browser redeemed at /gate, or the account's running trial, lets it in until
    // the trial ends, and the session ends with it (lib/trial).
    const trial = allowlisted || banned ? null : await trialAdmission(supabase, req, userId);
    // Off the list and no trial after all (its code was used up or revoked meanwhile): no session, and an account
    // made for this login goes with its identity.
    if (!allowlisted && !banned && !trial) {
      if (inserted) {
        const { error: undoErr } = await supabase.from("auth_identities").delete().eq("provider", provider).eq("subject", identity.subject).eq("user_id", userId);
        if (undoErr) throw undoErr;
        await supabase.from("users").delete().eq("id", userId);
      }
      return deny("not_whitelisted");
    }
    const session = await mintUserSession(userId, ipHash, trial ? trialSessionMs(trial) : undefined);
    // A deletion that ran meanwhile removed the identity before its last session eviction: the session this login just
    // made goes too (review, 2026-10-17). A password reset leaves the identity (lib/password-reset.ts).
    const { data: still, error: stillErr } = await supabase.from("auth_identities").select("user_id").eq("provider", provider).eq("subject", identity.subject).maybeSingle();
    if (stillErr) throw stillErr;
    if (still?.user_id !== userId) {
      await supabase.from("auth_sessions").delete().eq("token", session.token);
      return deny("state_mismatch");
    }
    // The browser keeps the account's login email: an X account carries none,
    // and a Google address may not be the one the password signs in with.
    const { data: cred, error: credErr } = await supabase.from("password_credentials").select("email").eq("user_id", userId).maybeSingle();
    if (credErr) throw credErr;
    const email = (cred?.email as string | undefined) ?? identity.email;
    const res = complete({ next: claims.next });
    res.cookies.set(HANDOVER_COOKIE, await signHandover({ token: session.token, email, banned }), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: STATE_COOKIE_PATH,
      maxAge: HANDOVER_TTL_S,
    });
    // As the password login does (lib/password-login openLoginSession): a
    // banned account loses the gate cookie (/banned is public without it); an
    // admitted one becomes a beta member and gets it.
    if (banned) return revokeGateCookie(res);
    if (trial) return grantTrialCookie(res, userId, trial);
    if (!allowlisted) return res;
    await admitAllowlisted(supabase, userId);
    return grantGateCookie(res, userId, session.expiresAt);
  } catch (e) {
    if (e instanceof OAuthError) return deny(e.code);
    if (e instanceof MissingTableError) {
      return done(NextResponse.json(
        { error: `Sign in with a provider needs the ${e.table} table. Run migrations/2026-09-24-auth-identities.sql first.` },
        { status: 503 },
      ));
    }
    if (isDbUnreachable(e)) return done(dbUnavailableResponse());
    console.error(`[oauth/${provider}] callback failed:`, e instanceof Error ? e.message : e);
    return deny("provider_error");
  }
}
