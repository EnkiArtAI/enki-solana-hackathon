import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail } from "@/lib/mailer";

/**
 * The daily spend breaker (key-theft measures, Kev 2026-11-04): what Enki may commit to metered providers in one UTC day,
 * reserved atomically in SQL 72 before a render or a judge runs on Enki's money. Unlike the free render caps it fails
 * closed: no database, no function, any error or an unreadable reply refuses, so a run before SQL 72 refuses too.
 */
const DEFAULT_USD_PER_DAY = 100;

/**
 * One judge call, the code's own bound: lib/video/charge.ts says "under $0.002" for 6 calls, prompt-check.ts $0.10/$0.50
 * per 1M tokens. REPORTED, no bill was read.
 */
export const JUDGE_CALL_MICRO = 300;

/** 0 closes on purpose; anything unreadable is the default, never "no limit". */
function capMicro(): number {
  const set = process.env.METERED_SPEND_USD_PER_DAY?.trim();
  const n = set ? Number(set) : NaN;
  return Math.round((Number.isFinite(n) && n >= 0 ? n : DEFAULT_USD_PER_DAY) * 1_000_000);
}

/** retry: the same unit can try again, because the cap was not read as reached. */
export type SpendRefusal = { ok: false; status: 503; why: string; error: string; retry: boolean };
export type SpendHeld = { ok: true; day: string; micro: number };

const refusal = (why: string, next: string, retry: boolean): SpendRefusal => ({ ok: false, status: 503, why, error: `${why} Nothing was generated and nothing was charged.${next}`, retry });
const REACHED = refusal("Enki has reached its daily limit for new generations.", " Try again after 00:00 UTC.", false);
const UNREAD = refusal("Enki could not check its daily limit right now.", "", true);

let warnedMissing = false;

/** Never throws. What it answers ok is reserved until the day ends or releaseSpend gives it back. */
export async function reserveSpend(db: SupabaseClient | null, micro: number): Promise<SpendHeld | SpendRefusal> {
  if (!db) return UNREAD;
  try {
    const { data, error } = await db.rpc("reserve_metered_spend", { p_micro: micro, p_cap_micro: capMicro() });
    if (error) {
      const missing = error.code === "PGRST202" || error.code === "42883";
      if (!missing || !warnedMissing) console.error(missing ? "[spend-cap] SQL 72 has not run: every metered render is refused" : "[spend-cap] reservation failed");
      warnedMissing ||= missing;
      return UNREAD;
    }
    const row = Array.isArray(data) && data.length === 1 ? data[0] : null;
    if (row?.allowed === true && typeof row.spend_day === "string") return { ok: true, day: row.spend_day, micro };
    if (row?.allowed === false) {
      if (row.first_refusal === true) after(tellSpendCapReached(db, row.spend_day));
      return REACHED;
    }
    return UNREAD;
  } catch {
    return UNREAD;
  }
}

/** For a call that was never billed. Never throws: what cannot be given back stays reserved, the safe side. */
export async function releaseSpend(db: SupabaseClient, held: SpendHeld): Promise<void> {
  try {
    const { error } = await db.rpc("release_metered_spend", { p_day: held.day, p_micro: held.micro });
    if (error) console.warn("[spend-cap] not given back");
  } catch {
    console.warn("[spend-cap] not given back");
  }
}

/**
 * Asked before a buyer signs anything: would this bill fit now? A reservation given straight back, so the refusals, the
 * fail-closed and the day's mail are the reservation's own. Holds no place: the render still reserves, and may still be refused.
 */
export async function spendFits(db: SupabaseClient | null, micro: number): Promise<SpendHeld | SpendRefusal> {
  const held = await reserveSpend(db, micro);
  if (held.ok && db) await releaseSpend(db, held);
  return held;
}

/**
 * One mail a day, on the day's first refusal (SQL 72), to the outage mails' recipients. sendMail answers rather than throws, so
 * one that no recipient got clears the mark, and a later refusal tries again: a day that refuses renders must not pass unsaid.
 */
async function tellSpendCapReached(db: SupabaseClient, day: string): Promise<void> {
  console.error("[spend-cap] the daily spend limit was reached");
  const to = (process.env.OPS_ALERT_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const sent = await Promise.all(to.map((address) => sendMail({
    to: address,
    subject: "Enki: the daily spend limit was reached",
    text: `A paid generation that would pass the limit of $${capMicro() / 1_000_000} a UTC day on metered provider calls was refused at ${new Date().toISOString()}. Until 00:00 UTC whatever no longer fits is refused, and nobody is charged for a refused one; smaller ones can still pass until the day is full, with no further mail. METERED_SPEND_USD_PER_DAY sets the number (a redeploy applies it). public.metered_spend_days holds each day's amount. If this was not real demand, check the provider dashboards for a stolen key.`,
  })));
  if (sent.some((r) => r.ok)) return;
  console.error("[spend-cap] the mail was not sent");
  if (to.length) await db.rpc("clear_first_refusal_metered_spend", { p_day: day });
}
