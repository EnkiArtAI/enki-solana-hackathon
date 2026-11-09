import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The capture of the intent rail (Kev, 2026-10-18: "wir printen nichts OHNE
 * bestätigter buchung"): booked only once the chain confirms; a refusal voids;
 * an unanswered send is made final by closing the nonce and then looked up;
 * only an unreadable history stays unknown. A withheld artist share is owed
 * as a licence credit once the payment landed.
 */
const s = vi.hoisted(() => ({
  claim: vi.fn(), book: vi.fn(), state: vi.fn(), owed: vi.fn(), refund: vi.fn(), fail: vi.fn(), submit: vi.fn(), landed: vi.fn(), close: vi.fn(), credit: vi.fn(),
  refused: vi.fn(), deserialize: vi.fn(), unfulfil: vi.fn(), marks: [] as string[], markError: null as null | { message: string }, creator: "creator-1" as string | null,
  conn: { getAccountInfoAndContext: vi.fn() },
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => { void fn(); } }));
vi.mock("@/lib/payments/authorization", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/authorization")>()),
  claimCapture: (...a: unknown[]) => s.claim(...a),
  bookCaptured: (...a: unknown[]) => s.book(...a),
  bookingState: (...a: unknown[]) => s.state(...a),
  bookPaidUndelivered: (...a: unknown[]) => s.owed(...a),
  recordRefundOwed: (...a: unknown[]) => s.refund(...a),
  failCapture: (...a: unknown[]) => s.fail(...a),
  unfulfil: (...a: unknown[]) => s.unfulfil(...a),
}));
vi.mock("@/lib/payments/x402-settle", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/x402-settle")>()),
  submitAndConfirm: (...a: unknown[]) => s.submit(...a),
  paymentConfirmed: (...a: unknown[]) => s.landed(...a),
  transferRefused: (...a: unknown[]) => s.refused(...a),
}));
vi.mock("@/lib/payments/nonce", () => ({ closeNonceAccount: (...a: unknown[]) => s.close(...a), createNonceAccount: vi.fn() }));
vi.mock("@/lib/payments/licence-credits", () => ({ recordLicenceCredits: (...a: unknown[]) => s.credit(...a) }));
vi.mock("@/lib/payments/solana", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/solana")>()),
  solanaConnection: () => s.conn,
  feePayerKeypair: () => ({ publicKey: "FeePayerKey" }),
}));
vi.mock("@solana/web3.js", async (orig) => {
  const real = await orig<typeof import("@solana/web3.js")>();
  // Accounts here are short labels; the connection is a stand-in that never reads the key.
  class PublicKey extends real.PublicKey { constructor(v: ConstructorParameters<typeof real.PublicKey>[0]) { try { super(v); } catch { super(new Uint8Array(32)); } } }
  return { ...real, PublicKey, Transaction: { ...real.Transaction, from: () => ({}) }, VersionedTransaction: { ...real.VersionedTransaction, deserialize: () => s.deserialize() } };
});

import { captureHeld } from "@/lib/payments/settle";

const db = {
  from: (table: string) => ({
    update: (patch: Record<string, unknown>) => {
      const q = {
        eq: (_c: string, v: string) => { if ("nonce_closed_at" in patch) s.marks.push(v); return q; },
        is: () => q,
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: "nonce_closed_at" in patch ? s.markError : null }).then(ok),
      };
      return q;
    },
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "prompts" && s.creator ? { creator_id: s.creator } : null }) }) }),
  }),
} as never;

const held = (over: Record<string, unknown> = {}) => ({
  intentId: "unit-1", signedTx: "AA==", signature: "SigOfFeePayer", nonceAccount: "NonceA", totalMicro: 1_106_930,
  plan: { cuPriceMicroLamports: 0, artistWithheld: false }, owner: "BuyerW", artistWallet: "ArtistW", artistAmountMicro: 1_000_000, promptId: "p-1", ...over,
});

beforeEach(() => {
  for (const f of [s.claim, s.book, s.state, s.owed, s.refund, s.fail, s.submit, s.landed, s.close, s.credit, s.refused]) f.mockReset();
  // By default the chain would refuse the transfer: the buyer's USDC account cannot pay.
  s.refused.mockResolvedValue(true);
  s.deserialize.mockReset(); s.deserialize.mockReturnValue({ held: true });
  s.unfulfil.mockReset(); s.unfulfil.mockResolvedValue(true); s.markError = null;
  // The node that answers sees the closed nonce account gone at slot 100.
  s.conn.getAccountInfoAndContext.mockReset(); s.conn.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 100 }, value: null });
  // A test that fails mid-way must not leave the next ones on fake timers.
  vi.useRealTimers();
  s.marks.length = 0; s.creator = "creator-1";
  s.claim.mockResolvedValue(held());
  s.book.mockResolvedValue(true); s.state.mockResolvedValue("open"); s.owed.mockResolvedValue(true); s.refund.mockResolvedValue(true); s.fail.mockResolvedValue(true);
  s.close.mockResolvedValue("closed"); s.credit.mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("capturing a held authorisation", () => {
  it("books only once the chain confirmed, then returns the nonce rent", async () => {
    s.submit.mockResolvedValue({ ok: true, signature: "SigOfFeePayer" });
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "captured", signature: "SigOfFeePayer" });
    expect(s.book).toHaveBeenCalledWith(db, "unit-1");
    expect(s.fail).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(s.close).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(s.marks).toEqual(["unit-1"]));
  });

  it("voids a refused capture that did not land as capture_failed, and books nothing", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: false, error: "insufficient funds", signature: "SigOfFeePayer" });
    s.landed.mockResolvedValue(false);
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "rejected", error: "insufficient funds" });
    expect(s.fail).toHaveBeenCalledWith(db, "unit-1", "capture_failed");
    expect(s.book).not.toHaveBeenCalled();
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it("books a refused capture whose payment had already landed: the buyer broadcast it first (review 2026-10-18)", async () => {
    const order: string[] = [];
    s.submit.mockResolvedValue({ ok: false, pending: false, error: "nonce has advanced", signature: "SigOfFeePayer" });
    s.close.mockImplementation(async () => { order.push("close"); return "gone"; });
    s.landed.mockImplementation(async () => { order.push("look"); return true; });
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "captured", signature: "SigOfFeePayer" });
    expect(order).toEqual(["close", "look"]);
    expect(s.book).toHaveBeenCalledWith(db, "unit-1");
    expect(s.fail).not.toHaveBeenCalled();
  });

  it("counts a capture as the buyer's only when the chain refuses its token transfer (round 4, 2026-10-19)", async () => {
    const order: string[] = [];
    s.refused.mockImplementation(async (_c: unknown, tx: unknown) => { order.push("simulate"); expect(tx).toEqual({ held: true }); return true; });
    s.close.mockImplementation(async () => { order.push("close"); return "closed"; });
    s.submit.mockResolvedValue({ ok: false, pending: false, error: "owner does not match", signature: "SigOfFeePayer" });
    s.landed.mockResolvedValue(false);
    await captureHeld(db, "unit-1");
    // Judged before the close changes the nonce.
    expect(order).toEqual(["simulate", "close"]);
    // With the payment's signature, so a payment the buyer already landed as a failure is judged by its own error.
    expect(s.refused).toHaveBeenCalledWith(s.conn, { held: true }, "SigOfFeePayer");
    expect(s.fail).toHaveBeenLastCalledWith(db, "unit-1", "capture_failed");
  });

  it.each([
    ["the chain would take the transfer (the RPC refused for its own reasons)", false],
    ["the simulation cannot run", null],
  ])("does not count a refused capture when %s", async (_label, refused) => {
    s.refused.mockResolvedValue(refused);
    s.submit.mockResolvedValue({ ok: false, pending: false, error: "node is behind", signature: "SigOfFeePayer" });
    s.landed.mockResolvedValue(false);
    await captureHeld(db, "unit-1");
    expect(s.fail).toHaveBeenLastCalledWith(db, "unit-1", "provider_failed");
  });

  it("does not count a capture whose held payment cannot be read for the judgement", async () => {
    s.deserialize.mockImplementation(() => { throw new Error("bad bytes"); });
    s.submit.mockResolvedValue({ ok: false, pending: false, error: "x", signature: "SigOfFeePayer" });
    s.landed.mockResolvedValue(false);
    await captureHeld(db, "unit-1");
    expect(s.fail).toHaveBeenLastCalledWith(db, "unit-1", "provider_failed");
  });

  it("judges a timeout that did not land the same way: the buyer's only when their transfer is refused", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.landed.mockResolvedValue(false);
    s.refused.mockResolvedValue(false);
    await captureHeld(db, "unit-1");
    expect(s.fail).toHaveBeenLastCalledWith(db, "unit-1", "provider_failed");
    s.refused.mockResolvedValue(true);
    await captureHeld(db, "unit-1");
    expect(s.fail).toHaveBeenLastCalledWith(db, "unit-1", "capture_failed");
  });

  it("counts nothing against the buyer when the judgement misses the deadline", async () => {
    s.refused.mockImplementation(() => new Promise(() => {}));
    s.submit.mockResolvedValue({ ok: false, pending: false, error: "x", signature: "SigOfFeePayer" });
    // The close and the lookup still answer at once: the payment did not land, and the void is Enki's.
    s.landed.mockResolvedValue(false);
    expect(await captureHeld(db, "unit-1", { deadlineAt: Date.now() + 20 })).toMatchObject({ kind: "rejected" });
    expect(s.fail).toHaveBeenLastCalledWith(db, "unit-1", "provider_failed");
    // And a close that misses it too stays unknown, voiding nothing.
    s.close.mockImplementation(() => new Promise(() => {}));
    s.fail.mockClear();
    expect(await captureHeld(db, "unit-1", { deadlineAt: Date.now() + 20 })).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    expect(s.fail).not.toHaveBeenCalled();
  });

  it("keeps a refused capture unknown when its nonce could not be closed: an earlier broadcast could still land", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: false, error: "insufficient funds", signature: "SigOfFeePayer" });
    s.close.mockResolvedValue("failed");
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    expect(s.fail).not.toHaveBeenCalled(); expect(s.landed).not.toHaveBeenCalled();
  });

  it("makes an unanswered capture final by closing the nonce first, then books what landed", async () => {
    const order: string[] = [];
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.close.mockImplementation(async () => { order.push("close"); return "closed"; });
    s.landed.mockImplementation(async () => { order.push("look"); return true; });
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "captured", signature: "SigOfFeePayer" });
    expect(order).toEqual(["close", "look"]);
    expect(s.book).toHaveBeenCalled();
    // Closed once, not again after the booking.
    await new Promise((r) => setTimeout(r, 0));
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it("voids an unanswered capture that did not land", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.landed.mockResolvedValue(false);
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "rejected", error: "The payment did not land" });
    expect(s.fail).toHaveBeenCalled();
    expect(s.book).not.toHaveBeenCalled();
  });

  it("reads a lagging node exactly three times, 400 ms apart (round 7, 2026-10-20)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.conn.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 99 }, value: { lamports: 1, data: Buffer.alloc(80) } });
    const done = captureHeld(db, "unit-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.conn.getAccountInfoAndContext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(399);
    expect(s.conn.getAccountInfoAndContext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.conn.getAccountInfoAndContext).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(await done).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    expect(s.conn.getAccountInfoAndContext).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("goes on with a capture whose close could not be recorded: the account is gone all the same (round 7, 2026-10-20)", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.markError = { message: "down" };
    s.landed.mockResolvedValue(true);
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "captured", signature: "SigOfFeePayer" });
    expect(s.book).toHaveBeenCalledWith(db, "unit-1");
  });

  it("reads the anchor from the unit's own nonce account, at confirmed (round 6, 2026-10-20)", async () => {
    const NONCE = "So11111111111111111111111111111111111111112";
    s.claim.mockResolvedValue(held({ nonceAccount: NONCE }));
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.landed.mockResolvedValue(false);
    await captureHeld(db, "unit-1");
    const [key, commitment] = s.conn.getAccountInfoAndContext.mock.calls[0];
    expect([String(key.toBase58()), commitment]).toEqual([NONCE, "confirmed"]);
  });

  it("asks whether the payment landed only of a node that has seen its account gone (round 5, 2026-10-20)", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.landed.mockResolvedValue(false);
    await captureHeld(db, "unit-1");
    expect(s.landed).toHaveBeenCalledWith(s.conn, "SigOfFeePayer", { goneAtSlot: 100 });
    // A node that still sees the account is behind the close, maybe behind the payment too: unknown, nothing voided.
    s.fail.mockClear(); s.landed.mockClear();
    s.conn.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 99 }, value: { lamports: 1, data: Buffer.alloc(80) } });
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    expect(s.landed).not.toHaveBeenCalled(); expect(s.fail).not.toHaveBeenCalled();
    // Asked three times, 400 ms apart, before giving up (round 6).
    expect(s.conn.getAccountInfoAndContext.mock.calls.length).toBeGreaterThanOrEqual(3);
    // A node that catches up on the second read settles it after all.
    s.conn.getAccountInfoAndContext.mockReset();
    s.conn.getAccountInfoAndContext.mockResolvedValueOnce({ context: { slot: 99 }, value: { lamports: 1, data: Buffer.alloc(80) } }).mockResolvedValue({ context: { slot: 101 }, value: null });
    expect(await captureHeld(db, "unit-1")).toMatchObject({ kind: "rejected" });
    expect(s.landed).toHaveBeenLastCalledWith(s.conn, "SigOfFeePayer", { goneAtSlot: 101 });
    s.fail.mockClear();
    s.conn.getAccountInfoAndContext.mockRejectedValue(new Error("rpc down"));
    expect(await captureHeld(db, "unit-1")).toMatchObject({ kind: "unknown" });
    expect(s.fail).not.toHaveBeenCalled();
  });

  it("stays unknown when the history cannot be read, and books or voids nothing", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.landed.mockResolvedValue(null);
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    expect(s.book).not.toHaveBeenCalled();
    expect(s.fail).not.toHaveBeenCalled();
  });

  it("stays unknown without looking when the nonce could not be closed: the payment could still land", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.close.mockResolvedValue("failed");
    expect(await captureHeld(db, "unit-1")).toMatchObject({ kind: "unknown" });
    expect(s.landed).not.toHaveBeenCalled();
    expect(s.marks).toEqual([]);
  });

  it("withholds a landed payment it cannot book as delivered, and books it refund-owed right away (verification 2026-10-18)", async () => {
    s.submit.mockResolvedValue({ ok: true, signature: "SigOfFeePayer" });
    s.book.mockResolvedValue(false);
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    expect(s.book).toHaveBeenCalledTimes(2);
    expect(s.state).toHaveBeenCalledWith(db, "unit-1");
    expect(s.owed).toHaveBeenCalledWith(db, "unit-1", "SigOfFeePayer", "the capture landed but its booking failed");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.close).not.toHaveBeenCalled();
    expect(s.credit).not.toHaveBeenCalled();
  });

  it("makes sure a withheld image's row does not say delivered, whatever a lost answer committed (round 5, 2026-10-20)", async () => {
    s.submit.mockResolvedValue({ ok: true, signature: "SigOfFeePayer" });
    s.book.mockResolvedValue(false);
    s.owed.mockResolvedValue(false);
    // The delivered booking committed, but neither its answer nor any read came back.
    s.state.mockResolvedValue(null);
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    await vi.waitFor(() => expect(s.unfulfil).toHaveBeenCalledWith(db, "unit-1"));
    // A write that fails is tried again, 2 s apart.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    s.unfulfil.mockReset(); s.unfulfil.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await captureHeld(db, "unit-1");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.unfulfil).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    // A delivered booking asks for nothing of the kind.
    s.unfulfil.mockClear(); s.book.mockResolvedValue(true);
    await captureHeld(db, "unit-1");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.unfulfil).not.toHaveBeenCalled();
  });

  it("delivers when the retried booking sticks", async () => {
    s.submit.mockResolvedValue({ ok: true, signature: "SigOfFeePayer" });
    s.book.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "captured", signature: "SigOfFeePayer" });
    expect(s.owed).not.toHaveBeenCalled();
  });

  it("delivers when the first booking committed after its re-read: the refund-owed booking loses to it", async () => {
    s.submit.mockResolvedValue({ ok: true, signature: "SigOfFeePayer" });
    s.book.mockResolvedValue(false);
    s.owed.mockResolvedValue(false);
    s.state.mockResolvedValueOnce("open").mockResolvedValueOnce("delivered");
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "captured", signature: "SigOfFeePayer" });
  });

  it("withholds whatever else the row reads after its refund-owed booking did not stick: the sweeps settle it (round 4, 2026-10-19)", async () => {
    // Refund-owed by a write whose answer was lost (its refund row is sweepRefundsOwed's), still open (the
    // unknown-capture sweep's), or unreadable.
    s.submit.mockResolvedValue({ ok: true, signature: "SigOfFeePayer" });
    s.book.mockResolvedValue(false);
    s.owed.mockResolvedValue(false);
    for (const last of ["owed", "open", null]) {
      s.state.mockResolvedValueOnce("open").mockResolvedValueOnce(last);
      expect(await captureHeld(db, "unit-1")).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    }
    expect(s.refund).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.credit).not.toHaveBeenCalled();
  });

  it("books nothing for a send confirmed after the deadline: the sweep settles it (verification 2026-10-18)", async () => {
    // The confirmation wins the race against the timer, but the clock already shows the deadline passed.
    let now = 1_790_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    s.submit.mockImplementation(async () => { now += 2_000; return { ok: true, signature: "SigOfFeePayer" }; });
    expect(await captureHeld(db, "unit-1", { deadlineAt: now + 1_000 })).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    expect(s.book).not.toHaveBeenCalled();
    clock.mockRestore();
  });

  it("cuts off a send that stalls past the deadline and settles it like a timeout", async () => {
    s.submit.mockImplementation(() => new Promise(() => {}));
    s.close.mockImplementation(() => new Promise(() => {}));
    expect(await captureHeld(db, "unit-1", { deadlineAt: Date.now() + 20 })).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    expect(s.book).not.toHaveBeenCalled(); expect(s.fail).not.toHaveBeenCalled();
  });

  it("answers by its deadline when the landed lookup hangs: unknown, nothing booked", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.landed.mockImplementation(() => new Promise(() => {}));
    expect(await captureHeld(db, "unit-1", { deadlineAt: Date.now() + 20 })).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    expect(s.book).not.toHaveBeenCalled();
  });

  it("books nothing for a payment found landed once the deadline has passed: the sweep settles it", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.landed.mockResolvedValue(true);
    expect(await captureHeld(db, "unit-1", { deadlineAt: Date.now() - 1 })).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    expect(s.landed).toHaveBeenCalled();
    expect(s.book).not.toHaveBeenCalled();
  });

  it("books a landed payment found before the deadline", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.landed.mockResolvedValue(true);
    expect(await captureHeld(db, "unit-1", { deadlineAt: Date.now() + 60_000 })).toEqual({ kind: "captured", signature: "SigOfFeePayer" });
  });

  it("delivers when the booking committed but its acknowledgement was lost", async () => {
    s.submit.mockResolvedValue({ ok: true, signature: "SigOfFeePayer" });
    s.book.mockResolvedValue(false);
    s.state.mockResolvedValue("delivered");
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "captured", signature: "SigOfFeePayer" });
  });

  it("answers by its deadline when the nonce close hangs: unknown, nothing booked or voided", async () => {
    s.submit.mockResolvedValue({ ok: false, pending: true, error: "timeout", signature: "SigOfFeePayer" });
    s.close.mockImplementation(() => new Promise(() => {}));
    const out = await captureHeld(db, "unit-1", { deadlineAt: Date.now() + 20 });
    expect(out).toEqual({ kind: "unknown", signature: "SigOfFeePayer" });
    expect(s.landed).not.toHaveBeenCalled();
    expect(s.fail).not.toHaveBeenCalled(); expect(s.book).not.toHaveBeenCalled();
  });

  it("sends nothing when another worker or a void holds the row", async () => {
    s.claim.mockResolvedValue(null);
    expect(await captureHeld(db, "unit-1")).toEqual({ kind: "lost" });
    expect(s.submit).not.toHaveBeenCalled();
  });
});

describe("a withheld artist share", () => {
  it("is owed as a licence credit to the artist's account once the payment landed", async () => {
    s.claim.mockResolvedValue(held({ plan: { cuPriceMicroLamports: 0, artistWithheld: true } }));
    s.submit.mockResolvedValue({ ok: true, signature: "SigOfFeePayer" });
    await captureHeld(db, "unit-1");
    await vi.waitFor(() => expect(s.credit).toHaveBeenCalledTimes(1));
    expect(s.credit.mock.calls[0][1]).toMatchObject({
      source: "intent:unit-1", promptId: "p-1",
      credits: [{ role: "artist", owner: "ArtistW", userId: "creator-1", micro: 1_000_000 }],
    });
  });

  it("is written before the nonce close, which may outlast the function (review 2026-10-18)", async () => {
    const order: string[] = [];
    s.claim.mockResolvedValue(held({ plan: { cuPriceMicroLamports: 0, artistWithheld: true } }));
    s.submit.mockResolvedValue({ ok: true, signature: "SigOfFeePayer" });
    s.credit.mockImplementation(async () => { order.push("credit"); return true; });
    s.close.mockImplementation(async () => { order.push("close"); return "closed"; });
    await captureHeld(db, "unit-1");
    await vi.waitFor(() => expect(order).toEqual(["credit", "close"]));
  });

  it("a credit that fails still lets the nonce close", async () => {
    s.claim.mockResolvedValue(held({ plan: { cuPriceMicroLamports: 0, artistWithheld: true } }));
    s.submit.mockResolvedValue({ ok: true, signature: "SigOfFeePayer" });
    s.credit.mockRejectedValue(new Error("db down"));
    await captureHeld(db, "unit-1");
    await vi.waitFor(() => expect(s.close).toHaveBeenCalledTimes(1));
  });

  it("owes nothing when the artist was paid in their own leg, or the capture failed", async () => {
    s.submit.mockResolvedValue({ ok: true, signature: "SigOfFeePayer" });
    await captureHeld(db, "unit-1");
    s.claim.mockResolvedValue(held({ plan: { cuPriceMicroLamports: 0, artistWithheld: true } }));
    s.submit.mockResolvedValue({ ok: false, pending: false, error: "x", signature: "SigOfFeePayer" });
    // The failed branch for real: the payment did not land (verification 2026-10-18; it ran the unknown branch).
    s.landed.mockResolvedValue(false);
    expect(await captureHeld(db, "unit-1")).toMatchObject({ kind: "rejected" });
    expect(s.fail).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.credit).not.toHaveBeenCalled();
  });
});
