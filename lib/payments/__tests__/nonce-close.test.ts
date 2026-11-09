import { describe, it, expect, vi } from "vitest";
import { Keypair, NONCE_ACCOUNT_LENGTH, SystemInstruction, SystemProgram, Transaction, type Connection } from "@solana/web3.js";

/** Closing a durable nonce (round 6, 2026-10-20): only the nonce itself is closed; anything else at its address is gone. */
const broadcast = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/payments/solana", () => ({ broadcastAndConfirm: (...a: unknown[]) => broadcast(...(a as [])) }));

import { closeNonceAccount, createNonceAccount } from "@/lib/payments/nonce";

const ADDRESS = Keypair.generate().publicKey.toBase58();
const conn = (info: { data: Buffer; lamports: number } | null) => ({
  getAccountInfo: async () => info,
  getLatestBlockhash: async () => ({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 1 }),
}) as unknown as Connection;

describe("closing a nonce account", () => {
  it("withdraws a nonce that is there", async () => {
    broadcast.mockClear();
    const authority = Keypair.generate();
    expect(await closeNonceAccount(conn({ data: Buffer.alloc(NONCE_ACCOUNT_LENGTH), lamports: 1_447_680 }), ADDRESS, authority)).toBe("closed");
    expect(broadcast).toHaveBeenCalledTimes(1);
    // Its whole balance, to the authority, signed by the authority: a partial withdrawal leaves the account alive (round 30).
    const tx = Transaction.from(broadcast.mock.calls[0][1] as Buffer);
    expect(tx.instructions).toHaveLength(1);
    expect(SystemInstruction.decodeNonceWithdraw(tx.instructions[0])).toEqual({
      noncePubkey: expect.objectContaining({}), authorizedPubkey: authority.publicKey, toPubkey: authority.publicKey, lamports: 1_447_680,
    });
    expect(SystemInstruction.decodeNonceWithdraw(tx.instructions[0]).noncePubkey.toBase58()).toBe(ADDRESS);
  });

  it("creates a rent-exempt, nonce-sized account whose authority is the fee payer (round 30, 2026-10-21)", async () => {
    broadcast.mockClear();
    const feePayer = Keypair.generate();
    const nonceKey = Keypair.generate();
    const node = {
      getMinimumBalanceForRentExemption: async (size: number) => (size === NONCE_ACCOUNT_LENGTH ? 1_447_680 : 0),
      getLatestBlockhash: async () => ({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 1 }),
      getAccountInfo: async () => ({ data: Buffer.alloc(NONCE_ACCOUNT_LENGTH), lamports: 1_447_680 }),
    } as unknown as Connection;
    await createNonceAccount(node, feePayer, nonceKey);
    const tx = Transaction.from(broadcast.mock.calls[0][1] as Buffer);
    const created = SystemInstruction.decodeCreateAccount(tx.instructions[0]);
    expect(created).toMatchObject({ lamports: 1_447_680, space: NONCE_ACCOUNT_LENGTH });
    expect(created.programId.equals(SystemProgram.programId)).toBe(true);
    expect(created.newAccountPubkey.equals(nonceKey.publicKey)).toBe(true);
    const init = SystemInstruction.decodeNonceInitialize(tx.instructions[1]);
    expect(init.authorizedPubkey.equals(feePayer.publicKey)).toBe(true);
    expect(init.noncePubkey.equals(nonceKey.publicKey)).toBe(true);
  });

  it("calls an empty address, or SOL someone sent to it after the close, gone, and sends nothing", async () => {
    broadcast.mockClear();
    expect(await closeNonceAccount(conn(null), ADDRESS, Keypair.generate())).toBe("gone");
    expect(await closeNonceAccount(conn({ data: Buffer.alloc(0), lamports: 5_000 }), ADDRESS, Keypair.generate())).toBe("gone");
    expect(broadcast).not.toHaveBeenCalled();
  });
});
