/**
 * Step-up with a code factor (the passkey keeps its own WebAuthn routes under
 * /api/auth/passkey/stepup).
 *
 *   GET                                   -> { factors: ["passkey" | "totp" | "email"], emailCodes, actions, addressFirst }
 *     (emailCodes: whether an email code can be a factor here; never for a password account;
 *      addressFirst: why a first passkey or authenticator app waits for Code by email, or null;
 *      actions: which of upload, publish, render, delete ask, lib/stepup-actions.ts)
 *   POST { scope, factor, code }          -> { token } for X-StepUp-Token
 *   PATCH { actions: { render: true } }   -> { actions } (switching one off is itself a step-up)
 *
 * Ban tolerant on purpose: a ban locks the marketplace, never the wallet, and
 * moving funds off a suspended account is a step-up too.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { checkCode, enrolledFactors, isPasswordAccount } from "@/lib/mfa";
import { isStepUpScope, mintStepUpToken, afterStepUp, stepUpActions, requireAddFactor, addressFirst } from "@/lib/webauthn";
import { isStepUpAction, withDefaults } from "@/lib/stepup-actions";

async function sessionUser(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const { userId } = await resolveSessionUserWithBan(supabase, req.headers.get("X-Session-Token"));
  return { supabase, userId };
}

export async function GET(req: NextRequest) {
  try {
    const { supabase, userId } = await sessionUser(req);
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const [factors, password, actions] = await Promise.all([
      enrolledFactors(supabase, userId), isPasswordAccount(supabase, userId), stepUpActions(supabase, userId),
    ]);
    // A password account always has its login email (NOT NULL): no read for it.
    return NextResponse.json({ factors, emailCodes: !password, actions, addressFirst: password ? null : await addressFirst(supabase, userId, factors) });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    return NextResponse.json({ error: "Could not read your security settings" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { scope?: unknown; factor?: unknown; code?: unknown } | null;
  if (!isStepUpScope(body?.scope)) return NextResponse.json({ error: "Unknown scope" }, { status: 400 });
  if (body?.factor !== "totp" && body?.factor !== "email") return NextResponse.json({ error: "factor must be totp or email" }, { status: 400 });
  if (typeof body.code !== "string") return NextResponse.json({ error: "code required" }, { status: 400 });
  try {
    const { supabase, userId } = await sessionUser(req);
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    // Only a factor that counts steps up: an email code is none for a password account.
    if (!(await enrolledFactors(supabase, userId)).includes(body.factor)) {
      return NextResponse.json({ error: "That factor is not set up" }, { status: 404 });
    }
    const result = await checkCode(supabase, userId, body.factor, body.code);
    if (result === "ok") {
      try {
        await afterStepUp(supabase, req.headers.get("X-Session-Token"), userId, body.scope);
      } catch {
        // The code is spent by now: say so, or a retry with it reads as a wrong guess.
        return NextResponse.json({ error: "Could not unlock the wallet. Get a new code and try again." }, { status: 503 });
      }
      return NextResponse.json({ token: await mintStepUpToken(userId, body.scope, body.factor) });
    }
    if (result === "none") return NextResponse.json({ error: "That factor is not set up" }, { status: 404 });
    if (result === "locked") return NextResponse.json({ error: "Too many wrong codes. This factor is locked for now; try another one or wait." }, { status: 429 });
    if (result === "busy") return NextResponse.json({ error: "Another check is running, try again" }, { status: 409 });
    return NextResponse.json({ error: "Wrong code" }, { status: 401 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[stepup] code check failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not check the code" }, { status: 500 });
  }
}

/**
 * The Settings table of actions that ask for the second factor (Kev,
 * 2026-10-17). Switching one off takes a factor, or without one a login
 * younger than ten minutes (requireAddFactor): a stolen session must not
 * plant an "off" that outlives the first factor (review, 2026-10-17).
 * Switching one on asks nothing.
 */
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { actions?: unknown } | null;
  const change = body?.actions;
  const entries = change && typeof change === "object" && !Array.isArray(change) ? Object.entries(change) : [];
  if (!entries.length || entries.some(([a, on]) => !isStepUpAction(a) || typeof on !== "boolean")) {
    return NextResponse.json({ error: "actions must name upload, publish, render or delete with true or false" }, { status: 400 });
  }
  try {
    const { supabase, userId } = await sessionUser(req);
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    if (entries.some(([, on]) => on === false)) {
      const blocked = await requireAddFactor(req, userId, "stepup-settings");
      if (blocked) return blocked;
    }
    // Merged in one statement (stepup_actions || patch), so two changes at
    // once cannot undo each other. Only what the account chose is stored,
    // so a default changed later still reaches the rest.
    const { data, error } = await supabase.rpc("merge_stepup_actions", { p_user: userId, p_patch: Object.fromEntries(entries) });
    if (error) {
      // The migration has not run yet: no function (PGRST202), no column (42703).
      if (error.code === "PGRST202" || error.code === "42703") return NextResponse.json({ error: "This setting is not available yet" }, { status: 503 });
      throw error;
    }
    return NextResponse.json({ actions: withDefaults(data) });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    return NextResponse.json({ error: "Could not save the setting" }, { status: 500 });
  }
}
