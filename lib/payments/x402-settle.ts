/**
 * x402 exact-svm settlement — the facilitator half of the agent endpoint.
 *
 * The agent builds and PARTIALLY signs a Solana transaction paying our
 * requirements (one TransferChecked of exactly maxAmountRequired USDC to the
 * platform wallet's ATA, our fee payer as payer), base64s it into the
 * X-PAYMENT header, and we: verify OFFLINE, co-sign as fee payer, submit
 * with preflight, and only then run the paid work. Spec:
 * github.com/coinbase/x402 /specs/schemes/exact/scheme_exact_svm.md.
 *
 * Every check here guards OUR key or OUR money:
 *  - the fee payer must be payer only — never an instruction account, never
 *    the transfer authority (a tx that spends the fee payer's own funds
 *    would otherwise be co-signed blind);
 *  - compute-budget price, limit and the whole priority fee are capped, and
 *    only the payer and the fee payer may sign, so a hostile tx cannot drain
 *    the fee payer through fees;
 *  - the transfer must be EXACTLY the required amount to EXACTLY the
 *    platform ATA of EXACTLY the USDC mint, decimals pinned;
 *  - no address-table lookups: every account must be static, or the checks
 *    above would be reading indices into accounts we cannot see;
 *  - nothing but ComputeBudget, spl-token TransferChecked, Memo and the
 *    Lighthouse guards wallets inject may appear — an unknown program is an
 *    automatic reject, not a warning.
 *
 * Verification is pure (no network); the chain itself is the final
 * cryptographic arbiter — submission runs WITH preflight, so a missing or
 * forged client signature fails simulation before anything lands.
 */
import {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { broadcastAndConfirm, Rejected } from "@/lib/payments/solana";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** TransferChecked's instruction discriminator in the spl-token program. */
const TRANSFER_CHECKED = 12;
const USDC_DECIMALS = 6;
/** 5 lamports per compute unit, the spec's ceiling for facilitator safety.
    BigInt() call, not a literal — the build targets pre-ES2020 (the same
    constraint that broke the dotAll regex, commit 56ac127). */
const MAX_CU_PRICE_MICROLAMPORTS = BigInt(5_000_000);
/** A USDC transfer needs under 10,000 compute units; 200,000 is ample headroom. */
const MAX_CU_LIMIT = 200_000;
/** The whole priority fee a payment may hand our fee payer: 50,000 lamports.
    Price alone was capped, so a hostile limit x price reached 0.007 SOL per
    payment (x402 exact-svm §2.2.1: sponsors cap both). */
const MAX_PRIORITY_FEE_LAMPORTS = BigInt(50_000);
/** Wallets such as Phantom and Solflare inject these guards; the spec says they MUST be allowed (exact-svm §3.1). */
const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
/** Two budget instructions, the transfer, a memo and up to three Lighthouse guards, plus one spare. */
const MAX_INSTRUCTIONS = 8;

/** The two names an x402 client gives each network: v1 and CAIP-2 (v2). */
export const X402_NETWORKS = {
  "solana": { v1: "solana", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
  "solana-devnet": { v1: "solana-devnet", caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" },
} as const;

/** Both names of the deployment's chain; any other chain key is not an x402 network. */
export function x402Network(chainKey: string): { v1: string; caip2: string } {
  const net = (X402_NETWORKS as Record<string, { v1: string; caip2: string }>)[chainKey];
  if (!net) throw new Error(`Not an x402 network: ${chainKey}`);
  return net;
}

/** A payment as an x402 client sends it: v1 names scheme and network at the top, v2 under `accepted`. */
export interface X402PaymentEnvelope {
  x402Version: number;
  scheme?: string;
  network?: string;
  accepted?: { scheme?: string; network?: string };
  payload: { transaction: string };
}

export type ParseResult =
  | { ok: true; tx: VersionedTransaction; version: 1 | 2 }
  | { ok: false; error: string };

/** Decode an X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2) header down to a deserialized transaction. */
export function parseXPayment(header: string, networks: readonly string[]): ParseResult {
  let envelope: X402PaymentEnvelope;
  try {
    envelope = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, error: "The payment header is not base64-encoded JSON" };
  }
  const scheme = envelope?.accepted?.scheme ?? envelope?.scheme;
  const network = envelope?.accepted?.network ?? envelope?.network;
  if (scheme !== "exact") return { ok: false, error: `Unsupported scheme: ${scheme}` };
  if (typeof network !== "string" || !networks.includes(network)) {
    return { ok: false, error: `Unsupported network: ${network} (this deployment takes ${networks.join(" or ")})` };
  }
  const b64 = envelope?.payload?.transaction;
  if (typeof b64 !== "string" || !b64) return { ok: false, error: "payload.transaction missing" };
  try {
    // VersionedMessage.deserialize handles both v0 and legacy wire formats.
    return { ok: true, tx: VersionedTransaction.deserialize(Buffer.from(b64, "base64")), version: envelope.x402Version === 2 ? 2 : 1 };
  } catch {
    return { ok: false, error: "payload.transaction is not a valid Solana transaction" };
  }
}

/**
 * One required transfer inside the payment: `owner`'s USDC account must
 * receive exactly `amountMicro`. The x402 route asks for one leg, the
 * platform's, since Enki sells the render and owes the artist a licence fee
 * (Kev, 2026-10-17); the check still takes any list of legs, exactly.
 */
export interface PaymentLegSpec {
  owner: PublicKey;
  amountMicro: number;
}

export interface VerifyParams {
  /** Every transfer the transaction MUST contain — no more, no fewer. */
  legs: PaymentLegSpec[];
  /** The USDC mint of the deployment's chain. */
  mint: PublicKey;
  /** Our fee payer — must be payer ONLY. */
  feePayer: PublicKey;
}

export type VerifyResult =
  | { ok: true; payer: PublicKey }
  | { ok: false; error: string };

/** Offline verification of the agent's partially-signed transaction. */
export function verifyAgentPayment(tx: VersionedTransaction, p: VerifyParams): VerifyResult {
  const msg = tx.message;

  if ((msg.addressTableLookups?.length ?? 0) > 0) {
    return { ok: false, error: "Address table lookups are not accepted — use static account keys" };
  }

  const keys = msg.staticAccountKeys;
  if (!keys.length || !keys[0].equals(p.feePayer)) {
    return { ok: false, error: "Transaction fee payer must be the feePayer from the 402 requirements" };
  }
  // The client and the fee payer, nobody else: each extra signer costs the fee payer 5,000 lamports (exact-svm §2.1.4).
  if (msg.header.numRequiredSignatures !== 2) {
    return { ok: false, error: "A payment carries exactly two signatures: the payer's and the fee payer's" };
  }
  if (msg.compiledInstructions.length > MAX_INSTRUCTIONS) {
    return { ok: false, error: `A payment has at most ${MAX_INSTRUCTIONS} instructions` };
  }
  let cuLimit: number | null = null;
  let cuPrice = BigInt(0);

  // Legs still to be satisfied, keyed by expected destination ATA.
  const wanted = p.legs.map((l) => ({
    // An author's vault is owned by a PDA, off the curve (lib/referral/shares).
    dest: getAssociatedTokenAddressSync(p.mint, l.owner, true),
    amount: BigInt(l.amountMicro),
    owner: l.owner,
  }));
  let payer: PublicKey | null = null;

  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program) return { ok: false, error: "Instruction references a missing program key" };
    const data = Buffer.from(ix.data);

    if (program.toBase58() === COMPUTE_BUDGET_PROGRAM) {
      // 2 = SetComputeUnitLimit (u32), 3 = SetComputeUnitPrice (u64).
      if (data[0] === 3) {
        if (data.length < 9 || data.readBigUInt64LE(1) > MAX_CU_PRICE_MICROLAMPORTS) {
          return { ok: false, error: "Compute unit price exceeds the facilitator ceiling" };
        }
        cuPrice = data.readBigUInt64LE(1);
      } else if (data[0] === 2) {
        if (data.length < 5 || data.readUInt32LE(1) > MAX_CU_LIMIT) {
          return { ok: false, error: `Compute unit limit exceeds ${MAX_CU_LIMIT}` };
        }
        cuLimit = data.readUInt32LE(1);
      } else {
        return { ok: false, error: "Only compute unit limit/price budget instructions are accepted" };
      }
      continue;
    }
    if (program.toBase58() === MEMO_PROGRAM || program.toBase58() === LIGHTHOUSE_PROGRAM) continue;

    if (program.equals(TOKEN_PROGRAM_ID)) {
      if (data[0] !== TRANSFER_CHECKED) return { ok: false, error: "Token instruction must be TransferChecked" };
      if (data.length < 10 || data[9] !== USDC_DECIMALS) {
        return { ok: false, error: "TransferChecked decimals must be 6 (USDC)" };
      }
      const amount = data.readBigUInt64LE(1);
      // TransferChecked accounts: source, mint, destination, authority.
      const [, mintIdx, destIdx, authIdx] = ix.accountKeyIndexes;
      const mint = keys[mintIdx], dest = keys[destIdx], authority = keys[authIdx];
      if (!mint?.equals(p.mint)) return { ok: false, error: "Transfer mint is not this deployment's USDC" };
      if (!authority) return { ok: false, error: "Transfer authority is missing" };
      // ONE buyer pays every leg — a second authority would mean co-signing
      // a stranger's transfer.
      if (payer && !payer.equals(authority)) {
        return { ok: false, error: "All transfers must share one authority" };
      }
      const at = wanted.findIndex((w) => dest?.equals(w.dest) && amount === w.amount);
      if (at < 0) {
        // The right recipient with another amount: the price moved since the quote (Kev, 2026-10-18: "write the clear message").
        const moved = wanted.find((w) => dest?.equals(w.dest));
        return {
          ok: false,
          error: moved
            ? `Your payment carries ${Number(amount) / 1_000_000} USDC, but the price is now ${Number(moved.amount) / 1_000_000} USDC (it changed since your quote). Pay the new amount — nothing was charged.`
            : `Unexpected transfer of ${amount} micro-USDC — the requirements' extra.legs list every required transfer (recipient and exact amount)`,
        };
      }
      wanted.splice(at, 1);
      payer = authority;
      continue;
    }

    return { ok: false, error: `Program ${program.toBase58()} is not accepted in a payment transaction` };
  }

  if (wanted.length > 0) {
    return {
      ok: false,
      error: `Missing transfer of ${wanted[0].amount} micro-USDC to ${wanted[0].owner.toBase58()} — build one TransferChecked per entry in extra.legs`,
    };
  }
  const transfer = payer ? { payer } : null;
  if (!transfer) return { ok: false, error: "No USDC TransferChecked instruction found" };

  // Without a limit instruction the runtime grants 200,000 units per other instruction.
  const others = msg.compiledInstructions.filter((ix) => keys[ix.programIdIndex]?.toBase58() !== COMPUTE_BUDGET_PROGRAM).length;
  const units = BigInt(cuLimit ?? Math.min(1_400_000, 200_000 * others));
  if ((units * cuPrice) / BigInt(1_000_000) > MAX_PRIORITY_FEE_LAMPORTS) {
    return { ok: false, error: `The payment's priority fee exceeds ${MAX_PRIORITY_FEE_LAMPORTS} lamports` };
  }

  // Fee payer safety: payer only. Any instruction touching it could spend it.
  const feePayerTouched = msg.compiledInstructions.some((ix) =>
    ix.accountKeyIndexes.some((i) => keys[i]?.equals(p.feePayer)),
  );
  if (feePayerTouched) {
    return { ok: false, error: "The fee payer may not appear in any instruction account" };
  }

  // The paying authority must be a REQUIRED SIGNER with a signature present.
  // (Cryptographic validity is the chain's job — submission runs preflight.)
  const authIdx = keys.findIndex((k) => k.equals(transfer!.payer));
  if (authIdx < 0 || authIdx >= msg.header.numRequiredSignatures) {
    return { ok: false, error: "Transfer authority is not a required signer of the transaction" };
  }
  const sig = tx.signatures[authIdx];
  if (!sig || sig.every((b) => b === 0)) {
    return { ok: false, error: "Transfer authority has not signed the transaction" };
  }

  return { ok: true, payer: transfer.payer };
}

/**
 * Co-sign as fee payer and return the transaction signature WITHOUT
 * submitting — the signature is deterministic, so the caller can run its
 * replay guard on it before anything is broadcast.
 */
export function cosignAsFeePayer(tx: VersionedTransaction, feePayer: Keypair): string {
  tx.sign([feePayer]);
  return bs58.encode(tx.signatures[0]);
}

/**
 * Simulate the co-signed payment with signature checks, before anything about
 * the request is decided. verifyAgentPayment checks the transaction's shape
 * only, so a forged signature or an empty payer would otherwise first fail at
 * submission, which a refused request never reaches: the answer to an
 * unpayable payment told a refused request from a clean one, for free.
 */
export async function simulatePayment(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<{ ok: true } | { ok: false; error: string; reason: SimulationReason }> {
  try {
    const { value } = await connection.simulateTransaction(tx, { sigVerify: true, commitment: "confirmed" });
    return value.err
      ? { ok: false, error: `Transaction simulation failed: ${JSON.stringify(value.err)}`, reason: simulationReason(value.err, tx) }
      : { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Transaction simulation failed";
    // The node refusing a signature it verifies strictly (JSON-RPC -32003, "Transaction signature verification
    // failure") answered about the payment: once its message is ours, only the payer's signature can fail that check (a
    // signature the library's cofactored check accepts). Read as an outage, /submit voided it as Enki's, outside every
    // pause, in a loop the fee payer paid for (round 30, 2026-10-21).
    return { ok: false, error, reason: /signature verification failure/i.test(error) ? "other" : "rpc" };
  }
}

/**
 * Why a payment would not settle, in terms an agent can act on (Kev,
 * 2026-10-18: "write the clear message"): the buyer's USDC is short or has no
 * account, the payment's blockhash expired, or Enki's fee payer cannot carry
 * the gas, which is Enki's side and never the buyer's.
 */
/** "rpc": the simulation itself could not run (the RPC threw): nothing about the payment is known (2026-10-19). */
export type SimulationReason = "payer_usdc" | "payer_no_account" | "expired" | "fee_payer" | "rpc" | "other";

export function simulationReason(err: unknown, tx: VersionedTransaction): SimulationReason {
  if (err === "BlockhashNotFound") return "expired";
  // The fee payer is account 0 and the only account whose SOL a payment spends.
  if (err === "InsufficientFundsForFee" || err === "AccountNotFound") return "fee_payer";
  const rent = (err as { InsufficientFundsForRent?: { account_index?: number } } | null)?.InsufficientFundsForRent;
  if (rent) return rent.account_index === 0 ? "fee_payer" : "other";
  const failed = tokenFailure(err, tx);
  if (!failed) return "other";
  // spl-token TokenError::InsufficientFunds is 1; a source account that does not exist reads as invalid data.
  if ((failed[1] as { Custom?: number } | null)?.Custom === 1) return "payer_usdc";
  if (failed[1] === "InvalidAccountData" || failed[1] === "UninitializedAccount") return "payer_no_account";
  return "other";
}

/** The failure, when it is on a token-program instruction: only those codes are about USDC (another program's Custom(1) is not). */
function tokenFailure(err: unknown, tx: VersionedTransaction): [number, unknown] | null {
  const failed = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  const ix = failed && tx.message?.compiledInstructions?.[failed[0]];
  return ix && tx.message.staticAccountKeys[ix.programIdIndex]?.equals(TOKEN_PROGRAM_ID) ? failed : null;
}

/**
 * Whether the chain refuses this payment on its token transfer, simulated
 * now: true when the transfer itself fails (the payer's USDC account is short,
 * re-owned, frozen or gone), false when it would pass or fails on anything
 * else (the fee payer, the nonce), null when the simulation cannot run (round
 * 4, 2026-10-19). Given the payment's signature, a payment that already failed
 * on chain is judged by its own error: its failure moved a durable nonce, so a
 * fresh simulation would only see the nonce (round 5, 2026-10-20: a buyer who
 * broadcast the held payment while it could not pay escaped the capture pause).
 */
export async function transferRefused(connection: Connection, tx: VersionedTransaction, signature?: string): Promise<boolean | null> {
  try {
    const own = signature ? (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0] : null;
    if (own?.err) return tokenFailure(own.err, tx) !== null;
    const { value } = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    return tokenFailure(value.err, tx) !== null;
  } catch {
    return null;
  }
}

/**
 * Whether a payment already landed on chain without an error. Simulation says
 * AlreadyProcessed only while the transaction's blockhash is in the status
 * cache (about a minute); after that it says BlockhashNotFound, so a retry
 * after a timeout must look the signature up in the history instead.
 */
export async function paymentLanded(connection: Connection, signature: string): Promise<boolean | null> {
  try {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    return Boolean(value[0] && !value[0].err);
  } catch {
    // Unknown, not absent: the caller must not tell the buyer nothing was charged.
    return null;
  }
}

/**
 * paymentLanded for a payment that releases an image (the intent rail): it
 * landed only once the cluster confirmed it. A payment only "processed" can
 * still be dropped, so it reads as unknown: the image is withheld and the
 * sweep asks again (round 4, 2026-10-19).
 */
export async function paymentConfirmed(
  connection: Connection,
  signature: string,
  { goneAtSlot }: { goneAtSlot?: number } = {},
): Promise<boolean | null> {
  try {
    const { context, value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = value[0];
    // "Not landed" only from a node that has seen the slot at which the payment's nonce account was gone: the payment
    // lands before its account goes, and a node behind that slot may not have seen it yet (round 5, 2026-10-20).
    if (!status) return goneAtSlot === undefined || context.slot >= goneAtSlot ? false : null;
    if (status.err) return false;
    return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" ? true : null;
  } catch {
    return null;
  }
}

/**
 * Submit WITH preflight (unlike the durable-nonce rails): this is a normal
 * recent-blockhash transaction, and preflight simulation is what rejects a
 * forged client signature or an empty payer balance before anything lands.
 *
 * The signature is fixed before the send and travels with every outcome. A
 * send that failed in transit, or was answered "already processed" after a
 * failover, is confirmed rather than believed (broadcastAndConfirm). Only a
 * rejection means nothing moved; anything else is pending: it may yet land.
 */
export type SubmitOutcome =
  | { ok: true; signature: string }
  | { ok: false; error: string; pending: boolean; signature: string };

export async function submitAndConfirm(
  connection: Connection,
  tx: VersionedTransaction | Transaction,
  timeoutMs = 45_000,
): Promise<SubmitOutcome> {
  const signature = bs58.encode(tx instanceof VersionedTransaction ? tx.signatures[0] : tx.signature!);
  try {
    await broadcastAndConfirm(connection, tx.serialize(), signature, { timeoutMs, maxRetries: 3 });
    return { ok: true, signature };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Transaction submission failed", pending: !(e instanceof Rejected), signature };
  }
}

/** The settlement header body the spec asks for on success: `payer` is the buyer's wallet (v1 :211, v2 :248). */
export function paymentResponseHeader(signature: string, network: string, payer: PublicKey): string {
  return Buffer.from(
    JSON.stringify({ success: true, transaction: signature, network, payer: payer.toBase58() }),
  ).toString("base64");
}
