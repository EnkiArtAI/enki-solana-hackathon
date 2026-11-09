import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { fakePostgrest } from "@/lib/__tests__/_fake-postgrest";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * An author claims what their posts earn (Kev, 2026-10-17): the X account
 * connected in Settings is the proof, matched by X's numeric id. The claim
 * records the user on every referral of that author and covers the author's
 * later prompts too; the shares go to the user's wallet while the user holds
 * that X account, and whoever holds it later takes over by claiming.
 */
const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("@/lib/__tests__/_fake-postgrest").fakePostgrest> | null, user: "u-author" as string | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => db.user }));
const balance = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/payments/solana", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/solana")>()),
  solanaConnection: () => ({ getTokenAccountBalance: balance.fn }),
}));

import { GET, POST } from "../../../app/api/referrals/claim/route";
import { claimAuthorShares } from "../claim";
import { authorVaultOwner, sharesOf } from "../shares";

const PROGRAM = new PublicKey("2sfm76FMcfqUYCv47J4VCNFMrp6PpfD6QYpmWqBCPyJV");
const AUTHOR_WALLET = Keypair.generate().publicKey.toBase58();
const REFERRER_WALLET = Keypair.generate().publicKey.toBase58();
const call = (method: "GET" | "POST") => (method === "GET" ? GET : POST)(new NextRequest("http://enki.test/api/referrals/claim", { method }));
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, minted_prompt_id: `p-${id}`, status: "approved", hunter_user_id: "u-ref", source_author_id: "42", claimed_by_user_id: null, claimed_at: null, ...over,
});

beforeEach(() => {
  db.user = "u-author";
  db.current = fakePostgrest();
  const t = db.current.tables;
  t.auth_identities = [{ provider: "x", subject: "42", user_id: "u-author", handle: "inkwell" }];
  t.hunt_submissions = [row("1"), row("2", { status: "pending" }), row("3", { source_author_id: "77" }), row("4", { claimed_by_user_id: "u-earlier", claimed_at: "2026-10-01T00:00:00Z", source_author_id: "77" })];
  t.user_wallets = [
    { user_id: "u-author", address: AUTHOR_WALLET, chain_family: "solana", removed_at: null },
    { user_id: "u-ref", address: REFERRER_WALLET, chain_family: "solana", removed_at: null },
  ];
  balance.fn.mockReset();
  process.env.SOLANA_ESCROW_PROGRAM_ID = PROGRAM.toBase58();
});

describe("the claim", () => {
  it("records the user on every referral of the connected X id, and on no other author's", async () => {
    const res = await call("POST");
    expect(await res.json()).toEqual({ claimed: 2 });
    const t = db.current!.tables.hunt_submissions;
    expect(t.filter((r) => r.claimed_by_user_id === "u-author").map((r) => r.id)).toEqual(["1", "2"]);
    expect(t.find((r) => r.id === "1")!.claimed_at).toEqual(expect.any(String));
    expect(t.find((r) => r.id === "3")!.claimed_by_user_id).toBeNull();
    expect(t.find((r) => r.id === "4")!.claimed_by_user_id).toBe("u-earlier");
  });

  it("takes over what a former holder of the X account claimed, and claims nothing twice", async () => {
    db.current!.tables.hunt_submissions[0].claimed_by_user_id = "u-former";
    expect(await (await call("POST")).json()).toEqual({ claimed: 2 });
    expect(db.current!.tables.hunt_submissions[0].claimed_by_user_id).toBe("u-author");
    expect(await (await call("POST")).json()).toEqual({ claimed: 0 });
  });

  it("needs a connected X account: matched by its id, never by a handle", async () => {
    db.current!.tables.auth_identities = [{ provider: "google", subject: "42", user_id: "u-author" }, { provider: "x", subject: "42", user_id: "u-other" }];
    const res = await call("POST");
    expect(res.status).toBe(409);
    expect(db.current!.tables.hunt_submissions.every((r) => r.claimed_by_user_id !== "u-author")).toBe(true);
  });

  it("answers 401 without a session and 503 when the database fails", async () => {
    db.user = null;
    expect((await call("POST")).status).toBe(401);
    expect((await call("GET")).status).toBe(401);
    db.user = "u-author";
    db.current!.state.failing = { table: "hunt_submissions", code: "XX000" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("POST")).status).toBe(503);
    err.mockRestore();
  });
});

describe("what the author sees", () => {
  it("the X handle, approved prompts, open and claimed ones, and the vault read on chain", async () => {
    balance.fn.mockResolvedValue({ value: { uiAmount: 1.25 } });
    expect(await (await call("GET")).json()).toEqual({ x: { handle: "inkwell" }, prompts: 1, claimed: false, open: 1, vaultUsd: 1.25, payoutWallet: true });
    // counted are approved referrals only: the pending one is claimed with the rest, never shown
    await call("POST");
    expect(await (await call("GET")).json()).toMatchObject({ prompts: 1, claimed: true, open: 0 });
    // a later referral is covered by the claim and asks for nothing; one a former holder claimed is open again
    db.current!.tables.hunt_submissions.push(row("5"), row("6", { claimed_by_user_id: "u-former" }));
    expect(await (await call("GET")).json()).toMatchObject({ prompts: 3, claimed: true, open: 1 });
    const [ata] = balance.fn.mock.calls[0];
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const { usdcMint } = await import("@/lib/payments/solana");
    expect(ata.toBase58()).toBe(getAssociatedTokenAddressSync(usdcMint(), authorVaultOwner(PROGRAM, "42"), true).toBase58());
  });

  it("says when there is no Solana payout wallet, so the line names the vault instead of the wallet", async () => {
    db.current!.tables.user_wallets = db.current!.tables.user_wallets.filter((w) => w.user_id !== "u-author");
    expect(await (await call("GET")).json()).toMatchObject({ payoutWallet: false });
  });

  it("no vault without the program or an answer, and nothing at all without an X account", async () => {
    balance.fn.mockRejectedValue(new Error("could not find account"));
    expect(await (await call("GET")).json()).toMatchObject({ vaultUsd: null });
    delete process.env.SOLANA_ESCROW_PROGRAM_ID;
    expect(await (await call("GET")).json()).toMatchObject({ vaultUsd: null });
    db.current!.tables.auth_identities = [];
    expect(await (await call("GET")).json()).toEqual({ x: null, prompts: 0, claimed: false, open: 0, vaultUsd: null, payoutWallet: false });
  });
});

describe("after the claim, the shares", () => {
  const client = () => db.current!.client as unknown as SupabaseClient;
  it("of a claimed prompt and of the author's later ones go to the claimant's wallet", async () => {
    expect((await sharesOf(client(), "p-1", PROGRAM))!.author).toEqual({ kind: "vault", owner: authorVaultOwner(PROGRAM, "42").toBase58() });
    await claimAuthorShares(client(), "u-author");
    db.current!.tables.hunt_submissions.push(row("5"));
    expect((await sharesOf(client(), "p-1", PROGRAM))!.author).toEqual({ kind: "wallet", owner: AUTHOR_WALLET });
    expect((await sharesOf(client(), "p-5", PROGRAM))!.author).toEqual({ kind: "wallet", owner: AUTHOR_WALLET });
    // the later prompt's legs: half of the fee to the author, nothing to the referrer
    const later = (await sharesOf(client(), "p-5", PROGRAM))!;
    expect(later.claimed).toBe(true);
    const { computeGenerationSplit } = await import("@/lib/payments/generation-pricing");
    const { shareLegs } = await import("../shares");
    expect(shareLegs({ split: computeGenerationSplit(0, 100_000), artistWallet: null, payTo: "enki", shares: later }))
      .toEqual([{ recipient: "enki", amountMicro: 105_000, role: "enki" }, { recipient: AUTHOR_WALLET, amountMicro: 5_000, role: "author" }]);
  });

  it("of another author's prompt stay with that author's own claim or vault", async () => {
    db.current!.tables.hunt_submissions.push(row("6", { source_author_id: "99" }));
    await claimAuthorShares(client(), "u-author");
    expect((await sharesOf(client(), "p-6", PROGRAM))!.author).toEqual({ kind: "vault", owner: authorVaultOwner(PROGRAM, "99").toBase58() });
    // nobody claimed author 99: its referrer keeps the quarter, its vault the other
    const other = (await sharesOf(client(), "p-6", PROGRAM))!;
    expect(other.claimed).toBe(false);
    const { computeGenerationSplit } = await import("@/lib/payments/generation-pricing");
    const { shareLegs } = await import("../shares");
    expect(shareLegs({ split: computeGenerationSplit(0, 100_000), artistWallet: null, payTo: "enki", shares: other }).map((l) => l.amountMicro)).toEqual([105_000, 2_500, 2_500]);
  });

  it("go back to the vault when the X account leaves the claimant, and to nobody who holds it without claiming", async () => {
    await claimAuthorShares(client(), "u-author");
    db.current!.tables.auth_identities = [];
    const gone = (await sharesOf(client(), "p-1", PROGRAM))!;
    expect(gone.author).toEqual({ kind: "vault", owner: authorVaultOwner(PROGRAM, "42").toBase58() });
    // the claim stands: the referrer does not get its quarter back, the vault gets the author's half
    expect(gone.claimed).toBe(true);
    const { computeGenerationSplit } = await import("@/lib/payments/generation-pricing");
    const { shareLegs } = await import("../shares");
    const legs = shareLegs({ split: computeGenerationSplit(0, 100_000), artistWallet: null, payTo: "enki", shares: gone });
    expect(legs.map((l) => l.recipient)).toEqual(["enki", authorVaultOwner(PROGRAM, "42").toBase58()]);
    expect(legs[1].amountMicro).toBe(5_000);
    // a later referral of the same author is covered too
    db.current!.tables.hunt_submissions.push(row("7"));
    expect((await sharesOf(client(), "p-7", PROGRAM))!.claimed).toBe(true);
    db.current!.tables.auth_identities = [{ provider: "x", subject: "42", user_id: "u-ref", handle: "inkwell" }];
    expect((await sharesOf(client(), "p-1", PROGRAM))!.author).toEqual({ kind: "vault", owner: authorVaultOwner(PROGRAM, "42").toBase58() });
  });

  it("never take a Google account whose id happens to equal the X id for the author", async () => {
    db.current!.tables.auth_identities = [{ provider: "google", subject: "42", user_id: "u-ref" }];
    db.current!.tables.hunt_submissions[0].claimed_by_user_id = "u-ref";
    expect((await sharesOf(client(), "p-1", PROGRAM))!.author).toEqual({ kind: "vault", owner: authorVaultOwner(PROGRAM, "42").toBase58() });
  });

  it("follow the current holder once it claims, over a former holder's claim", async () => {
    db.current!.tables.hunt_submissions[0].claimed_by_user_id = "u-former";
    db.current!.tables.user_wallets.push({ user_id: "u-former", address: REFERRER_WALLET, chain_family: "solana", removed_at: null });
    expect((await sharesOf(client(), "p-1", PROGRAM))!.author).toEqual({ kind: "vault", owner: authorVaultOwner(PROGRAM, "42").toBase58() });
    await claimAuthorShares(client(), "u-author");
    expect((await sharesOf(client(), "p-1", PROGRAM))!.author).toEqual({ kind: "wallet", owner: AUTHOR_WALLET });
  });
});

describe("the Settings line", () => {
  it("shows once an X account is connected, claims by POST, and names the vault only when it holds money", () => {
    const view = readSource(join(__dirname, "..", "..", "..", "components", "settings", "SettingsView.tsx"));
    // The read and the claim live in Settings' account hooks (DEC-2026-11-08-41); the line stays in the view.
    const hook = readSource(join(__dirname, "..", "..", "..", "components", "settings", "use-account.ts"));
    expect(hook).toContain('const hasX = identities.some((i) => i.provider === "x");');
    expect(hook).toContain('fetch("/api/referrals/claim", { method: "POST", headers: sessionAuthHeaders() })');
    expect(view).toContain("{hasX && claim && claim.prompts > 0 && (claim.open > 0 || claim.claimed) && (");
    expect(hook).toContain("setClaimRound((n) => n + 1);");
    // before and after the claim alike: the wallet only with a Solana payout wallet
    expect(view.split('{claim.payoutWallet ? "to your wallet." : "into your author vault until a Solana wallet is on your account."}').length - 1).toBe(2);
    expect(view).not.toContain("every render goes to your wallet");
    expect(view).toContain("{claim.vaultUsd ? (");
  });
});
