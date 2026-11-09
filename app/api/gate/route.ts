import { NextRequest, NextResponse } from "next/server";
import { whitelistStageActive } from "@/lib/allowlist";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { grantTrialPass, redeemableCode } from "@/lib/trial";
import { readTrial, TRIAL_COOKIE } from "@/lib/trial-cookie";

// Validates the team access code; the code itself lives only in TEAM_ACCESS_CODE
// (server env). It no longer opens the app by itself (DEC-434): the page goes on
// to the sign-in, whose login sets the member cookie the proxy checks. Any other
// code may be a trial code (lib/trial): it earns a pass, and the tester's own
// login spends it.
export async function POST(req: NextRequest) {
  const code = process.env.TEAM_ACCESS_CODE;
  if (!code) {
    // ENV-01: a missing setting is said as one (503), not as a server fault.
    return NextResponse.json({ ok: false, error: "The access code is not configured on this environment" }, { status: 503 });
  }
  // Per address: codes are not to be guessed.
  const limit = checkRequestRateLimit(rateLimitKey(req, "gate"), 10, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  let given = "";
  try {
    const body = await req.json();
    given = (body?.code ?? "").toString();
  } catch {
    /* empty / invalid body → treated as wrong code */
  }

  if (given !== code) {
    let trialCode: string | null = null;
    try {
      trialCode = given ? await redeemableCode(getSupabaseServerClient(), given) : null;
    } catch (e) {
      if (isDbUnreachable(e)) return dbUnavailableResponse();
      throw e;
    }
    if (trialCode) return grantTrialPass(NextResponse.json({ ok: true, trial: true }), trialCode);
    return NextResponse.json({ ok: false, error: "Wrong access code" }, { status: 401 });
  }

  return NextResponse.json({ ok: true, signIn: true });
}

const COOKIE = "enki_team";

/**
 * GET → { team: boolean, whitelistActive: boolean } — whether this browser
 * carries what the proxy opens the app for (a member's or a running trial's
 * signed cookie, DEC-434), and whether the private-beta whitelist stage
 * is still active. The client asks this: BetaGate's team fallback, and the
 * landing, which renews a signed-in browser's missing cookie; whitelistActive
 * ⇒ once it's false (TEAM_ACCESS_CODE unset), every signed-in, non-banned
 * account is admitted regardless of role (Kev, 2026-09-24, SOC-8) — during the
 * stage the role/allowlist rules stay. Grants NOTHING by itself: every
 * user-bound API still requires a real session.
 */
export async function GET(req: NextRequest) {
  const active = whitelistStageActive();
  if (!active) return NextResponse.json({ team: false, whitelistActive: false });
  const pepper = process.env.AUTH_PEPPER ?? "";
  const team = Boolean(readTrial("member", req.cookies.get(COOKIE)?.value, pepper) || readTrial("trial", req.cookies.get(TRIAL_COOKIE)?.value, pepper));
  return NextResponse.json({ team, whitelistActive: true });
}
