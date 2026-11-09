/**
 * Building the transaction the buyer signs but nobody broadcasts yet.
 *
 * This is the whole authorise-then-capture trick in one function. An ordinary
 * Solana transaction carries a recent blockhash and dies about 90 seconds
 * later, which is useless as an authorisation — the generation is not finished
 * by then. A DURABLE NONCE transaction carries a nonce value instead and never
 * expires, so a signature can sit unbroadcast for as long as the work takes.
 *
 * Three details make or break it, and all three are silent failures rather
 * than loud ones, which is why each has a test:
 *
 *   1. AdvanceNonceAccount MUST be the first instruction. The runtime looks at
 *      instruction zero and nowhere else; put it second and the transaction is
 *      rejected as having a stale blockhash.
 *   2. recentBlockhash MUST be the nonce VALUE, not a blockhash. It is the
 *      field's name that misleads here — with a real blockhash the nonce is
 *      never consumed and the transaction expires like any other.
 *   3. The fee payer is Enki, never the buyer. Buyers hold USDC and no SOL.
 *
 * Amounts and recipients come from paymentLegs(), which reads them from the
 * intent row. Nothing a client sent ever reaches this file.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  type Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { PaymentLeg } from "@/lib/payments/generation-pay";
import { USDC_DECIMALS } from "@/lib/payments/solana-transfer";

/**
 * The nonce advance and two TransferChecked need under 20k compute units. A
 * limit keeps the priority fee priced on what runs, not on 200k units per
 * instruction, since Enki pays it even when the capture fails on chain.
 */
export const INTENT_CU_LIMIT = 30_000;

export interface AuthorizationTxParams {
  nonceAccount: PublicKey;
  nonceAuthority: PublicKey;
  /** The value currently stored in the nonce account, base58. */
  nonce: string;
  feePayer: PublicKey;
  buyer: PublicKey;
  mint: PublicKey;
  /**
   * Every leg pays an owner whose USDC account already exists: Enki fronts no
   * account (Kev, 2026-10-18). A fronted account's rent went back to whoever
   * closed it, which made fronting a way to farm Enki's SOL.
   */
  legs: PaymentLeg[];
  /** Priced once at /authorize and stored with the intent, so /submit rebuilds the same bytes; 0 adds no price instruction. */
  cuPriceMicroLamports: number;
}

export interface BuiltAuthorization {
  transaction: Transaction;
}

export function buildAuthorizationTx(params: AuthorizationTxParams): BuiltAuthorization {
  const { nonceAccount, nonceAuthority, nonce, feePayer, buyer, mint, legs, cuPriceMicroLamports } = params;
  if (legs.length === 0) throw new Error("Refusing to build a payment with no legs");

  const tx = new Transaction();

  // (1) Instruction zero, always. Advancing the nonce is also what makes the
  // signature single-use: once this lands, the stored value changes and the
  // same transaction can never be replayed.
  tx.add(
    SystemProgram.nonceAdvance({
      noncePubkey: nonceAccount,
      authorizedPubkey: nonceAuthority,
    }),
  );

  // Right after the advance, never before it: the runtime reads the nonce from instruction zero only.
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: INTENT_CU_LIMIT }));
  if (cuPriceMicroLamports > 0) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports }));

  const buyerAta = getAssociatedTokenAddressSync(mint, buyer);

  for (const leg of legs) {
    const ata = getAssociatedTokenAddressSync(mint, new PublicKey(leg.recipient));
    tx.add(
      createTransferCheckedInstruction(
        buyerAta,
        mint,
        ata,
        buyer,
        BigInt(leg.amountMicro),
        USDC_DECIMALS,
      ),
    );
  }

  // (2) The nonce value stands in for the blockhash. This is what removes the
  // expiry, and therefore what lets the abort condition be a heartbeat.
  tx.recentBlockhash = nonce;
  // (3) Enki pays. The buyer signs for their own token transfers and needs no
  // SOL of their own.
  tx.feePayer = feePayer;

  return { transaction: tx };
}

/**
 * Add Enki's signature before the buyer ever sees the transaction.
 *
 * Signing first is safe and saves a round trip: our signature alone authorises
 * nothing, because every transfer still needs the buyer's. It also means the
 * buyer's wallet receives something complete apart from their own signature,
 * which is what a wallet UI can display honestly.
 */
export function signAsEnki(tx: Transaction, feePayer: Keypair): string {
  tx.partialSign(feePayer);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

/**
 * The transaction's id once Enki signed it: the fee payer's signature, slot 0.
 * Known before the buyer signs, so a payment the buyer broadcasts without ever
 * submitting it can still be looked up (review 2026-10-18).
 */
export function feePayerSignature(tx: Transaction): string {
  return bs58.encode(tx.signature!);
}

/**
 * Re-read what the buyer sent back, and refuse anything that is not the
 * transaction we built.
 *
 * A buyer returning a DIFFERENT signed transaction is the obvious attack —
 * same nonce, transfers redirected or shrunk. Comparing the serialised message
 * catches every variation of it at once, because the message covers the
 * instructions, the accounts, the amounts and the fee payer. Signatures are
 * excluded from that comparison, which is the point: they are the only part
 * that legitimately differs.
 */
export function matchesBuiltTransaction(signedBase64: string, built: Transaction): boolean {
  try {
    const signed = Transaction.from(Buffer.from(signedBase64, "base64"));
    return signed.serializeMessage().equals(built.serializeMessage());
  } catch {
    return false;
  }
}

/**
 * Did the buyer actually sign it?
 *
 * matchesBuiltTransaction above answers a different question and says so: it
 * compares the MESSAGE and deliberately ignores signatures, because those are
 * the only part that legitimately differs. That reasoning is sound for the
 * attack it was written against — a returned transaction with the transfers
 * redirected or shrunk — and it has a blind spot the size of the whole
 * product: a signature can simply be ABSENT.
 *
 * The authorize route hands the buyer a transaction Enki has already
 * partial-signed. Echoing it back unchanged therefore passes a message
 * comparison perfectly, because it IS our message. Nothing else in the stack
 * looked at signatures — `verifySignatures` appeared nowhere in the codebase —
 * so the intent was marked authorised, the generation ran, and the buyer got
 * their image. The failure only surfaced later, inside settle(), where
 * Transaction.serialize() throws "Signature verification failed" — after
 * the capture had already written captured_at (0481edd9), and inside a try whose
 * catch returns null. The route logs "delivered but not captured" and returns
 * the image anyway.
 *
 * verifySignatures() defaults to requiring ALL signers, which here is Enki as
 * fee payer plus the buyer as the owner of every transferChecked. So one call
 * covers both "is it signed" and "is the signature valid over this message".
 */
export function hasRequiredSignatures(signedBase64: string): boolean {
  try {
    return Transaction.from(Buffer.from(signedBase64, "base64")).verifySignatures();
  } catch {
    return false;
  }
}
