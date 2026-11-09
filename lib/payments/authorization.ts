/**
 * The life of one generation authorisation.
 *
 * Kev, 2026-08-06: "once the image goes through, we will receive the money.
 * otherwise it will be sent back." Taken literally that rules out a refund
 * worker, because a refund presupposes a charge that should not have happened.
 * So nothing is charged until the image exists.
 *
 * The buyer signs a Solana transfer built on a durable nonce and we hold it
 * unbroadcast. That signature is an authorisation, not a payment, and it ends
 * exactly one of two ways:
 *
 *   capture  we broadcast it        the image was delivered
 *   void     we advance the nonce   nothing was, or ever will be, charged
 *
 * Both are claimed with a conditional UPDATE that demands the other be unset,
 * so a race has a loser rather than two winners. Broadcasting AND flushing the
 * same nonce is the one outcome this file exists to make impossible.
 *
 * ── The abort condition ─────────────────────────────────────────────────
 * The authorisation dies at the first terminal state that is not delivery,
 * and otherwise at a DEADLINE measured from the moment work started.
 *
 * This used to be a heartbeat: the running job renewed its claim every 15s and
 * three missed beats meant abandoned. The argument for it was that a deadline
 * would kill slow-but-legitimate generations. On this platform that argument
 * does not hold — the generate route's own budget ladder makes the upper bound
 * a fact rather than a guess:
 *
 *     285s  the route's in-process timeout
 *     300s  maxDuration — Vercel kills the function here
 *     330s  SLOT_TTL_MS
 *     360s  everything above has expired; the worker is provably gone
 *
 * A generation CANNOT run past 300s, so nothing legitimate is ever cut short
 * by waiting 360. The heartbeat was solving a problem the platform already
 * solves, and it cost more than it bought: it needed a beat, a timer, a
 * lost() signal nobody branched on, and it made the sweep's SELECT and its
 * write disagree about a moving value — a race that voided live authorisations
 * and shipped their images free.
 *
 * consumed_at is the anchor instead, set once by claimForGeneration when the
 * work actually starts. It never moves, so selection and execution cannot
 * disagree.
 *
 * IF ENKI EVER LEAVES VERCEL this reasoning goes with it (Kev, 2026-08-19).
 * Without a platform-enforced maxDuration there is no upper bound to derive a
 * deadline from, and the heartbeat has to come back — it is in the history of
 * this file, not lost.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { encryptString, decryptString } from "@/lib/crypto";
import { accountOf } from "@/lib/payments/authorize-flow";

const TABLE = "generation_payment_intents";

/**
 * Past this, the worker that claimed an authorisation is provably gone: the
 * route's function budget (maxDuration 300s) and the concurrency slot TTL
 * (330s) have both expired.
 *
 * Lower than this and the sweep races a generation that is still running,
 * which either lets one payment buy two images or hands the first one over
 * unpaid.
 */
export const ABANDONED_AFTER_MS = 360_000;

/**
 * A video is the one case the ladder above does not bound: it runs at a provider, for minutes, and the cron that follows it is
 * no function that can be killed with its claim. So a video unit carries hold_until (SQL 70) and the sweep leaves it alone till
 * then. Every other row has it NULL and is swept as ever; before SQL 70 the column is missing (42703) and the sweep reads as it
 * always did, so a deploy before that file does not switch it off.
 */
const NOT_HELD = (at: string) => `hold_until.is.null,hold_until.lt.${at}`;

/**
 * An intent prepared at /authorize and never signed holds a nonce account's
 * rent. A wallet popup waits 60 s at most, but the render queue signs one
 * order at a time, so a queued order's window can open minutes after its
 * /authorize: 300 s covers five full windows ahead of it (review 2026-10-18;
 * 120 s before). A buyer who declines is cancelled by the client at once.
 */
export const UNSIGNED_AFTER_MS = 300_000;

/**
 * A capture lease older than this ended without an outcome. Like
 * ABANDONED_AFTER_MS it outlives the route (maxDuration 300 s): a younger
 * lease may still belong to a live capture, and settling it would book a
 * refund for an image that route then delivers (review 2026-10-18).
 */
export const CAPTURE_UNSETTLED_AFTER_MS = 360_000;

export type VoidReason =
  | "provider_failed"
  | "rejected"
  | "cancelled"
  | "abandoned"
  | "expired"
  /** The buyer no longer held the USDC when the render was about to start (2026-10-18). */
  | "unfunded"
  /** The capture did not land: refused, failed on chain, or made final unlanded (2026-10-18). */
  | "capture_failed";

export interface HeldAuthorization {
  intentId: string;
  /** The signed, unbroadcast transaction, base64. */
  signedTx: string;
  /** Its signature (the fee payer's, slot 0): known before the broadcast, stored with the lease. */
  signature: string;
  nonceAccount: string | null;
  totalMicro: number;
  /** What the capture owes once it lands: the stored plan, and the artist share it may withhold. */
  plan: unknown;
  /** The intent's owner (session owner string), whose USDC tells a buyer's failure from Enki's. */
  owner: string;
  artistWallet: string | null;
  artistAmountMicro: number;
  promptId: string | null;
}

/** Bind the ciphertext to its row: a signed tx copied into another intent will not open. */
const aadFor = (intentId: string) => `intent:${intentId}`;

const nowIso = () => new Date().toISOString();
const staleCutoff = () => new Date(Date.now() - ABANDONED_AFTER_MS).toISOString();

/**
 * Record the buyer's signature and start beating in one write.
 *
 * consumed_at stays NULL until claimForGeneration takes the work. An
 * authorisation that is signed and never claimed is swept on authorized_at
 * instead — a signature nobody is working on is exactly the thing that must
 * not sit armed indefinitely.
 *
 * false means the row was no longer a fresh quote of this buyer; a write the
 * database failed throws, because that is Enki's side (round 4, 2026-10-19).
 */
export async function storeAuthorization(
  supabase: SupabaseClient,
  {
    intentId,
    buyerWallet,
    signedTx,
    nonceAccount,
    nonceAuthority,
  }: {
    intentId: string;
    buyerWallet: string;
    signedTx: string;
    nonceAccount: string;
    nonceAuthority: string;
  },
): Promise<boolean> {
  const sealed = encryptString(signedTx, aadFor(intentId));
  const now = nowIso();

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      authorized_at: now,
      nonce_account: nonceAccount,
      nonce_authority: nonceAuthority,
      authorized_tx_ct: sealed.encrypted,
      authorized_tx_iv: sealed.iv,
      authorized_tx_tag: sealed.authTag,
      authorized_tx_kid: sealed.kid ?? "field-v1",
      status: "generating",
      updated_at: now,
    })
    .eq("id", intentId)
    .eq("buyer_wallet", buyerWallet)
    // Only a fresh quote may be authorised. Re-signing something already
    // captured or voided must not resurrect it.
    .is("authorized_at", null)
    .is("captured_at", null)
    .is("voided_at", null)
    .select("id")
    .maybeSingle();

  if (error) throw new Error(`[payments/auth] could not store the authorisation: ${error.message}`);
  return Boolean(data);
}

/**
 * Take the capture lease, and get the transaction to broadcast.
 *
 * The lease is capture_started_at plus the transaction's own signature, set in
 * one conditional write on a claimed, authorised row nobody has captured,
 * voided or leased. It books NOTHING: captured_at is written only once the
 * chain confirms the payment (bookCaptured), never before (2026-10-18; at
 * 0481edd9 the claim itself wrote captured_at and a capture that never landed
 * read as paid). null means another worker or a void got there first.
 */
export async function claimCapture(
  supabase: SupabaseClient,
  intentId: string,
): Promise<HeldAuthorization | null> {
  const { data: row, error } = await supabase
    .from(TABLE)
    .select("id, buyer_wallet, authorized_tx_ct, authorized_tx_iv, authorized_tx_tag, authorized_tx_kid, nonce_account, total_micro, fronted_atas, artist_wallet, artist_amount_micro, prompt_id")
    .eq("id", intentId)
    .maybeSingle();
  if (error) {
    console.error("[payments/auth] capture lookup failed:", error.message);
    return null;
  }
  if (!row?.authorized_tx_ct) return null;

  const signedTx = decryptString(
    { encrypted: row.authorized_tx_ct, iv: row.authorized_tx_iv, authTag: row.authorized_tx_tag, kid: row.authorized_tx_kid },
    aadFor(intentId),
  );
  const signature = bs58.encode(Transaction.from(Buffer.from(signedTx, "base64")).signature!);
  const now = nowIso();
  const { data: leased, error: leaseError } = await supabase
    .from(TABLE)
    .update({ capture_started_at: now, tx_signature: signature, updated_at: now })
    .eq("id", intentId)
    .not("authorized_at", "is", null)
    .not("consumed_at", "is", null)
    .is("capture_started_at", null)
    .is("captured_at", null)
    .is("voided_at", null)
    .select("id")
    .maybeSingle();
  if (leaseError) {
    console.error("[payments/auth] capture lease failed:", leaseError.message);
    return null;
  }
  if (!leased) return null;

  return {
    intentId,
    signedTx,
    signature,
    nonceAccount: row.nonce_account as string | null,
    totalMicro: Number(row.total_micro),
    plan: row.fronted_atas,
    owner: row.buyer_wallet as string,
    artistWallet: (row.artist_wallet as string | null) ?? null,
    artistAmountMicro: Number(row.artist_amount_micro ?? 0),
    promptId: (row.prompt_id as string | null) ?? null,
  };
}

/**
 * The signature of an intent's payment (the fee payer's, slot 0): from the
 * held transaction, or, for a unit the buyer never submitted, the one
 * /authorize recorded when it handed the payment out. null when neither exists;
 * throws when the row cannot be read, which is not "never handed out" (round 4,
 * 2026-10-19).
 */
export async function heldSignatureOf(supabase: SupabaseClient, intentId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("tx_signature, authorized_tx_ct, authorized_tx_iv, authorized_tx_tag, authorized_tx_kid")
    .eq("id", intentId)
    .maybeSingle();
  if (error) throw new Error(`[payments/auth] the held payment cannot be read: ${error.message}`);
  if (!data?.authorized_tx_ct) return (data?.tx_signature as string | null | undefined) ?? null;
  const signedTx = decryptString(
    { encrypted: data.authorized_tx_ct, iv: data.authorized_tx_iv, authTag: data.authorized_tx_tag, kid: data.authorized_tx_kid },
    aadFor(intentId),
  );
  return bs58.encode(Transaction.from(Buffer.from(signedTx, "base64")).signature!);
}

/**
 * The held payment landed although no capture of ours booked it (the buyer
 * broadcast it, or a capture's outcome was unknown): the intent is paid, the
 * image was not delivered, and a refund is owed. One write clears a void
 * (single_outcome forbids captured AND voided); a failure row carries the
 * exact amount for the refund.
 */
export async function bookPaidUndelivered(supabase: SupabaseClient, intentId: string, signature: string, why: string): Promise<boolean> {
  const now = nowIso();
  const { data, error } = await supabase
    .from(TABLE)
    .update({ captured_at: now, voided_at: null, void_reason: null, status: "captured", tx_signature: signature, updated_at: now })
    .eq("id", intentId)
    .is("captured_at", null)
    .select("total_micro, buyer_wallet")
    .maybeSingle();
  // An error is not "already booked": the caller reads the row before it decides anything (verification 2026-10-18).
  if (error) {
    console.error("[payments/auth] booking a paid, undelivered intent failed:", intentId, error.message);
    return false;
  }
  if (!data) return false;
  console.error("[payments/auth] paid, image not delivered, refund owed:", intentId);
  // A row this write cannot add, sweepRefundsOwed adds.
  await recordRefundOwed(supabase, { intentId, owner: String(data.buyer_wallet), signature, totalMicro: Number(data.total_micro), why });
  return true;
}

/**
 * The refund row of a paid, undelivered intent. It carries the intent's own
 * id, so it exists once however often it is written (a lost answer, a retry,
 * the sweep): a second insert is refused as a duplicate key. A lookup before
 * the insert could not tell a lost answer from an absent row (round 4,
 * 2026-10-19). It names the buyer's account, which is how the admin People
 * list finds it. true = the row exists.
 */
export async function recordRefundOwed(
  supabase: SupabaseClient,
  { intentId, owner, signature, totalMicro, why }: { intentId: string; owner: string; signature: string; totalMicro: number; why: string },
): Promise<boolean> {
  const row = {
    id: intentId, surface: "generate-image", intent_id: intentId, tx_signature: signature,
    amount_paid_micro: totalMicro, error: `paid, image not delivered: ${why}. Refund owed.`,
  };
  // An account that cannot be read now is not "no account": written without it, the row stayed invisible for good.
  // Not written; the booking stands and the refund sweep tries again (round 5, 2026-10-20).
  let userId: string | null;
  try { userId = await accountOf(supabase, owner); }
  catch {
    console.error("[payments/auth] refund owed, the buyer's account could not be read; the sweep retries:", intentId);
    return false;
  }
  let { error } = await supabase.from("generation_failures").insert({ ...row, user_id: userId });
  // An account that is gone must not keep the refund from being recorded.
  if (error?.code === "23503" && userId) ({ error } = await supabase.from("generation_failures").insert({ ...row, user_id: null }));
  if (!error || error.code === "23505") return true;
  console.error("[payments/auth] refund owed, its row could not be written; the sweep retries:", intentId, error.message);
  return false;
}

/** How far back the refund sweep looks: a booking's refund row is due within minutes, never days. */
const REFUND_SWEEP_WINDOW_MS = 24 * 60 * 60_000;

/** Pages the refund sweep reads at most per run: far more owed rows than a day ever has. */
const REFUND_SWEEP_PAGES = 20;

/**
 * Every intent booked paid with its image withheld (captured, never
 * fulfilled) whose refund row is missing: the booking committed and the row
 * did not (a lost answer, a failed insert). Written here; the row's key makes
 * a second write harmless (round 4, 2026-10-19). Reads the whole window page
 * by page: rows already refunded stay in it for 24 hours, and one newest page
 * hid every older row behind them (round 5, 2026-10-20). Returns how many it
 * wrote.
 */
export async function sweepRefundsOwed(supabase: SupabaseClient, pageSize = 100): Promise<number> {
  const since = new Date(Date.now() - REFUND_SWEEP_WINDOW_MS).toISOString();
  let written = 0;
  for (let page = 0; page < REFUND_SWEEP_PAGES; page++) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("id, buyer_wallet, tx_signature, total_micro")
      .not("nonce_account", "is", null)
      .not("captured_at", "is", null)
      .is("fulfilled_at", null)
      .gte("captured_at", since)
      .order("id")
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error || !data?.length) return written;
    const { data: have, error: haveError } = await supabase.from("generation_failures").select("id").in("id", data.map((r) => r.id));
    if (haveError) return written;
    const recorded = new Set((have ?? []).map((r) => r.id as string));
    for (const r of data) {
      if (recorded.has(r.id as string)) continue;
      const ok = await recordRefundOwed(supabase, {
        intentId: r.id as string, owner: String(r.buyer_wallet), signature: String(r.tx_signature ?? ""),
        totalMicro: Number(r.total_micro), why: "the payment landed but the image was not delivered",
      });
      if (ok) written++;
    }
    if (data.length < pageSize) return written;
  }
  return written;
}

/** The chain confirmed the leased capture: the intent is paid and fulfilled. */
export async function bookCaptured(supabase: SupabaseClient, intentId: string): Promise<boolean> {
  const now = nowIso();
  const { data, error } = await supabase
    .from(TABLE)
    .update({ captured_at: now, fulfilled_at: now, status: "captured", updated_at: now })
    .eq("id", intentId)
    .not("capture_started_at", "is", null)
    .is("captured_at", null)
    .is("voided_at", null)
    .select("id")
    .maybeSingle();
  if (error) console.error("[payments/auth] booking a capture failed:", error.message);
  return Boolean(data);
}

/**
 * A landed capture whose image was withheld must not read as delivered: a
 * booking that committed while its answer was lost, and could not be read
 * back, is turned into paid-undelivered, which sweepRefundsOwed then refunds
 * (round 5, 2026-10-20). Touches only a row that says delivered. true = the
 * write went through.
 */
export async function unfulfil(supabase: SupabaseClient, intentId: string): Promise<boolean> {
  const { error } = await supabase
    .from(TABLE)
    .update({ fulfilled_at: null, updated_at: nowIso() })
    .eq("id", intentId)
    .not("captured_at", "is", null)
    .not("fulfilled_at", "is", null);
  return !error;
}

/**
 * How a leased intent stands, read whole: delivered (captured and fulfilled),
 * owed (captured, never fulfilled: paid, image withheld, refund owed), open
 * (not captured), or null when the row cannot be read. bookCaptured answers
 * false on an error even when its write committed (a lost acknowledgement);
 * this tells the cases apart (verification 2026-10-18).
 */
export async function bookingState(supabase: SupabaseClient, intentId: string): Promise<"delivered" | "owed" | "open" | null> {
  const { data, error } = await supabase.from(TABLE).select("captured_at, fulfilled_at").eq("id", intentId).maybeSingle();
  if (error || !data) return null;
  return data.fulfilled_at ? "delivered" : data.captured_at ? "owed" : "open";
}

/**
 * The leased capture did not land, and never can: the intent is void and
 * nothing was charged. "capture_failed" counts toward the buyer's pause;
 * "provider_failed" is a failure on Enki's side (the network, the fee payer)
 * that must not (review 2026-10-18; "rejected" until round 4, 2026-10-19,
 * which /submit uses for the buyer's own refusals).
 */
export async function failCapture(
  supabase: SupabaseClient,
  intentId: string,
  reason: "capture_failed" | "provider_failed" = "capture_failed",
): Promise<boolean> {
  const now = nowIso();
  const { data, error } = await supabase
    .from(TABLE)
    .update({ voided_at: now, void_reason: reason as VoidReason, status: "voided", updated_at: now })
    .eq("id", intentId)
    .not("capture_started_at", "is", null)
    .is("captured_at", null)
    .is("voided_at", null)
    .select("id")
    .maybeSingle();
  if (error) console.error("[payments/auth] failing a capture failed:", error.message);
  return Boolean(data);
}

/**
 * Claim the right to flush the nonce, and get the nonce to flush.
 *
 * null means we lost — capture got there first, which can only happen if the
 * image was delivered. Nothing to undo.
 *
 * The DB write comes first and the on-chain advance second: a flushed nonce
 * with an unflushed row would let the sweeper try again forever, whereas a
 * flushed row with a live nonce is caught by the sweep. Both orders leak
 * something; only this one leaks a retry.
 */
export async function voidAuthorization(
  supabase: SupabaseClient,
  intentId: string,
  reason: VoidReason,
  { unclaimed = false }: { unclaimed?: boolean } = {},
): Promise<{ intentId: string; nonceAccount: string | null } | null> {
  const now = nowIso();
  let update = supabase
    .from(TABLE)
    .update({ voided_at: now, void_reason: reason, status: "voided", updated_at: now })
    .eq("id", intentId)
    .not("authorized_at", "is", null)
    .is("capture_started_at", null)
    .is("captured_at", null)
    .is("voided_at", null);
  // A buyer's cancel stops only what no render has claimed: one already running is paid for by Enki and finishes
  // (review 2026-10-18). The route's own failure void (unclaimed false) is the one that voids a claimed unit.
  if (unclaimed) update = update.is("consumed_at", null);
  const { data, error } = await update.select("id, nonce_account").maybeSingle();

  if (error) {
    console.error("[payments/auth] void failed:", error.message);
    return null;
  }
  if (!data) return null;
  return { intentId, nonceAccount: data.nonce_account };
}

/**
 * Void a row ONLY IF it is still stale at the moment of the write.
 *
 * The predicate is repeated here verbatim, OR branch included, so selection
 * and execution agree. A NULL consumed_at does not satisfy `lt`, which is why
 * the second branch cannot be dropped: an authorisation that was signed and
 * never claimed would otherwise be immortal.
 *
 * With consumed_at this is belt and braces rather than a fix — the timestamp
 * is written once by claimForGeneration and never moves, so the SELECT and the
 * UPDATE cannot disagree about it. Under the heartbeat they could, and did:
 * a beat landing between the two was ignored by the write, which voided live
 * authorisations and shipped their images unpaid.
 *
 * voidAuthorization stays deadline-blind on purpose: an explicit void
 * (provider failed, buyer cancelled) is a decision, not an observation, and
 * must not be second-guessed by a timestamp.
 */
async function voidIfStale(
  supabase: SupabaseClient,
  intentId: string,
  cutoff: string,
  reason: VoidReason,
  holds = true,
): Promise<{ intentId: string; nonceAccount: string | null } | null> {
  const now = nowIso();
  let write = supabase
    .from(TABLE)
    .update({ voided_at: now, void_reason: reason, status: "voided", updated_at: now })
    .eq("id", intentId)
    .not("authorized_at", "is", null)
    .is("capture_started_at", null)
    .is("captured_at", null)
    .is("voided_at", null)
    .or(`consumed_at.lt.${cutoff},and(consumed_at.is.null,authorized_at.lt.${cutoff})`);
  if (holds) write = write.or(NOT_HELD(now));
  const { data, error } = await write
    .select("id, nonce_account")
    .maybeSingle();

  if (error) {
    console.error("[payments/auth] stale void failed:", error.message);
    return null;
  }
  if (!data) return null;
  return { intentId, nonceAccount: data.nonce_account as string | null };
}

/**
 * Void every intent that was prepared at /authorize and never signed.
 *
 * /authorize creates a nonce account (about 0.00145 SOL of rent from the fee
 * payer) before the buyer sees the wallet popup. A buyer who cancels there
 * never reaches /submit, so authorized_at stays null and sweepAbandoned, which
 * only looks at signed rows, never saw it: the account stayed open and its
 * rent with it, once per cancelled checkout. Same cutoff as the signed sweep,
 * re-checked at the moment of the write so a /submit that lands in between
 * wins and is never voided.
 */
export async function sweepUnsubmitted(
  supabase: SupabaseClient,
  limit = 20,
): Promise<{ intentId: string; nonceAccount: string | null }[]> {
  const cutoff = new Date(Date.now() - UNSIGNED_AFTER_MS).toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, tx_signature, batch_intent_id")
    .eq("status", "building")
    .not("nonce_account", "is", null)
    .is("authorized_at", null)
    .is("captured_at", null)
    .is("voided_at", null)
    .lt("updated_at", cutoff)
    .limit(limit);
  if (error) {
    console.warn("[payments/auth] unsubmitted sweep failed:", error.message);
    return [];
  }

  // A hand-out records every unit's signature before it answers (transactionsFor), so an order with a unit still
  // unsigned was never handed out, its signed units neither: /authorize stopped part way (round 21, 2026-10-20).
  const batches = [...new Set((data ?? []).flatMap((r) => (r.batch_intent_id ? [r.batch_intent_id as string] : [])))];
  const { data: unsigned, error: unsignedError } = batches.length
    ? await supabase.from(TABLE).select("batch_intent_id").in("batch_intent_id", batches).is("tx_signature", null)
    : { data: [], error: null };
  if (unsignedError) {
    console.warn("[payments/auth] unsubmitted sweep failed:", unsignedError.message);
    return [];
  }
  const partly = new Set((unsigned ?? []).map((r) => r.batch_intent_id as string));

  const flushed: { intentId: string; nonceAccount: string | null }[] = [];
  for (const row of data ?? []) {
    const now = nowIso();
    // A unit whose payment was never handed out (no signature recorded: /authorize stopped before it answered) could
    // not be signed: Enki's, never the buyer's abandoned unit (round 20, 2026-10-20). The write repeats the read's
    // condition on the unit's own signature, so one recorded in between keeps "abandoned"; a sibling's cannot be
    // repeated there, and a hand-out in between reads as Enki's, the blame rule's side.
    const signed = Boolean(row.tx_signature);
    const handedOut = signed && !partly.has(row.batch_intent_id as string);
    let update = supabase
      .from(TABLE)
      .update({ voided_at: now, void_reason: (handedOut ? "abandoned" : "provider_failed") as VoidReason, status: "voided", updated_at: now })
      .eq("id", row.id as string)
      .eq("status", "building")
      .is("authorized_at", null)
      .is("voided_at", null)
      .lt("updated_at", cutoff);
    if (handedOut) update = update.not("tx_signature", "is", null);
    else if (!signed) update = update.is("tx_signature", null);
    const { data: won } = await update
      .select("id, nonce_account")
      .maybeSingle();
    if (won) flushed.push({ intentId: row.id as string, nonceAccount: won.nonce_account as string | null });
  }
  return flushed;
}

/**
 * Void every authorisation whose worker went quiet.
 *
 * Runs from the five-minute cron (/api/cron/sweep-payments), and each new
 * generation sweeps a handful first — the same pattern generation_slots
 * uses.
 *
 * Each row is voided through voidIfStale rather than in one bulk UPDATE, so
 * the staleness is re-checked at the moment of the write. Under the heartbeat
 * that recheck was the difference between correct and catastrophic; with
 * consumed_at it is cheap insurance, because the value cannot change between
 * the two statements.
 */
export async function sweepAbandoned(
  supabase: SupabaseClient,
  limit = 20,
): Promise<{ intentId: string; nonceAccount: string | null }[]> {
  const cutoff = staleCutoff();
  const read = (holds: boolean) => {
    const stale = supabase
      .from(TABLE)
      .select("id, consumed_at")
      .not("authorized_at", "is", null)
      // A capture lease is the unknown-capture sweep's: this one's write refuses it, so selecting it only filled the
      // limit and hid the dead claims behind it (round 4, 2026-10-19).
      .is("capture_started_at", null)
      .is("captured_at", null)
      .is("voided_at", null)
      // The null branch is the normal case, not defence in depth: consumed_at
      // is NULL for every authorisation that was signed and never claimed, and
      // those are swept on how long ago they were authorised.
      .or(`consumed_at.lt.${cutoff},and(consumed_at.is.null,authorized_at.lt.${cutoff})`);
    return (holds ? stale.or(NOT_HELD(nowIso())) : stale).limit(limit);
  };
  let { data, error } = await read(true);
  const holds = error?.code !== "42703";
  if (!holds) ({ data, error } = await read(false));

  if (error) {
    console.warn("[payments/auth] sweep failed:", error.message);
    return [];
  }

  const flushed: { intentId: string; nonceAccount: string | null }[] = [];
  for (const row of data ?? []) {
    // Re-checked at write time against the same cutoff the SELECT used. Signed and never rendered is the buyer's
    // (abandoned); a render that claimed the unit and went quiet died on Enki's side (round 4, 2026-10-19). A
    // claim's consumed_at never moves, so the reason read here holds at the write.
    const won = await voidIfStale(supabase, row.id as string, cutoff, row.consumed_at ? "provider_failed" : "abandoned", holds);
    if (won) flushed.push(won);
  }
  return flushed;
}
