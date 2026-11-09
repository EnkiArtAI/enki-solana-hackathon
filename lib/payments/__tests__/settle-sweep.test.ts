import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * How the intent rail settles every way an intent can end (2026-10-18): a
 * void closes the nonce and books a payment the buyer broadcast themselves
 * (refund owed); the sweep settles a capture whose outcome stayed unknown,
 * and returns the rent of every final intent whose nonce is still open.
 */
const s = vi.hoisted(() => ({
  voidAuth: vi.fn(), abandoned: vi.fn(), unsubmitted: vi.fn(), held: vi.fn(), paidUndelivered: vi.fn(), fail: vi.fn(), refunds: vi.fn(),
  landed: vi.fn(), close: vi.fn(), marks: [] as string[], lts: [] as unknown[][],
  unknownRows: [] as Record<string, unknown>[], finalRows: [] as Record<string, unknown>[],
  conn: { getAccountInfoAndContext: vi.fn() }, markError: null as null | { message: string }, updatedAt: "2026-01-01T00:00:00Z", freshReads: [] as string[],
}));
vi.mock("@/lib/payments/authorization", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/authorization")>()),
  voidAuthorization: (...a: unknown[]) => s.voidAuth(...a),
  sweepAbandoned: (...a: unknown[]) => s.abandoned(...a),
  sweepUnsubmitted: (...a: unknown[]) => s.unsubmitted(...a),
  heldSignatureOf: (...a: unknown[]) => s.held(...a),
  bookPaidUndelivered: (...a: unknown[]) => s.paidUndelivered(...a),
  failCapture: (...a: unknown[]) => s.fail(...a),
  sweepRefundsOwed: (...a: unknown[]) => s.refunds(...a),
}));
vi.mock("@/lib/payments/x402-settle", async (orig) => ({ ...(await orig<typeof import("@/lib/payments/x402-settle")>()), paymentConfirmed: (...a: unknown[]) => s.landed(...a) }));
vi.mock("@/lib/payments/nonce", () => ({ closeNonceAccount: (...a: unknown[]) => s.close(...a), createNonceAccount: vi.fn() }));
vi.mock("@solana/web3.js", async (orig) => {
  const real = await orig<typeof import("@solana/web3.js")>();
  // Accounts here are short labels; the connection is a stand-in that never reads the key.
  class PublicKey extends real.PublicKey { constructor(v: ConstructorParameters<typeof real.PublicKey>[0]) { try { super(v); } catch { super(new Uint8Array(32)); } } }
  return { ...real, PublicKey };
});
vi.mock("@/lib/payments/solana", async (orig) => ({ ...(await orig<typeof import("@/lib/payments/solana")>()), solanaConnection: () => s.conn, feePayerKeypair: () => ({}) }));

import { voidAndFlush, sweepAndFlush } from "@/lib/payments/settle";
import { fakeClient, type Row } from "./_pg-fake";

const db = {
  from: () => ({
    update: (patch: Record<string, unknown>) => {
      const q = { eq: (_c: string, v: string) => { if ("nonce_closed_at" in patch) s.marks.push(v); return q; }, is: () => q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: "nonce_closed_at" in patch ? s.markError : null }).then(ok) };
      return q;
    },
    select: (cols: string) => {
      // A row's last write, read before a "gone" close is believed (round 5, 2026-10-20).
      if (cols === "updated_at") return { eq: (_c: string, id: string) => { s.freshReads.push(id); return { maybeSingle: async () => (s.updatedAt === "unreadable" ? { data: null, error: { message: "down" } } : { data: { updated_at: s.updatedAt }, error: null }) }; } };
      const rows = cols.includes("tx_signature") ? s.unknownRows : s.finalRows;
      const q: Record<string, unknown> = {};
      for (const m of ["not", "is", "or"]) q[m] = () => q;
      q.lt = (c: string, v: unknown) => { s.lts.push([cols, c, v]); return q; };
      q.limit = async () => ({ data: rows, error: null });
      return q;
    },
  }),
} as never;

beforeEach(() => {
  for (const f of [s.voidAuth, s.abandoned, s.unsubmitted, s.held, s.paidUndelivered, s.fail, s.landed, s.close, s.refunds]) f.mockReset();
  s.refunds.mockResolvedValue(0);
  s.marks.length = 0; s.markError = null; s.updatedAt = "2026-01-01T00:00:00Z"; s.freshReads.length = 0; s.unknownRows = []; s.finalRows = []; s.lts.length = 0;
  s.close.mockResolvedValue("closed");
  s.conn.getAccountInfoAndContext.mockReset(); s.conn.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 100 }, value: null });
  s.abandoned.mockResolvedValue([]); s.unsubmitted.mockResolvedValue([]);
  s.held.mockResolvedValue("HeldSig");
  s.paidUndelivered.mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a void", () => {
  beforeEach(() => s.voidAuth.mockResolvedValue({ nonceAccount: "NonceA" }));

  it("closes the nonce, records it and books nothing when the held payment did not land", async () => {
    s.landed.mockResolvedValue(false);
    expect(await voidAndFlush(db, "u-1", "provider_failed")).toBe(true);
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(s.marks).toEqual(["u-1"]);
    expect(s.paidUndelivered).not.toHaveBeenCalled();
  });

  it("books a payment the buyer broadcast themselves, with a refund owed", async () => {
    s.landed.mockResolvedValue(true);
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.landed).toHaveBeenCalledWith(expect.anything(), "HeldSig", { goneAtSlot: 100 });
    expect(s.paidUndelivered).toHaveBeenCalledWith(db, "u-1", "HeldSig", expect.stringContaining("broadcast"));
  });

  it("looks nothing up while the nonce is still open: the payment could still land", async () => {
    s.close.mockResolvedValue("failed");
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.landed).not.toHaveBeenCalled();
    expect(s.marks).toEqual([]);
  });

  it("says so when it cannot tell, books nothing, and leaves the close unrecorded for the sweep to ask again", async () => {
    s.landed.mockResolvedValue(null);
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.paidUndelivered).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("could not tell"), "u-1");
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(s.marks).toEqual([]);
  });

  it("records the close of a landed payment only once its booking stuck (round 4, 2026-10-19)", async () => {
    s.landed.mockResolvedValue(true);
    s.paidUndelivered.mockResolvedValue(false);
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.marks).toEqual([]);
    s.paidUndelivered.mockResolvedValue(true);
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.marks).toEqual(["u-1"]);
  });

  it("believes a \"gone\" account only on a row not written in the last 2 minutes (round 5, 2026-10-20)", async () => {
    s.close.mockResolvedValue("gone");
    s.held.mockResolvedValue(null);
    s.updatedAt = new Date(Date.now() - 60_000).toISOString();
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.marks).toEqual([]);
    s.updatedAt = new Date(Date.now() - 180_000).toISOString();
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.marks).toEqual(["u-1"]);
    expect(s.freshReads).toEqual(["u-1", "u-1"]);
    // A row it cannot read counts as fresh (round 6, 2026-10-20).
    s.marks.length = 0; s.updatedAt = "unreadable";
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.marks).toEqual([]);
    // A close that found the account is believed at once.
    s.marks.length = 0; s.close.mockResolvedValue("closed"); s.updatedAt = new Date().toISOString();
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.marks).toEqual(["u-1"]);
  });

  it("leaves the close unrecorded while the answering node still sees the account (round 5, 2026-10-20)", async () => {
    s.landed.mockResolvedValue(false);
    s.conn.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 99 }, value: { lamports: 1, data: Buffer.alloc(80) } });
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.landed).not.toHaveBeenCalled();
    expect(s.marks).toEqual([]);
    s.conn.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 100 }, value: null });
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.landed).toHaveBeenCalledWith(s.conn, "HeldSig", { goneAtSlot: 100 });
    expect(s.marks).toEqual(["u-1"]);
  });

  it("reads SOL sent to a closed nonce's address as the nonce gone (round 6, 2026-10-20)", async () => {
    s.landed.mockResolvedValue(false);
    s.conn.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 140 }, value: { lamports: 5_000, data: Buffer.alloc(0) } });
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.landed).toHaveBeenCalledWith(s.conn, "HeldSig", { goneAtSlot: 140 });
    expect(s.marks).toEqual(["u-1"]);
  });

  it("leaves the close unrecorded when the held payment cannot be read, and looks nothing up", async () => {
    s.held.mockRejectedValue(new Error("db down"));
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.landed).not.toHaveBeenCalled();
    expect(s.marks).toEqual([]);
  });

  it("records the close of a unit whose payment was never handed out, without a lookup", async () => {
    s.held.mockResolvedValue(null);
    await voidAndFlush(db, "u-1", "provider_failed");
    expect(s.landed).not.toHaveBeenCalled();
    expect(s.marks).toEqual(["u-1"]);
  });

  it("does nothing more when it lost the row", async () => {
    s.voidAuth.mockResolvedValue(null);
    expect(await voidAndFlush(db, "u-1", "provider_failed")).toBe(false);
    expect(s.close).not.toHaveBeenCalled();
  });
});

describe("the sweep", () => {
  it("settles abandoned rows like a void", async () => {
    s.abandoned.mockResolvedValue([{ intentId: "u-2", nonceAccount: "N2" }]);
    s.landed.mockResolvedValue(true);
    await sweepAndFlush(db);
    expect(s.paidUndelivered).toHaveBeenCalledWith(db, "u-2", "HeldSig", expect.any(String));
  });

  it("settles a capture whose outcome stayed unknown: closes its nonce first, then books it or fails it from the chain", async () => {
    const order: string[] = [];
    s.close.mockImplementation(async () => { order.push("close"); return "closed"; });
    s.landed.mockImplementation(async (_c: unknown, sig: string) => { order.push(`look:${sig}`); return sig === "Landed"; });
    s.unknownRows = [
      { id: "u-3", nonce_account: "N3", nonce_closed_at: null, tx_signature: "Landed" },
      { id: "u-4", nonce_account: "N4", nonce_closed_at: "t", tx_signature: "Gone" },
    ];
    expect(await sweepAndFlush(db)).toBe(2);
    expect(order).toEqual(["close", "look:Landed", "look:Gone"]);
    expect(s.paidUndelivered).toHaveBeenCalledWith(db, "u-3", "Landed", expect.stringContaining("unknown"));
    // Enki's side left it without an outcome: never counted against the buyer (verification 2026-10-18).
    expect(s.fail).toHaveBeenCalledWith(db, "u-4", "provider_failed");
  });

  it("does not count an unknown capture settled while its refund-owed booking did not stick (round 4, 2026-10-19)", async () => {
    s.unknownRows = [{ id: "u-10", nonce_account: "N10", nonce_closed_at: "t", tx_signature: "Landed" }];
    s.landed.mockResolvedValue(true);
    s.paidUndelivered.mockResolvedValue(false);
    expect(await sweepAndFlush(db)).toBe(0);
    expect(s.paidUndelivered).toHaveBeenCalledWith(db, "u-10", "Landed", expect.any(String));
  });

  it("settles an unknown capture only from a node that has seen its account gone (round 5, 2026-10-20)", async () => {
    s.unknownRows = [{ id: "u-12", nonce_account: "N12", nonce_closed_at: "t", tx_signature: "Gone12" }];
    s.landed.mockResolvedValue(false);
    s.conn.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 99 }, value: { lamports: 1, data: Buffer.alloc(80) } });
    expect(await sweepAndFlush(db)).toBe(0);
    expect(s.fail).not.toHaveBeenCalled();
    s.conn.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 100 }, value: null });
    expect(await sweepAndFlush(db)).toBe(1);
    expect(s.landed).toHaveBeenCalledWith(s.conn, "Gone12", { goneAtSlot: 100 });
  });

  it("leaves an unknown capture alone while its nonce cannot be closed or its history cannot be read", async () => {
    s.unknownRows = [{ id: "u-5", nonce_account: "N5", nonce_closed_at: null, tx_signature: "S5" }];
    s.close.mockResolvedValueOnce("failed");
    await sweepAndFlush(db);
    expect(s.landed).not.toHaveBeenCalled();
    s.landed.mockResolvedValue(null);
    await sweepAndFlush(db);
    expect(s.paidUndelivered).not.toHaveBeenCalled();
    expect(s.fail).not.toHaveBeenCalled();
  });

  it("settles a voided final intent like any void: closes, then books a payment that landed (review 2026-10-18)", async () => {
    s.finalRows = [{ id: "u-8", nonce_account: "N8", voided_at: "t" }, { id: "u-9", nonce_account: "N9", voided_at: null }];
    s.landed.mockResolvedValue(true);
    expect(await sweepAndFlush(db)).toBe(2);
    expect(s.marks).toEqual(["u-8", "u-9"]);
    expect(s.held).toHaveBeenCalledTimes(1);
    expect(s.paidUndelivered).toHaveBeenCalledWith(db, "u-8", "HeldSig", "the buyer broadcast the held payment");
  });

  it("counts a captured row whose close could not be recorded as nothing done (round 6, 2026-10-20)", async () => {
    s.finalRows = [{ id: "u-14", nonce_account: "N14", voided_at: null }];
    s.markError = { message: "down" };
    expect(await sweepAndFlush(db)).toBe(0);
    s.markError = null;
    expect(await sweepAndFlush(db)).toBe(1);
  });

  it("counts a settled void whose close could not be recorded as nothing done (round 5, 2026-10-20)", async () => {
    s.finalRows = [{ id: "u-13", nonce_account: "N13", voided_at: "t" }];
    s.landed.mockResolvedValue(false);
    s.markError = { message: "down" };
    expect(await sweepAndFlush(db)).toBe(0);
    s.markError = null;
    expect(await sweepAndFlush(db)).toBe(1);
  });

  it("counts a voided final intent it could not settle as nothing done, so the cron's loop stops (round 4, 2026-10-19)", async () => {
    s.finalRows = [{ id: "u-11", nonce_account: "N11", voided_at: "t" }];
    s.landed.mockResolvedValue(null);
    expect(await sweepAndFlush(db)).toBe(0);
    expect(s.marks).toEqual([]);
  });

  it("returns the rent of every final intent whose nonce is still open, and records each close", async () => {
    s.finalRows = [{ id: "u-6", nonce_account: "N6" }, { id: "u-7", nonce_account: "N7" }];
    s.close.mockImplementation(async (_c: unknown, a: string) => (a === "N7" ? "failed" : "closed"));
    expect(await sweepAndFlush(db)).toBe(1);
    expect(s.marks).toEqual(["u-6"]);
  });

  it("writes the refund rows a booking lost, and counts them (round 4, 2026-10-19)", async () => {
    s.refunds.mockResolvedValue(2);
    expect(await sweepAndFlush(db)).toBe(2);
    expect(s.refunds).toHaveBeenCalledWith(db);
  });

  it("never throws, so a failing sweep cannot stop a paying customer's generation", async () => {
    s.abandoned.mockRejectedValue(new Error("db down"));
    expect(await sweepAndFlush(db)).toBe(0);
  });
});

describe("the unknown-capture sweep's patience (review 2026-10-18)", () => {
  it("waits past the route's 300 s budget before it settles a capture lease", async () => {
    const { CAPTURE_UNSETTLED_AFTER_MS, ABANDONED_AFTER_MS } = await import("@/lib/payments/authorization");
    expect(CAPTURE_UNSETTLED_AFTER_MS).toBeGreaterThan(300_000);
    expect(CAPTURE_UNSETTLED_AFTER_MS).toBe(ABANDONED_AFTER_MS);
    // And the sweep's query uses it (verification 2026-10-18: the constant alone proved nothing).
    vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
    await sweepAndFlush(db);
    expect(s.lts).toContainEqual(["id, nonce_account, nonce_closed_at, tx_signature", "capture_started_at", new Date(1_790_000_000_000 - 360_000).toISOString()]);
    vi.restoreAllMocks();
  });
});

describe("a void that must spare a claimed unit (review 2026-10-18)", () => {
  it("passes the buyer's 'unclaimed only' through to the conditional void", async () => {
    s.voidAuth.mockResolvedValue(null);
    expect(await voidAndFlush(db, "unit-1", "cancelled", { unclaimed: true })).toBe(false);
    expect(s.voidAuth).toHaveBeenCalledWith(db, "unit-1", "cancelled", { unclaimed: true });
    await voidAndFlush(db, "unit-2", "provider_failed");
    expect(s.voidAuth).toHaveBeenLastCalledWith(db, "unit-2", "provider_failed", { unclaimed: false });
  });
});

/** The cron's own selections, on rows the fake filters as Postgres would (round 4, 2026-10-19: C8). */
describe("what the sweep picks", () => {
  it("closes only units that ended, and settles only a lease too old for any route", async () => {
    const old = new Date(Date.now() - 400_000).toISOString();
    const young = new Date(Date.now() - 60_000).toISOString();
    const base = { authorized_at: old, consumed_at: old, capture_started_at: null, captured_at: null, voided_at: null, nonce_closed_at: null, tx_signature: null };
    const rows: Row[] = [
      { ...base, id: "live", nonce_account: "NL", tx_signature: "SL" },
      { ...base, id: "captured", nonce_account: "NC", capture_started_at: old, captured_at: old, tx_signature: "SC" },
      { ...base, id: "voided", nonce_account: "NV", voided_at: old },
      { ...base, id: "voidedLease", nonce_account: "NW", capture_started_at: old, voided_at: old, tx_signature: "SW" },
      { ...base, id: "oldLease", nonce_account: "NK", capture_started_at: old, tx_signature: "SK" },
      { ...base, id: "youngLease", nonce_account: "NY", capture_started_at: young, tx_signature: "SY" },
    ];
    s.landed.mockResolvedValue(false);
    s.held.mockResolvedValue(null);
    await sweepAndFlush(fakeClient({ generation_payment_intents: rows }));
    expect(s.close.mock.calls.map((c) => c[1]).sort()).toEqual(["NC", "NK", "NV", "NW"]);
    expect(s.fail.mock.calls.map((c) => c[1])).toEqual(["oldLease"]);
    expect(rows.filter((r) => r.nonce_closed_at).map((r) => r.id).sort()).toEqual(["captured", "oldLease", "voided", "voidedLease"]);
  });
});
