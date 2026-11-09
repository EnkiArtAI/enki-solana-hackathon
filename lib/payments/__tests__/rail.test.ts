import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";

/**
 * The one switch between the web rails (Kev, 2026-10-18: "so, dass wir das
 * einfach umknipsen auf escrow können"): escrow only when its program is
 * configured and deployed on the payment chain, intents otherwise.
 */
const s = vi.hoisted(() => ({ account: vi.fn() }));
vi.mock("@/lib/payments/solana", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/solana")>()),
  solanaConnection: () => ({ getAccountInfo: (...a: unknown[]) => s.account(...a) }),
}));

import { escrowDeployed, paymentRail, railOf, resetPaymentRailCache } from "@/lib/payments/rail";

const PROGRAM = Keypair.generate().publicKey.toBase58();
beforeEach(() => {
  resetPaymentRailCache();
  s.account.mockReset();
  vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana");
  vi.stubEnv("SOLANA_ESCROW_PROGRAM_ID", PROGRAM);
  vi.stubEnv("SOLANA_FEE_PAYER_SECRET_KEY", JSON.stringify(Array.from(Keypair.generate().secretKey)));
});
afterEach(() => vi.unstubAllEnvs());

describe("the web payment rail", () => {
  it("is escrow when its program is deployed on the payment chain", async () => {
    s.account.mockResolvedValue({ executable: true });
    expect(await paymentRail()).toBe("escrow");
    expect(String(s.account.mock.calls[0][0])).toBe(PROGRAM);
  });

  it("is intents when no program id is set, or the id finds no program there (a devnet id in a mainnet env)", async () => {
    vi.stubEnv("SOLANA_ESCROW_PROGRAM_ID", "");
    expect(await paymentRail()).toBe("intent");
    expect(s.account).not.toHaveBeenCalled();
    vi.stubEnv("SOLANA_ESCROW_PROGRAM_ID", PROGRAM);
    s.account.mockResolvedValue(null);
    expect(await paymentRail()).toBe("intent");
    resetPaymentRailCache();
    s.account.mockResolvedValue({ executable: false });
    expect(await paymentRail()).toBe("intent");
  });

  it("asks the chain once per program, then again after the program id changes", async () => {
    s.account.mockResolvedValue({ executable: true });
    await paymentRail();
    await paymentRail();
    expect(s.account).toHaveBeenCalledTimes(1);
    vi.stubEnv("SOLANA_ESCROW_PROGRAM_ID", Keypair.generate().publicKey.toBase58());
    s.account.mockResolvedValue(null);
    expect(await paymentRail()).toBe("intent");
    expect(s.account).toHaveBeenCalledTimes(2);
  });

  it("asks again after five minutes", async () => {
    vi.useFakeTimers();
    try {
      s.account.mockResolvedValue({ executable: true });
      await paymentRail();
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await paymentRail();
      expect(s.account).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last answer when the chain cannot answer, and falls back to intents without one", async () => {
    s.account.mockRejectedValue(new Error("rpc down"));
    expect(await paymentRail()).toBe("intent");
    resetPaymentRailCache();
    s.account.mockResolvedValueOnce({ executable: true });
    expect(await paymentRail()).toBe("escrow");
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(5 * 60_000 + 1);
      s.account.mockRejectedValue(new Error("rpc down"));
      expect(await paymentRail()).toBe("escrow");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("whether the escrow program is deployed, for a decision that must not guess (round 20, 2026-10-20)", () => {
  it("answers from the chain or its cache, and throws when the chain cannot answer and nothing is cached", async () => {
    s.account.mockResolvedValueOnce({ executable: true });
    expect(await escrowDeployed()).toBe(true);
    s.account.mockRejectedValue(new Error("rpc down"));
    // Cached: the last answer.
    expect(await escrowDeployed()).toBe(true);
    resetPaymentRailCache();
    await expect(escrowDeployed()).rejects.toThrow("could not be read");
    // paymentRail keeps its fallback.
    expect(await paymentRail()).toBe("intent");
    s.account.mockResolvedValueOnce(null);
    expect(await escrowDeployed()).toBe(false);
    vi.stubEnv("SOLANA_ESCROW_PROGRAM_ID", "");
    resetPaymentRailCache();
    expect(await escrowDeployed()).toBe(false);
  });
});

describe("the rail of an existing order", () => {
  it("follows the row, not the switch", () => {
    expect(railOf({ nonce_account: "N" })).toBe("intent");
    expect(railOf({ batch_intent_id: "b" })).toBe("intent");
    expect(railOf({ deposit_signature: "s" })).toBe("escrow");
    expect(railOf({})).toBeNull();
  });
});
