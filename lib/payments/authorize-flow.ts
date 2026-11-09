/**
 * The two halves of authorising a generation payment, sharing one builder.
 *
 * /authorize builds the transaction and hands it to the buyer to sign.
 * /submit takes the signed one back and stores it.
 *
 * Both must agree byte for byte on what the transaction is, or /submit rejects
 * an honest buyer. That is why the input which could drift, the nonce account,
 * is written to the intent row by /authorize and READ BACK by /submit rather
 * than recomputed.
 *
 * Enki fronts no token account any more (Kev, 2026-10-18): a fronted
 * account's rent went to whoever closed it, a way to farm Enki's SOL.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { Keypair, NONCE_ACCOUNT_LENGTH, PublicKey, type Connection, type Transaction, type ParsedAccountData } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createNonceAccount } from "@/lib/payments/nonce";
import { paymentLegs, type PaymentLeg } from "@/lib/payments/generation-pay";
import { buildAuthorizationTx } from "@/lib/payments/authorize-tx";
import { feePayerKeypair, usdcMint } from "@/lib/payments/solana";
import { priorityFeeMicroLamports } from "@/lib/payments/solana-transfer";

export interface IntentRow {
  id: string;
  buyer_wallet: string;
  artist_wallet: string | null;
  artist_amount_micro: number;
  model_cost_micro: number;
  enki_fee_micro: number;
  total_micro: number;
  nonce_account: string | null;
  fronted_atas: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A real base58 Solana key; an all-lowercase one is a legacy row an old bug lowercased, a key nobody holds. */
function solanaKey(address: unknown): string | null {
  if (typeof address !== "string" || address === address.toLowerCase()) return null;
  try { return new PublicKey(address).toBase58() === address ? address : null; } catch { return null; }
}

/**
 * The wallet an intent's owner pays from. Email, Google and X accounts own an
 * intent by their user id: their primary live Solana wallet. A wallet account
 * owns it by the address it signed in with. (At 0481edd9 exactWallet matched
 * the address only, so every user-id owner got a 409.)
 */
export async function buyerWallet(supabase: SupabaseClient, owner: string): Promise<string | null> {
  if (!UUID.test(owner)) return solanaKey(owner);
  const { data, error } = await supabase
    .from("user_wallets")
    .select("address")
    .eq("user_id", owner)
    .eq("chain_family", "solana")
    .is("removed_at", null)
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle();
  // An unreadable row is not "no wallet": the route voided a claimed unit as unfunded on a database blip (round 4).
  if (error) throw error;
  return solanaKey(data?.address);
}

/**
 * Every owner string that pays from this wallet: the wallet's own session and
 * each account that holds it live. One person can own intents under both (a
 * wallet login and an email account with that wallet attached), so the limits
 * that protect one balance count them together (review 2026-10-18). A wallet
 * held but not primary is counted too: conservative, never a looser limit.
 */
export async function ownersPaying(supabase: SupabaseClient, wallet: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("user_wallets")
    .select("user_id")
    .eq("address", wallet)
    .eq("chain_family", "solana")
    .is("removed_at", null);
  if (error) throw error;
  return [wallet, ...new Set((data ?? []).map((r) => r.user_id as string).filter(Boolean))];
}

/** The account behind an intent's owner: a user id as it is, a wallet's live account, or null (round 4, 2026-10-19). */
export async function accountOf(supabase: SupabaseClient, owner: string): Promise<string | null> {
  if (UUID.test(owner)) return owner;
  return (await ownersPaying(supabase, owner))[1] ?? null;
}

/**
 * The buyer's USDC account as a transfer from it sees it: owned by the wallet
 * and initialised, or null (absent, re-owned to another key, frozen). A
 * re-owned account keeps its balance but refuses every transfer from the
 * wallet (verification 2026-10-18). Throws when the chain cannot answer.
 */
export async function usdcAccountOf(connection: Connection, wallet: string): Promise<{ amountMicro: number; slot: number } | null> {
  const ata = getAssociatedTokenAddressSync(usdcMint(), new PublicKey(wallet));
  const { context, value: info } = await connection.getParsedAccountInfo(ata, "confirmed");
  const account = (info?.data as ParsedAccountData | undefined)?.parsed?.info as
    | { owner?: string; state?: string; tokenAmount?: { amount?: string } } | undefined;
  if (account?.owner !== wallet || account.state !== "initialized") return null;
  // The slot the balance was read at: a capture confirmed at or before it is in this balance (round 8, 2026-10-20).
  return { amountMicro: Number(account.tokenAmount?.amount ?? 0), slot: context.slot };
}

export type Coverage =
  | { ok: true; wallet: string }
  | { ok: false; reason: "no_wallet" }
  | { ok: false; reason: "payer_usdc" | "payer_no_account"; needMicro: number; haveMicro: number };

/**
 * Whether the buyer's USDC covers every unit they hold open plus addMicro
 * (Kev, 2026-10-18: "logo soll er so viel usdc haben wie er drucken will").
 * One USDC balance can back only one capture: without the sum, 1 USDC would
 * cover four held 1 USDC units, four renders would run and three captures
 * would fail after Enki paid the provider. Asked at /authorize (addMicro the
 * new units), at /submit and right before the provider call (both 0, the
 * units are already open). An RPC that cannot answer throws: unknown is not
 * "no USDC".
 */
/** Coverage the chain answered but that cannot be decided: Enki's, never the buyer's (round 21, 2026-10-20). */
export class CoverageUnknown extends Error {}

export async function buyerCovers(
  supabase: SupabaseClient,
  connection: Connection,
  owner: string,
  addMicro: number,
): Promise<Coverage> {
  const wallet = await buyerWallet(supabase, owner);
  if (!wallet) return { ok: false, reason: "no_wallet" };
  const { data, error } = await supabase
    .from("generation_payment_intents")
    .select("id, total_micro, capture_started_at, tx_signature")
    .in("buyer_wallet", await ownersPaying(supabase, wallet))
    .not("nonce_account", "is", null)
    // A unit whose nonce is closed can no longer move USDC: it landed (the balance shows it) or never will.
    .is("nonce_closed_at", null)
    .is("captured_at", null)
    .is("voided_at", null);
  if (error) throw error;
  const rows = data ?? [];
  // A capture in flight that the cluster already confirmed is in the balance: counting its unit as well counted its USDC
  // twice until the booking caught up (round 4, 2026-10-19). The balance is read first and a capture is left out only
  // when it was confirmed in a slot that balance includes: read the other way round, a capture confirming between the
  // two reads was counted twice and a buyer who holds enough was refused, or voided "unfunded" (round 8, 2026-10-20).
  const account = await usdcAccountOf(connection, wallet);
  const sum = (list: typeof rows) => list.reduce((total, r) => total + Number(r.total_micro ?? 0), 0);
  // A lease taken after the rows were read may have confirmed before the balance was: its capture is in that balance
  // and its unit was counted as well. Before a refusal the leases are read again, unfiltered, so a capture booked
  // meanwhile still shows its lease and is placed by its slot like any other (round 22, 2026-10-20).
  const unleased = rows.filter((r) => !r.capture_started_at).map((r) => r.id as string);
  if (account && unleased.length && account.amountMicro < sum(rows) + addMicro) {
    const { data: leases, error: leaseError } = await supabase.from("generation_payment_intents").select("id, capture_started_at, tx_signature").in("id", unleased);
    if (leaseError) throw leaseError;
    for (const lease of leases ?? []) Object.assign(rows.find((r) => r.id === lease.id) ?? {}, lease);
  }
  const leased = rows.filter((r) => r.capture_started_at && r.tx_signature);
  // Over the history: a lease lives up to 6 minutes, the recent-status cache about 2 (round 5, 2026-10-20).
  const { context: seen, value: statuses } = leased.length && account
    ? await connection.getSignatureStatuses(leased.map((r) => String(r.tx_signature)), { searchTransactionHistory: true })
    : { context: { slot: 0 }, value: [] };
  const spent = new Set(leased.filter((_, i) => {
    const status = statuses[i];
    return Boolean(account && status && !status.err && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") && status.slot <= account.slot);
  }));
  // A capture the status node cannot place against the balance (the node is behind the balance's slot, or sees it only
  // processed within it) may be in that balance already: a refusal that rests on it is unknown, thrown, so Enki's on
  // every caller, never the buyer's (round 21, 2026-10-20).
  const unsure = account ? leased.filter((r, i) => {
    const status = statuses[i];
    return !spent.has(r) && !status?.err && (seen.slot < account.slot || (status?.confirmationStatus === "processed" && status.slot <= account.slot));
  }) : [];
  const needMicro = sum(rows.filter((r) => !spent.has(r))) + addMicro;
  if (!account) return { ok: false, reason: "payer_no_account", needMicro, haveMicro: 0 };
  if (account.amountMicro >= needMicro) return { ok: true, wallet };
  if (unsure.length && account.amountMicro >= needMicro - sum(unsure)) throw new CoverageUnknown("A capture in flight cannot be placed against the buyer's balance");
  return { ok: false, reason: "payer_usdc", needMicro, haveMicro: account.amountMicro };
}

/** Kev, 2026-10-18: "sperre nur für 30min bei 5 geplatzten abbuchungen". */
export const FAILED_CAPTURE_LIMIT = 5;
export const FAILED_CAPTURE_PAUSE_MS = 30 * 60_000;

/**
 * Whether the buyer is paused: 5 captures that did not land within 30 minutes
 * (each one cost Enki a provider bill). The pause ends when the oldest of
 * those five is 30 minutes old. Completed payments never count (Kev's 07-05
 * rule: no limits on paying).
 */
export async function capturePause(supabase: SupabaseClient, owner: string): Promise<{ paused: false } | { paused: true; until: string }> {
  const since = new Date(Date.now() - FAILED_CAPTURE_PAUSE_MS).toISOString();
  const wallet = await buyerWallet(supabase, owner);
  const { data, error } = await supabase
    .from("generation_payment_intents")
    .select("voided_at")
    .in("buyer_wallet", wallet ? await ownersPaying(supabase, wallet) : [owner])
    .eq("void_reason", "capture_failed")
    .gte("voided_at", since)
    .order("voided_at", { ascending: false })
    .limit(FAILED_CAPTURE_LIMIT);
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length < FAILED_CAPTURE_LIMIT) return { paused: false };
  const oldest = new Date(String(rows[FAILED_CAPTURE_LIMIT - 1].voided_at)).getTime();
  return { paused: true, until: new Date(oldest + FAILED_CAPTURE_PAUSE_MS).toISOString() };
}

/**
 * Opening a unit costs Enki's fee payer two transaction fees (the nonce
 * account's create and close, about 15,000 lamports with priority) even when
 * it is never paid; an open-then-drop loop had no limit (review 2026-10-18).
 * 13 units opened and dropped in an hour pause new orders until the oldest of
 * them is an hour old (Kev, 2026-10-18: "bei 13 bestellten und nicht gezahlten
 * bildern schon schluss"). Paid units never count (Kev's 07-05 rule: no limits on
 * paying). A void counts by its reason alone, which only the code that knows
 * the cause writes: cancelled, abandoned (never signed, or signed and never
 * rendered), rejected (refused by a check or the chain for what the buyer
 * sent) and unfunded are the buyer's; provider_failed is Enki's and
 * capture_failed is the capture pause's (round 4, 2026-10-19: a list of
 * reasons next to a filter on who claimed the unit let one rule undo the other).
 */
export const DROPPED_UNIT_LIMIT = 13;
export const DROPPED_UNIT_WINDOW_MS = 60 * 60_000;
const DROPPED_REASONS = ["cancelled", "rejected", "abandoned", "unfunded"];

export async function droppedPause(supabase: SupabaseClient, owner: string): Promise<{ paused: false } | { paused: true; until: string }> {
  const since = new Date(Date.now() - DROPPED_UNIT_WINDOW_MS).toISOString();
  const wallet = await buyerWallet(supabase, owner);
  const { data, error } = await supabase
    .from("generation_payment_intents")
    .select("voided_at")
    .in("buyer_wallet", wallet ? await ownersPaying(supabase, wallet) : [owner])
    .not("nonce_account", "is", null)
    .in("void_reason", DROPPED_REASONS)
    .gte("voided_at", since)
    .order("voided_at", { ascending: false })
    .limit(DROPPED_UNIT_LIMIT);
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length < DROPPED_UNIT_LIMIT) return { paused: false };
  const oldest = new Date(String(rows[DROPPED_UNIT_LIMIT - 1].voided_at)).getTime();
  return { paused: true, until: new Date(oldest + DROPPED_UNIT_WINDOW_MS).toISOString() };
}

/**
 * What /authorize decides once and stores in the intent's fronted_atas (a
 * jsonb column nothing else reads since the fronting went, 2026-10-18), so
 * /submit and the capture rebuild the very bytes the buyer signed.
 */
export interface RailPlan {
  cuPriceMicroLamports: number;
  /**
   * The artist's share rides in Enki's leg and is owed as a licence credit
   * once the capture lands (the x402 merchant model). A plan stored before
   * round 4 (2026-10-19) may say false: the artist paid in their own leg.
   */
  artistWithheld: boolean;
}

/** The stored plan; a row without one (written before it existed) rebuilds with no price and the artist's own leg. */
export function railPlanOf(raw: unknown): RailPlan {
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const price = p.cuPriceMicroLamports;
  return {
    cuPriceMicroLamports: typeof price === "number" && Number.isSafeInteger(price) && price >= 0 ? price : 0,
    artistWithheld: p.artistWithheld === true,
  };
}

/**
 * Decide the plan for an intent: the capped p75 priority fee, and the artist's
 * share withheld. Enki sells the render and owes the artist a licence fee, as
 * on x402 (Kev, 2026-10-17: "verkäufer-modell für künstlerprompts"): the whole
 * price lands in Enki's leg and the artist is credited once the image is
 * delivered, so a refund owed is exactly what Enki received (round 4,
 * 2026-10-19: with the artist paid in their own leg, a refund of the total
 * paid back money Enki never had, and a creator buying their own prompt could
 * book such refunds at will).
 */
export async function planFor(intent: IntentRow, connection: Connection): Promise<RailPlan> {
  return {
    cuPriceMicroLamports: priorityFeeMicroLamports(await connection.getRecentPrioritizationFees()),
    artistWithheld: intent.artist_amount_micro > 0,
  };
}

/** The legs a plan pays: the artist's own leg, or everything to Enki when the artist's share is withheld. */
export function legsFor(intent: IntentRow, enkiWallet: string, plan: RailPlan): PaymentLeg[] {
  if (!plan.artistWithheld) return paymentLegs(intent, enkiWallet);
  // The same checks paymentLegs runs on the split, then one leg for the total.
  paymentLegs({ ...intent, artist_wallet: intent.artist_wallet ?? enkiWallet }, enkiWallet);
  return [{ recipient: enkiWallet, amountMicro: intent.total_micro }];
}

/** Kev, 2026-10-18: "8 offene käufe pro person max". */
export const INTENT_MAX_OPEN_PER_BUYER = 8;
/**
 * Open nonce accounts overall: a stop for a runaway, not the budget. Each
 * parks ~0.00106 SOL of the fee payer's, and openIntentBatch's reserve check
 * already refuses what the fee payer cannot carry while keeping x402's share.
 * At 40 a few wallets holding idle USDC, each opening 8 units and never
 * signing, locked every buyer out for 5 to 10 minutes a round (round 4,
 * 2026-10-19).
 */
export const INTENT_MAX_OPEN = 400;
/** SOL the fee payer keeps for x402 settlements and its own fees whatever the web rail holds (0.01 SOL). */
export const FEE_PAYER_RESERVE_LAMPORTS = 10_000_000;
/** The fee payer's own rent-exempt floor on mainnet (a 0-byte system account, read 2026-10-18). */
const FEE_PAYER_FLOOR_LAMPORTS = 650_240;
/**
 * What one unit costs the fee payer over its life, besides the rent it gets
 * back: the nonce's create (two signatures), the capture (two signatures and
 * the capped priority fee, 1,000,000 micro-lamports x 30,000 CU) and the close
 * (one signature) (round 5, 2026-10-20: only the create was counted).
 */
const UNIT_FEES_LAMPORTS = 10_000 + 10_000 + 30_000 + 5_000;
/** Of those, what an open unit has still to spend: its capture and its close (round 6, 2026-10-20). */
const PENDING_FEES_LAMPORTS = 10_000 + 30_000 + 5_000;
/**
 * How long after its reservation a unit's account may not exist yet: its create waits up to 60 s for confirmation
 * on a blockhash that lives about as long (round 7, 2026-10-20: 60 s was shorter than a slow create).
 */
const CREATING_MS = 120_000;

export type OpenedUnit = { id: string; unitIndex: number; nonceAccount: string; nonce: string };
export type OpenRefusal = "fee_payer_low" | "cap" | "not_open" | "nonce_failed";

/**
 * Open a batch of units on a quoted intent: check the fee payer can carry their
 * rent, reserve one nonce address per unit in ONE database call (caps
 * included), then create the accounts. Nothing exists on chain before its
 * address is on a row, so a crash or a second request never orphans rent.
 */
export async function openIntentBatch(
  supabase: SupabaseClient,
  connection: Connection,
  intent: { id: string; buyer_wallet: string },
  units: number,
): Promise<{ ok: true; units: OpenedUnit[] } | { ok: false; refusal: OpenRefusal }> {
  const feePayer = feePayerKeypair();
  // Counted before the balance is read: an account created in between is then counted twice, a refusal, the safe side.
  // The balance does not yet show what open units will still spend (their capture and close), nor the rent of units
  // reserved moments ago whose accounts are still being created: both are taken off it (round 6, 2026-10-20).
  const open = () => supabase.from("generation_payment_intents")
    .select("id", { count: "exact", head: true }).not("nonce_account", "is", null).is("nonce_closed_at", null);
  const [{ count: openNow, error: countError }, { count: creating, error: creatingError }] = await Promise.all([
    open(),
    // Not handed out yet: /authorize records a unit's signature only after reading its created account, so a unit with
    // one is on chain and its rent already off the balance (round 7, 2026-10-20: it was taken off twice).
    open().eq("status", "building").is("tx_signature", null).gte("updated_at", new Date(Date.now() - CREATING_MS).toISOString()),
  ]);
  if (countError) throw countError;
  if (creatingError) throw creatingError;
  const [lamports, rent] = await Promise.all([
    connection.getBalance(feePayer.publicKey),
    connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH),
  ]);
  const spendable = lamports - FEE_PAYER_FLOOR_LAMPORTS - FEE_PAYER_RESERVE_LAMPORTS
    - (openNow ?? 0) * PENDING_FEES_LAMPORTS - (creating ?? 0) * (rent + 10_000);
  const affordable = Math.floor(spendable / (rent + UNIT_FEES_LAMPORTS));
  if (affordable < units) {
    console.error("[payments/intent] the fee payer cannot carry the nonce rent: fund it with SOL");
    return { ok: false, refusal: "fee_payer_low" };
  }

  const keypairs = Array.from({ length: units }, () => Keypair.generate());
  const { data, error } = await supabase.rpc("open_intent_batch", {
    p_intent: intent.id,
    p_buyer: intent.buyer_wallet,
    p_units: units,
    p_nonces: keypairs.map((k) => k.publicKey.toBase58()),
    p_authority: feePayer.publicKey.toBase58(),
    // What the balance can carry, enforced under the batch's own lock: two orders checked against one balance at once
    // could each pass the check above and together spend x402's reserve (round 5, 2026-10-20).
    p_max_open: Math.min(INTENT_MAX_OPEN, (openNow ?? 0) + affordable),
    p_max_open_buyer: INTENT_MAX_OPEN_PER_BUYER,
  });
  if (error) {
    if (error.code === "P0002") return { ok: false, refusal: "not_open" };
    // The batch may have committed with its answer lost: what it reserved is voided as Enki's at once, not swept as the
    // buyer's abandoned units minutes later. No account exists yet; the cron records them closed (round 5, 2026-10-20).
    const now = new Date().toISOString();
    await supabase.from("generation_payment_intents")
      .update({ status: "voided", voided_at: now, void_reason: "provider_failed", updated_at: now })
      .eq("batch_intent_id", intent.id).is("authorized_at", null).is("voided_at", null);
    throw error;
  }
  const rows = (data ?? []) as { id: string; unit_index: number; nonce_account: string }[];
  if (rows.length === 0) return { ok: false, refusal: "cap" };

  const byAddress = new Map(keypairs.map((k) => [k.publicKey.toBase58(), k]));
  const created = await Promise.allSettled(rows.map((r) => createNonceAccount(connection, feePayer, byAddress.get(r.nonce_account)!)));
  if (created.every((c) => c.status === "fulfilled")) {
    return {
      ok: true,
      units: rows.map((r, i) => ({ id: r.id, unitIndex: r.unit_index, nonceAccount: r.nonce_account, nonce: (created[i] as PromiseFulfilledResult<{ nonce: string }>).value.nonce })),
    };
  }
  // One account failed: the batch is void (Enki's failure, so never the buyer's dropped units). Its accounts are
  // closed by the cron (closeFinalNonces), not here: an account a moment old may not show on every RPC yet, and a
  // close that saw it "gone" would record it closed for good; a create that failed may still land (round 4,
  // 2026-10-19, as DEC-124 for /authorize).
  const now = new Date().toISOString();
  await supabase.from("generation_payment_intents")
    .update({ status: "voided", voided_at: now, void_reason: "provider_failed", updated_at: now })
    .in("id", rows.map((r) => r.id)).is("voided_at", null);
  return { ok: false, refusal: "nonce_failed" };
}

/** The unit's nonce account is gone and its rent is back: it no longer counts against any cap. */
export async function markNonceClosed(supabase: SupabaseClient, intentId: string): Promise<boolean> {
  const { error } = await supabase.from("generation_payment_intents")
    .update({ nonce_closed_at: new Date().toISOString() })
    .eq("id", intentId).is("nonce_closed_at", null);
  // true = recorded; a write that failed leaves the row for the sweep's next round (round 5, 2026-10-20).
  return !error;
}

/**
 * Rebuild the exact transaction for an intent. Deterministic given the row:
 * same legs, same nonce, same fronted accounts, same bytes.
 */
export function authorizationFor(
  intent: IntentRow,
  buyerWallet: string,
  nonce: string,
  enkiWallet: string,
): { transaction: Transaction } {
  if (!intent.nonce_account) throw new Error("Intent has no nonce account");
  const plan = railPlanOf(intent.fronted_atas);

  return buildAuthorizationTx({
    nonceAccount: new PublicKey(intent.nonce_account),
    nonceAuthority: feePayerKeypair().publicKey,
    nonce,
    feePayer: feePayerKeypair().publicKey,
    buyer: new PublicKey(buyerWallet),
    mint: usdcMint(),
    legs: legsFor(intent, enkiWallet, plan),
    cuPriceMicroLamports: plan.cuPriceMicroLamports,
  });
}

/** The Enki payout wallet, case-exact, from the server environment only. */
export function enkiWallet(): string {
  const addr =
    process.env.SOLANA_PLATFORM_WALLET || process.env.NEXT_PUBLIC_SOLANA_PLATFORM_WALLET;
  if (!addr) throw new Error("SOLANA_PLATFORM_WALLET is not set");
  return addr;
}
