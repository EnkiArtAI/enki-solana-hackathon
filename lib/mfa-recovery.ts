import crypto, { hkdfSync } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { sendMail } from "@/lib/mailer";
import { CODE_TTL_MS, MAX_ATTEMPTS, RESET_ADVICE, confirmedEmailFactor, enrolledFactors, isPasswordAccount, lockEnd, sendRefusal, type Factor } from "@/lib/mfa";
import { everyAddress, hasXLogin, mailEach, X_NEEDS_EMAIL } from "@/lib/security-notice";
import { maskEmail } from "@/lib/confirm-email";
import { PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { recoveryThreshold } from "@/lib/recovery/threshold";
import { guardianFactorMessage } from "@/lib/guardian-message";
// lib/password-reset's sha256 would load lib/password-auth, which hashes with AUTH_PEPPER when it loads.
export const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * The way out for a lost factor, with no staff (Kev, 2026-11-05: "support weg"). A factor is removed only with every
 * factor (lib/webauthn.ts requireAllFactors), so someone who lost one is stuck. One recovery code and a signed-in
 * session remove one named factor. A code removes a factor and does nothing else: it is no step-up factor, it opens no
 * wallet and passes no gate. migrations/2026-11-05-mfa-recovery.sql.
 *
 * With no code left: one code to every address of the account, all entered, or the guardians' yes removes it at once
 * (Kev, 2026-11-07: "keine wartezeit"). Every address hears after each.
 *
 * Ban tolerant on purpose, like the step-up routes: a ban locks the marketplace, never the wallet.
 */

const CODES_PER_SET = 10;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
export const NOT_READY = "This is not available yet";

/** The tables are not there yet (SQL 74 not run). */
export class RecoveryNotReady extends Error {}
const tableMissing = (error: { code?: string } | null) => error?.code === "PGRST205" || error?.code === "42P01";
const check = (error: { code?: string } | null) => {
  if (error) throw tableMissing(error) ? new RecoveryNotReady() : error;
};

function recoveryKey(): Uint8Array {
  const pepper = process.env.AUTH_PEPPER;
  if (!pepper) throw new Error("AUTH_PEPPER not configured");
  return new Uint8Array(hkdfSync("sha256", Buffer.from(pepper, "base64"), new Uint8Array(0), Buffer.from("enki-mfa-recovery-v1"), 32));
}
const keyed = (text: string) => crypto.createHmac("sha256", recoveryKey()).update(text).digest("hex");

/**
 * Case, dashes and spaces do not matter, and the letters Crockford's alphabet leaves out read as the digits they resemble. A
 * leading "3. " or "3) " goes: the dialog numbers the list, and a copy made by selecting it keeps the numbers. A code holds
 * no dot or bracket, so this never cuts into one (DEC-2026-11-07-29).
 */
export const normalizeCode = (code: string) => code.replace(/^\s*\d+[.)]\s*/, "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
const codeHash = (userId: string, code: string) => keyed(`${userId}:${normalizeCode(code)}`);

/** 16 characters of 5 bits each: 80 bits. */
function newCode(): string {
  const raw = Array.from({ length: 16 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  return raw.match(/.{4}/g)!.join("-");
}

async function insertCodes(supabase: SupabaseClient, userId: string, n: number): Promise<string[]> {
  const codes = Array.from({ length: n }, newCode);
  const { error } = await supabase.from("mfa_recovery_codes").insert(codes.map((code) => ({ id: crypto.randomUUID(), user_id: userId, code_hash: codeHash(userId, code) })));
  check(error);
  return codes;
}

// No head read: postgrest-js answers a missing table's empty 404 with no error and no count.
export async function codesLeft(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await supabase.from("mfa_recovery_codes").select("id").eq("user_id", userId).is("used_at", null);
  check(error);
  return data?.length ?? 0;
}

/**
 * After a factor was added, with the factors from before it: the codes, once. A first factor gets its own set whatever the
 * table holds: unused rows there may be whoever planted the factor before it, and the owner must not read "10 left" holding
 * none. A further factor gets a set only when no unused code is left. Null otherwise, and when they cannot be written: the
 * factor stands either way.
 */
export async function codesForNewFactor(supabase: SupabaseClient, userId: string, factor: Factor, before: Factor[]): Promise<string[] | null> {
  try {
    // Mailed codes naming this factor meant the one before it: they must not remove this one.
    check((await supabase.from("mfa_recovery").update(REQUEST_CLOSED).eq("user_id", userId).eq("factor", factor)).error);
    // The same for an ask to the guardians: their yes must not remove the new one. A failure is told and issues no codes.
    checkAsk((await supabase.from("recovery_requests").update({ status: "cancelled" }).eq("user_id", userId).eq("factor", factor).eq("status", "pending")).error);
    if (!before.length) return await newCodeSet(supabase, userId);
    return (await codesLeft(supabase, userId)) ? null : await insertCodes(supabase, userId, CODES_PER_SET);
  } catch (e) {
    if (!(e instanceof RecoveryNotReady)) console.error("[mfa-recovery] no codes issued:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * The new ten go in first and only the rows read before them go after, so neither a failure nor two at once leave zero.
 * Unused codes that die are told to every address: the owner may hold them on paper. A failed notice leaves the set standing.
 */
export async function newCodeSet(supabase: SupabaseClient, userId: string): Promise<string[]> {
  const { data: older, error: read } = await supabase.from("mfa_recovery_codes").select("id, used_at").eq("user_id", userId);
  check(read);
  const codes = await insertCodes(supabase, userId, CODES_PER_SET);
  if (!older?.length) return codes;
  const { error } = await supabase.from("mfa_recovery_codes").delete().in("id", older.map((r) => r.id));
  check(error);
  if (older.some((r) => !r.used_at)) {
    const to = await everyAddress(supabase, userId).catch((e) => {
      console.error("[mfa-recovery] no new-codes notice:", e instanceof Error ? e.message : e);
      return [] as string[];
    });
    await mailEach(
      to,
      "New recovery codes were made for your Enki account",
      `New recovery codes were made for your Enki account (${new Date().toUTCString()}). The old ones no longer work. If that was you, there is nothing to do.\n\n` +
        `If it was not, someone is using your session: ${RESET_ADVICE}`,
    );
  }
  return codes;
}

export type RecoveryRow = {
  user_id: string;
  failed_attempts: number;
  lockouts: number;
  locked_until: string | null;
  factor: Factor | null;
  code_hashes: string[] | null;
  code_expires_at: string | null;
  code_sent_at: string | null;
  sends_day: string | null;
  sends_count: number;
};
// The limits stay: closing a request must not buy another code.
const REQUEST_CLOSED = { factor: null, code_hashes: null, code_expires_at: null };

export async function recoveryRow(supabase: SupabaseClient, userId: string): Promise<RecoveryRow> {
  const read = () => supabase.from("mfa_recovery").select("*").eq("user_id", userId).maybeSingle();
  const first = await read();
  check(first.error);
  if (first.data) return first.data as RecoveryRow;
  const { error } = await supabase.from("mfa_recovery").insert({ user_id: userId });
  if (error?.code !== "23505") check(error);
  const again = await read();
  check(again.error);
  if (!again.data) throw new Error("mfa_recovery row missing after insert");
  return again.data as RecoveryRow;
}

/**
 * Spends one attempt BEFORE the code is looked at, against the row as it was read, in the database: parallel guesses
 * cannot buy extra tries, and the fifth writes the lock itself, so no failure in between leaves a guess unpaid.
 */
async function claimAttempt(supabase: SupabaseClient, row: RecoveryRow): Promise<"claimed" | "locked" | "busy"> {
  const now = Date.now();
  if (row.locked_until && Date.parse(row.locked_until) > now) return "locked";
  const tries = row.failed_attempts + 1;
  const { data, error } = await supabase
    .from("mfa_recovery")
    .update(tries >= MAX_ATTEMPTS ? { failed_attempts: 0, lockouts: row.lockouts + 1, locked_until: lockEnd(row.lockouts, now) } : { failed_attempts: tries })
    .eq("user_id", row.user_id)
    .eq("failed_attempts", row.failed_attempts)
    .or(`locked_until.is.null,locked_until.lte.${new Date(now).toISOString()}`)
    .select("user_id")
    .maybeSingle();
  check(error);
  return data ? "claimed" : "busy";
}
const afterWrong = (row: RecoveryRow): "wrong" | "locked" => (row.failed_attempts + 1 >= MAX_ATTEMPTS ? "locked" : "wrong");
const ATTEMPTS_CLEARED = { failed_attempts: 0, lockouts: 0, locked_until: null };

const FACTOR_NAME: Record<Factor, string> = { passkey: "your passkeys", totp: "your authenticator app", email: "your email code" };
export const isFactor = (f: unknown): f is Factor => f === "passkey" || f === "totp" || f === "email";

/**
 * A factor removed by a recovery code or the mail path: a guardians' ask for it has nothing left to remove, and its yes must not
 * reach a factor of that kind added later (DEC-2026-11-07-36). Best effort: before SQL 74 ran the column is missing, and a
 * failure is logged; the new factor's own cancel (codesForNewFactor) still stands behind it.
 */
async function closeAsks(supabase: SupabaseClient, userId: string, factor: Factor): Promise<void> {
  const { error } = await supabase.from("recovery_requests").update({ status: "cancelled" }).eq("user_id", userId).eq("factor", factor).eq("status", "pending");
  if (error && !tableMissing(error) && !columnMissing(error)) console.error("[mfa-recovery] an ask for a removed factor stays open:", error.message);
}

/** All passkeys count as one factor, so they go together. */
async function removeFactor(supabase: SupabaseClient, userId: string, factor: Factor): Promise<void> {
  const { error } = await (factor === "passkey"
    ? supabase.from("webauthn_credentials").delete().eq("user_id", userId)
    : supabase.from("mfa_factors").delete().eq("user_id", userId).eq("kind", factor));
  if (error) throw error;
}

export type Redeemed =
  | { result: "ok"; recoveryCodes: string[]; codesLeft: number }
  | { result: "not_enrolled" | "wrong" | "locked" | "busy" };

/**
 * One code removes one named factor. The addresses are read first, so a failed read spends nothing. The code goes with a
 * conditional update, so of two requests carrying it one wins. If the factor cannot be removed the code comes back.
 */
export async function redeemCode(supabase: SupabaseClient, userId: string, code: string, factor: Factor): Promise<Redeemed> {
  const row = await recoveryRow(supabase, userId);
  if (!(await enrolledFactors(supabase, userId)).includes(factor)) return { result: "not_enrolled" };
  const addresses = await everyAddress(supabase, userId);
  const claim = await claimAttempt(supabase, row);
  if (claim !== "claimed") return { result: claim };

  const { data: spent, error } = await supabase
    .from("mfa_recovery_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("code_hash", codeHash(userId, code))
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  check(error);
  if (!spent) return { result: afterWrong(row) };

  try {
    const { error: e } = await supabase.from("mfa_recovery").update(ATTEMPTS_CLEARED).eq("user_id", userId);
    if (e) throw e;
    await removeFactor(supabase, userId, factor);
  } catch (e) {
    const { error: back } = await supabase.from("mfa_recovery_codes").update({ used_at: null }).eq("id", spent.id);
    if (back) console.error("[mfa-recovery] code not restored:", back.message);
    throw e;
  }
  // Only now, or a removal that failed would have cost a running request. If this write fails the factor is gone, so it reads as closed.
  if (row.factor === factor) await supabase.from("mfa_recovery").update(REQUEST_CLOSED).eq("user_id", userId);
  await closeAsks(supabase, userId, factor);

  // The factor is gone either way: a replacement that cannot be written leaves one code fewer, and the panel says how many.
  const replacement = await insertCodes(supabase, userId, 1).catch((e) => {
    console.error("[mfa-recovery] no replacement code:", e instanceof Error ? e.message : e);
    return [] as string[];
  });
  const left = await codesLeft(supabase, userId).catch(() => 0);
  await mailEach(
    addresses,
    "A recovery code was used on your Enki account",
    `A recovery code removed ${FACTOR_NAME[factor]} from your Enki account (${new Date().toUTCString()}). ${left} recovery ${left === 1 ? "code is" : "codes are"} left. ` +
      `If that was you, there is nothing to do.\n\nIf it was not, someone is using your session and holds one of your codes: ${RESET_ADVICE}`,
  );
  return { result: "ok", recoveryCodes: replacement, codesLeft: left };
}

const TWO_ADDRESSES = "Emailing codes needs two email addresses or more, one code to each";

/** What else removes a lost factor on this account: a code left, two guardians or more who can be asked; or that nothing does now. */
const otherWays = (codes: boolean, guardians: boolean) =>
  codes ? `Use a recovery code${guardians ? " or ask your guardians" : ""}.`
    : guardians ? "No recovery code is left either, so only your guardians can remove a lost factor now."
    : "No recovery code is left either, and fewer than two guardians can be asked, so a lost factor cannot be removed now.";

/** The ways besides the mail path this account has now: a recovery code left, two guardians or more who can be asked. Throws as its reads do. */
export async function waysBesideMail(supabase: SupabaseClient, userId: string): Promise<{ codes: boolean; guardians: boolean }> {
  const [left, guardians] = await Promise.all([codesLeft(supabase, userId), askableGuardians(supabase, userId)]);
  return { codes: left > 0, guardians: guardians.length >= 2 };
}

/** The mail path's refusal with fewer than two addresses, naming only the other ways this account has (DEC-2026-11-07-30). */
export async function tooFew(supabase: SupabaseClient, userId: string): Promise<string> {
  const { codes, guardians } = await waysBesideMail(supabase, userId);
  return `${TWO_ADDRESSES}, not counting the address of an email code you lost. ${otherWays(codes, guardians)}`;
}

/**
 * Who gets a code on the mail path: every address of the account (lib/security-notice.ts everyAddress), sorted so the codes
 * keep their order between the send and the confirm, but the address of an email factor named as lost: whoever reads that
 * inbox holds the factor, and whoever does not could never get its code. `every` is the whole list, for the mail after.
 */
async function mailPathAddresses(supabase: SupabaseClient, userId: string, lost: Factor): Promise<{ to: string[]; every: string[] }> {
  const [every, named] = await Promise.all([everyAddress(supabase, userId), lost === "email" ? confirmedEmailFactor(supabase, userId) : null]);
  const to = every.filter((a) => a.toLowerCase() !== named?.toLowerCase()).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return { to, every };
}
const mailCodeHash = (userId: string, address: string, code: string) => keyed(`mail:${userId}:${address.toLowerCase()}:${code}`);
export const sameHash = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

export type MailSent = { result: "sent"; to: string[] } | { result: "not_enrolled" | "too_few" | "cooldown" | "daily_cap" | "send_failed" };

/**
 * No recovery code left: one 6 digit code to EACH address (Kev, 2026-11-07: "keine wartezeit"). A new set replaces the last one;
 * one a minute and five a day, across every send of the account. `to` names the addresses masked, in the order the codes go back.
 */
export async function sendMailCodes(supabase: SupabaseClient, userId: string, factor: Factor): Promise<MailSent> {
  const row = await recoveryRow(supabase, userId);
  if (!(await enrolledFactors(supabase, userId)).includes(factor)) return { result: "not_enrolled" };
  const { to } = await mailPathAddresses(supabase, userId, factor);
  if (to.length < 2) return { result: "too_few" };
  const now = Date.now();
  const refused = sendRefusal(row, now);
  if (refused) return { result: refused };
  const today = new Date(now).toISOString().slice(0, 10);
  const codes = to.map(() => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"));
  // Conditional on what was read: of parallel sends one wins, the rest wait their minute.
  let send = supabase
    .from("mfa_recovery")
    .update({
      ...REQUEST_CLOSED,
      factor,
      code_hashes: to.map((address, i) => mailCodeHash(userId, address, codes[i])),
      code_expires_at: new Date(now + CODE_TTL_MS).toISOString(),
      code_sent_at: new Date(now).toISOString(),
      sends_day: today,
      sends_count: (row.sends_day === today ? row.sends_count : 0) + 1,
    })
    .eq("user_id", userId);
  send = row.code_sent_at ? send.eq("code_sent_at", row.code_sent_at) : send.is("code_sent_at", null);
  const { data: won, error } = await send.select("user_id").maybeSingle();
  check(error);
  if (!won) return { result: "cooldown" };
  const sent = await Promise.all(to.map((address, i) => sendMail({
    to: address,
    subject: "Your Enki recovery code",
    text: `Your Enki recovery code for this address is ${codes[i]}. It is valid for 10 minutes. We sent one code to each of your ${to.length} email addresses: ` +
      `entered together in Settings, Recovery, Lost a factor, they remove ${FACTOR_NAME[factor]} from your account at once.\n\n` +
      `Never give this code to anyone: Enki never asks for it. If you did not ask for it, someone is using your session: ${RESET_ADVICE}`,
  }).then((m) => m.ok, () => false)));
  // A set with one code missing can never be entered; the next send replaces it.
  return sent.every(Boolean) ? { result: "sent", to: to.map(maskEmail) } : { result: "send_failed" };
}

export type MailConfirmed = { result: "removed" | "none" | "changed" | "too_few" | "wrong" | "locked" | "busy" };

/**
 * Every code of the live set, in the order `to` named them: the factor goes at once, with the account's unused recovery codes
 * (whoever walked this path had lost them, and a found paper and a session must not strip the factor left), and every address
 * hears. The addresses are read before the try is spent, so a failed read spends nothing and a list that changed since the send
 * says so. The set is spent with a conditional update, so of two requests carrying it one goes on. If the factor cannot go, the
 * set comes back.
 */
export async function confirmMailCodes(supabase: SupabaseClient, userId: string, codes: string[]): Promise<MailConfirmed> {
  const row = await recoveryRow(supabase, userId);
  const factor = row.factor;
  const hashes = row.code_hashes;
  const enrolled = await enrolledFactors(supabase, userId);
  if (!factor || !hashes?.length || !row.code_sent_at || !enrolled.includes(factor)) return { result: "none" };
  const { to, every } = await mailPathAddresses(supabase, userId, factor);
  if (to.length < 2) return { result: "too_few" };
  if (to.length !== hashes.length) return { result: "changed" };
  const claim = await claimAttempt(supabase, row);
  if (claim !== "claimed") return { result: claim };

  const ok = codes.length === to.length && !!row.code_expires_at && Date.parse(row.code_expires_at) > Date.now() &&
    to.every((address, i) => sameHash(mailCodeHash(userId, address, String(codes[i]).replace(/\D/g, "")), hashes[i]));
  if (!ok) return { result: afterWrong(row) };
  const { data: spent, error } = await supabase
    .from("mfa_recovery")
    .update({ factor: null, code_hashes: null, code_expires_at: null })
    .eq("user_id", userId)
    .eq("code_sent_at", row.code_sent_at)
    .not("code_hashes", "is", null)
    .select("user_id")
    .maybeSingle();
  check(error);
  if (!spent) return { result: "none" };
  try {
    check((await supabase.from("mfa_recovery").update(ATTEMPTS_CLEARED).eq("user_id", userId)).error);
    // The paper first: a failure between the two leaves the factor with no old code beside it, never a removed factor with them.
    check((await supabase.from("mfa_recovery_codes").delete().eq("user_id", userId).is("used_at", null)).error);
    await removeFactor(supabase, userId, factor);
  } catch (e) {
    const { error: back } = await supabase.from("mfa_recovery").update({ factor, code_hashes: hashes, code_expires_at: row.code_expires_at }).eq("user_id", userId);
    if (back) console.error("[mfa-recovery] mailed codes not restored:", back.message);
    throw e;
  }
  await closeAsks(supabase, userId, factor);
  await mailEach(
    every,
    "A factor was removed from your Enki account",
    `A code sent to each of your email addresses removed ${FACTOR_NAME[factor]} from your Enki account (${new Date().toUTCString()}). ` +
      `The recovery codes you had left stopped working too: ${enrolled.some((f) => f !== factor) ? "New codes in Settings, Recovery, makes a new set." : "the next factor you add comes with a new set."} ` +
      `If that was you, there is nothing else to do.\n\nIf it was not, someone reads your email and is using your session: ${RESET_ADVICE}`,
  );
  return { result: "removed" };
}

// ── Guardians remove a lost factor at once (Kev, 2026-11-07: "ok go for the guardians", "keine wartezeit") ──
// A request in recovery_requests names the factor (NULL there: a password reset's request); one recovery_approvals row per
// guardian asked. SQL 74 adds the column; before it ran every read of it fails, and that is RecoveryNotReady too.

const ASK_TTL_MS = 7 * 24 * 3600_000;
const columnMissing = (error: { code?: string } | null) => error?.code === "PGRST204" || error?.code === "42703";
const checkAsk = (error: { code?: string } | null) => {
  if (error) throw tableMissing(error) || columnMissing(error) ? new RecoveryNotReady() : error;
};
const GUARDIAN_KIND: Record<Factor, string> = { passkey: "passkeys", totp: "authenticator app", email: "email code" };
export const guardianOrigin = () => process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://enki.gallery";
const maskWallet = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`;
export const maskGuardian = (g: Guardian) => (g.guardian_type === "wallet" ? maskWallet(g.value) : maskEmail(g.value));

export type Guardian = { id: string; guardian_type: "email" | "wallet"; value: string };

/**
 * A guardian who answered can be reached: a yes to a request counts as the yearly check's answer (lib/recovery/guardian-check.ts),
 * and the check's own answer lands here too. Before SQL 75 ran the columns are missing; that, or any failure, changes nothing else.
 */
export async function stampReachable(supabase: SupabaseClient, guardianId: string): Promise<void> {
  const { error } = await supabase.from("recovery_guardians")
    .update({ checked_at: new Date().toISOString(), check_sent_at: null, check_token_hash: null, unreachable_at: null })
    .eq("id", guardianId);
  if (error && !columnMissing(error)) console.error("[mfa-recovery] guardian not stamped reachable:", error.message);
}
type Ask = { id: string; factor: Factor; expires_at: string };

/**
 * The guardians this path asks: confirmed, by email or by wallet, the two channels on which someone else answers. An
 * authenticator guardian is the owner's own app and a phone guardian has no ask built, so neither counts nor is asked.
 */
async function askableGuardians(supabase: SupabaseClient, userId: string): Promise<Guardian[]> {
  const { data, error } = await supabase.from("recovery_guardians").select("id, guardian_type, value").eq("user_id", userId).eq("status", "confirmed").in("guardian_type", ["email", "wallet"]);
  if (error) throw error;
  return ((data ?? []) as Guardian[]).filter((g) => g.value);
}

/** The owner's threshold (lib/recovery/threshold.ts), never below two on this path, never above the guardians it can ask. */
const yesNeeded = async (supabase: SupabaseClient, userId: string, askable: number) => Math.max(2, Math.min(await recoveryThreshold(supabase, userId), askable));

async function pendingAsks(supabase: SupabaseClient, userId: string): Promise<Ask[]> {
  const { data, error } = await supabase.from("recovery_requests").select("id, factor, expires_at").eq("user_id", userId).eq("status", "pending").not("factor", "is", null);
  checkAsk(error);
  return (data ?? []) as Ask[];
}
const live = (a: Ask) => Date.parse(a.expires_at) > Date.now();

async function ownerHandle(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await supabase.from("users").select("handle").eq("id", userId).maybeSingle();
  if (error) throw error;
  return (data?.handle as string | null) ?? null;
}

export type Asked =
  | { result: "asked"; needed: number; emailed: number; notReached: string[]; wallets: { guardian: string; link: string }[] }
  | { result: "not_enrolled" | "too_few" | "open" | "send_failed" };

/**
 * A signed-in owner names the lost factor and asks the guardians: each email guardian gets a link with its own token (only its
 * hash is stored), each wallet guardian a link the owner sends, where the wallet signs. Every address of the owner hears at once,
 * with the guardians named. One ask at a time per account (a unique index in SQL 74), for 7 days.
 */
export async function askGuardians(supabase: SupabaseClient, userId: string, factor: Factor): Promise<Asked> {
  if (!(await enrolledFactors(supabase, userId)).includes(factor)) return { result: "not_enrolled" };
  const guardians = await askableGuardians(supabase, userId);
  if (guardians.length < 2) return { result: "too_few" };
  const pending = await pendingAsks(supabase, userId);
  if (pending.some(live)) return { result: "open" };
  const [needed, every, handle] = await Promise.all([yesNeeded(supabase, userId, guardians.length), everyAddress(supabase, userId), ownerHandle(supabase, userId)]);
  if (pending.length) checkAsk((await supabase.from("recovery_requests").update({ status: "expired" }).in("id", pending.map((a) => a.id))).error);

  const id = crypto.randomUUID();
  const { error } = await supabase.from("recovery_requests").insert({ id, user_id: userId, status: "pending", factor, expires_at: new Date(Date.now() + ASK_TTL_MS).toISOString() });
  if (error?.code === "23505") return { result: "open" }; // another ask landed first
  checkAsk(error);
  const tokens = guardians.map(() => crypto.randomBytes(24).toString("hex"));
  const { error: rows } = await supabase.from("recovery_approvals").insert(guardians.map((g, i) => ({ request_id: id, guardian_id: g.id, code_hash: sha256(tokens[i]) })));
  if (rows) {
    await supabase.from("recovery_requests").delete().eq("id", id); // its approvals go with it
    throw rows;
  }
  const link = (g: Guardian, i: number) => `${guardianOrigin()}/guardian?factor=${id}&g=${g.id}${g.guardian_type === "email" ? `&t=${tokens[i]}` : ""}`;
  const who = handle ? `@${handle}` : "your friend";
  const Who = handle ? `@${handle}` : "Your friend";
  const emailed = await Promise.all(guardians.map((g, i) => (g.guardian_type !== "email" ? false : sendMail({
    to: g.value,
    subject: `${Who} asks for your help getting back into Enki Art`,
    text: `${Who} named you as a recovery guardian on Enki Art and asks for your yes: they lost a security factor (their ${GUARDIAN_KIND[factor]}). ` +
      `Your yes helps remove ${who}'s lost security factor so they can get into their money again. The moment ${needed} guardians say yes, it is removed.\n\n` +
      `Only say yes if ${who} asked you themselves, by phone or in person, not only by a message: someone who took over their account can write to you in their name.\n\n` +
      `Say yes here:\n${link(g, i)}\n\n` +
      `If they did not ask you themselves, do nothing: without your yes nothing changes, and the request ends in 7 days.`,
  }).then((m) => m.ok, () => false))));
  // A guardian whose mail did not go out has no link, and its token exists only as a hash. With fewer reached than must say yes
  // the ask could never end in a yes: it is closed again and nobody is told, as nobody was asked (DEC-2026-11-07-32).
  const reached = guardians.filter((g, i) => g.guardian_type === "wallet" || emailed[i]);
  if (reached.length < needed) {
    const { error: closed } = await supabase.from("recovery_requests").update({ status: "cancelled" }).eq("id", id);
    if (closed) console.error("[mfa-recovery] an ask no guardian got stays open:", closed.message);
    return { result: "send_failed" };
  }
  await mailEach(
    every,
    "Your guardians were asked to remove a factor from your Enki account",
    `Your guardians were asked to remove ${FACTOR_NAME[factor]} from your Enki account (${new Date().toUTCString()}): ${reached.map(maskGuardian).join(", ")}. ` +
      `The moment ${needed} of them say yes, it is removed, with no wait. If that was you, there is nothing to do.\n\n` +
      `If it was not, someone is using your session: withdraw it in Settings, Recovery, Lost a factor, tell your guardians not to say yes, and ${RESET_ADVICE}`,
  );
  return {
    result: "asked",
    needed,
    emailed: emailed.filter(Boolean).length,
    notReached: guardians.filter((g, i) => g.guardian_type === "email" && !emailed[i]).map(maskGuardian),
    wallets: guardians.flatMap((g, i) => (g.guardian_type === "wallet" ? [{ guardian: maskWallet(g.value), link: link(g, i) }] : [])),
  };
}

/** The owner takes the ask back. Session only: it can only make the account safer. */
export async function withdrawGuardianAsk(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from("recovery_requests").update({ status: "cancelled" }).eq("user_id", userId).eq("status", "pending").not("factor", "is", null).select("id");
  checkAsk(error);
  return !!data?.length;
}

export type GuardianAskStatus = { askable: number; reachable: number; total: number; needed: number; ask: { factor: Factor; approved: number; needed: number; expiresAt: string; wallets: { guardian: string; link: string }[] } | null };

/**
 * What Settings shows: how many guardians can be asked, how many of them can be reached (no yearly check left unanswered,
 * lib/recovery/guardian-check.ts; before SQL 75 ran, all of them), of how many on the list (any type, any status), how many
 * must say yes, and a running ask with its wallet links.
 */
export async function guardianAskStatus(supabase: SupabaseClient, userId: string): Promise<GuardianAskStatus> {
  const [guardians, pending, all, unanswered] = await Promise.all([
    askableGuardians(supabase, userId),
    pendingAsks(supabase, userId),
    supabase.from("recovery_guardians").select("id").eq("user_id", userId),
    supabase.from("recovery_guardians").select("id").eq("user_id", userId).not("unreachable_at", "is", null),
  ]);
  if (all.error) throw all.error;
  if (unanswered.error && !columnMissing(unanswered.error)) throw unanswered.error;
  const total = all.data?.length ?? 0;
  const reachable = guardians.filter((g) => !(unanswered.data ?? []).some((u) => u.id === g.id)).length;
  const needed = await yesNeeded(supabase, userId, guardians.length);
  const ask = pending.find(live);
  if (!ask) return { askable: guardians.length, reachable, total, needed, ask: null };
  const { data, error } = await supabase.from("recovery_approvals").select("guardian_id, approved_at").eq("request_id", ask.id);
  if (error) throw error;
  const rows = (data ?? []) as { guardian_id: string; approved_at: string | null }[];
  const approved = rows.filter((r) => r.approved_at && guardians.some((g) => g.id === r.guardian_id)).length;
  const wallets = guardians
    .filter((g) => g.guardian_type === "wallet" && rows.some((r) => r.guardian_id === g.id))
    .map((g) => ({ guardian: maskWallet(g.value), link: `${guardianOrigin()}/guardian?factor=${ask.id}&g=${g.id}` }));
  return { askable: guardians.length, reachable, total, needed, ask: { factor: ask.factor, approved, needed, expiresAt: ask.expires_at, wallets } };
}

type AskRow = { id: string; user_id: string; status: string; expires_at: string; factor: Factor | null };
async function askRow(supabase: SupabaseClient, requestId: string): Promise<AskRow | null> {
  const { data, error } = await supabase.from("recovery_requests").select("id, user_id, status, expires_at, factor").eq("id", requestId).maybeSingle();
  checkAsk(error);
  return (data as AskRow | null)?.factor ? (data as AskRow) : null;
}
const isOpen = (r: AskRow) => r.status === "pending" && Date.parse(r.expires_at) > Date.now();

/** What the /guardian page shows a guardian. Null for a link that is no ask. */
export async function guardianAskInfo(supabase: SupabaseClient, requestId: string, guardianId: string) {
  const request = await askRow(supabase, requestId);
  if (!request) return null;
  const [{ data: approval, error }, { data: guardian, error: gErr }, handle] = await Promise.all([
    supabase.from("recovery_approvals").select("approved_at").eq("request_id", requestId).eq("guardian_id", guardianId).maybeSingle(),
    supabase.from("recovery_guardians").select("guardian_type, value").eq("id", guardianId).eq("user_id", request.user_id).maybeSingle(),
    ownerHandle(supabase, request.user_id),
  ]);
  if (error) throw error;
  if (gErr) throw gErr;
  if (!approval || !guardian?.value) return null;
  return {
    requesterHandle: handle,
    factor: GUARDIAN_KIND[request.factor as Factor],
    guardianType: guardian.guardian_type as string,
    maskedValue: guardian.guardian_type === "wallet" ? maskWallet(String(guardian.value)) : maskEmail(String(guardian.value)),
    alreadyApproved: !!approval.approved_at,
    open: isOpen(request),
  };
}

export function walletSigned(address: string, message: string, signature: string): boolean {
  try {
    return ed25519.verify(Buffer.from(signature, "base64"), new TextEncoder().encode(message), new PublicKey(address).toBytes());
  } catch {
    return false;
  }
}

export type GuardianYes = { result: "counted"; approved: number; needed: number; removed: boolean } | { result: "inactive" | "not_found" | "unsigned" };

/**
 * A guardian says yes: by the token in their mail, or a wallet's signature over this request. The yes that reaches the number
 * removes the factor at once, with the owner's unused recovery codes, and every address of the owner hears. A no, or silence,
 * changes nothing; a request ends after 7 days or when the owner takes it back.
 */
export async function approveGuardianAsk(supabase: SupabaseClient, requestId: string, guardianId: string, proof: { token?: string; signature?: string }): Promise<GuardianYes> {
  const request = await askRow(supabase, requestId);
  if (!request || !isOpen(request)) return { result: "inactive" };
  const [{ data: approval, error }, { data: guardian, error: gErr }] = await Promise.all([
    supabase.from("recovery_approvals").select("code_hash, approved_at").eq("request_id", requestId).eq("guardian_id", guardianId).maybeSingle(),
    supabase.from("recovery_guardians").select("guardian_type, value, status").eq("id", guardianId).eq("user_id", request.user_id).maybeSingle(),
  ]);
  if (error) throw error;
  if (gErr) throw gErr;
  if (!approval || guardian?.status !== "confirmed" || !guardian.value) return { result: "not_found" };
  if (guardian.guardian_type === "wallet") {
    if (!proof.signature || !walletSigned(String(guardian.value), guardianFactorMessage(requestId), proof.signature)) return { result: "unsigned" };
  } else if (guardian.guardian_type !== "email" || !proof.token || !sameHash(sha256(proof.token), String(approval.code_hash))) {
    return { result: "not_found" };
  }
  await stampReachable(supabase, guardianId);
  if (!approval.approved_at) {
    const { error: e } = await supabase.from("recovery_approvals").update({ approved_at: new Date().toISOString() }).eq("request_id", requestId).eq("guardian_id", guardianId).is("approved_at", null);
    if (e) throw e;
  }
  return settleAsk(supabase, request);
}

/** Counts the yes of guardians still confirmed; at the number, the one request that claims it removes the factor. */
async function settleAsk(supabase: SupabaseClient, request: AskRow): Promise<GuardianYes> {
  const { user_id: userId } = request;
  const factor = request.factor as Factor;
  const [{ data: yes, error }, guardians] = await Promise.all([
    supabase.from("recovery_approvals").select("guardian_id").eq("request_id", request.id).not("approved_at", "is", null),
    askableGuardians(supabase, userId),
  ]);
  if (error) throw error;
  const approved = (yes ?? []).filter((y) => guardians.some((g) => g.id === y.guardian_id)).length;
  const needed = await yesNeeded(supabase, userId, guardians.length);
  if (approved < needed) return { result: "counted", approved, needed, removed: false };
  // Read before the claim: a failed read removes nothing, and the email factor's own address hears too.
  const [enrolled, every] = await Promise.all([enrolledFactors(supabase, userId), everyAddress(supabase, userId)]);
  const gone = !enrolled.includes(factor);
  const { data: claimed, error: claimErr } = await supabase.from("recovery_requests").update({ status: gone ? "cancelled" : "completed" }).eq("id", request.id).eq("status", "pending").select("id").maybeSingle();
  checkAsk(claimErr);
  if (!claimed || gone) return { result: "counted", approved, needed, removed: false };
  try {
    // The paper first, as on the mail path.
    check((await supabase.from("mfa_recovery_codes").delete().eq("user_id", userId).is("used_at", null)).error);
    await removeFactor(supabase, userId, factor);
  } catch (e) {
    const { error: back } = await supabase.from("recovery_requests").update({ status: "pending" }).eq("id", request.id);
    if (back) console.error("[mfa-recovery] guardian ask not restored:", back.message);
    throw e;
  }
  await mailEach(
    every,
    "A factor was removed from your Enki account",
    `Your guardians removed ${FACTOR_NAME[factor]} from your Enki account (${new Date().toUTCString()}): ${approved} of them said yes. ` +
      `The recovery codes you had left stopped working too: ${enrolled.some((f) => f !== factor) ? "New codes in Settings, Recovery, makes a new set." : "the next factor you add comes with a new set."} ` +
      `If that was you, there is nothing else to do.\n\nIf it was not, someone talked your guardians round and is using your session: ${RESET_ADVICE}`,
  );
  return { result: "counted", approved, needed, removed: true };
}

/**
 * The factor-added mail's last sentence: only the ways this account has to remove a factor it did not add. A recovery code
 * counts only when the owner can hold one: unused codes from before a further factor that came with no new set (a set issued
 * with the factor is shown to whoever added it, and a first factor's set replaces every older code). Guardians count from two
 * who can be asked, the mail path from two addresses besides the factor's own. Null before SQL 74 ran or when a read fails:
 * the mail then names no way at all.
 */
export async function removalWays(supabase: SupabaseClient, userId: string, factor: Factor, before: Factor[], issued: boolean): Promise<string | null> {
  try {
    const [left, row, { to }, guardians] = await Promise.all([
      codesLeft(supabase, userId),
      supabase.from("mfa_recovery").select("user_id").eq("user_id", userId).maybeSingle(),
      mailPathAddresses(supabase, userId, factor),
      askableGuardians(supabase, userId),
    ]);
    check(row.error);
    const ways = [
      ...(before.length && !issued && left ? ["a recovery code you saved before it"] : []),
      ...(guardians.length >= 2 ? ["your guardians' yes"] : []),
      ...(to.length >= 2 ? ["a code to each of your email addresses"] : []),
    ];
    if (!ways.length) {
      return `This account has no way to remove it now: no recovery code from before this factor, fewer than two guardians who can be asked, and fewer than two email addresses${factor === "email" ? " besides the new code's" : ""}.`;
    }
    return `Then remove it in Settings, Recovery, Lost a factor, with ${ways.length > 1 ? `${ways.slice(0, -1).join(", ")} or ${ways.at(-1)}` : ways[0]}.`;
  } catch (e) {
    if (!(e instanceof RecoveryNotReady)) console.error("[mfa-recovery] no removal ways:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Settings' words where the mail path is not offered (fewer than two addresses): the other ways this account has, or that a lost
 * factor cannot be removed now, and the second address it can add: Code by email (byEmail), unless the account signs in with a
 * password (it cannot add one, lib/mfa.ts isPasswordAccount) or has one already (one per account), and X gives none; then a
 * Google account (DEC-2026-11-07-30). Adding either takes every factor, as New codes does (requireAddFactor). An X account with
 * no address hears why one matters (X_NEEDS_EMAIL).
 */
function mailRefusal(addresses: number, codesLeft: number, byEmail: boolean, guardians: boolean, xWithoutEmail = false): string {
  const has = `${TWO_ADDRESSES}, and this account has ${addresses ? "one" : "none"}.`;
  const step = `A second address: ${byEmail ? "Code by email at another address, added in Settings" : "a Google account with another email address, connected in Settings, Profile, Connected accounts"}. That takes every factor`;
  const x = xWithoutEmail ? ` ${X_NEEDS_EMAIL}` : "";
  return `${has} ${otherWays(codesLeft > 0, guardians)} ${step}${codesLeft ? "" : ", as New codes does"}.${x}`;
}

/**
 * What Settings shows. Before SQL 74 ran: available false, and the area stays hidden. addresses counts every address of the
 * account (everyAddress), for the ways back in that Settings counts.
 */
export async function recoveryStatus(supabase: SupabaseClient, userId: string): Promise<{ available: boolean; codesLeft: number; addresses: number; mailRefused: string | null; guardians: GuardianAskStatus | null }> {
  try {
    const [left, row, addresses, guardians] = await Promise.all([
      codesLeft(supabase, userId),
      supabase.from("mfa_recovery").select("user_id").eq("user_id", userId).maybeSingle(),
      everyAddress(supabase, userId),
      guardianAskStatus(supabase, userId),
    ]);
    check(row.error); // before SQL 74 ran: not available
    // mailRefused: what Settings shows where No code left would start the mail path.
    const byEmail = addresses.length < 2 && !(await isPasswordAccount(supabase, userId)) && !(await confirmedEmailFactor(supabase, userId));
    // A password account always has its login email, so only an account with none at all is read for an X login.
    const mailRefused = addresses.length < 2
      ? mailRefusal(addresses.length, left, byEmail, guardians.askable >= 2, !addresses.length && (await hasXLogin(supabase, userId)))
      : null;
    return { available: true, codesLeft: left, addresses: addresses.length, mailRefused, guardians };
  } catch (e) {
    if (e instanceof RecoveryNotReady) return { available: false, codesLeft: 0, addresses: 0, mailRefused: null, guardians: null };
    throw e;
  }
}

export function recoveryFailure(e: unknown, what: string): NextResponse {
  if (e instanceof RecoveryNotReady) return NextResponse.json({ error: NOT_READY }, { status: 503 });
  if (isDbUnreachable(e)) return dbUnavailableResponse();
  console.error(`[mfa-recovery] ${what} failed:`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: "That did not work. Try again." }, { status: 500 });
}

/** A route behind a signed-in session, banned or not, with the answers every one of them shares. */
export function recoveryRoute(what: string, run: (req: NextRequest, supabase: SupabaseClient, userId: string) => Promise<NextResponse>) {
  return async (req: NextRequest): Promise<NextResponse> => {
    try {
      const supabase = getSupabaseServerClient();
      const { userId } = await resolveSessionUserWithBan(supabase, req.headers.get("X-Session-Token"));
      if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
      return await run(req, supabase, userId);
    } catch (e) {
      return recoveryFailure(e, what);
    }
  };
}
