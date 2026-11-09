/**
 * The web checkout on the intent (durable-nonce) rail, next to escrow (Kev,
 * 2026-10-18: "wir brauchen intents wieder"). The four payment routes call
 * these when lib/payments/rail.ts chose the intent rail for an order.
 *
 *   authorize  one unit row and nonce account per image, each transaction
 *              built and partially signed by Enki, handed to the buyer
 *   submit     each signed transaction must be the one built, fully signed and
 *              payable (simulated); the buyer's USDC must cover every open
 *              unit; then each is stored sealed, unbroadcast
 *   status     the units' states, for a client resuming after a reload
 *   cancel     voids what has not started
 *
 * Refusals are EscrowPaymentError because escrowRoute, the shared wrapper of
 * the four routes (session, rate limits, plain messages), maps exactly that.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { Transaction, VersionedTransaction, type Connection, type SignatureStatus } from "@solana/web3.js";
import { EscrowPaymentError } from "@/lib/payments/escrow/server-chain";
import {
  authorizationFor, buyerCovers, buyerWallet, capturePause, CoverageUnknown, droppedPause, DROPPED_UNIT_LIMIT, enkiWallet, INTENT_MAX_OPEN_PER_BUYER, openIntentBatch, planFor,
  type Coverage, type IntentRow,
} from "@/lib/payments/authorize-flow";
import { feePayerSignature, hasRequiredSignatures, matchesBuiltTransaction, signAsEnki } from "@/lib/payments/authorize-tx";
import { storeAuthorization } from "@/lib/payments/authorization";
import { readNonce } from "@/lib/payments/nonce";
import { simulatePayment } from "@/lib/payments/x402-settle";
import { settleVoided, voidAndFlush } from "@/lib/payments/settle";
import { feePayerKeypair } from "@/lib/payments/solana";
import { findMissingAtas } from "@/lib/payments/solana-transfer";
import { renderableRoute } from "@/lib/generation/renderable";
import { inputsUnmatched, loadPromptText, shortestValue, shortestWebFill, VALUE_MAX } from "@/lib/generation/prompt-text";
import { PROMPT_MAX } from "@/lib/generation/prompt-limits";
import { paymentRail, railOf, type PaymentRail } from "@/lib/payments/rail";
import { VIDEO_MODELS, VIDEO_NOT_AVAILABLE, type Resolution } from "@/lib/video/models";
import { availableAt, loadVideoRoutes } from "@/lib/video/routes";

const TABLE = "generation_payment_intents";
const ROW = "id, buyer_wallet, status, prompt_id, model_id, model_family, resolution, quality, boost, reference_image_count, artist_wallet, artist_amount_micro, model_cost_micro, enki_fee_micro, total_micro, nonce_account, tx_signature, fronted_atas, batch_intent_id, unit_index, authorized_at, consumed_at, captured_at, fulfilled_at, voided_at, void_reason";

type UnitRow = IntentRow & {
  status: string; tx_signature?: string | null; prompt_id?: string | null;
  model_id: string | null; model_family: string | null; resolution: string | null; quality: string | null; boost: boolean | null; reference_image_count: number | null; batch_intent_id: string | null; unit_index: number | null;
  authorized_at: string | null; consumed_at: string | null; captured_at: string | null; fulfilled_at: string | null; voided_at: string | null;
  void_reason?: string | null;
};

const usd = (micro: number) => `${micro / 1_000_000} USDC`;
const OUR_SIDE = "Payments are paused for a moment on our side. Nothing was charged — try again shortly.";
/** A video's row names a video generator as its family: it runs on its operator's route, never an image's. */
const videoRowOf = (family: string | null | undefined) => VIDEO_MODELS.find((m) => m.label === family) ?? null;

/** The buyer's coverage as a refusal an agent or a person can act on, in the x402 wording (DEC-68). */
function refuseCoverage(c: Exclude<Coverage, { ok: true }>): never {
  if (c.reason === "no_wallet") throw new EscrowPaymentError(409, "Connect a Solana wallet before paying.");
  if (c.reason === "payer_no_account") throw new EscrowPaymentError(402, `Your wallet has no USDC yet. Add at least ${usd(c.needMicro)} and pay again — nothing was charged.`);
  throw new EscrowPaymentError(402, `Your wallet holds ${usd(c.haveMicro)}, but your open images need ${usd(c.needMicro)}. Add USDC and pay again — nothing was charged.`);
}

async function pausedRefusal(db: SupabaseClient, owner: string): Promise<void> {
  const at = (until: string) => new Date(until).toISOString().slice(11, 16);
  const pause = await capturePause(db, owner);
  if (pause.paused) {
    throw new EscrowPaymentError(429, `Five payments in a row did not go through, so paying is paused until ${at(pause.until)} UTC.`);
  }
  const dropped = await droppedPause(db, owner);
  if (dropped.paused) {
    throw new EscrowPaymentError(429, `You left ${DROPPED_UNIT_LIMIT} images unpaid in the last hour, so new orders are paused until ${at(dropped.until)} UTC. Nothing was charged.`);
  }
}

async function unitsOf(db: SupabaseClient, intentId: string, owner: string): Promise<UnitRow[]> {
  const { data, error } = await db.from(TABLE).select(ROW).eq("batch_intent_id", intentId).eq("buyer_wallet", owner).order("unit_index");
  if (error) throw new EscrowPaymentError(503, "The payment is temporarily unavailable. Please check its status later.");
  return (data ?? []) as UnitRow[];
}

/**
 * Each unit's transaction, rebuilt from its row and its nonce, partially
 * signed by Enki. Its signature is recorded on the unit before it is handed
 * out: the buyer could broadcast it without ever submitting it, and every void
 * looks that up (settleVoided). A retry rebuilds the same bytes, so the same
 * signature.
 */
async function transactionsFor(db: SupabaseClient, connection: Connection, units: UnitRow[], buyer: string): Promise<string[]> {
  const enki = enkiWallet();
  return Promise.all(units.map(async (u) => {
    const nonce = u.nonce_account ? await readNonce(connection, u.nonce_account) : null;
    if (!nonce) throw new EscrowPaymentError(503, "The payment could not be prepared. Please try again.");
    const { transaction } = authorizationFor(u, buyer, nonce, enki);
    const wire = signAsEnki(transaction, feePayerKeypair());
    const signature = feePayerSignature(transaction);
    // Only this payment's broadcast moves its nonce (Enki is the authority and advances nothing else): a different
    // signature on a retry means the buyer sent the one handed out. Its recorded signature stays for the void's
    // lookup; it is never overwritten (verification 2026-10-18).
    if (u.tx_signature && u.tx_signature !== signature) throw new PaymentAlreadySent();
    if (!u.tx_signature) {
      const { error } = await db.from(TABLE).update({ tx_signature: signature }).eq("id", u.id).is("authorized_at", null).is("tx_signature", null);
      if (error) throw new EscrowPaymentError(503, "The payment could not be prepared. Please try again.");
    }
    return wire;
  }));
}

class PaymentAlreadySent extends Error {}
const ALREADY_SENT = "This order's payment was already sent from your wallet. Nothing more will be charged; if it went through without an image, it is refunded.";

/** Hand an order's payments out; one the buyer already sent voids the order, and the void books it if it landed. */
async function handOut(db: SupabaseClient, connection: Connection, units: UnitRow[], buyer: string): Promise<string[]> {
  try {
    return await transactionsFor(db, connection, units, buyer);
  } catch (e) {
    if (!(e instanceof PaymentAlreadySent)) throw e;
    await voidUnstarted(db, units, "rejected");
    throw new EscrowPaymentError(409, ALREADY_SENT);
  }
}

export async function authorizeIntent(
  db: SupabaseClient,
  connection: Connection,
  { intentId, owner, units }: { intentId: string; owner: string; units: number },
) {
  await pausedRefusal(db, owner);
  const { data: intent, error } = await db.from(TABLE).select(ROW).eq("id", intentId).eq("buyer_wallet", owner).maybeSingle();
  if (error) throw new EscrowPaymentError(503, "The payment is temporarily unavailable. Please check its status later.");
  if (!intent) throw new EscrowPaymentError(404, "This image request was not found.");
  const buyer = await buyerWallet(db, owner);
  if (!buyer) throw new EscrowPaymentError(409, "Connect a Solana wallet before paying.");
  // One press is one video, whichever prompt (Kev, 2026-11-03: "allow also only the creation of 1 video for premium prompts").
  const video = videoRowOf((intent as UnitRow).model_family);
  if (video && units !== 1) throw new EscrowPaymentError(422, "One press makes one video. Nothing was charged.");

  // A retry of the same request gets the same unsigned transactions back; a signed or started order is not re-opened.
  if ((intent as UnitRow).batch_intent_id === intentId) {
    const open = await unitsOf(db, intentId, owner);
    if (open.length !== units || open.some((u) => u.authorized_at || u.voided_at)) {
      throw new EscrowPaymentError(409, "This image request is already paid or closed.");
    }
    // A hand-out that fails voids nothing: the first call may still be creating the nonces and hand the order out; one
    // that died leaves it to the sweep, which reads an order signed in part as Enki's (DEC-237) (round 22, 2026-10-20).
    return { intentId, paymentScheme: "intent" as const, units, transactions: await handOut(db, connection, open, buyer) };
  }

  // This rail holds at most 8 open payments per buyer: a larger order is refused before anything opens (verification 2026-10-18).
  if (units > INTENT_MAX_OPEN_PER_BUYER) {
    throw new EscrowPaymentError(429, `At most ${INTENT_MAX_OPEN_PER_BUYER} images can be paid for at once. Choose fewer images — nothing was charged.`);
  }
  // A model this environment cannot render opens nothing: the route would refuse every unit, voided as Enki's and so
  // outside the buyer's limits, in a loop (verification 2026-10-18).
  // A video's is its operator's row, asked again here: an operator can go in the minutes since the quote.
  const route = video ? null : await renderableRoute(db, intent as UnitRow);
  if (video) {
    const routes = await loadVideoRoutes(db).catch(() => null);
    const row = routes?.find((r) => r.id === video.id);
    if (!row || !availableAt(row).includes((intent as UnitRow).resolution as Resolution)) throw new EscrowPaymentError(503, `${VIDEO_NOT_AVAILABLE} Nothing was charged.`);
  } else if (!route) {
    throw new EscrowPaymentError(503, "This model cannot be rendered right now. Nothing was charged — choose another model or try again later.");
  }
  // An artist's prompt whose text cannot be read, that no web buyer can fill, or whose shortest web fill is past what
  // the host takes, opens nothing: the route would refuse every unit as Enki's, outside the buyer's limits, in a loop (round 11,
  // 2026-10-20; DEC-126's case, for the prompt).
  const paidPrompt = (intent as UnitRow).prompt_id;
  if (paidPrompt && Number((intent as UnitRow).artist_amount_micro) > 0) {
    const text = await loadPromptText(db, paidPrompt);
    const unrenderable = new EscrowPaymentError(409, "This prompt cannot be rendered right now. Nothing was charged — choose another prompt or model.");
    if (!text.ok) throw text.status === 422 ? unrenderable : new EscrowPaymentError(503, OUR_SIDE);
    const shortest = shortestWebFill(text.text, text.variables);
    const max = route ? PROMPT_MAX[route.provider] : undefined;
    if (inputsUnmatched(shortest) || (max !== undefined && shortest.text.length > max)) throw unrenderable;
    // A field no buyer can send (its shortest value is longer than a value may be), with a slot or without one: the
    // composer asks every stored variable of a premium prompt, and the route refuses the value as the artist's (round
    // 14, 2026-10-20: DEC-212 relied on the slot's unmatched fill, which a field without a slot never makes).
    if (text.variables.some((v) => shortestValue(v).length > VALUE_MAX)) throw unrenderable;
  }
  // Every capture pays into Enki's USDC account. A new treasury wallet has none until its first USDC arrives, and then
  // each capture would fail after the provider was paid, reading to the buyer as "no USDC" (review 2026-10-18).
  if ((await findMissingAtas([enkiWallet()])).length > 0) {
    console.error("[payments/intent] Enki's treasury (SOLANA_PLATFORM_WALLET) has no USDC account: send it any USDC once");
    throw new EscrowPaymentError(503, "Payments are paused for a moment on our side. Nothing was charged — try again shortly.");
  }
  const coverage = await buyerCovers(db, connection, owner, units * Number((intent as UnitRow).total_micro));
  if (!coverage.ok) refuseCoverage(coverage);
  // The plan rides on the quoted row, so every unit cloned from it carries the same plan.
  const plan = await planFor(intent as UnitRow, connection);
  const { error: planError } = await db.from(TABLE).update({ fronted_atas: plan }).eq("id", intentId).eq("status", "quoted").is("batch_intent_id", null);
  // A plan that did not land would open the units on the row's old one, the artist paid in their own leg (round 5).
  if (planError) throw new EscrowPaymentError(503, OUR_SIDE);

  const opened = await openIntentBatch(db, connection, { id: intentId, buyer_wallet: owner }, units);
  if (!opened.ok) {
    if (opened.refusal === "cap") await capRefusal(db, owner, units);
    if (opened.refusal === "not_open") throw new EscrowPaymentError(409, "This image request is no longer open. Start a new one.");
    throw new EscrowPaymentError(503, "Payments are paused for a moment on our side. Nothing was charged — try again shortly.");
  }
  try {
    // Built from the rows as stored: a concurrent /authorize may have written its own plan before this one opened, and
    // /submit and the capture rebuild from the stored plan (review 2026-10-18).
    const rows = await unitsOf(db, intentId, owner);
    if (rows.length !== units) throw new EscrowPaymentError(503, "The payment could not be prepared. Please try again.");
    return { intentId, paymentScheme: "intent" as const, units, transactions: await handOut(db, connection, rows, buyer) };
  } catch (e) {
    // Opened but not handed out: nobody can sign them, so they go now, as Enki's failure (never the buyer's dropped
    // units), instead of holding the buyer's limits until the sweep (verification 2026-10-18).
    const fresh = opened.units.map((u) => ({
      ...(intent as UnitRow), id: u.id, nonce_account: u.nonceAccount, authorized_at: null, consumed_at: null, captured_at: null, voided_at: null,
    }));
    // Not settled here: an account created a moment ago may not show on every RPC yet, and a close that sees "gone"
    // would record it closed for good. The cron's closeFinalNonces settles these voided rows minutes later
    // (verification 2026-10-18).
    await voidUnstarted(db, fresh, "provider_failed", { settle: false }).catch(() => undefined);
    throw e;
  }
}

/**
 * Void every unit of an order that has not started (signed or not), returning
 * each nonce's rent. An unsigned unit's nonce closes right after the answer,
 * so the buyer's open units free at once, and the chain is asked whether the
 * buyer broadcast the handed-out payment unsubmitted (review 2026-10-18).
 */
async function voidUnstarted(
  db: SupabaseClient,
  units: UnitRow[],
  reason: "cancelled" | "rejected" | "provider_failed",
  { settle = true }: { settle?: boolean } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await Promise.all(units.map(async (u) => {
    if (u.consumed_at || u.captured_at || u.voided_at) return;
    if (u.authorized_at) return void (await voidAndFlush(db, u.id, reason, { unclaimed: true }));
    // Not a unit booked meanwhile: a void's settle books the buyer's own landed broadcast unsigned and clears voided_at
    // (bookPaidUndelivered), so only captured_at tells it from an open one (round 8, 2026-10-20).
    const { data: won } = await db.from(TABLE).update({ status: "voided", voided_at: now, void_reason: reason, updated_at: now })
      .eq("id", u.id).is("authorized_at", null).is("voided_at", null).is("captured_at", null).select("id").maybeSingle();
    const account = u.nonce_account;
    if (won && account && settle) after(() => settleVoided(db, u.id, account));
  }));
}

/**
 * The batch RPC refuses the buyer's cap and the overall one alike; the buyer's
 * own count of open payments (the RPC's predicate) says which (review
 * 2026-10-18). Only the first is the buyer's to fix.
 */
async function capRefusal(db: SupabaseClient, owner: string, units: number): Promise<never> {
  const { count } = await db.from(TABLE).select("id", { count: "exact", head: true })
    .eq("buyer_wallet", owner).not("nonce_account", "is", null).is("nonce_closed_at", null);
  if (count !== null && count + units > INTENT_MAX_OPEN_PER_BUYER) {
    // The message counts what the buyer can finish or cancel; finished payments whose account is still closing are
    // Enki's to clear, and read as busy (verification 2026-10-18).
    const { count: live } = await db.from(TABLE).select("id", { count: "exact", head: true })
      .eq("buyer_wallet", owner).not("nonce_account", "is", null).is("nonce_closed_at", null).is("captured_at", null).is("voided_at", null);
    if (live) {
      throw new EscrowPaymentError(429, `You already have ${live} open payments, and at most ${INTENT_MAX_OPEN_PER_BUYER} can be open at once. Finish or cancel some first — nothing was charged.`);
    }
  }
  throw new EscrowPaymentError(503, "Payments are busy right now. Nothing was charged — try again in a few minutes.");
}

/**
 * A read that failed before /submit could look at the order (its rail, its units) answers 503, and the client waits
 * on the status while the order's unsigned units would later be swept as the buyer's abandoned ones. They are voided
 * here as Enki's, best effort (an outage that fails this write too is the residual), and the cron settles them
 * (DEC-124) (round 8, 2026-10-20; DEC-151's case at the first read). Only an intent order's units carry
 * batch_intent_id; a unit booked paid-undelivered carries captured_at.
 */
export async function voidUnsignedAsOurs(db: SupabaseClient, intentId: string, owner: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db.from(TABLE).update({ status: "voided", voided_at: now, void_reason: "provider_failed", updated_at: now })
      .eq("batch_intent_id", intentId).eq("buyer_wallet", owner).is("authorized_at", null).is("voided_at", null).is("captured_at", null);
  } catch { /* the sweep's "abandoned" stays the residual */ }
}

export async function submitIntent(
  db: SupabaseClient,
  connection: Connection,
  { intentId, owner, signedTransactions }: { intentId: string; owner: string; signedTransactions: string[] },
) {
  const units = await unitsOf(db, intentId, owner).catch(async (e) => { await voidUnsignedAsOurs(db, intentId, owner); throw e; });
  if (units.length === 0) throw new EscrowPaymentError(404, "This image request was not found.");
  // The chain's word on every payment this order handed out, asked once and only before a refusal: the buyer may have
  // broadcast one themselves, and then their money moved (round 8, 2026-10-20).
  let sent: Promise<Map<string, SignatureStatus | null>> | undefined;
  const sentOf = () => (sent ??= (async () => {
    const sigs = units.flatMap((u) => (u.tx_signature ? [u.tx_signature] : []));
    const { value } = sigs.length ? await connection.getSignatureStatuses(sigs, { searchTransactionHistory: true }) : { value: [] };
    return new Map<string, SignatureStatus | null>(sigs.map((sig, i) => [sig, value[i] ?? null]));
  })());
  const anyLanded = async () => [...(await sentOf()).values()].some((st) => st && !st.err);
  // Swept or cancelled before anyone signed: the signature came too late, and nothing was ever held. Unless the buyer
  // broadcast a payment of it themselves and it landed before its void was settled and booked (round 24, 2026-10-21).
  if (units.every((u) => u.voided_at && !u.authorized_at)) {
    if (await anyLanded().catch(() => false)) throw new EscrowPaymentError(409, ALREADY_SENT);
    throw new EscrowPaymentError(409, "This payment expired before it was signed. Nothing was charged — start again.");
  }
  if (units.some((u) => u.authorized_at || u.voided_at || u.status !== "building")) {
    throw new EscrowPaymentError(409, "This image request is already paid or closed.");
  }
  if (signedTransactions.length !== units.length) throw new EscrowPaymentError(400, "Sign one payment per image.");

  // Enki's side refused (an unreadable nonce, the fee payer, an RPC or a database that threw): the order is voided as
  // provider_failed, never the buyer's dropped units, and the answer is final (409), so the client ends the order
  // instead of parking it as "still being checked" (verification 2026-10-18). Settled at once, except where a nonce
  // could not be read: that account may still exist, and a close that saw it "gone" would record it closed for good,
  // so the cron settles those minutes later (DEC-124; round 5, 2026-10-20).
  // A payment of this order the buyer broadcast themselves may have landed: then "Nothing was charged" would be false,
  // so it is told as handOut tells it. Not asked where the RPC itself just failed: the lookup would wait on it (round 10,
  // 2026-10-20).
  // Before anything is stored here the order is read fresh: a /submit of this same order that overlapped this one may
  // have stored it meanwhile, and then it is that one's and nothing is voided, whatever voided a unit of it since (that
  // void settled its own units, as DEC-232); partly stored, the stored units are voided as signed, so the other one's
  // next store loses for Enki's reason (rounds 21, 22, 2026-10-20).
  const ours = async ({ current, settle = true, ask = true }: { current?: UnitRow[]; settle?: boolean; ask?: boolean } = {}): Promise<never> => {
    const now = current ?? (await unitsOf(db, intentId, owner).catch(() => units));
    if (!current && now.every((u) => u.authorized_at)) throw new EscrowPaymentError(409, "This image request is already paid or closed.");
    const landed = ask && (await anyLanded().catch(() => false));
    await voidUnstarted(db, now, "provider_failed", { settle });
    throw new EscrowPaymentError(409, landed ? ALREADY_SENT : OUR_SIDE);
  };
  let buyer: string | null;
  // A wallet that cannot be read is Enki's database, not a buyer without a wallet (round 5, 2026-10-20).
  try { buyer = await buyerWallet(db, owner); } catch { return ours(); }
  if (!buyer) throw new EscrowPaymentError(409, "Connect a Solana wallet before paying.");

  // The buyer's refusal, unless a payment of this order landed: then "nothing was charged" would be false, so it is
  // told as handOut tells it, and the void books what landed with a refund owed (round 8, 2026-10-20).
  const theirs = async (status: number, message: string): Promise<never> => {
    const landed = await anyLanded();
    await voidUnstarted(db, units, "rejected");
    throw new EscrowPaymentError(landed ? 409 : status, landed ? ALREADY_SENT : message);
  };

  const enki = enkiWallet();
  try {
  for (const [i, u] of units.entries()) {
    const nonce = u.nonce_account ? await readNonce(connection, u.nonce_account) : null;
    const signed = signedTransactions[i];
    if (!nonce) return ours({ settle: false });
    // A payment the buyer broadcast moved its nonce, so it no longer matches: asked before this refusal (round 8).
    if (!matchesBuiltTransaction(signed, authorizationFor(u, buyer, nonce, enki).transaction) || !hasRequiredSignatures(signed)) {
      await theirs(400, "The signed payment is not the one prepared. Nothing was charged — start again.");
    }
    const simulated = await simulatePayment(connection, VersionedTransaction.deserialize(Transaction.from(Buffer.from(signed, "base64")).serialize()));
    if (!simulated.ok) {
      if (simulated.reason === "fee_payer" || simulated.reason === "rpc") await ours({ ask: simulated.reason === "fee_payer" });
      // "Expired" right after the nonce was read as this payment's is a simulating node behind the nonce's creation,
      // unless this payment was sent or another of the order's landed (the buyer broadcast it): only then is it the
      // buyer's (round 6; round 8, 2026-10-20). Settled at once: settleVoided does not believe a fresh account "gone"
      // (DEC-163).
      if (simulated.reason === "expired" && !(await sentOf()).get(String(u.tx_signature)) && !(await anyLanded())) await ours();
      if (simulated.reason === "payer_usdc") await theirs(402, `Your wallet holds less than the ${usd(Number(u.total_micro))} this image costs. Add USDC and pay again — nothing was charged.`);
      if (simulated.reason === "payer_no_account") await theirs(402, `Your wallet has no USDC yet. Add at least ${usd(Number(u.total_micro))} and pay again — nothing was charged.`);
      await theirs(402, "Your payment could not be checked. Nothing was charged — start again.");
    }
  }
  const coverage = await buyerCovers(db, connection, owner, 0);
  if (!coverage.ok) {
    // A payment of the order the buyer broadcast after its unit was checked moved the balance too: told, never "nothing
    // was charged" (round 11, 2026-10-20). A lookup that throws is the catch's, our side.
    const landed = await anyLanded();
    await voidUnstarted(db, units, "rejected");
    if (landed) throw new EscrowPaymentError(409, ALREADY_SENT);
    refuseCoverage(coverage);
  }
  } catch (e) {
    if (e instanceof EscrowPaymentError) throw e;
    // Coverage that could not place a capture against the balance (DEC-239) is no failed read: every nonce was read and
    // the RPC answers, so the chain is asked and the voids settle at once (round 22, 2026-10-20).
    if (e instanceof CoverageUnknown) await ours();
    // A read that threw (nonce, simulation, coverage, the lookup) is Enki's side; the nonce may be the one that could not
    // be read, and the RPC the one that failed.
    await ours({ settle: false, ask: false });
  }

  const authority = feePayerKeypair().publicKey.toBase58();
  // The order as this request stored it, for a fallback that cannot read it again: the units before the n-th are its
  // own (an overlapping /submit loses at the first), so they are voided as signed (round 22, 2026-10-20).
  const asStored = (n: number) => units.map((x, j) => (j < n ? { ...x, authorized_at: x.authorized_at ?? new Date().toISOString() } : x));
  for (const [i, u] of units.entries()) {
    let stored: boolean;
    // A write Enki's database failed is Enki's side, read fresh so a unit already stored is voided as signed; only a
    // lost race below is the order changing under the buyer (round 4, 2026-10-19).
    try { stored = await storeAuthorization(db, { intentId: u.id, buyerWallet: owner, signedTx: signedTransactions[i], nonceAccount: u.nonce_account!, nonceAuthority: authority }); }
    catch {
      const read = await unitsOf(db, intentId, owner).catch(() => asStored(i));
      // At the first unit a later one reads stored only if an overlapping /submit stored it, and that one stores in
      // order: stored whole, the order is that one's, as before the stores (DEC-242). A one-unit order stays
      // ambiguous (this store may have committed) and is voided as Enki's (round 23, 2026-10-21).
      if (i === 0 && read.length > 1 && read.every((x) => x.authorized_at)) throw new EscrowPaymentError(409, "This image request is already paid or closed.");
      return ours({ current: read });
    }
    if (!stored) {
      // At the first unit nothing of this request's is stored and the unit may be one an overlapping /submit is storing:
      // a read that fails stands (503, check the status) (round 22, 2026-10-20).
      const fresh = await unitsOf(db, intentId, owner).catch((e) => { if (i === 0) throw e; return null; });
      if (!fresh) return ours({ current: asStored(i) });
      // Stored by a /submit of this same order that overlapped this one (the signed bytes are the ones verified
      // above): the order did not change, so nothing is voided, as a retry of a stored order answers (round 20).
      // Voided since (a render of it failed, a cancel): that void settled its own units (round 21, 2026-10-20).
      const mine = fresh.find((f) => f.id === u.id);
      if (mine?.authorized_at) throw new EscrowPaymentError(409, "This image request is already paid or closed.");
      // Closed under this one: the rest goes for the reason it was closed, so a failure on Enki's side (another
      // /submit's, the sweep's) stays Enki's (round 21, 2026-10-20).
      // A payment of the order the buyer broadcast meanwhile is told, never "nothing was charged" (round 21, 2026-10-20).
      const landed = await anyLanded().catch(() => false);
      await voidUnstarted(db, fresh, mine?.void_reason === "provider_failed" ? "provider_failed" : "rejected");
      throw new EscrowPaymentError(409, landed ? ALREADY_SENT : "This image request changed while paying. Nothing was charged — start again.");
    }
  }
  return intentStatus(db, intentId, owner);
}

export async function intentStatus(db: SupabaseClient, intentId: string, owner: string) {
  const units = await unitsOf(db, intentId, owner);
  if (units.length === 0) throw new EscrowPaymentError(404, "This image request was not found.");
  // A unit's generation names the unit row as its payment_intent_id; its image as the escrow status reads it.
  const paid = units.filter((u) => u.captured_at).map((u) => u.id);
  const { data: gens } = paid.length ? await db.from("generations").select("id, payment_intent_id").in("payment_intent_id", paid) : { data: [] };
  const genIds = (gens ?? []).map((g) => g.id as string);
  const { data: imgs } = genIds.length
    ? await db.from("generated_images").select("generation_id, storage_url").in("generation_id", genIds).eq("accepted", true).is("deleted_at", null)
    : { data: [] };
  const genOf = (unitId: string) => (gens ?? []).find((g) => g.payment_intent_id === unitId)?.id as string | undefined;
  const imageOf = (genId: string) => (imgs ?? []).find((i) => i.generation_id === genId)?.storage_url as string | undefined;
  // An order whose every unit ended void is expired, never funded as well: the checkout refuses that pair for good (review 2026-10-18).
  const expired = units.every((u) => u.voided_at);
  const funded = !expired && units.every((u) => u.authorized_at);
  return {
    intentId,
    paymentScheme: "intent" as const,
    state: expired ? "expired" : funded ? "funded" : "prepared",
    funded,
    // The escrow status's unit shape, which the checkout checks (lib/generation-checkout.ts statusBody): a
    // generation id only on a delivered unit (null if its record was lost), its image only when saved.
    // Delivered means booked AND handed over (fulfilled): a payment that landed while its image was withheld is
    // paid-undelivered, refund owed, and reads as failed (review 2026-10-18).
    units: units.map((u) => {
      const delivered = Boolean(u.captured_at && u.fulfilled_at);
      const generationId = delivered ? genOf(u.id) ?? null : null;
      const imageUrl = generationId ? imageOf(generationId) : undefined;
      return {
        unit_index: u.unit_index,
        state: delivered ? "delivered" : u.captured_at || u.voided_at ? "failed" : u.consumed_at ? "running" : "pending",
        generation_id: generationId,
        ...(imageUrl ? { imageUrl } : {}),
      };
    }),
    batch: null,
  };
}

export async function cancelIntent(db: SupabaseClient, intentId: string, owner: string) {
  const units = await unitsOf(db, intentId, owner);
  if (units.length === 0) throw new EscrowPaymentError(404, "This image request was not found.");
  await voidUnstarted(db, units, "cancelled");
  return { intentId, paymentScheme: "intent" as const, cancelled: true, state: "closed", refundPending: false };
}

/**
 * The rail an order is paid on: the one that opened it, else the switch
 * (lib/payments/rail.ts). An order escrow already prepared stays escrow's.
 */
export async function railFor(db: SupabaseClient, intentId: string, owner: string): Promise<PaymentRail> {
  const { data, error } = await db.from(TABLE).select("nonce_account, batch_intent_id, deposit_signature, model_family").eq("id", intentId).eq("buyer_wallet", owner).maybeSingle();
  if (error) throw new EscrowPaymentError(503, "The payment is temporarily unavailable. Please check its status later.");
  const rail = data && railOf(data);
  if (rail) return rail;
  // A video is held, never deposited: a flip of the switch after its quote does not send it to escrow.
  if (videoRowOf(data?.model_family)) return "intent";
  // An escrow deposit prepared or submitted but not yet confirmed has no deposit_signature on the intent yet; its
  // deposit or recovery row pins it to escrow, so a flip of the switch mid-checkout cannot strand it (review 2026-10-18).
  if (data) {
    const [deposit, recovery] = await Promise.all(["generation_escrow_deposits", "generation_escrow_recovery"].map((t) =>
      db.from(t).select("intent_id").eq("intent_id", intentId).maybeSingle()));
    if (deposit.error || recovery.error) throw new EscrowPaymentError(503, "The payment is temporarily unavailable. Please check its status later.");
    if (deposit.data || recovery.data) return "escrow";
  }
  return paymentRail();
}
