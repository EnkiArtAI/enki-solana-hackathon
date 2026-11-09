import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";

/**
 * Nonce accounts of the intent rail (2026-10-18): every address is reserved
 * on an intent row, inside the caps, BEFORE its account exists on chain, so
 * no rent can be orphaned; the fee payer keeps a reserve for x402; and an
 * account counts against the caps until its close is recorded.
 */
const created: string[] = [];
const closed: string[] = [];
const create = vi.fn();
const close = vi.fn();
vi.mock("@/lib/payments/nonce", () => ({
  createNonceAccount: (_c: unknown, _f: unknown, kp: Keypair) => create(kp),
  closeNonceAccount: (_c: unknown, address: string) => close(address),
}));
const voidAuth = vi.fn();
vi.mock("@/lib/payments/authorization", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/authorization")>()),
  voidAuthorization: (...a: unknown[]) => voidAuth(...a),
  // A unit whose payment was never handed out: its void is settled by the close alone (round 4, 2026-10-19).
  heldSignatureOf: async () => null,
}));

import { openIntentBatch, INTENT_MAX_OPEN, INTENT_MAX_OPEN_PER_BUYER, FEE_PAYER_RESERVE_LAMPORTS } from "@/lib/payments/authorize-flow";
import { feePayerKeypair } from "@/lib/payments/solana";
const feePayerKey = () => feePayerKeypair().publicKey.toBase58();

const RENT = 1_056_640;
const FLOOR = 650_240;
type Call = { table: string; patch: Record<string, unknown>; filters: [string, unknown][] };

function db(rpc: (args: Record<string, unknown>) => { data: unknown; error: { code: string } | null }, openNow = 0, creating = 0) {
  const rpcCalls: Record<string, unknown>[] = [];
  const updates: Call[] = [];
  const counts: unknown[][] = [];
  // Each count query's own filters, in order (round 8, 2026-10-20).
  const queries: unknown[][][] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => { rpcCalls.push({ name, ...args }); return rpc(args); },
    from: (table: string) => ({
      // The open accounts' count: what the batch's overall cap starts from.
      select: (_cols: string, opts: unknown) => {
        const q: Record<string, unknown> = {};
        const mine: unknown[][] = [];
        queries.push(mine);
        for (const m of ["not", "is", "eq", "gte"]) q[m] = (...a: unknown[]) => { counts.push([table, m, ...a, opts]); mine.push([m, ...a]); return q; };
        // The second count: units reserved within the last minute, accounts maybe not created yet.
        q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ count: mine.some(([m]) => m === "gte") ? creating : openNow, error: null }).then(ok);
        return q;
      },
      update: (patch: Record<string, unknown>) => {
        const call: Call = { table, patch, filters: [] };
        updates.push(call);
        const q = {
          eq: (c: string, v: unknown) => (call.filters.push([c, v]), q),
          in: (c: string, v: unknown) => (call.filters.push([c, v]), q),
          is: (c: string, v: unknown) => (call.filters.push([c, v]), q),
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
        };
        return q;
      },
    }),
  };
  return { client: client as never, rpcCalls, updates, counts, queries };
}
// Only the fee payer's balance carries anything (round 6, 2026-10-20: any key answered).
const conn = (lamports: number) => ({
  getBalance: async (key: { toBase58(): string }) => (key.toBase58() === feePayerKey() ? lamports : 0),
  getMinimumBalanceForRentExemption: async () => RENT,
}) as unknown as Connection;
// Rent plus a unit's fees over its life: create, capture with the capped priority fee, close (round 5).
const enough = (units: number) => FLOOR + FEE_PAYER_RESERVE_LAMPORTS + units * (RENT + 55_000);
// What open units will still spend (capture and close), and the rent of units whose accounts are being created (round 6).
const PENDING = 45_000;
const intent = { id: "11111111-1111-4111-8111-111111111111", buyer_wallet: "Buyer" };
const rowsFor = (args: Record<string, unknown>) => (args.p_nonces as string[]).map((n, i) => ({ id: i === 0 ? intent.id : `unit-${i}`, unit_index: i, nonce_account: n }));

beforeEach(async () => {
  created.length = 0; closed.length = 0;
  create.mockReset().mockImplementation(async (kp: Keypair) => { created.push(kp.publicKey.toBase58()); return { address: kp.publicKey.toBase58(), nonce: `nonce-${created.length}` }; });
  close.mockReset().mockImplementation(async (a: string) => { closed.push(a); return "closed"; });
  voidAuth.mockReset();
  vi.stubEnv("SOLANA_FEE_PAYER_SECRET_KEY", JSON.stringify(Array.from(Keypair.generate().secretKey)));
  (await import("@/lib/payments/solana")).resetFeePayerCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("opening a batch of intent units", () => {
  it("caps at 8 open units per buyer (Kev, 2026-10-18), and overall only against a runaway (round 4, 2026-10-19)", () => {
    expect(INTENT_MAX_OPEN_PER_BUYER).toBe(8);
    expect(INTENT_MAX_OPEN).toBe(400);
  });

  it("reserves every nonce address in one database call before creating exactly those accounts", async () => {
    const d = db((args) => ({ data: rowsFor(args), error: null }));
    const r = await openIntentBatch(d.client, conn(enough(3)), intent, 3);
    expect(r).toMatchObject({ ok: true });
    expect(d.rpcCalls).toHaveLength(1);
    const call = d.rpcCalls[0];
    // The balance carries exactly these 3: the overall cap is what is open now plus what the balance carries.
    expect(call).toMatchObject({ name: "open_intent_batch", p_intent: intent.id, p_buyer: "Buyer", p_units: 3, p_max_open: 3, p_max_open_buyer: 8 });
    expect(created).toEqual(call.p_nonces);
    expect((r as { units: { nonceAccount: string; nonce: string }[] }).units.map((u) => u.nonceAccount)).toEqual(call.p_nonces);
    expect((r as { units: { nonce: string }[] }).units.every((u) => u.nonce.startsWith("nonce-"))).toBe(true);
  });

  it("binds the overall cap to what the balance carries, counted from the accounts open now (round 5, 2026-10-20)", async () => {
    const d = db((args) => ({ data: rowsFor(args), error: null }), 37);
    await openIntentBatch(d.client, conn(enough(5) + 37 * PENDING), intent, 2);
    expect(d.rpcCalls[0]).toMatchObject({ p_max_open: 37 + 5 });
    expect(d.counts).toEqual(expect.arrayContaining([["generation_payment_intents", "not", "nonce_account", "is", null, { count: "exact", head: true }], ["generation_payment_intents", "is", "nonce_closed_at", null, { count: "exact", head: true }]]));
    // Never above the runaway stop.
    const rich = db((args) => ({ data: rowsFor(args), error: null }), 390);
    await openIntentBatch(rich.client, conn(enough(50) + 390 * PENDING), intent, 2);
    expect(rich.rpcCalls[0]).toMatchObject({ p_max_open: 400 });
  });

  it("takes off what open units will still spend and the rent of accounts still being created (round 6, 2026-10-20)", async () => {
    // 10 open units, 3 of them reserved in the last minute: the balance carries 5 more only after both are taken off.
    const d = db((args) => ({ data: rowsFor(args), error: null }), 10, 3);
    await openIntentBatch(d.client, conn(enough(5) + 10 * PENDING + 3 * (RENT + 10_000)), intent, 2);
    expect(d.rpcCalls[0]).toMatchObject({ p_max_open: 10 + 5 });
    expect(d.counts).toEqual(expect.arrayContaining([
      ["generation_payment_intents", "eq", "status", "building", { count: "exact", head: true }],
      // Only units not handed out yet: a handed-out unit's account exists (round 7, 2026-10-20).
      ["generation_payment_intents", "is", "tx_signature", null, { count: "exact", head: true }],
    ]));
    // Each filter on its own count: the open count takes every open account, the creating count only units still
    // being created and not handed out; moved to the other query, either double counts or refuses (round 8, 2026-10-20).
    const creatingQuery = d.queries.find((q) => q.some(([m]) => m === "gte"));
    expect(d.queries.find((q) => q !== creatingQuery)).toEqual([["not", "nonce_account", "is", null], ["is", "nonce_closed_at", null]]);
    expect(creatingQuery?.slice(0, 4)).toEqual([["not", "nonce_account", "is", null], ["is", "nonce_closed_at", null], ["eq", "status", "building"], ["is", "tx_signature", null]]);
    // Reserved within the last 120 s.
    const window = d.counts.find((c) => c[1] === "gte");
    expect(window?.[2]).toBe("updated_at");
    expect(Math.abs(Date.now() - 120_000 - Date.parse(String(window?.[3])))).toBeLessThan(5_000);
    // One lamport short of that, one unit fewer.
    const short = db((args) => ({ data: rowsFor(args), error: null }), 10, 3);
    await openIntentBatch(short.client, conn(enough(5) + 10 * PENDING + 3 * (RENT + 10_000) - 1), intent, 2);
    expect(short.rpcCalls[0]).toMatchObject({ p_max_open: 10 + 4 });
  });

  it("creates nothing and asks nothing of the database when the fee payer cannot carry the rent and its reserve", async () => {
    const d = db(() => ({ data: [], error: null }));
    expect(await openIntentBatch(d.client, conn(enough(3) - 1), intent, 3)).toEqual({ ok: false, refusal: "fee_payer_low" });
    expect(d.rpcCalls).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    expect((await openIntentBatch(d.client, conn(enough(3)), intent, 3)).ok).toBe(false);
    expect(d.rpcCalls).toHaveLength(1);
  });

  it("creates no account when the caps refuse the batch", async () => {
    const d = db(() => ({ data: [], error: null }));
    expect(await openIntentBatch(d.client, conn(enough(2)), intent, 2)).toEqual({ ok: false, refusal: "cap" });
    expect(create).not.toHaveBeenCalled();
  });

  it("voids what a batch whose answer was lost may have reserved, as Enki's (round 5, 2026-10-20)", async () => {
    const d = db(() => ({ data: null, error: { code: "08006" } }));
    await expect(openIntentBatch(d.client, conn(enough(2)), intent, 2)).rejects.toMatchObject({ code: "08006" });
    const voided = d.updates.find((u) => u.patch.void_reason === "provider_failed");
    expect(voided?.filters).toEqual([["batch_intent_id", intent.id], ["authorized_at", null], ["voided_at", null]]);
    expect(create).not.toHaveBeenCalled();
  });

  it("says the intent is not open when the database refuses it", async () => {
    const d = db(() => ({ data: null, error: { code: "P0002" } }));
    expect(await openIntentBatch(d.client, conn(enough(1)), intent, 1)).toEqual({ ok: false, refusal: "not_open" });
    expect(create).not.toHaveBeenCalled();
  });

  it("voids the batch when one account fails and leaves every close to the cron (round 4, 2026-10-19)", async () => {
    let n = 0;
    create.mockImplementation(async (kp: Keypair) => { if (++n === 2) throw new Error("rpc down"); created.push(kp.publicKey.toBase58()); return { address: kp.publicKey.toBase58(), nonce: "x" }; });
    const d = db((args) => ({ data: rowsFor(args), error: null }));
    expect(await openIntentBatch(d.client, conn(enough(3)), intent, 3)).toEqual({ ok: false, refusal: "nonce_failed" });
    // Enki's failure: provider_failed, which the buyer's dropped-unit pause never counts (verification 2026-10-18).
    const voided = d.updates.find((u) => u.patch.void_reason === "provider_failed");
    expect(voided?.filters).toContainEqual(["id", [intent.id, "unit-1", "unit-2"]]);
    // A close a moment after the create could see the account "gone" and record it closed for good.
    expect(closed).toEqual([]);
    expect(d.updates.filter((u) => "nonce_closed_at" in u.patch)).toEqual([]);
  });
});

describe("a void records the close of its nonce", () => {
  it("marks the unit's nonce closed once the account is gone, and not when the close failed", async () => {
    const { voidAndFlush } = await import("@/lib/payments/settle");
    voidAuth.mockResolvedValue({ nonceAccount: "NonceA" });
    const d = db(() => ({ data: null, error: null }));
    expect(await voidAndFlush(d.client, "unit-9", "provider_failed")).toBe(true);
    expect(d.updates.some((u) => "nonce_closed_at" in u.patch && u.filters.some((f) => f[0] === "id" && f[1] === "unit-9"))).toBe(true);
    close.mockResolvedValue("failed");
    const e = db(() => ({ data: null, error: null }));
    await voidAndFlush(e.client, "unit-10", "provider_failed");
    expect(e.updates.some((u) => "nonce_closed_at" in u.patch)).toBe(false);
  });
});
