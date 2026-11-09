/**
 * What every password login checks before it opens a session, and how it
 * opens one. Shared by the login and an invited account's first login, so
 * neither can skip a check the other makes.
 */
import { NextRequest, NextResponse } from "next/server";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { mintUserSession } from "@/lib/user-session";
import { activeBanFor } from "@/lib/session-user";
import { whitelistStageActive, isEmailAllowed, admitAllowlisted, grantGateCookie, revokeGateCookie } from "@/lib/allowlist";
import { getClientIp, hashIp, isIpBanned } from "@/lib/ip-hash";
import { grantTrialCookie, trialAdmission, trialPassCode, trialSessionMs, type ActiveTrial } from "@/lib/trial";

type Supabase = ReturnType<typeof getSupabaseServerClient>;

/** A refusal for this login, or null with the caller's IP hash. The access
    list answers with the generic 401, so it is no oracle for accounts.
    trialFor: the account whose password was checked; off the list, a trial
    code this browser redeemed (or its running trial) lets it in (lib/trial),
    asked last, so a blocked network spends no code. */
export async function loginRefusal(
  req: NextRequest,
  supabase: Supabase,
  email: string,
  trialFor?: string,
): Promise<{ refusal: NextResponse; ipHash?: undefined; trial?: undefined } | { refusal: null; ipHash: string | null; trial: ActiveTrial | null }> {
  const wrong = () => ({ refusal: NextResponse.json({ error: "Wrong login or password" }, { status: 401 }) });
  let allowed = true;
  try {
    allowed = !whitelistStageActive() || (await isEmailAllowed(supabase, email));
  } catch (e) {
    if (isDbUnreachable(e)) return { refusal: dbUnavailableResponse() };
    throw e;
  }
  if (!allowed && !trialFor) return wrong();

  const ipHash = hashIp(getClientIp(req));
  if (await isIpBanned(supabase, ipHash)) {
    return { refusal: NextResponse.json({ error: "Access from this network is blocked." }, { status: 403 }) };
  }
  if (allowed) return { refusal: null, ipHash, trial: null };
  let trial: ActiveTrial | null = null;
  try {
    // A suspended account spends no code: it is turned away as any login off the list (the Google/X path skips it too).
    if (await activeBanFor(supabase, trialFor!)) return wrong();
    trial = await trialAdmission(supabase, req, trialFor!);
  } catch (e) {
    if (isDbUnreachable(e)) return { refusal: dbUnavailableResponse() };
    throw e;
  }
  if (trial) return { refusal: null, ipHash, trial };
  // The password was right and the browser holds a pass: what failed is the code, and it may be said.
  return trialPassCode(req)
    ? { refusal: NextResponse.json({ error: "Your trial with this code has ended, or the code can no longer be used.", trialEnded: true }, { status: 403 }) }
    : wrong();
}

/** A deleted account stays deleted (DEC-2026-10-17-31): softDelete keeps its credential and its wallets, so every login
    has to ask. The caller's own refusal, so a right password learns nothing a wrong one would not; a read that fails is
    a 503, never a pass. A ban is not this: a banned account keeps its session and its way to its funds. */
export async function deletedRefusal(supabase: Supabase, userId: string, error: string, status: number): Promise<NextResponse | null> {
  const { data, error: readErr } = await supabase.from("users").select("deleted_at").eq("id", userId).maybeSingle();
  if (readErr) return dbUnavailableResponse();
  return data?.deleted_at ? NextResponse.json({ error }, { status }) : null;
}

/** Opens the session. Banned users still get one: it only opens /api/ban/*
    (status, appeal, funds), and the banned flag routes the client to /banned.
    The gate cookie grants app access during the whitelist stage; a banned
    account loses it (the cookie opens every page, /banned is public without it). */
export async function openLoginSession(supabase: Supabase, userId: string, email: string, ipHash: string | null, trial: ActiveTrial | null = null): Promise<NextResponse> {
  const banned = !!(await activeBanFor(supabase, userId));
  // The caller's loginRefusal passed the access list: the account is a beta member. A trial is not one: its session and
  // its cookie end with the trial.
  if (!banned && !trial) await admitAllowlisted(supabase, userId);
  const session = await mintUserSession(userId, ipHash, trial ? trialSessionMs(trial) : undefined);
  const res = NextResponse.json({ email, ...session, ...(banned ? { banned: true } : {}) });
  return banned ? revokeGateCookie(res) : trial ? grantTrialCookie(res, userId, trial) : grantGateCookie(res, userId, session.expiresAt);
}
