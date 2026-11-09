import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";

/**
 * Who pays an intent and whether they can (2026-10-18): the paying wallet of
 * any account, the buyer's USDC against EVERY unit they hold open (Kev: "logo
 * soll er so viel usdc haben wie er drucken will"), and a 30-minute pause
 * after 5 captures that did not land (Kev).
 */
import { fakeClient } from "./_pg-fake";
import { buyerWallet, buyerCovers, capturePause, CoverageUnknown, droppedPause, DROPPED_UNIT_LIMIT, DROPPED_UNIT_WINDOW_MS, FAILED_CAPTURE_LIMIT, FAILED_CAPTURE_PAUSE_MS } from "@/lib/payments/authorize-flow";

const WALLET = Keypair.generate().publicKey.toBase58();
const USER = "aaaaaaaa-1111-4111-8111-111111111111";

type Unit = number | { total_micro: number; capture_started_at: string | null; tx_signature: string | null };
type Rows = { wallet?: string | null; open?: Unit[]; failures?: string[]; dbError?: boolean; holders?: string[]; leases?: Record<string, unknown>[]; leaseError?: boolean };
function db(r: Rows) {
  const filters: [string, string, unknown][] = [];
  const chain = (result: () => unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ["eq", "not", "is", "gte", "order", "limit", "in", "or"]) q[m] = (...a: unknown[]) => { filters.push([m, String(a[0]), a[1]]); return q; };
    q.maybeSingle = async () => result();
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok);
    return q;
  };
  return {
    filters,
    client: {
      from: (table: string) => ({
        select: () => chain(() => {
          if (r.dbError) return { data: null, error: { message: "down" } };
          // The holders lookup asks by address and reads a list; the paying-wallet lookup asks by user id and reads one row.
          if (table === "user_wallets" && filters.some((f) => f[1] === "address")) return { data: (r.holders ?? []).map((user_id) => ({ user_id })), error: null };
          if (table === "user_wallets") return { data: r.wallet ? { address: r.wallet } : null, error: null };
          if (filters.some((f) => f[1] === "void_reason")) return { data: (r.failures ?? []).map((voided_at) => ({ voided_at })), error: null };
          // The leases read again by unit id (u0, u1, ... in the order given).
          if (filters.some((f) => f[0] === "in" && f[1] === "id")) return r.leaseError ? { data: null, error: { message: "down" } } : { data: r.leases ?? [], error: null };
          return { data: (r.open ?? []).map((u, i) => ({ id: `u${i}`, ...(typeof u === "number" ? { total_micro: u, capture_started_at: null, tx_signature: null } : u) })), error: null };
        }),
      }),
    } as never,
  };
}
/** The buyer's USDC account as getParsedAccountInfo returns it; null balance = no account. */
const conn = (balance: number | null, opts: { throws?: boolean; owner?: string; state?: string; statuses?: Record<string, unknown>; order?: string[]; slot?: number; statusSlot?: number } = {}) => ({
  // As a node answers: a status older than the recent cache only over the history, at the slot that node has seen
  // (the balance's slot unless a test says otherwise).
  getSignatureStatuses: async (sigs: string[], o?: { searchTransactionHistory?: boolean }) => {
    opts.order?.push("statuses");
    // A node has seen every slot it reports a status at (round 30).
    const reported = Object.values(opts.statuses ?? {}).map((st) => Number((st as { slot?: number } | null)?.slot ?? 0));
    return { context: { slot: opts.statusSlot ?? Math.max(opts.slot ?? 100, ...reported) }, value: sigs.map((sig) => (o?.searchTransactionHistory ? opts.statuses?.[sig] ?? null : null)) };
  },
  getParsedAccountInfo: async () => {
    opts.order?.push("balance");
    if (opts.throws) throw new Error("rpc down");
    // The balance as read at this slot (100 unless a test says otherwise).
    const context = { slot: opts.slot ?? 100 };
    if (balance === null) return { context, value: null };
    return { context, value: { data: { parsed: { info: { owner: opts.owner ?? WALLET, state: opts.state ?? "initialized", tokenAmount: { amount: String(balance) } } } } } };
  },
}) as unknown as Connection;

beforeEach(() => vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet"));
afterEach(() => vi.unstubAllEnvs());

describe("the wallet an intent's owner pays from", () => {
  it("is the primary live Solana wallet of a user id (email, Google and X accounts)", async () => {
    const d = db({ wallet: WALLET });
    expect(await buyerWallet(d.client, USER)).toBe(WALLET);
    expect(d.filters).toEqual(expect.arrayContaining([["eq", "user_id", USER], ["eq", "chain_family", "solana"], ["is", "removed_at", null], ["order", "is_primary", { ascending: false }]]));
  });

  it("is the address itself for a wallet account", async () => {
    expect(await buyerWallet(db({}).client, WALLET)).toBe(WALLET);
  });

  it("is nobody for a lowercased address that still decodes to a 32-byte key nobody holds", async () => {
    // The dangerous case: valid base58 of the right length, so only the case check stops it.
    const { PublicKey } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    let lowered = "";
    for (let i = 0; i < 5_000 && !lowered; i++) {
      const l = Keypair.generate().publicKey.toBase58().toLowerCase();
      try { if (bs58.decode(l).length === 32 && new PublicKey(l).toBase58() === l) lowered = l; } catch { /* next */ }
    }
    expect(lowered).not.toBe("");
    expect(await buyerWallet(db({ wallet: lowered }).client, USER)).toBeNull();
    expect(await buyerWallet(db({}).client, lowered)).toBeNull();
  });

  it("is nobody for a legacy all-lowercase address, an invalid one, or an account without a wallet", async () => {
    expect(await buyerWallet(db({ wallet: WALLET.toLowerCase() }).client, USER)).toBeNull();
    expect(await buyerWallet(db({}).client, WALLET.toLowerCase())).toBeNull();
    expect(await buyerWallet(db({}).client, "not-a-key")).toBeNull();
    expect(await buyerWallet(db({ wallet: null }).client, USER)).toBeNull();
  });

  it("throws when an account's wallet cannot be read: unknown is not 'no wallet' (round 4, 2026-10-19)", async () => {
    await expect(buyerWallet(db({ dbError: true }).client, USER)).rejects.toBeTruthy();
    await expect(buyerCovers(db({ dbError: true }).client, conn(9), USER, 1)).rejects.toBeTruthy();
  });
});

describe("the buyer's USDC covers every open unit", () => {
  it("passes when the balance covers the open units plus the new ones", async () => {
    expect(await buyerCovers(db({ open: [1_000_000, 1_000_000] }).client, conn(3_000_000), WALLET, 1_000_000)).toEqual({ ok: true, wallet: WALLET });
  });

  it("refuses 1 USDC for four 1 USDC units, saying what is needed and what is there", async () => {
    expect(await buyerCovers(db({ open: [1_000_000, 1_000_000, 1_000_000] }).client, conn(1_000_000), WALLET, 1_000_000))
      .toEqual({ ok: false, reason: "payer_usdc", needMicro: 4_000_000, haveMicro: 1_000_000 });
  });

  it("counts only units that hold a nonce and are neither captured nor voided", async () => {
    const d = db({ open: [] });
    await buyerCovers(d.client, conn(5), WALLET, 0);
    expect(d.filters).toEqual(expect.arrayContaining([["in", "buyer_wallet", [WALLET]], ["not", "nonce_account", "is"], ["is", "nonce_closed_at", null], ["is", "captured_at", null], ["is", "voided_at", null]]));
  });

  it("leaves out a capture in flight the cluster already confirmed: its USDC is gone from the balance already (round 4, 2026-10-19)", async () => {
    const leased = { total_micro: 1_000_000, capture_started_at: "t", tx_signature: "SigA" };
    const confirmed = { SigA: { slot: 90, err: null, confirmationStatus: "confirmed" } };
    // The balance after SigA's debit: 1 USDC left for the other open unit.
    expect(await buyerCovers(db({ open: [1_000_000, leased] }).client, conn(1_000_000, { statuses: confirmed }), WALLET, 0)).toEqual({ ok: true, wallet: WALLET });
    expect(await buyerCovers(db({ open: [1_000_000, leased] }).client, conn(1_000_000, { statuses: { SigA: { slot: 90, err: null, confirmationStatus: "finalized" } } }), WALLET, 0)).toEqual({ ok: true, wallet: WALLET });
  });

  it("leaves out a capture confirmed in the balance's own slot, and counts one confirmed after the balance was read (round 8, 2026-10-20)", async () => {
    const leased = { total_micro: 1_000_000, capture_started_at: "t", tx_signature: "SigA" };
    // Confirmed in slot 100, the slot the balance was read at: in the balance already.
    expect(await buyerCovers(db({ open: [1_000_000, leased] }).client, conn(1_000_000, { statuses: { SigA: { slot: 100, err: null, confirmationStatus: "confirmed" } } }), WALLET, 0)).toEqual({ ok: true, wallet: WALLET });
    // Confirmed in slot 101, after the read: the 2 USDC balance still holds its USDC, so it counts, and covers.
    expect(await buyerCovers(db({ open: [1_000_000, leased] }).client, conn(2_000_000, { statuses: { SigA: { slot: 101, err: null, confirmationStatus: "confirmed" } } }), WALLET, 0)).toEqual({ ok: true, wallet: WALLET });
    // The same capture left out would let a third unit open on USDC the capture is about to take.
    expect(await buyerCovers(db({ open: [1_000_000, leased] }).client, conn(2_000_000, { statuses: { SigA: { slot: 101, err: null, confirmationStatus: "confirmed" } } }), WALLET, 1_000_000))
      .toEqual({ ok: false, reason: "payer_usdc", needMicro: 3_000_000, haveMicro: 2_000_000 });
  });

  it.each([
    ["only processed", { err: null, confirmationStatus: "processed" }],
    ["failed on chain", { err: { InstructionError: [2, { Custom: 1 }] }, confirmationStatus: "confirmed" }],
    ["not seen", null],
  ])("keeps counting a capture in flight that is %s", async (_label, status) => {
    const leased = { total_micro: 1_000_000, capture_started_at: "t", tx_signature: "SigA" };
    expect(await buyerCovers(db({ open: [1_000_000, leased] }).client, conn(1_000_000, { statuses: { SigA: status } }), WALLET, 0))
      .toEqual({ ok: false, reason: "payer_usdc", needMicro: 2_000_000, haveMicro: 1_000_000 });
  });

  it("throws instead of refusing when the refusal rests on a capture the status node cannot place against the balance (round 21, 2026-10-20)", async () => {
    const leased = { total_micro: 1_000_000, capture_started_at: "t", tx_signature: "SigA" };
    const open = () => db({ open: [1_000_000, leased] }).client;
    // The status node is behind the balance's slot and does not see the capture yet: it may be in the balance.
    await expect(buyerCovers(open(), conn(1_000_000, { statusSlot: 99 }), WALLET, 0)).rejects.toThrow(/cannot be placed/);
    // Its own class: /submit tells it from a read that failed (round 22).
    await expect(buyerCovers(open(), conn(1_000_000, { statusSlot: 99 }), WALLET, 0)).rejects.toBeInstanceOf(CoverageUnknown);
    // Seen only processed, in a slot the balance includes.
    await expect(buyerCovers(open(), conn(1_000_000, { statuses: { SigA: { slot: 100, err: null, confirmationStatus: "processed" } } }), WALLET, 0)).rejects.toThrow(/cannot be placed/);
    // Processed after the balance's slot, failed on chain, or not seen by a node at the balance's slot: not in it, so the refusal stands.
    for (const opts of [{ statuses: { SigA: { slot: 101, err: null, confirmationStatus: "processed" } } }, { statusSlot: 99, statuses: { SigA: { slot: 98, err: { InstructionError: [2, { Custom: 1 }] }, confirmationStatus: "confirmed" } } }, {}]) {
      expect(await buyerCovers(open(), conn(1_000_000, opts), WALLET, 0)).toEqual({ ok: false, reason: "payer_usdc", needMicro: 2_000_000, haveMicro: 1_000_000 });
    }
    // Confirmed in a slot the balance includes, seen by a node behind it: in the balance, left out once, not twice (round 22).
    expect(await buyerCovers(db({ open: [2_000_000, leased] }).client, conn(1_000_000, { statusSlot: 99, statuses: { SigA: { slot: 98, err: null, confirmationStatus: "confirmed" } } }), WALLET, 0))
      .toEqual({ ok: false, reason: "payer_usdc", needMicro: 2_000_000, haveMicro: 1_000_000 });
    // Short even if the capture were in the balance: refused.
    expect(await buyerCovers(db({ open: [1_000_000, 1_000_000, leased] }).client, conn(1_000_000, { statusSlot: 99 }), WALLET, 0))
      .toEqual({ ok: false, reason: "payer_usdc", needMicro: 3_000_000, haveMicro: 1_000_000 });
  });

  it("reads the leases again before a refusal: a capture leased after the rows were read may be in the balance (round 22, 2026-10-20)", async () => {
    const lease = { id: "u1", capture_started_at: "t", tx_signature: "SigB" };
    // Leased and confirmed in slot 99 while the balance (slot 100) was read: in it, so the 1 USDC left covers unit 0.
    const covered = db({ open: [1_000_000, 1_000_000], leases: [lease] });
    expect(await buyerCovers(covered.client, conn(1_000_000, { statuses: { SigB: { slot: 99, err: null, confirmationStatus: "confirmed" } } }), WALLET, 0)).toEqual({ ok: true, wallet: WALLET });
    expect(covered.filters).toContainEqual(["in", "id", ["u0", "u1"]]);
    // Confirmed after the balance was read: its USDC is still in it, so it counts.
    expect(await buyerCovers(db({ open: [1_000_000, 1_000_000], leases: [lease] }).client, conn(1_000_000, { statuses: { SigB: { slot: 101, err: null, confirmationStatus: "confirmed" } } }), WALLET, 0))
      .toEqual({ ok: false, reason: "payer_usdc", needMicro: 2_000_000, haveMicro: 1_000_000 });
    // Covered on the rows as read: not asked again.
    const enough = db({ open: [1_000_000, 1_000_000], leases: [lease] });
    expect(await buyerCovers(enough.client, conn(2_000_000), WALLET, 0)).toEqual({ ok: true, wallet: WALLET });
    expect(enough.filters.some((f) => f[0] === "in" && f[1] === "id")).toBe(false);
    // A read that fails is unknown, not "no USDC".
    await expect(buyerCovers(db({ open: [1_000_000, 1_000_000], leaseError: true }).client, conn(1_000_000), WALLET, 0)).rejects.toBeTruthy();
  });

  it("finds a capture booked between the balance read and the re-read, on rows as the database holds them (round 23, 2026-10-21)", async () => {
    // Every handed-out unit carries its signature; a booked capture keeps its lease and gains captured_at.
    const row = (id: string, sig: string) => ({ id, buyer_wallet: WALLET, nonce_account: `N-${id}`, nonce_closed_at: null, captured_at: null, voided_at: null, total_micro: 1_000_000, capture_started_at: null, tx_signature: sig });
    const rows = [row("a", "SigA"), row("b", "SigB")];
    // While the balance is read, b's capture is leased, lands in slot 99 and is booked.
    const chain = {
      getParsedAccountInfo: async () => {
        Object.assign(rows[1], { capture_started_at: "t", captured_at: "t", fulfilled_at: "t" });
        return { context: { slot: 100 }, value: { data: { parsed: { info: { owner: WALLET, state: "initialized", tokenAmount: { amount: "1000000" } } } } } };
      },
      getSignatureStatuses: async (sigs: string[]) => ({ context: { slot: 100 }, value: sigs.map((sig) => (sig === "SigB" ? { slot: 99, err: null, confirmationStatus: "confirmed" } : null)) }),
    } as unknown as Connection;
    expect(await buyerCovers(fakeClient({ generation_payment_intents: rows }), chain, WALLET, 0)).toEqual({ ok: true, wallet: WALLET });
    // At /authorize the new units count toward the refusal that asks again.
    expect(await buyerCovers(db({ open: [1_000_000], leases: [{ id: "u0", capture_started_at: "t", tx_signature: "SigB" }] }).client, conn(1_000_000, { statuses: { SigB: { slot: 99, err: null, confirmationStatus: "confirmed" } } }), WALLET, 1_000_000))
      .toEqual({ ok: true, wallet: WALLET });
  });

  it("asks the balance before the captures, and asks nothing when no capture is in flight or there is no account (round 8, 2026-10-20)", async () => {
    const order: string[] = [];
    const leased = { total_micro: 1, capture_started_at: "t", tx_signature: "SigA" };
    await buyerCovers(db({ open: [leased] }).client, conn(5, { order }), WALLET, 0);
    expect(order).toEqual(["balance", "statuses"]);
    order.length = 0;
    expect(await buyerCovers(db({ open: [leased] }).client, conn(null, { order }), WALLET, 0)).toEqual({ ok: false, reason: "payer_no_account", needMicro: 1, haveMicro: 0 });
    expect(order).toEqual(["balance"]);
    order.length = 0;
    await buyerCovers(db({ open: [1, { total_micro: 1, capture_started_at: null, tx_signature: "SigB" }] }).client, conn(5, { order }), WALLET, 0);
    expect(order).toEqual(["balance"]);
  });

  it("says the buyer has no USDC account, and that an account has no wallet", async () => {
    expect(await buyerCovers(db({ open: [] }).client, conn(null), WALLET, 7_560)).toEqual({ ok: false, reason: "payer_no_account", needMicro: 7_560, haveMicro: 0 });
    expect(await buyerCovers(db({ wallet: null }).client, conn(9), USER, 1)).toEqual({ ok: false, reason: "no_wallet" });
  });

  it("throws when the chain or the database cannot answer: unknown is not 'no USDC'", async () => {
    await expect(buyerCovers(db({ open: [] }).client, conn(0, { throws: true }), WALLET, 1)).rejects.toThrow(/rpc down/);
    await expect(buyerCovers(db({ dbError: true }).client, conn(9), WALLET, 1)).rejects.toBeTruthy();
  });
});

describe("the pause after failed captures", () => {
  it("is 5 failures in 30 minutes (Kev, 2026-10-18)", () => {
    expect(FAILED_CAPTURE_LIMIT).toBe(5);
    expect(FAILED_CAPTURE_PAUSE_MS).toBe(30 * 60_000);
  });

  it("does not pause 4, and pauses 5 until the oldest of them is 30 minutes old", async () => {
    const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    expect(await capturePause(db({ failures: [t(1), t(2), t(3), t(4)] }).client, WALLET)).toEqual({ paused: false });
    const five = [t(1), t(2), t(3), t(4), t(10)];
    const r = await capturePause(db({ failures: five }).client, WALLET);
    expect(r.paused).toBe(true);
    expect(new Date((r as { until: string }).until).getTime()).toBe(new Date(five[4]).getTime() + 30 * 60_000);
  });

  it("counts only this buyer's captures that did not land, within the window", async () => {
    const d = db({ failures: [] });
    await capturePause(d.client, WALLET);
    expect(d.filters).toEqual(expect.arrayContaining([["in", "buyer_wallet", [WALLET]], ["eq", "void_reason", "capture_failed"], ["order", "voided_at", { ascending: false }], ["limit", "5", undefined]]));
    const since = d.filters.find((f) => f[0] === "gte" && f[1] === "voided_at")?.[2] as string;
    expect(Math.abs(new Date(since).getTime() - (Date.now() - 30 * 60_000))).toBeLessThan(5_000);
  });
});

describe("one balance, several owners (review 2026-10-18)", () => {
  const OTHER_USER = "bbbbbbbb-2222-4222-8222-222222222222";

  it("counts open units under every owner that pays from the wallet: its own session and each account holding it", async () => {
    const d = db({ open: [1_000_000], holders: [USER, OTHER_USER, USER] });
    await buyerCovers(d.client, conn(5_000_000), WALLET, 0);
    expect(d.filters).toEqual(expect.arrayContaining([["eq", "address", WALLET], ["eq", "chain_family", "solana"], ["is", "removed_at", null]]));
    expect(d.filters).toContainEqual(["in", "buyer_wallet", [WALLET, USER, OTHER_USER]]);
  });

  it("an email account's coverage and pause see the wallet session's units too", async () => {
    const d = db({ wallet: WALLET, open: [], holders: [USER] });
    await buyerCovers(d.client, conn(5), USER, 0);
    expect(d.filters).toContainEqual(["in", "buyer_wallet", [WALLET, USER]]);
    const p = db({ wallet: WALLET, failures: [], holders: [USER] });
    await capturePause(p.client, USER);
    expect(p.filters).toContainEqual(["in", "buyer_wallet", [WALLET, USER]]);
    // The dropped pause is counted per paying wallet too (DEC-101) (round 30).
    const q = db({ wallet: WALLET, failures: [], holders: [USER] });
    await droppedPause(q.client, USER);
    expect(q.filters).toContainEqual(["in", "buyer_wallet", [WALLET, USER]]);
  });

  it("an owner without a wallet is paused on its own string", async () => {
    const d = db({ wallet: null, failures: [] });
    await capturePause(d.client, USER);
    expect(d.filters).toContainEqual(["in", "buyer_wallet", [USER]]);
  });
});

describe("the pause after dropped units (review 2026-10-18)", () => {
  const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

  it("is 13 dropped units in an hour (Kev, 2026-10-18)", () => {
    expect(DROPPED_UNIT_LIMIT).toBe(13);
    expect(DROPPED_UNIT_WINDOW_MS).toBe(60 * 60_000);
  });

  it("does not pause 12, and pauses 13 until the oldest of them is an hour old", async () => {
    const rows = Array.from({ length: 13 }, (_, i) => t(i + 1));
    expect(await droppedPause(db({ failures: rows.slice(0, 12) }).client, WALLET)).toEqual({ paused: false });
    const r = await droppedPause(db({ failures: rows }).client, WALLET);
    expect(r.paused).toBe(true);
    expect(new Date((r as { until: string }).until).getTime()).toBe(new Date(rows[12]).getTime() + 60 * 60_000);
  });

  it("counts the opened units the buyer dropped by their reason alone: never a paid one, a provider failure or a failed capture (round 4, 2026-10-19)", async () => {
    const d = db({ failures: [] });
    await droppedPause(d.client, WALLET);
    expect(d.filters).toEqual(expect.arrayContaining([
      ["in", "buyer_wallet", [WALLET]], ["not", "nonce_account", "is"],
      ["in", "void_reason", ["cancelled", "rejected", "abandoned", "unfunded"]], ["limit", "13", undefined],
    ]));
    // No second rule beside the reason: who claimed the unit no longer decides (the reason's writer does).
    expect(d.filters.some((f) => f[0] === "or" || f[1] === "capture_started_at" || f[1] === "consumed_at")).toBe(false);
    const since = d.filters.find((f) => f[0] === "gte" && f[1] === "voided_at")?.[2] as string;
    expect(Math.abs(new Date(since).getTime() - (Date.now() - 60 * 60_000))).toBeLessThan(5_000);
  });
});

describe("coverage on real rows (round 5, 2026-10-20)", () => {
  it("leaves out a confirmed capture in flight, read from the columns it selects", async () => {
    const rows = [
      { id: "a", buyer_wallet: WALLET, nonce_account: "NA", nonce_closed_at: null, captured_at: null, voided_at: null, capture_started_at: null, tx_signature: null, total_micro: 1_000_000 },
      { id: "b", buyer_wallet: WALLET, nonce_account: "NB", nonce_closed_at: null, captured_at: null, voided_at: null, capture_started_at: "t", tx_signature: "SigB", total_micro: 1_000_000 },
    ];
    const confirmed = { SigB: { slot: 90, err: null, confirmationStatus: "confirmed" } };
    expect(await buyerCovers(fakeClient({ generation_payment_intents: rows }), conn(1_000_000, { statuses: confirmed }), WALLET, 0)).toEqual({ ok: true, wallet: WALLET });
  });
});

describe("the dropped-unit pause on real rows (round 4, 2026-10-19)", () => {
  const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const unit = (i: number, void_reason: string, over: Record<string, unknown> = {}) =>
    ({ id: `u-${i}`, buyer_wallet: WALLET, nonce_account: `N${i}`, void_reason, voided_at: t(i + 1), ...over });

  it("pauses on 13 of the buyer's own reasons, whoever claimed the units", async () => {
    const reasons = ["cancelled", "rejected", "abandoned", "unfunded"];
    // Claimed or not, leased or not: the reason alone decides.
    const rows = Array.from({ length: 13 }, (_, i) => unit(i, reasons[i % 4], i % 2 ? { consumed_at: t(i + 2) } : {}));
    expect((await droppedPause(fakeClient({ generation_payment_intents: rows }), WALLET)).paused).toBe(true);
    expect((await droppedPause(fakeClient({ generation_payment_intents: rows.slice(1) }), WALLET)).paused).toBe(false);
  });

  it("never counts Enki's voids, failed captures, other rails, other buyers or the last hour's edge", async () => {
    const own = Array.from({ length: 12 }, (_, i) => unit(i, "cancelled"));
    for (const extra of [
      unit(20, "provider_failed"), unit(21, "capture_failed"), unit(22, "cancelled", { nonce_account: null }),
      unit(23, "cancelled", { buyer_wallet: "SomeoneElse" }), unit(24, "cancelled", { voided_at: t(61) }),
    ]) {
      expect((await droppedPause(fakeClient({ generation_payment_intents: [...own, extra] }), WALLET)).paused).toBe(false);
    }
  });
});

describe("an account a transfer from the wallet would fail on (verification 2026-10-18)", () => {
  it("is no account: re-owned to another key, or frozen, whatever its balance", async () => {
    for (const opts of [{ owner: "SomeoneElseKey" }, { state: "frozen" }]) {
      expect(await buyerCovers(db({ open: [] }).client, conn(5_000_000, opts), WALLET, 1)).toEqual({ ok: false, reason: "payer_no_account", needMicro: 1, haveMicro: 0 });
    }
  });
});
