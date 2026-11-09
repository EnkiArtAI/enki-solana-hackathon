/**
 * Where the decision in the database meets the chain.
 *
 * lib/payments/authorization.ts decides WHETHER we may charge — a single
 * conditional UPDATE picks one winner between capture and void. This file
 * carries that decision out. The split matters: the claim is atomic and the
 * chain is not, so everything that can fail slowly happens after the winner is
 * already settled.
 *
 * ── Which way a crash should fail ───────────────────────────────────────
 * Capture claims first, broadcasts second. If we die in between, we hold a
 * captured intent with no signature on chain — recoverable, because a
 * durable-nonce transaction does not expire and nobody else can advance that
 * nonce. Void writes the row first, closes the account second: a closed
 * account with an open row would be swept forever, whereas a voided row with a
 * live nonce is caught by the next sweep. Both orders leak something; these
 * are the orders that leak a retry rather than a charge.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { NONCE_ACCOUNT_LENGTH, PublicKey, Transaction, VersionedTransaction, type Connection } from "@solana/web3.js";
import {
  bookCaptured,
  bookingState,
  bookPaidUndelivered,
  CAPTURE_UNSETTLED_AFTER_MS,
  claimCapture,
  failCapture,
  heldSignatureOf,
  unfulfil,
  voidAuthorization,
  sweepAbandoned,
  sweepRefundsOwed,
  sweepUnsubmitted,
  type VoidReason,
} from "@/lib/payments/authorization";
import { closeNonceAccount } from "@/lib/payments/nonce";
import { markNonceClosed } from "@/lib/payments/authorize-flow";
import { feePayerKeypair, solanaConnection, usdcMint } from "@/lib/payments/solana";
import { paymentConfirmed, submitAndConfirm, transferRefused, type SubmitOutcome } from "@/lib/payments/x402-settle";
import { recordLicenceCredits } from "@/lib/payments/licence-credits";
import { railPlanOf } from "@/lib/payments/authorize-flow";

export type CaptureOutcome =
  | { kind: "captured"; signature: string }
  | { kind: "rejected"; error: string }
  | { kind: "unknown"; signature: string }
  | { kind: "lost" };

/**
 * Charge for a finished image, BEFORE it is handed over (Kev, 2026-10-18:
 * "wir printen nichts OHNE bestätigter buchung").
 *
 *   captured  the chain confirmed the payment; the intent is booked.
 *   rejected  refused (preflight, the buyer's USDC gone) or failed on chain:
 *             void, nothing was charged, the image is withheld.
 *   unknown   no answer in time: the nonce is closed so the payment can no
 *             longer land, then looked up; only an unreadable history (or a
 *             close that misses deadlineAt) stays unknown, and so does a
 *             landed payment whose booking did not stick: the image is
 *             withheld and the sweep settles the row.
 *   lost      another worker or a void holds the row.
 *
 * deadlineAt bounds everything after the send: the nonce close retries for
 * minutes, and the route must answer before the platform kills it.
 *
 * At 0481edd9 this sent with skipPreflight, booked the intent before any
 * confirmation and closed the nonce in after() right behind the send.
 */
export async function captureHeld(
  supabase: SupabaseClient,
  intentId: string,
  { timeoutMs = 40_000, deadlineAt = Infinity }: { timeoutMs?: number; deadlineAt?: number } = {},
): Promise<CaptureOutcome> {
  const held = await claimCapture(supabase, intentId);
  if (!held) return { kind: "lost" };
  const connection = solanaConnection();
  // The send is bounded too: its broadcast can stall before the confirm wait starts. A send cut off by the deadline
  // is pending: the nonce is closed and the chain asked, like a timeout (verification 2026-10-18).
  const late: SubmitOutcome = { ok: false, pending: true, error: "The capture's deadline passed", signature: held.signature };
  const sent = await byDeadline(submitAndConfirm(connection, Transaction.from(Buffer.from(held.signedTx, "base64")), timeoutMs), deadlineAt, late);

  if (sent.ok && Date.now() > deadlineAt) {
    console.error("[payments/settle] payment confirmed after the capture's deadline, image withheld; the sweep settles it:", intentId);
    return { kind: "unknown", signature: held.signature };
  }
  if (sent.ok) return captured(supabase, held);
  // Whose failure it would be, asked of the chain before the close changes the nonce (round 4, 2026-10-19).
  const blame = await byDeadline(failedBy(connection, held), deadlineAt, "provider_failed" as const);
  // Not confirmed. The nonce is closed so the payment can no longer land, then the chain is asked whether it already
  // did: a refusal can be the buyer's own earlier broadcast of the held payment (the nonce had moved on), and that
  // payment is real (review 2026-10-18).
  const close = held.nonceAccount ? await byDeadline(closeNonce(supabase, intentId, held.nonceAccount), deadlineAt, "failed" as const) : "gone";
  const landed = close === "failed" ? null : await byDeadline(landedAfterClose(connection, held.signature, held.nonceAccount), deadlineAt, null);
  // Past the deadline nothing is booked: the route could not answer before the kill, and the sweep books a landed
  // payment refund-owed instead (verification 2026-10-18).
  if (landed === true && Date.now() > deadlineAt) {
    console.error("[payments/settle] payment landed after the capture's deadline, image withheld; the sweep settles it:", intentId);
    return { kind: "unknown", signature: held.signature };
  }
  if (landed === true) return captured(supabase, held, { nonceClosed: true });
  if (landed === false) {
    await failCapture(supabase, intentId, blame);
    return { kind: "rejected", error: sent.pending ? "The payment did not land" : sent.error };
  }
  console.error("[payments/settle] capture outcome unknown, image withheld; the sweep settles it:", intentId);
  return { kind: "unknown", signature: held.signature };
}

/**
 * Whose failure a capture that did not land was. Kev's pause ("5 geplatzte
 * abbuchungen") protects Enki's provider bills from a buyer whose USDC refuses
 * the capture: short, re-owned, frozen or closed, each of which the chain
 * refuses on the token transfer itself (a re-owned account keeps its balance,
 * verification 2026-10-18). So the payment is simulated as it stands: a
 * transfer the chain refuses is the buyer's; one it would take (a timeout, an
 * RPC that refused for its own reasons), one refused on Enki's fee payer or
 * the nonce, and a simulation that cannot run are Enki's (round 4, 2026-10-19:
 * every refused send counted as the buyer's unless Enki's fee payer was
 * provably short, so an RPC incident paused honest buyers).
 */
async function failedBy(connection: Connection, held: { signedTx: string; signature: string }): Promise<"capture_failed" | "provider_failed"> {
  try {
    const tx = VersionedTransaction.deserialize(Buffer.from(held.signedTx, "base64"));
    return (await transferRefused(connection, tx, held.signature)) ? "capture_failed" : "provider_failed";
  } catch {
    return "provider_failed";
  }
}

/**
 * Whether a payment landed, asked after its nonce account was closed: the
 * slot at which a node sees the account gone anchors the answer, since the
 * payment can only land before that. A node that still sees the account is
 * behind the close and may be behind the payment too: unknown (round 5,
 * 2026-10-20: an RPC pool or a failover could answer "not landed" from a
 * node that had not yet seen it, and a paid capture was then voided).
 */
async function landedAfterClose(connection: Connection, signature: string, account: string | null): Promise<boolean | null> {
  if (!account) return paymentConfirmed(connection, signature);
  let goneAtSlot: number | null = null;
  // A node that still sees the nonce is usually a slot or two behind: asked again, 400 ms apart, before "unknown" (round
  // 6, 2026-10-20). Only the nonce itself counts as still there: SOL anyone sent to the address after the close made a
  // plain account there, and the nonce is gone all the same.
  for (let tries = 0; tries < 3 && goneAtSlot === null; tries++) {
    if (tries) await new Promise((r) => setTimeout(r, 400));
    try {
      const { context, value } = await connection.getAccountInfoAndContext(new PublicKey(account), "confirmed");
      if (!value || value.data.length !== NONCE_ACCOUNT_LENGTH) goneAtSlot = context.slot;
    } catch {
      return null;
    }
  }
  return goneAtSlot === null ? null : paymentConfirmed(connection, signature, { goneAtSlot });
}

/** What a late close settles to once the deadline passes; the close itself carries on in the background. */
async function byDeadline<T>(work: Promise<T>, deadlineAt: number, late: T): Promise<T> {
  if (!Number.isFinite(deadlineAt)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((done) => { timer = setTimeout(() => done(late), Math.max(0, deadlineAt - Date.now())); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Book the landed capture, return the nonce rent, and owe the artist a
 * withheld share. Only a booking that stuck delivers: one that failed, or that
 * the sweep already made paid-undelivered with a refund owed, withholds the
 * image (unknown) and leaves the row to the sweep.
 */
async function captured(
  supabase: SupabaseClient,
  held: Awaited<ReturnType<typeof claimCapture>> & object,
  { nonceClosed = false }: { nonceClosed?: boolean } = {},
): Promise<CaptureOutcome> {
  if (!(await bookedOnce(supabase, held))) {
    console.error("[payments/settle] payment landed but could not be booked as delivered, image withheld, refund owed:", held.intentId);
    // The image is withheld, so the row must not say delivered, whatever a lost answer committed (round 5, 2026-10-20).
    after(async () => {
      for (let tries = 0; tries < 3; tries++) {
        if (tries) await new Promise((r) => setTimeout(r, 2_000));
        if (await unfulfil(supabase, held.intentId)) return;
      }
      console.error("[payments/settle] a withheld image's row may still say delivered, check it:", held.intentId);
    });
    return { kind: "unknown", signature: held.signature };
  }
  const account = held.nonceAccount;
  // The credit first: the close retries for minutes and may outlast the function, and nothing writes the credit later.
  after(async () => {
    await owedToArtist(supabase, held).catch((e) => console.error("[payments/settle] licence credit not written, owed:", held.intentId, e));
    if (account && !nonceClosed) await closeNonce(supabase, held.intentId, account);
  });
  return { kind: "captured", signature: held.signature };
}

/**
 * A landed payment ends in exactly one booking (verification 2026-10-18).
 * bookCaptured is retried once (its predicates make it idempotent); a lost
 * acknowledgement shows as fulfilled_at. If it still did not stick, the
 * payment is booked paid-undelivered with a refund owed right here, unless the
 * first write committed meanwhile, which then delivers after all. A row left
 * open is the unknown-capture sweep's, and a refund row lost on the way is
 * sweepRefundsOwed's (round 4, 2026-10-19). true = booked as delivered.
 */
async function bookedOnce(supabase: SupabaseClient, held: { intentId: string; signature: string }): Promise<boolean> {
  if (await bookCaptured(supabase, held.intentId)) return true;
  if (await bookCaptured(supabase, held.intentId)) return true;
  if ((await bookingState(supabase, held.intentId)) === "delivered") return true;
  if (await bookPaidUndelivered(supabase, held.intentId, held.signature, "the capture landed but its booking failed")) return false;
  return (await bookingState(supabase, held.intentId)) === "delivered";
}

/** Close a unit's nonce account and record it when the account is gone. */
async function closeNonce(supabase: SupabaseClient, intentId: string, account: string): Promise<"closed" | "gone" | "failed" | "unrecorded"> {
  const outcome = await closeNonceAccount(solanaConnection(), account, feePayerKeypair()).catch(() => "failed" as const);
  if (outcome === "failed") {
    console.error("[payments/settle] nonce left open:", account);
    return outcome;
  }
  if (await markNonceClosed(supabase, intentId)) return outcome;
  // The account is gone either way; only its record is missing, which the sweep writes next round (round 6, 2026-10-20).
  console.error("[payments/settle] nonce closed but not recorded; the sweep records it:", account);
  return "unrecorded";
}

/**
 * A plan that withheld the artist's share paid it into Enki's leg: once the
 * payment landed, Enki owes it as a licence credit, to the artist's account
 * and the wallet the share was priced to (the x402 merchant rule, DEC-71).
 */
async function owedToArtist(supabase: SupabaseClient, held: Awaited<ReturnType<typeof claimCapture>> & object): Promise<void> {
  if (!railPlanOf(held.plan).artistWithheld || held.artistAmountMicro <= 0) return;
  const { data } = held.promptId
    ? await supabase.from("prompts").select("creator_id").eq("id", held.promptId).maybeSingle()
    : { data: null };
  await recordLicenceCredits(supabase, {
    source: `intent:${held.intentId}`,
    mint: usdcMint().toBase58(),
    promptId: held.promptId,
    credits: [{ role: "artist", owner: held.artistWallet, userId: (data?.creator_id as string | undefined) ?? null, micro: held.artistAmountMicro }],
  });
}

/**
 * Give up on a payment: nothing was charged and now nothing can be.
 *
 * Closing the nonce account is what makes that permanent — the runtime
 * requires an initialised nonce account, and there no longer is one. It also
 * returns the rent, which is why this is cheaper than leaving the account
 * behind with an advanced nonce.
 */
export async function voidAndFlush(
  supabase: SupabaseClient,
  intentId: string,
  reason: VoidReason,
  { unclaimed = false }: { unclaimed?: boolean } = {},
): Promise<boolean> {
  const won = await voidAuthorization(supabase, intentId, reason, { unclaimed });
  if (!won) return false;
  if (won.nonceAccount) await settleVoided(supabase, intentId, won.nonceAccount);
  return true;
}

/**
 * After a void: close the nonce, then settle the held payment. The buyer
 * holds it fully signed and can broadcast it themselves before the close; then
 * they paid without an image, and the intent is booked with a refund owed.
 * The nonce is recorded closed only once that is settled: until then the row
 * stays in closeFinalNonces, whose next close finds the account gone and asks
 * again (round 4, 2026-10-19: recorded first, an unreadable lookup or a failed
 * booking was never looked at again). true = settled and recorded.
 */
export async function settleVoided(supabase: SupabaseClient, intentId: string, nonceAccount: string): Promise<boolean> {
  const close = await closeNonceAccount(solanaConnection(), nonceAccount, feePayerKeypair()).catch(() => "failed" as const);
  if (close === "failed") {
    console.error("[payments/settle] nonce left open:", nonceAccount);
    return false;
  }
  // "Gone" from a node that has not yet seen an account created a moment ago would record it closed for good, its rent
  // stranded: a row touched in the last 2 minutes is left for a later round (DEC-124's case; round 5, 2026-10-20).
  if (close === "gone" && (await touchedLately(supabase, intentId))) return false;
  if (!(await voidSettled(supabase, intentId, nonceAccount))) return false;
  return markNonceClosed(supabase, intentId);
}

/** How long after its last write a row's "gone" account is not believed. */
const FRESH_MS = 120_000;

/** Whether the row was written within FRESH_MS; an unreadable row counts as fresh. */
async function touchedLately(supabase: SupabaseClient, intentId: string): Promise<boolean> {
  const { data, error } = await supabase.from("generation_payment_intents").select("updated_at").eq("id", intentId).maybeSingle();
  if (error || !data?.updated_at) return true;
  return Date.now() - new Date(String(data.updated_at)).getTime() < FRESH_MS;
}

/** Whether a voided unit's payment is settled: never handed out, did not land, or landed and is booked. */
async function voidSettled(supabase: SupabaseClient, intentId: string, nonceAccount: string): Promise<boolean> {
  let signature: string | null;
  try { signature = await heldSignatureOf(supabase, intentId); } catch { return false; }
  if (!signature) return true;
  const landed = await landedAfterClose(solanaConnection(), signature, nonceAccount);
  if (landed === null) console.error("[payments/settle] could not tell whether a voided payment landed; the sweep asks again:", intentId);
  if (landed !== true) return landed === false;
  return bookPaidUndelivered(supabase, intentId, signature, "the buyer broadcast the held payment");
}

/**
 * A capture whose lease is older than captureHeld can take and has no
 * outcome: close its nonce so it can no longer land, then settle it from the
 * chain. Landed means paid while the image was withheld: booked, refund owed.
 */
async function settleUnknownCaptures(supabase: SupabaseClient, limit: number): Promise<number> {
  const cutoff = new Date(Date.now() - CAPTURE_UNSETTLED_AFTER_MS).toISOString();
  const { data } = await supabase
    .from("generation_payment_intents")
    .select("id, nonce_account, nonce_closed_at, tx_signature")
    .not("capture_started_at", "is", null)
    .lt("capture_started_at", cutoff)
    .is("captured_at", null)
    .is("voided_at", null)
    .limit(limit);
  let settled = 0;
  for (const row of (data ?? []) as { id: string; nonce_account: string | null; nonce_closed_at: string | null; tx_signature: string | null }[]) {
    if (row.nonce_account && !row.nonce_closed_at && (await closeNonce(supabase, row.id, row.nonce_account)) === "failed") continue;
    if (!row.tx_signature) continue;
    const landed = await landedAfterClose(solanaConnection(), row.tx_signature, row.nonce_account);
    if (landed === true) {
      // A booking that did not stick is asked again next round; one whose answer was lost left this list, and its
      // refund row is sweepRefundsOwed's (round 4, 2026-10-19).
      if (!(await bookPaidUndelivered(supabase, row.id, row.tx_signature, "the capture's outcome was unknown, so the image was withheld"))) continue;
    }
    // Only Enki's side leaves a capture without an outcome (a close that failed, a history it could not read, the
    // deadline, a booking that failed); a buyer's refusal ends at the route. Never counted (verification 2026-10-18).
    else if (landed === false) await failCapture(supabase, row.id, "provider_failed");
    else continue;
    settled++;
  }
  return settled;
}

/**
 * Every intent that ended (captured or voided) with its nonce account still
 * open: return the rent. A voided one is settled like any void, since its
 * payment may have landed before the close (review 2026-10-18).
 */
async function closeFinalNonces(supabase: SupabaseClient, limit: number): Promise<number> {
  const { data } = await supabase
    .from("generation_payment_intents")
    .select("id, nonce_account, voided_at")
    .not("nonce_account", "is", null)
    .is("nonce_closed_at", null)
    .or("captured_at.not.is.null,voided_at.not.is.null")
    .limit(limit);
  let closed = 0;
  for (const row of (data ?? []) as { id: string; nonce_account: string; voided_at: string | null }[]) {
    // Only a close it recorded counts: the cron repeats until a round settles nothing, and a void left for later
    // counted as closed kept it looping on that row (round 4 fix, 2026-10-19).
    const done = row.voided_at ? await settleVoided(supabase, row.id, row.nonce_account) : ["closed", "gone"].includes(await closeNonce(supabase, row.id, row.nonce_account));
    if (done) closed++;
  }
  return closed;
}

/**
 * Flush authorisations whose worker went quiet.
 *
 * Runs every five minutes from /api/cron/sweep-payments, round after round
 * until one settles nothing. Never allowed to throw: a failing sweep must not
 * stop the cron's other work.
 */
export async function sweepAndFlush(supabase: SupabaseClient, limit = 5): Promise<number> {
  try {
    // Signed and gone quiet, plus prepared and never signed: both hold a nonce.
    const flushed = [...(await sweepAbandoned(supabase, limit)), ...(await sweepUnsubmitted(supabase, limit))];
    for (const { intentId, nonceAccount } of flushed) {
      if (nonceAccount) await settleVoided(supabase, intentId, nonceAccount);
    }
    const settled = await settleUnknownCaptures(supabase, limit);
    const closed = await closeFinalNonces(supabase, limit);
    const refunds = await sweepRefundsOwed(supabase);
    const total = flushed.length + settled + closed + refunds;
    if (total > 0) console.warn(`[payments/settle] swept ${flushed.length} abandoned, settled ${settled} unknown capture(s), closed ${closed} nonce(s), wrote ${refunds} refund row(s)`);
    return total;
  } catch (e) {
    console.warn("[payments/settle] sweep failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}
