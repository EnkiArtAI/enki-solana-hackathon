/**
 * Trial codes (Kev, 2026-10-26): the owner makes a code with a number of
 * uses (or none), minutes of access, an optional expiry and a budget per
 * tester. A tester types it at /gate, signs in with their own account (so
 * Enki can reach them later) and uses Enki until the minutes or the budget
 * run out. Tables and functions: migrations/2026-10-26-trial-codes.sql.
 */
import { createHmac, randomInt } from "crypto";
import type { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readTrial, signTrial, TRIAL_COOKIE, TRIAL_PASS_COOKIE } from "@/lib/trial-cookie";

type Supabase = SupabaseClient;

/** How long a redeemed code waits for its tester to sign in. */
export const TRIAL_PASS_MS = 30 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // as the invite's: no I, O, 0, 1
const CODE_LENGTH = 16; // 80 bits

/** A new code, in fours for reading out: "K7QM-..." */
export function newTrialCode(): string {
  const raw = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return raw.match(/.{4}/g)!.join("-");
}

/** A typed code as it is compared: its letters and digits, upper case. */
export const normalizeTrialCode = (typed: string) => typed.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Kept only as this keyed hash: the table never holds a code that works. Null without the pepper. */
export function hashTrialCode(code: string): string | null {
  const pepper = process.env.AUTH_PEPPER;
  return pepper ? createHmac("sha256", pepper).update(`trial-code:${normalizeTrialCode(code)}`).digest("hex") : null;
}

export type ActiveTrial = { redemptionId: string; endsAt: string; budgetMicro: number; spentMicro: number };

type TrialRow = { redemption_id: string; ends_at: string; budget_micro: number | string; spent_micro: number | string };
const toTrial = (data: unknown): ActiveTrial | null => {
  const row = (Array.isArray(data) ? data[0] : data) as TrialRow | null | undefined;
  return row?.redemption_id
    ? { redemptionId: row.redemption_id, endsAt: row.ends_at, budgetMicro: Number(row.budget_micro), spentMicro: Number(row.spent_micro) }
    : null;
};
// Before the migration has run there are no trials, and nothing else changes.
const missing = (error: { code?: string } | null) => error?.code === "PGRST205" || error?.code === "PGRST202" || error?.code === "42P01" || error?.code === "42883";

/** The code a typed one names while it can still be redeemed (not revoked, not past its date, a use left); else null. */
export async function redeemableCode(supabase: Supabase, typed: string): Promise<string | null> {
  const hash = hashTrialCode(typed);
  if (!hash || normalizeTrialCode(typed).length !== CODE_LENGTH) return null;
  const { data, error } = await supabase
    .from("trial_codes")
    .select("id, max_uses, uses, expires_at, revoked_at")
    .eq("code_hash", hash)
    .maybeSingle();
  if (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (!data || data.revoked_at) return null;
  if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) return null;
  if (data.max_uses !== null && data.uses >= data.max_uses) return null;
  return String(data.id);
}

/** The account's running trial: not past its end, its code not revoked. */
export async function activeTrial(supabase: Supabase, userId: string): Promise<ActiveTrial | null> {
  const { data, error } = await supabase.rpc("active_trial", { p_user_id: userId });
  if (error) {
    if (missing(error)) return null;
    throw error;
  }
  return toTrial(data);
}

/** The code this browser redeemed at /gate, while its pass lasts. */
export const trialPassCode = (req: NextRequest): string | null =>
  readTrial("pass", req.cookies.get(TRIAL_PASS_COOKIE)?.value, process.env.AUTH_PEPPER ?? "")?.subject ?? null;

/**
 * Lets a login that is not on the access list in on a trial: the code this
 * browser redeemed at /gate, spent on this account now (one use, once per
 * account and code; a second code is not thrown away while an earlier trial
 * runs), else the account's running trial. Null: no trial.
 */
export async function trialAdmission(supabase: Supabase, req: NextRequest, userId: string): Promise<ActiveTrial | null> {
  const code = trialPassCode(req);
  if (code) {
    const { data, error } = await supabase.rpc("redeem_trial_code", { p_code_id: code, p_user_id: userId });
    if (error && !missing(error)) throw error;
    if (!error && toTrial(data)) {
      // The client wall admits a trial account while its trial runs (/api/users/handle says so); 'user' only, a staff
      // or beta role is never touched.
      const { error: roleErr } = await supabase.from("users").update({ role: "trial" }).eq("id", userId).eq("role", "user");
      if (roleErr) console.error("[trial] could not mark the account:", roleErr.message);
    }
  }
  // The trial that ends last, this one or an earlier one still running.
  return activeTrial(supabase, userId);
}

const COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" };

/** What a redeemed code gives the browser until its tester signs in. */
export function grantTrialPass(res: NextResponse, codeId: string): NextResponse {
  const expires = Date.now() + TRIAL_PASS_MS;
  res.cookies.set(TRIAL_PASS_COOKIE, signTrial("pass", codeId, expires, process.env.AUTH_PEPPER ?? ""), { ...COOKIE_OPTIONS, maxAge: TRIAL_PASS_MS / 1000 });
  return res;
}

/** The app opens for the trial's length, as the team cookie opens it for the team; the pass is spent. */
export function grantTrialCookie(res: NextResponse, userId: string, trial: ActiveTrial): NextResponse {
  const ends = Date.parse(trial.endsAt);
  res.cookies.set(TRIAL_COOKIE, signTrial("trial", userId, ends, process.env.AUTH_PEPPER ?? ""), {
    ...COOKIE_OPTIONS,
    maxAge: Math.max(0, Math.floor((ends - Date.now()) / 1000)),
  });
  res.cookies.set(TRIAL_PASS_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return res;
}

/** A trial login's session ends with the trial. */
export const trialSessionMs = (trial: ActiveTrial, now = Date.now()) => Math.max(0, Date.parse(trial.endsAt) - now);
