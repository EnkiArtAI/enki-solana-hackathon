import { describe, it, expect } from "vitest";
import { ComputeBudgetProgram, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { paymentConfirmed, paymentLanded, simulatePayment, simulationReason, transferRefused } from "@/lib/payments/x402-settle";

/** An unpayable payment is refused before anything about the request is decided (round-3 review). */
const conn = (result: { err: unknown } | Error) => ({
  simulateTransaction: async (_tx: unknown, opts: { sigVerify?: boolean }) => {
    if (!opts?.sigVerify) throw new Error("signatures were not checked");
    if (result instanceof Error) throw result;
    return { value: result };
  },
}) as unknown as Connection;
const tx = {} as VersionedTransaction;

describe("simulating an agent's payment", () => {
  it("passes a payment that would settle, with its signatures checked", async () => {
    expect(await simulatePayment(conn({ err: null }), tx)).toEqual({ ok: true });
  });

  it("refuses a forged signature or an empty payer", async () => {
    expect(await simulatePayment(conn({ err: "SignatureFailure" }), tx)).toEqual({ ok: false, error: 'Transaction simulation failed: "SignatureFailure"', reason: "other" });
  });

  it("names the reason an agent can act on", async () => {
    expect(await simulatePayment(conn({ err: "BlockhashNotFound" }), tx)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses when the node cannot simulate", async () => {
    expect((await simulatePayment(conn(new Error("node down")), tx)).ok).toBe(false);
    // Nothing about the payment is known: its own reason, so no caller blames the payer (2026-10-19).
    expect(await simulatePayment(conn(new Error("node down")), tx)).toMatchObject({ ok: false, reason: "rpc" });
    // The node refusing the payer's signature answered: the payer's, never an outage (round 30, 2026-10-21).
    expect(await simulatePayment(conn(new Error("failed to simulate transaction: Transaction signature verification failure")), tx)).toMatchObject({ ok: false, reason: "other" });
    // The node's own trouble, with web3's prefix, stays an outage (round 31).
    expect(await simulatePayment(conn(new Error("failed to simulate transaction: Node is behind by 42 slots")), tx)).toMatchObject({ ok: false, reason: "rpc" });
  });
});

describe("a payment that already landed", () => {
  const history = (status: { err: unknown; confirmationStatus?: string } | null, opts: { fail?: boolean } = {}) => ({
    getSignatureStatuses: async (_s: string[], o: { searchTransactionHistory?: boolean }) => {
      if (opts.fail) throw new Error("node down");
      if (!o?.searchTransactionHistory) return { value: [null] };
      return { value: [status] };
    },
  }) as unknown as Connection;

  it("is found in the signature history once its blockhash is gone", async () => {
    expect(await paymentLanded(history({ err: null }), "sig")).toBe(true);
  });

  it("is not a landing when it failed on chain, or is unknown", async () => {
    expect(await paymentLanded(history({ err: { InstructionError: [0, "x"] } }), "sig")).toBe(false);
    expect(await paymentLanded(history(null), "sig")).toBe(false);
    // A lookup that fails is unknown, never "not landed" (review 2026-10-18).
    expect(await paymentLanded(history(null, { fail: true }), "sig")).toBeNull();
  });

  it("says not landed only from a node that has seen the slot its account was gone at (round 5, 2026-10-20)", async () => {
    const at = (slot: number, status: unknown) => ({
      getSignatureStatuses: async () => ({ context: { slot }, value: [status] }),
    }) as unknown as Connection;
    expect(await paymentConfirmed(at(120, null), "sig", { goneAtSlot: 120 })).toBe(false);
    expect(await paymentConfirmed(at(119, null), "sig", { goneAtSlot: 120 })).toBeNull();
    // A status it has is an answer whatever its slot.
    expect(await paymentConfirmed(at(10, { err: null, confirmationStatus: "finalized" }), "sig", { goneAtSlot: 120 })).toBe(true);
    expect(await paymentConfirmed(at(10, { err: { InstructionError: [2, { Custom: 1 }] } }), "sig", { goneAtSlot: 120 })).toBe(false);
  });

  it("releases an image only once the cluster confirmed it: processed is not yet landed (round 4, 2026-10-19)", async () => {
    expect(await paymentConfirmed(history({ err: null, confirmationStatus: "confirmed" }), "sig")).toBe(true);
    expect(await paymentConfirmed(history({ err: null, confirmationStatus: "finalized" }), "sig")).toBe(true);
    expect(await paymentConfirmed(history({ err: null, confirmationStatus: "processed" }), "sig")).toBeNull();
    expect(await paymentConfirmed(history({ err: { InstructionError: [0, "x"] }, confirmationStatus: "confirmed" }), "sig")).toBe(false);
    // Asked over the history, as a payment older than its blockhash needs.
    expect(await paymentConfirmed(history(null), "sig")).toBe(false);
    expect(await paymentConfirmed(history(null, { fail: true }), "sig")).toBeNull();
  });
});

/** Why a payment would not settle, in terms an agent can act on (Kev, 2026-10-18: "write the clear message"). */
describe("the reason a payment would not settle", () => {
  const mint = Keypair.generate().publicKey, buyer = Keypair.generate().publicKey, payTo = Keypair.generate().publicKey;
  // As PayBox builds it: two budget instructions, the TransferChecked at index 2, a memo at index 3.
  const payment = new VersionedTransaction(new TransactionMessage({
    payerKey: Keypair.generate().publicKey,
    recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, buyer), mint, getAssociatedTokenAddressSync(mint, payTo), buyer, 7_560, 6),
      new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from("x") }),
    ],
  }).compileToV0Message());

  it("reads the token program's InsufficientFunds as the buyer's USDC being short", () => {
    expect(simulationReason({ InstructionError: [2, { Custom: 1 }] }, payment)).toBe("payer_usdc");
  });

  it("reads a source account that does not exist as the buyer having no USDC account", () => {
    expect(simulationReason({ InstructionError: [2, "InvalidAccountData"] }, payment)).toBe("payer_no_account");
    expect(simulationReason({ InstructionError: [2, "UninitializedAccount"] }, payment)).toBe("payer_no_account");
  });

  it("does not read another program's Custom(1) or a missing instruction as the buyer's USDC", () => {
    expect(simulationReason({ InstructionError: [3, { Custom: 1 }] }, payment)).toBe("other");
    expect(simulationReason({ InstructionError: [0, { Custom: 1 }] }, payment)).toBe("other");
    expect(simulationReason({ InstructionError: [9, { Custom: 1 }] }, payment)).toBe("other");
    expect(simulationReason({ InstructionError: [2, { Custom: 3 }] }, payment)).toBe("other");
  });

  it("reads an expired blockhash as an expired payment", () => {
    expect(simulationReason("BlockhashNotFound", payment)).toBe("expired");
  });

  it("puts a fee payer without SOL on Enki's side, and only account 0's rent", () => {
    expect(simulationReason("InsufficientFundsForFee", payment)).toBe("fee_payer");
    expect(simulationReason("AccountNotFound", payment)).toBe("fee_payer");
    expect(simulationReason({ InsufficientFundsForRent: { account_index: 0 } }, payment)).toBe("fee_payer");
    expect(simulationReason({ InsufficientFundsForRent: { account_index: 1 } }, payment)).toBe("other");
  });

  it("leaves everything else to the raw error", () => {
    expect(simulationReason("SignatureFailure", payment)).toBe("other");
    expect(simulationReason(null, payment)).toBe("other");
  });

  /** Whose failure an intent capture is (round 4, 2026-10-19). */
  const sim = (err: unknown) => ({
    simulateTransaction: async () => { if (err instanceof Error) throw err; return { value: { err } }; },
  }) as unknown as Connection;

  it("blames the payer for any refusal on the token transfer: short, re-owned, frozen, gone", async () => {
    for (const code of [{ Custom: 1 }, { Custom: 4 }, { Custom: 17 }, "InvalidAccountData"]) {
      expect(await transferRefused(sim({ InstructionError: [2, code] }), payment)).toBe(true);
    }
  });

  it("does not blame the payer for a payment that would pass, a fee payer, a nonce or another program", async () => {
    for (const err of [null, "InsufficientFundsForFee", "BlockhashNotFound", { InstructionError: [3, { Custom: 1 }] }, { InstructionError: [0, { Custom: 1 }] }]) {
      expect(await transferRefused(sim(err), payment)).toBe(false);
    }
  });

  it("knows nothing when the simulation cannot run", async () => {
    expect(await transferRefused(sim(new Error("node down")), payment)).toBeNull();
  });

  /** The held payment's own landing, asked over the history; a simulation only when it has not failed (round 5, 2026-10-20). */
  const landed = (own: { err: unknown } | null, simulated: unknown = null, asked: string[] = []) => ({
    getSignatureStatuses: async (sigs: string[], o: { searchTransactionHistory?: boolean }) => {
      asked.push(`status:${sigs.join(",")}:${o?.searchTransactionHistory === true}`);
      return { value: [own] };
    },
    simulateTransaction: async () => { asked.push("simulate"); return { value: { err: simulated } }; },
  }) as unknown as Connection;

  it("judges a payment that already failed on chain by its own error, not by a fresh simulation", async () => {
    const asked: string[] = [];
    // The buyer broadcast it while their USDC was short: the nonce moved, a simulation would only say BlockhashNotFound.
    expect(await transferRefused(landed({ err: { InstructionError: [2, { Custom: 1 }] } }, "BlockhashNotFound", asked), payment, "HeldSig")).toBe(true);
    expect(asked).toEqual(["status:HeldSig:true"]);
    expect(await transferRefused(landed({ err: "InsufficientFundsForFee" }), payment, "HeldSig")).toBe(false);
  });

  it("simulates a payment that has not failed on chain, and without a signature asks nothing first", async () => {
    const asked: string[] = [];
    expect(await transferRefused(landed(null, { InstructionError: [2, { Custom: 4 }] }, asked), payment, "HeldSig")).toBe(true);
    expect(asked).toEqual(["status:HeldSig:true", "simulate"]);
    const none: string[] = [];
    expect(await transferRefused(landed({ err: { InstructionError: [2, { Custom: 1 }] } }, null, none), payment)).toBe(false);
    expect(none).toEqual(["simulate"]);
  });
});
