import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { computeGenerationSplit, X402_ENKI_FEE_BPS } from "@/lib/payments/generation-pricing";
import { authorVaultOwner, shareLegs, sharesOf, type PromptShares } from "../shares";

/**
 * A referred prompt's shares leave the buyer's own transaction (Kev,
 * 2026-10-14; docs/ESCROW-V2-SHARES.md): a quarter of Enki's fee to the
 * referrer and a quarter into the author's vault until the author claims,
 * then half to the author's wallet and nothing to the referrer. Floored,
 * the rest stays Enki's, the legs always add up.
 */
const PROGRAM = new PublicKey("2sfm76FMcfqUYCv47J4VCNFMrp6PpfD6QYpmWqBCPyJV");
const PAY_TO = Keypair.generate().publicKey.toBase58();
const REFERRER = Keypair.generate().publicKey.toBase58();
const AUTHOR = Keypair.generate().publicKey.toBase58();
const ARTIST = Keypair.generate().publicKey.toBase58();
const VAULT = authorVaultOwner(PROGRAM, "42").toBase58();
const free = computeGenerationSplit(0, 100_000);
const sum = (legs: { amountMicro: number }[]) => legs.reduce((n, l) => n + l.amountMicro, 0);

describe("shareLegs", () => {
  it("pays a quarter of the fee to the referrer and a quarter into the author's vault before the claim", () => {
    const shares: PromptShares = { referrerWallet: REFERRER, author: { kind: "vault", owner: VAULT }, claimed: false };
    const legs = shareLegs({ split: free, artistWallet: null, payTo: PAY_TO, shares });
    expect(free.enkiFeeMicro).toBe(10_000);
    expect(legs).toEqual([
      { recipient: PAY_TO, amountMicro: 110_000 - 2_500 - 2_500, role: "enki" },
      { recipient: REFERRER, amountMicro: 2_500, role: "referrer" },
      { recipient: VAULT, amountMicro: 2_500, role: "author" },
    ]);
    expect(sum(legs)).toBe(free.totalMicro);
  });

  it("pays half of the fee to the author's wallet and nothing to the referrer after the claim", () => {
    const shares: PromptShares = { referrerWallet: REFERRER, author: { kind: "wallet", owner: AUTHOR }, claimed: true };
    const legs = shareLegs({ split: free, artistWallet: null, payTo: PAY_TO, shares });
    expect(legs).toEqual([
      { recipient: PAY_TO, amountMicro: 110_000 - 5_000, role: "enki" },
      { recipient: AUTHOR, amountMicro: 5_000, role: "author" },
    ]);
    expect(sum(legs)).toBe(free.totalMicro);
  });

  it("after a claim nobody holds right now, pays the author's half into the vault and still nothing to the referrer", () => {
    const shares: PromptShares = { referrerWallet: REFERRER, author: { kind: "vault", owner: VAULT }, claimed: true };
    const legs = shareLegs({ split: free, artistWallet: null, payTo: PAY_TO, shares });
    expect(legs).toEqual([
      { recipient: PAY_TO, amountMicro: 110_000 - 5_000, role: "enki" },
      { recipient: VAULT, amountMicro: 5_000, role: "author" },
    ]);
    expect(sum(legs)).toBe(free.totalMicro);
  });

  it("keeps the artist's leg first on a priced prompt, and the shares of the fee after Enki's", () => {
    const priced = computeGenerationSplit(50_000, 100_000);
    const shares: PromptShares = { referrerWallet: REFERRER, author: { kind: "vault", owner: VAULT }, claimed: false };
    const legs = shareLegs({ split: priced, artistWallet: ARTIST, payTo: PAY_TO, shares });
    expect(priced.enkiFeeMicro).toBe(15_000);
    expect(legs.map((l) => l.recipient)).toEqual([ARTIST, PAY_TO, REFERRER, VAULT]);
    expect(legs.map((l) => l.role)).toEqual(["artist", "enki", "referrer", "author"]);
    expect(legs[0].amountMicro).toBe(50_000);
    expect(legs[2].amountMicro).toBe(3_750);
    expect(legs[3].amountMicro).toBe(3_750);
    expect(sum(legs)).toBe(priced.totalMicro);
  });

  it("floors each share and leaves the rest in Enki's leg, so the legs add up to the total", () => {
    const odd = computeGenerationSplit(0, 100_030);
    expect(odd.enkiFeeMicro).toBe(10_003);
    const legs = shareLegs({ split: odd, artistWallet: null, payTo: PAY_TO, shares: { referrerWallet: REFERRER, author: { kind: "vault", owner: VAULT }, claimed: false } });
    expect(legs[1].amountMicro).toBe(2_500);
    expect(legs[2].amountMicro).toBe(2_500);
    expect(sum(legs)).toBe(odd.totalMicro);
  });

  it("holds nothing for anyone: no wallet, no leg; no X id, no vault; not referred, the old two legs", () => {
    expect(shareLegs({ split: free, artistWallet: null, payTo: PAY_TO, shares: { referrerWallet: null, author: { kind: "vault", owner: VAULT }, claimed: false } }))
      .toEqual([{ recipient: PAY_TO, amountMicro: 107_500, role: "enki" }, { recipient: VAULT, amountMicro: 2_500, role: "author" }]);
    expect(shareLegs({ split: free, artistWallet: null, payTo: PAY_TO, shares: { referrerWallet: REFERRER, author: null, claimed: false } }))
      .toEqual([{ recipient: PAY_TO, amountMicro: 107_500, role: "enki" }, { recipient: REFERRER, amountMicro: 2_500, role: "referrer" }]);
    expect(shareLegs({ split: free, artistWallet: null, payTo: PAY_TO, shares: null })).toEqual([{ recipient: PAY_TO, amountMicro: 110_000, role: "enki" }]);
    const priced = computeGenerationSplit(50_000, 100_000);
    expect(shareLegs({ split: priced, artistWallet: ARTIST, payTo: PAY_TO, shares: null }))
      .toEqual([{ recipient: ARTIST, amountMicro: 50_000, role: "artist" }, { recipient: PAY_TO, amountMicro: 115_000, role: "enki" }]);
  });
});

describe("shareLegs on a rail with a higher fee (Kev, 2026-10-18: \"fix double referral\")", () => {
  const before: PromptShares = { referrerWallet: REFERRER, author: { kind: "vault", owner: VAULT }, claimed: false };

  it("keeps the shares at fractions of the 10% fee when x402 charges 20%, and Enki keeps the rest", () => {
    const x402 = computeGenerationSplit(50_000, 100_000, { enkiFeeBps: X402_ENKI_FEE_BPS });
    expect(x402.enkiFeeMicro).toBe(30_000);
    const legs = shareLegs({ split: x402, artistWallet: ARTIST, payTo: PAY_TO, shares: before });
    expect(legs.map((l) => l.amountMicro)).toEqual([50_000, 130_000 - 3_750 - 3_750, 3_750, 3_750]);
    expect(sum(legs)).toBe(x402.totalMicro);
    const claimed = shareLegs({ split: x402, artistWallet: ARTIST, payTo: PAY_TO, shares: { ...before, author: { kind: "wallet", owner: AUTHOR }, claimed: true } });
    expect(claimed.map((l) => l.amountMicro)).toEqual([50_000, 130_000 - 7_500, 7_500]);
  });

  // The web rail pays no shares until escrow v2 ships (docs/ESCROW-V2-SHARES.md); this compares the 10% split the spec defines.
  it("pays the same shares at 20% as the 10% policy split gives for the same render", () => {
    const web = shareLegs({ split: computeGenerationSplit(0, 100_030), artistWallet: null, payTo: PAY_TO, shares: before });
    const x402 = shareLegs({ split: computeGenerationSplit(0, 100_030, { enkiFeeBps: X402_ENKI_FEE_BPS }), artistWallet: null, payTo: PAY_TO, shares: before });
    expect(x402.slice(1)).toEqual(web.slice(1));
  });

  it("never pays more than a discounted fee, so the legs still add up", () => {
    const discounted = { ...free, enkiFeeMicro: 4_000, enkiTotalMicro: 104_000, totalMicro: 104_000 };
    const legs = shareLegs({ split: discounted, artistWallet: null, payTo: PAY_TO, shares: before });
    expect(legs.map((l) => l.amountMicro)).toEqual([102_000, 1_000, 1_000]);
    expect(sum(legs)).toBe(104_000);
  });
});

describe("authorVaultOwner", () => {
  it("is the program's PDA at the documented seeds, off the curve, one per X id", () => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(42));
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from("author"), bytes], PROGRAM);
    expect(authorVaultOwner(PROGRAM, "42").equals(expected)).toBe(true);
    expect(PublicKey.isOnCurve(authorVaultOwner(PROGRAM, "42").toBytes())).toBe(false);
    expect(authorVaultOwner(PROGRAM, "43").equals(expected)).toBe(false);
    expect(authorVaultOwner(PROGRAM, "1234567890123456789").toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("refuses anything that is not an X user id", () => {
    for (const bad of ["", "ann", "-1", "18446744073709551616", "1e3", "12 "]) {
      expect(() => authorVaultOwner(PROGRAM, bad)).toThrow("not an X user id");
    }
  });
});

describe("sharesOf", () => {
  /** Any query chain answers the table's rows. */
  const fake = (tables: Record<string, unknown[]>) => {
    const from = (table: string) => {
      let rows = tables[table] ?? [];
      const chain: Record<string, unknown> = {
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (ok: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok),
        // the one filter the shares read needs honoured: "a claim was recorded"
        not: (col: string, _op: string, val: unknown) => { rows = rows.filter((r) => ((r as Record<string, unknown>)[col] ?? null) !== val); return chain; },
      };
      for (const m of ["select", "eq", "is", "limit", "in", "order"]) chain[m] = () => chain;
      return chain;
    };
    return { from } as unknown as SupabaseClient;
  };
  const wallets = (address: string) => [{ address }];

  it("reads the referral record: the referrer's wallet, and the author's vault until a claimant has a wallet", async () => {
    const before = fake({ hunt_submissions: [{ hunter_user_id: "u-ref", claimed_by_user_id: null, source_author_id: "42" }], user_wallets: wallets(REFERRER) });
    expect(await sharesOf(before, "p-1", PROGRAM)).toEqual({ referrerWallet: REFERRER, author: { kind: "vault", owner: VAULT }, claimed: false });
    const after = fake({ hunt_submissions: [{ hunter_user_id: "u-ref", claimed_by_user_id: "u-author", source_author_id: "42" }], user_wallets: wallets(AUTHOR), auth_identities: [{ user_id: "u-author" }] });
    expect(await sharesOf(after, "p-1", PROGRAM)).toEqual({ referrerWallet: AUTHOR, author: { kind: "wallet", owner: AUTHOR }, claimed: true });
  });

  it("reads only an approved referral: a pending or rejected one earns nobody anything", () => {
    const src = readSource(join(__dirname, "..", "shares.ts"));
    expect(src).toContain('.eq("minted_prompt_id", promptId)');
    expect(src).toContain('.eq("status", "approved")');
  });

  it("answers null for a prompt nobody referred, and no vault without an X id or the program", async () => {
    expect(await sharesOf(fake({}), "p-1", PROGRAM)).toBeNull();
    const noId = fake({ hunt_submissions: [{ hunter_user_id: "u-ref", claimed_by_user_id: null, source_author_id: null }], user_wallets: wallets(REFERRER) });
    expect(await sharesOf(noId, "p-1", PROGRAM)).toEqual({ referrerWallet: REFERRER, author: null, claimed: false });
    const noProgram = fake({ hunt_submissions: [{ hunter_user_id: "u-ref", claimed_by_user_id: null, source_author_id: "42" }], user_wallets: wallets(REFERRER) });
    expect(await sharesOf(noProgram, "p-1", null)).toEqual({ referrerWallet: REFERRER, author: null, claimed: false });
    const noWallet = fake({ hunt_submissions: [{ hunter_user_id: "u-ref", claimed_by_user_id: null, source_author_id: "42" }], user_wallets: [] });
    expect(await sharesOf(noWallet, "p-1", PROGRAM)).toEqual({ referrerWallet: null, author: { kind: "vault", owner: VAULT }, claimed: false });
  });
});

describe("the x402 rail", () => {
  it("turns every share but Enki's into a licence credit (Kev, 2026-10-17: Enki sells the render) and derives off-curve token accounts", () => {
    const ROOT = join(__dirname, "..", "..", "..");
    const route = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));
    expect(route).toContain("const shares = await sharesOf(supabase, input.promptId, programId);");
    expect(route).toContain("...shareLegs({ split: quote.split, artistWallet: null, payTo, shares })\n        .flatMap((l) => l.role === \"referrer\" || l.role === \"author\" ? [{ role: l.role, owner: l.recipient, micro: l.amountMicro }] : []),");
    expect(route).toContain("const legs = [{ recipient: payTo, amountMicro }];");
    expect(route).toContain("getAssociatedTokenAddressSync(mint, new PublicKey(owner), true),");
    expect(readSource(join(ROOT, "lib", "payments", "x402-settle.ts"))).toContain("dest: getAssociatedTokenAddressSync(p.mint, l.owner, true),");
    expect(readSource(join(ROOT, "lib", "payments", "solana-transfer.ts"))).toContain("const ata = getAssociatedTokenAddressSync(mint, new PublicKey(owner), true);");
  });
});
