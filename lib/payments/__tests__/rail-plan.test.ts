import { describe, it, expect, vi } from "vitest";
import type { Connection } from "@solana/web3.js";

/**
 * The plan /authorize stores with a nonce-rail intent (2026-10-18): the
 * priority fee is priced once, and every artist share is paid through Enki's
 * leg and owed as a licence credit once delivered, the x402 merchant model
 * (round 4, 2026-10-19).
 */
const missing = vi.fn(async (owners: string[]) => owners.slice(0, 0));
vi.mock("@/lib/payments/solana-transfer", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/solana-transfer")>()),
  findMissingAtas: (owners: string[]) => missing(owners),
}));

import { railPlanOf, planFor, legsFor, type IntentRow } from "@/lib/payments/authorize-flow";

const ENKI = "EnkiTreasury";
const ARTIST = "ArtistWallet";
const intent = (over: Partial<IntentRow> = {}): IntentRow => ({
  id: "i-1", buyer_wallet: "B", artist_wallet: ARTIST, artist_amount_micro: 1_000_000,
  model_cost_micro: 6_300, enki_fee_micro: 100_630, total_micro: 1_106_930, nonce_account: "N", fronted_atas: null, ...over,
});
const conn = (fees: number[]) => ({ getRecentPrioritizationFees: async () => fees.map((prioritizationFee) => ({ prioritizationFee, slot: 1 })) }) as unknown as Connection;

describe("railPlanOf", () => {
  it("reads a stored plan, and a row without one as no price and the artist's own leg", () => {
    expect(railPlanOf({ cuPriceMicroLamports: 700, artistWithheld: true })).toEqual({ cuPriceMicroLamports: 700, artistWithheld: true });
    expect(railPlanOf(null)).toEqual({ cuPriceMicroLamports: 0, artistWithheld: false });
    expect(railPlanOf([{ owner: "x" }])).toEqual({ cuPriceMicroLamports: 0, artistWithheld: false });
    expect(railPlanOf({ cuPriceMicroLamports: -1, artistWithheld: "yes" })).toEqual({ cuPriceMicroLamports: 0, artistWithheld: false });
    expect(railPlanOf({ cuPriceMicroLamports: 1.5 })).toEqual({ cuPriceMicroLamports: 0, artistWithheld: false });
  });
});

describe("planFor", () => {
  it("prices the p75 fee and withholds the artist's share, whatever the artist's account (round 4, 2026-10-19)", async () => {
    missing.mockClear();
    expect(await planFor(intent(), conn([10, 20, 30, 40, 50]))).toEqual({ cuPriceMicroLamports: 40, artistWithheld: true });
    expect((await planFor(intent({ artist_wallet: null }), conn([]))).artistWithheld).toBe(true);
    // Nothing about the artist's account is asked any more.
    expect(missing).not.toHaveBeenCalled();
  });

  it("withholds nothing for a free prompt", async () => {
    expect((await planFor(intent({ artist_amount_micro: 0, artist_wallet: null, enki_fee_micro: 630, total_micro: 6_930 }), conn([]))).artistWithheld).toBe(false);
  });
});

describe("legsFor", () => {
  it("pays the artist and Enki their split when nothing is withheld", () => {
    expect(legsFor(intent(), ENKI, { cuPriceMicroLamports: 0, artistWithheld: false })).toEqual([
      { recipient: ARTIST, amountMicro: 1_000_000 },
      { recipient: ENKI, amountMicro: 106_930 },
    ]);
  });

  it("pays the whole total to Enki when the artist's share is withheld", () => {
    expect(legsFor(intent(), ENKI, { cuPriceMicroLamports: 0, artistWithheld: true })).toEqual([{ recipient: ENKI, amountMicro: 1_106_930 }]);
  });

  it("still refuses a row whose split does not add up", () => {
    expect(() => legsFor(intent({ total_micro: 1 }), ENKI, { cuPriceMicroLamports: 0, artistWithheld: true })).toThrow(/Split invariant/);
  });
});

describe("authorizationFor rebuilds from the stored plan", () => {
  it("uses the stored price and, when the artist's share is withheld, one transfer to Enki", async () => {
    const { Keypair, ComputeBudgetInstruction, ComputeBudgetProgram } = await import("@solana/web3.js");
    const { TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
    const fee = Keypair.generate();
    vi.stubEnv("SOLANA_FEE_PAYER_SECRET_KEY", JSON.stringify(Array.from(fee.secretKey)));
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
    (await import("@/lib/payments/solana")).resetFeePayerCache();
    const { authorizationFor } = await import("@/lib/payments/authorize-flow");
    const key = () => Keypair.generate().publicKey.toBase58();
    const row = intent({ artist_wallet: key(), nonce_account: key(), fronted_atas: { cuPriceMicroLamports: 777, artistWithheld: true } });
    const { transaction } = authorizationFor(row, key(), "6zRZaKfDGdKRvSaBnFVE9RarFAbn9DsWwVAKrTLbLNKZ", key());
    const price = transaction.instructions.find((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ComputeBudgetInstruction.decodeInstructionType(ix) === "SetComputeUnitPrice");
    expect(Number(ComputeBudgetInstruction.decodeSetComputeUnitPrice(price!).microLamports)).toBe(777);
    expect(transaction.instructions.filter((ix) => ix.programId.equals(TOKEN_PROGRAM_ID))).toHaveLength(1);
    vi.unstubAllEnvs();
  });
});
