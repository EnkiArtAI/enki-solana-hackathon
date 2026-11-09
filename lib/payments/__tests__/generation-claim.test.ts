import { describe, it, expect } from "vitest";
import { claimForGeneration } from "@/lib/payments/generation-claim";

/**
 * One intent must buy exactly one image, once. Only an authorised intent of the
 * nonce rail is claimable; the prepaid branch is gone (Kev, 2026-10-18).
 *
 * The fake below ENFORCES the filters rather than recording them. A stub that
 * returns a row regardless of `.is("consumed_at", null)` would make every test
 * here pass while the real double-claim went through — the failure mode this
 * file exists to rule out.
 */

type Row = Record<string, unknown>;

function fakeSupabase(initial: Row | null) {
  const state: { row: Row | null } = { row: initial ? { ...initial } : null };
  const calls = { updates: 0 };

  const builder = (mode: "select" | "update", patch?: Row) => {
    const preds: ((r: Row) => boolean)[] = [];
    const api: Record<string, unknown> = {
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), api),
      neq: (c: string, v: unknown) => (preds.push((r) => r[c] !== v), api),
      is: (c: string, v: unknown) => (preds.push((r) => r[c] === v || (v === null && r[c] == null)), api),
      not: (c: string, op: string, v: unknown) => {
        if (op !== "is" || v !== null) throw new Error(`fake: unsupported not(${op})`);
        return preds.push((r) => r[c] != null), api;
      },
      lt: (c: string, v: string) => (preds.push((r) => String(r[c] ?? "") < v), api),
      select: () => api,
      maybeSingle: async () => {
        const r = state.row;
        if (!r || !preds.every((p) => p(r))) return { data: null, error: null };
        if (mode === "update") {
          calls.updates += 1;
          state.row = { ...r, ...patch };
          return { data: { ...state.row }, error: null };
        }
        return { data: { ...r }, error: null };
      },
    };
    return api;
  };

  return {
    client: {
      from: () => ({
        select: () => builder("select"),
        update: (patch: Row) => builder("update", patch),
      }),
    } as never,
    state,
    calls,
  };
}

const BUYER = "So1anaBuyerWa11et";
const base = {
  id: "intent-1",
  buyer_wallet: BUYER,
  resolution: "2K",
  model_family: "nano-banana-pro",
  consumed_at: null,
  fulfilled_at: null,
  captured_at: null,
  voided_at: null,
  authorized_at: null,
  status: "quoted",
};

const claim = (row: Row | null) => {
  const f = fakeSupabase(row);
  return { run: () => claimForGeneration(f.client, { intentId: "intent-1", buyerWallet: BUYER }), f };
};

describe("an intent the escrow rail settled (Kev, 2026-10-18: the prepaid branch is gone)", () => {
  it("is never claimable, so none of the 60 confirmed rows buys another render", async () => {
    // As live escrow rows look: confirmed, deposit settled, no held signature.
    const { run, f } = claim({ ...base, status: "confirmed", deposit_confirmed_at: "2026-10-13T10:00:00Z", fulfilled_at: "2026-10-13T10:01:00Z" });
    expect(await run()).toMatchObject({ ok: false, status: 402 });
    expect(f.calls.updates).toBe(0);
    // Even one that never rendered.
    const fresh = claim({ ...base, status: "confirmed", deposit_confirmed_at: "2026-10-13T10:00:00Z" });
    expect(await fresh.run()).toMatchObject({ ok: false, status: 402 });
    expect(fresh.f.calls.updates).toBe(0);
  });
});

describe("claiming an authorised intent", () => {
  it("claims it once and reports the mode the route must capture under", async () => {
    const { run, f } = claim({ ...base, status: "generating", authorized_at: "2026-08-07T10:00:00Z" });
    const r = await run();
    expect(r).toMatchObject({ ok: true, mode: "authorized", resolution: "2K", modelFamily: "nano-banana-pro" });
    expect(f.state.row?.consumed_at).toBeTruthy();
  });

  it("refuses the SECOND claim, so one signature cannot buy two images", async () => {
    const f = fakeSupabase({ ...base, status: "generating", authorized_at: "2026-08-07T10:00:00Z" });
    const first = await claimForGeneration(f.client, { intentId: "intent-1", buyerWallet: BUYER });
    const second = await claimForGeneration(f.client, { intentId: "intent-1", buyerWallet: BUYER });

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, status: 409 });
    // One row mutation, not two: the refusal is the database's, not a
    // read-then-check that a race could slip through.
    expect(f.calls.updates).toBe(1);
  });

  it("refuses one already captured — the money has moved", async () => {
    const { run } = claim({ ...base, status: "generating", authorized_at: "t", captured_at: "t" });
    expect(await run()).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/already used/i) });
  });

  it("refuses a unit voided between its read and the claim's write: no render for a cancelled unit (round 32, 2026-10-21)", async () => {
    const f = fakeSupabase({ ...base, status: "generating", authorized_at: "t" });
    const client = f.client as unknown as { from: () => { select: () => { maybeSingle: () => Promise<unknown> } } };
    const from = client.from;
    client.from = () => {
      const table = from();
      const select = table.select;
      return { ...table, select: () => {
        const read = select();
        const answer = read.maybeSingle;
        read.maybeSingle = async () => { const r = await answer(); f.state.row = { ...f.state.row!, voided_at: "t" }; return r; };
        return read;
      } };
    };
    expect(await claimForGeneration(f.client, { intentId: "intent-1", buyerWallet: BUYER })).toMatchObject({ ok: false, status: 409 });
    expect(f.calls.updates).toBe(0);
  });

  it("refuses one already voided, and says so distinctly", async () => {
    const { run } = claim({ ...base, status: "generating", authorized_at: "t", voided_at: "t" });
    expect(await run()).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/cancelled/i) });
  });
});

describe("the guard against charging twice", () => {
  it("refuses an intent that is confirmed AND authorised instead of picking one", async () => {
    // Nothing should ever write this row. If something does, capturing the
    // held transaction would take a second payment for funds already settled.
    const { run, f } = claim({ ...base, status: "confirmed", authorized_at: "t" });
    const r = await run();
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as { error: string }).error).toMatch(/inconsistent/i);
    // And it must not have touched the row on the way out.
    expect(f.calls.updates).toBe(0);
  });
});

describe("refusals that are not about money", () => {
  it("reports a missing intent as not found, not as a payment problem", async () => {
    const { run } = claim(null);
    expect(await run()).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a quote nobody has paid or signed", async () => {
    const { run } = claim({ ...base });
    expect(await run()).toMatchObject({ ok: false, status: 402 });
  });

  it("will not let one buyer claim another's intent", async () => {
    const f = fakeSupabase({ ...base, status: "generating", authorized_at: "t" });
    const r = await claimForGeneration(f.client, { intentId: "intent-1", buyerWallet: "someoneElse" });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(f.calls.updates).toBe(0);
  });
});
