import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * These tests exist for one claim: an authorisation can be captured or voided,
 * never both, and it dies from SILENCE rather than from a clock.
 *
 * That means the fake (./_pg-fake) has to model a conditional UPDATE honestly — a
 * stub that always returns a row would pass every mutual-exclusion assertion
 * while the real thing double-spends. So it applies the accumulated filters to
 * the rows and updates only what matches, exactly as PostgREST would, and an
 * UPDATE matching nothing yields null without an error.
 */

import { Builder, fakeClient, type Row } from "./_pg-fake";

// ── fixtures ────────────────────────────────────────────────────────────

const BUYER = "8xKevBuyerWalletBase58";
const INTENT = "11111111-1111-1111-1111-111111111111";
/** A real partially signed transaction: the capture reads its signature (slot 0, the fee payer's). */
const FEE = Keypair.generate();
const TX = (() => {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: FEE.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.recentBlockhash = bs58.encode(Buffer.alloc(32, 7));
  tx.feePayer = FEE.publicKey;
  tx.partialSign(FEE);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
})();
const SIGNATURE = bs58.encode(Transaction.from(Buffer.from(TX, "base64")).signature!);

const quotedRow = (over: Row = {}): Row => ({
  id: INTENT,
  buyer_wallet: BUYER,
  total_micro: 250_000,
  status: "quoted",
  authorized_at: null,
  consumed_at: null,
  captured_at: null,
  voided_at: null,
  void_reason: null,
  nonce_account: null,
  ...over,
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

async function mod() {
  return import("@/lib/payments/authorization");
}

/** Put a live authorisation on the table and hand back its row. */
async function authorized(rows: Row[]) {
  const { storeAuthorization } = await mod();
  const ok = await storeAuthorization(fakeClient(rows), {
    intentId: INTENT,
    buyerWallet: BUYER,
    signedTx: TX,
    nonceAccount: "NonceAcc111",
    nonceAuthority: "EnkiAuth111",
  });
  expect(ok).toBe(true);
  return rows[0];
}

describe("generation authorisation", () => {
  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    (await import("@/lib/crypto")).resetKeyringCache();
  });

  it("records the signature without claiming the work", async () => {
    const rows = [quotedRow()];
    const row = await authorized(rows);

    expect(row.authorized_at).toBeTruthy();
    /* consumed_at is the in-flight marker and belongs to claimForGeneration,
       not to this write. Setting it here would tell the sweeper a generation
       was already running the moment the buyer signed, and start its 360s
       deadline against work that had not begun. The unclaimed case is swept on
       authorized_at instead. */
    expect(row.consumed_at ?? null).toBeNull();
    expect(row.status).toBe("generating");
  });

  it("throws when the database fails the write: that is Enki's side, not a changed order (round 4, 2026-10-19)", async () => {
    const { storeAuthorization } = await mod();
    const q: Record<string, unknown> = {};
    for (const m of ["update", "eq", "is", "select"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: null, error: { message: "connection reset" } });
    const down = { from: () => q } as unknown as SupabaseClient;
    await expect(storeAuthorization(down, { intentId: INTENT, buyerWallet: BUYER, signedTx: TX, nonceAccount: "N", nonceAuthority: "A" })).rejects.toThrow("connection reset");
  });

  it("refuses to re-authorise a settled intent", async () => {
    const { storeAuthorization } = await mod();
    const rows = [quotedRow({ authorized_at: ago(1000), voided_at: ago(500) })];

    const ok = await storeAuthorization(fakeClient(rows), {
      intentId: INTENT,
      buyerWallet: BUYER,
      signedTx: TX,
      nonceAccount: "N",
      nonceAuthority: "A",
    });
    expect(ok).toBe(false);
    expect(rows[0].status).not.toBe("generating");
  });

  it("refuses a second store, a unit voided before it was signed, and one booked from the buyer's own broadcast (round 32, 2026-10-21)", async () => {
    const { storeAuthorization } = await mod();
    const store = (rows: Row[]) => storeAuthorization(fakeClient(rows), { intentId: INTENT, buyerWallet: BUYER, signedTx: TX, nonceAccount: "N", nonceAuthority: "A" });
    // Stored once: an overlapping /submit's store loses (DEC-232).
    const twice = [quotedRow({ status: "building" })];
    expect(await store(twice)).toBe(true);
    const first = twice[0].authorized_at;
    expect(await store(twice)).toBe(false);
    expect(twice[0].authorized_at).toBe(first);
    // Voided before anyone signed it (a sweep, a cancel): never resurrected.
    const voided = [quotedRow({ status: "voided", voided_at: ago(1000), void_reason: "provider_failed" })];
    expect(await store(voided)).toBe(false);
    expect(voided[0].authorized_at ?? null).toBeNull();
    // Booked paid-undelivered from the buyer's own broadcast (voided_at cleared): never re-authorised.
    const booked = [quotedRow({ status: "captured", captured_at: ago(1000) })];
    expect(await store(booked)).toBe(false);
    expect(booked[0].status).toBe("captured");
  });

  it("hands back the signed transaction on a lease, books nothing, and opens only on its own row", async () => {
    const { claimCapture } = await mod();
    const rows = [quotedRow()];
    await authorized(rows);
    rows[0].consumed_at = ago(1000);

    const held = await claimCapture(fakeClient(rows), INTENT);
    expect(held?.signedTx).toBe(TX);
    expect(held?.signature).toBe(SIGNATURE);
    expect(held?.nonceAccount).toBe("NonceAcc111");
    // Whose USDC tells a buyer's failed capture from Enki's (review 2026-10-18).
    expect(held?.owner).toBe(BUYER);
    // The lease, and the signature stored before the broadcast; nothing booked as paid (2026-10-18).
    expect(rows[0].capture_started_at).toBeTruthy();
    expect(rows[0].tx_signature).toBe(SIGNATURE);
    expect(rows[0].captured_at ?? null).toBeNull();

    // The ciphertext is bound to the intent id: lifted into another row it
    // must not open, so a leaked blob is not a charge against someone else.
    const other = "22222222-2222-2222-2222-222222222222";
    const stolen = [quotedRow({ ...rows[0], id: other, capture_started_at: null })];
    await expect(claimCapture(fakeClient(stolen), other)).rejects.toThrow();
  });

  it("leases only a claimed authorisation", async () => {
    const { claimCapture } = await mod();
    const rows = [quotedRow()];
    await authorized(rows);
    // Signed but no generation took it: there is no image to charge for.
    expect(await claimCapture(fakeClient(rows), INTENT)).toBeNull();
    expect(rows[0].capture_started_at ?? null).toBeNull();
  });
});

describe("capture and void are mutually exclusive", () => {
  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    (await import("@/lib/crypto")).resetKeyringCache();
  });

  const leased = async (rows: Row[]) => {
    const { claimCapture } = await mod();
    await authorized(rows);
    rows[0].consumed_at = ago(1000);
    expect(await claimCapture(fakeClient(rows), INTENT)).not.toBeNull();
  };

  it("refuses to void a capture in flight, and what was already captured", async () => {
    const { voidAuthorization, bookCaptured } = await mod();
    const rows = [quotedRow()];
    await leased(rows);
    expect(await voidAuthorization(fakeClient(rows), INTENT, "provider_failed")).toBeNull();
    expect(await bookCaptured(fakeClient(rows), INTENT)).toBe(true);
    expect(await voidAuthorization(fakeClient(rows), INTENT, "provider_failed")).toBeNull();
    expect(rows[0].captured_at).toBeTruthy();
    expect(rows[0].fulfilled_at).toBeTruthy();
    expect(rows[0].status).toBe("captured");
    expect(rows[0].voided_at).toBeNull();
  });

  it("voids only a signed unit, and never one already voided (round 32, 2026-10-21)", async () => {
    const { voidAuthorization } = await mod();
    // Handed out, never signed: the buyer's cancel or the sweep decides it, not this void.
    const unsigned = [quotedRow({ status: "building", nonce_account: "N" })];
    expect(await voidAuthorization(fakeClient(unsigned), INTENT, "provider_failed", { unclaimed: true })).toBeNull();
    expect(unsigned[0].voided_at ?? null).toBeNull();
    // Already voided as Enki's: a later cancel does not rewrite whose it was.
    const rows = [quotedRow()];
    await authorized(rows);
    expect(await voidAuthorization(fakeClient(rows), INTENT, "provider_failed", { unclaimed: true })).not.toBeNull();
    expect(await voidAuthorization(fakeClient(rows), INTENT, "cancelled", { unclaimed: true })).toBeNull();
    expect(rows[0].void_reason).toBe("provider_failed");
  });

  it("lets a buyer's cancel void only what no render has claimed (review 2026-10-18)", async () => {
    const { voidAuthorization } = await mod();
    const rows = [quotedRow()];
    await authorized(rows);
    rows[0].consumed_at = ago(1000);
    expect(await voidAuthorization(fakeClient(rows), INTENT, "cancelled", { unclaimed: true })).toBeNull();
    expect(rows[0].voided_at ?? null).toBeNull();
    rows[0].consumed_at = null;
    expect(await voidAuthorization(fakeClient(rows), INTENT, "cancelled", { unclaimed: true })).not.toBeNull();
    expect(rows[0].void_reason).toBe("cancelled");
  });

  it("refuses to lease what was already voided", async () => {
    const { claimCapture, voidAuthorization } = await mod();
    const rows = [quotedRow()];
    await authorized(rows);
    rows[0].consumed_at = ago(1000);

    expect(await voidAuthorization(fakeClient(rows), INTENT, "rejected")).not.toBeNull();
    expect(await claimCapture(fakeClient(rows), INTENT)).toBeNull();
    expect(rows[0].voided_at).toBeTruthy();
    expect(rows[0].void_reason).toBe("rejected");
    expect(rows[0].captured_at).toBeNull();
  });

  it("never leases twice", async () => {
    const { claimCapture } = await mod();
    const rows = [quotedRow()];
    await leased(rows);
    expect(await claimCapture(fakeClient(rows), INTENT)).toBeNull();
  });

  it("a capture that did not land voids the intent as capture_failed, and can never be booked after", async () => {
    const { failCapture, bookCaptured } = await mod();
    const rows = [quotedRow()];
    await leased(rows);
    expect(await failCapture(fakeClient(rows), INTENT)).toBe(true);
    expect(rows[0].void_reason).toBe("capture_failed");
    expect(rows[0].status).toBe("voided");
    expect(await bookCaptured(fakeClient(rows), INTENT)).toBe(false);
    expect(rows[0].captured_at ?? null).toBeNull();
  });

  it("records a failure on Enki's side as provider_failed, which no pause counts (round 4, 2026-10-19)", async () => {
    const { failCapture } = await mod();
    const rows = [quotedRow()];
    await leased(rows);
    expect(await failCapture(fakeClient(rows), INTENT, "provider_failed")).toBe(true);
    expect(rows[0].void_reason).toBe("provider_failed");
  });

  it("books and fails only a leased capture", async () => {
    const { failCapture, bookCaptured } = await mod();
    const rows = [quotedRow()];
    await authorized(rows);
    expect(await bookCaptured(fakeClient(rows), INTENT)).toBe(false);
    expect(await failCapture(fakeClient(rows), INTENT)).toBe(false);
  });
});

describe("the abort condition is silence, not elapsed time", () => {
  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    (await import("@/lib/crypto")).resetKeyringCache();
  });

  it("leaves a two-hour-old authorisation alone while it is still beating", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);

    // Older than any deadline anyone would have picked — and irrelevant,
    // because the worker is still there. This is the whole point of the
    // design: no generation dies of taking long.
    row.authorized_at = ago(2 * 60 * 60_000);
    row.consumed_at = ago(ABANDONED_AFTER_MS / 3);

    expect(await sweepAbandoned(fakeClient(rows))).toEqual([]);
    expect(rows[0].voided_at).toBeNull();
  });

  it("voids one that went quiet, and says which nonce to flush", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    row.consumed_at = ago(ABANDONED_AFTER_MS + 1000);

    const flushed = await sweepAbandoned(fakeClient(rows));
    expect(flushed).toEqual([{ intentId: INTENT, nonceAccount: "NonceAcc111" }]);
    // A render claimed it and died: Enki's side, outside the buyer's limits (round 4, 2026-10-19).
    expect(rows[0].void_reason).toBe("provider_failed");
  });

  it("voids a signed unit nobody rendered as the buyer's abandoned one", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    row.authorized_at = ago(ABANDONED_AFTER_MS + 1000);
    expect(await sweepAbandoned(fakeClient(rows))).toHaveLength(1);
    expect(rows[0].void_reason).toBe("abandoned");
  });

  it("finds a dead claim behind a page of capture leases it may not void (round 4, 2026-10-19)", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const stale = ago(ABANDONED_AFTER_MS + 1000);
    const leases = Array.from({ length: 5 }, (_, i) => quotedRow({ id: `lease-${i}`, authorized_at: stale, consumed_at: stale, capture_started_at: stale }));
    const rows = [...leases, quotedRow({ id: "dead", authorized_at: stale, consumed_at: stale, nonce_account: "N-dead" })];
    expect(await sweepAbandoned(fakeClient(rows), 5)).toEqual([{ intentId: "dead", nonceAccount: "N-dead" }]);
    expect(leases.every((l) => (l.voided_at ?? null) === null)).toBe(true);
  });

  it("does not touch a job one beat behind", async () => {
    const { sweepAbandoned } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    // One missed beat is a slow DB write, not a death. The grace is three.
    row.consumed_at = ago(20_000);

    expect(await sweepAbandoned(fakeClient(rows))).toEqual([]);
  });

  it("clears an authorised row that never beat, rather than leaving it forever", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    // storeAuthorization always writes a first beat, so this state is a bug —
    // the sweep makes the bug self-clearing instead of a permanent live nonce.
    row.consumed_at = null;
    row.authorized_at = ago(ABANDONED_AFTER_MS + 1000);

    expect(await sweepAbandoned(fakeClient(rows))).toHaveLength(1);
  });

  it("leaves settled rows out of the sweep entirely", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const stale = ago(ABANDONED_AFTER_MS + 1000);
    const rows = [
      quotedRow({ id: "a", authorized_at: stale, consumed_at: stale, captured_at: stale }),
      quotedRow({ id: "b", authorized_at: stale, consumed_at: stale, voided_at: stale }),
      quotedRow({ id: "c" }), // never authorised: only a quote, no signature to flush
    ];
    expect(await sweepAbandoned(fakeClient(rows))).toEqual([]);
  });
});

/**
 * The sweep selects on the heartbeat and then has to kill through a separate
 * write. If that write does not repeat the condition, a worker that beat in
 * between is killed anyway — its generation runs to completion against a dead
 * authorisation, captureAndBroadcast returns null, and the image ships free.
 *
 * The file's own comment claimed per-row voiding prevented exactly this. It
 * did not: voidAuthorization's WHERE carried no heartbeat condition at all.
 */
describe("a beat that lands mid-sweep saves the row", () => {
  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    (await import("@/lib/crypto")).resetKeyringCache();
  });

  /** A client that lets the worker beat once, right after the sweep's SELECT. */
  function racingClient(rows: Row[], onFirstResolve: () => void): SupabaseClient {
    let n = 0;
    return {
      from: () => {
        const b = new Builder(rows);
        const original = b.then.bind(b);
        (b as unknown as { then: unknown }).then = (
          onfulfilled?: ((v: { data: unknown; error: unknown }) => unknown) | null,
          onrejected?: ((reason: unknown) => unknown) | null,
        ) =>
          original((res: { data: unknown; error: unknown }) => {
            if (n++ === 0) onFirstResolve();
            return onfulfilled ? onfulfilled(res) : res;
          }, onrejected);
        return b;
      },
    } as unknown as SupabaseClient;
  }

  it("leaves the row alone when the heartbeat refreshed after the SELECT", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    row.consumed_at = ago(ABANDONED_AFTER_MS * 2); // stale, so the SELECT takes it

    // The worker wakes up between the SELECT and the write — the exact race
    // the sweep's comment promised was handled.
    const flushed = await sweepAbandoned(racingClient(rows, () => {
      row.consumed_at = new Date().toISOString();
    }));

    expect(flushed).toEqual([]);
    expect(row.voided_at ?? null).toBeNull();
    expect(row.void_reason ?? null).toBeNull();
  });

  it("still voids a row that is genuinely silent — the fix must not disable the sweep", async () => {
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    row.consumed_at = ago(ABANDONED_AFTER_MS * 2);

    const flushed = await sweepAbandoned(fakeClient(rows));

    expect(flushed.map((f) => f.intentId)).toEqual([INTENT]);
    expect(row.void_reason).toBe("provider_failed");
  });

  it("still voids an authorised row that never beat at all", async () => {
    // The OR's second branch: a NULL heartbeat does not satisfy `lt`, so
    // dropping it from the write would make this row immortal.
    const { sweepAbandoned, ABANDONED_AFTER_MS } = await mod();
    const rows = [quotedRow()];
    const row = await authorized(rows);
    row.consumed_at = null;
    row.authorized_at = ago(ABANDONED_AFTER_MS * 2);

    const flushed = await sweepAbandoned(fakeClient(rows));

    expect(flushed.map((f) => f.intentId)).toEqual([INTENT]);
    expect(row.void_reason).toBe("abandoned");
  });
});

describe("a checkout cancelled before signing gives its nonce rent back", () => {
  const building = (over: Row = {}) => quotedRow({ status: "building", nonce_account: "NonceAcc222", updated_at: ago(1000), ...over });

  it("voids an intent prepared and never signed once it is stale, and names the nonce to close", async () => {
    const { sweepUnsubmitted, ABANDONED_AFTER_MS } = await mod();
    // Its payment handed out (signature recorded), never signed: the buyer's abandoned unit.
    const rows = [building({ tx_signature: "Handed", updated_at: ago(ABANDONED_AFTER_MS + 1000) })];
    expect(await sweepUnsubmitted(fakeClient(rows))).toEqual([{ intentId: INTENT, nonceAccount: "NonceAcc222" }]);
    expect(rows[0].void_reason).toBe("abandoned");
    expect(rows[0].status).toBe("voided");
  });

  it("does not void as Enki's a unit whose payment was handed out between the sweep's read and its write (round 20, 2026-10-20)", async () => {
    const { sweepUnsubmitted, ABANDONED_AFTER_MS } = await mod();
    const rows = [building({ updated_at: ago(ABANDONED_AFTER_MS + 1000) })];
    const client = fakeClient(rows);
    const from = client.from.bind(client);
    // /authorize records the signature after the sweep read the row unsigned.
    (client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = from(t) as unknown as { update: (patch: Record<string, unknown>) => unknown };
      const update = q.update.bind(q);
      q.update = (patch) => { rows[0].tx_signature = "Late"; return update(patch); };
      return q;
    };
    expect(await sweepUnsubmitted(client)).toEqual([]);
    expect(rows[0].void_reason ?? null).toBeNull();
  });

  it("voids every unit of an order /authorize signed only in part as Enki's, and a fully signed one as the buyer's (round 21, 2026-10-20)", async () => {
    const { sweepUnsubmitted, ABANDONED_AFTER_MS } = await mod();
    const old = ago(ABANDONED_AFTER_MS + 1000);
    const rows = [
      // Order A: two units signed, the third never was (its nonce read failed), and that one already voided as Enki's.
      building({ id: "a0", batch_intent_id: "A", tx_signature: "SigA0", updated_at: old }),
      building({ id: "a1", batch_intent_id: "A", tx_signature: "SigA1", updated_at: old }),
      building({ id: "a2", batch_intent_id: "A", status: "voided", voided_at: old, void_reason: "provider_failed", updated_at: old }),
      // Order B: every unit signed, so handed out.
      building({ id: "b0", batch_intent_id: "B", tx_signature: "SigB0", updated_at: old }),
      building({ id: "b1", batch_intent_id: "B", tx_signature: "SigB1", updated_at: old }),
    ];
    expect((await sweepUnsubmitted(fakeClient(rows))).map((r) => r.intentId)).toEqual(["a0", "a1", "b0", "b1"]);
    expect(rows.map((r) => [r.id, r.void_reason])).toEqual([["a0", "provider_failed"], ["a1", "provider_failed"], ["a2", "provider_failed"], ["b0", "abandoned"], ["b1", "abandoned"]]);
  });

  it("sweeps nothing when the order's other units cannot be read", async () => {
    const { sweepUnsubmitted, ABANDONED_AFTER_MS } = await mod();
    const rows = [building({ batch_intent_id: "A", tx_signature: "SigA0", updated_at: ago(ABANDONED_AFTER_MS + 1000) })];
    const client = fakeClient(rows);
    const from = client.from.bind(client);
    (client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = from(t) as unknown as { select: (cols: string) => unknown };
      const select = q.select.bind(q);
      q.select = (cols: string) => (cols === "batch_intent_id" ? { in: () => ({ is: async () => ({ data: null, error: { message: "down" } }) }) } : select(cols));
      return q;
    };
    expect(await sweepUnsubmitted(client)).toEqual([]);
    expect(rows[0].void_reason ?? null).toBeNull();
  });

  it("leaves a buyer who is still in the wallet popup alone", async () => {
    const { sweepUnsubmitted } = await mod();
    expect(await sweepUnsubmitted(fakeClient([building()]))).toEqual([]);
  });

  it("finds a stale one behind a page of fresh ones", async () => {
    const { sweepUnsubmitted, ABANDONED_AFTER_MS } = await mod();
    const fresh = Array.from({ length: 20 }, (_, i) => building({ id: `fresh-${i}` }));
    const rows = [...fresh, building({ updated_at: ago(ABANDONED_AFTER_MS + 1000) })];
    expect(await sweepUnsubmitted(fakeClient(rows))).toEqual([{ intentId: INTENT, nonceAccount: "NonceAcc222" }]);
  });

  it("lets a /submit that lands between its SELECT and its write win", async () => {
    const { sweepUnsubmitted, ABANDONED_AFTER_MS } = await mod();
    const rows = [building({ updated_at: ago(ABANDONED_AFTER_MS + 1000) })];
    let n = 0;
    const racing = {
      from: () => {
        const b = new Builder(rows);
        const original = b.then.bind(b);
        (b as unknown as { then: unknown }).then = (
          ok?: ((v: { data: unknown; error: unknown }) => unknown) | null,
          ko?: ((reason: unknown) => unknown) | null,
        ) => original((res: { data: unknown; error: unknown }) => {
          if (n++ === 0) rows[0].authorized_at = new Date().toISOString(); // the buyer's signature arrives
          return ok ? ok(res) : res;
        }, ko);
        return b;
      },
    } as unknown as SupabaseClient;
    expect(await sweepUnsubmitted(racing)).toEqual([]);
    expect(rows[0].voided_at).toBeNull();
  });

  it("never voids one that was signed, however old", async () => {
    const { sweepUnsubmitted, ABANDONED_AFTER_MS } = await mod();
    const rows = [building({ updated_at: ago(ABANDONED_AFTER_MS + 1000), authorized_at: ago(ABANDONED_AFTER_MS + 500) })];
    expect(await sweepUnsubmitted(fakeClient(rows))).toEqual([]);
    expect(rows[0].voided_at).toBeNull();
  });
});

describe("the end of an intent nobody booked (2026-10-18)", () => {
  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    (await import("@/lib/crypto")).resetKeyringCache();
  });

  const ACCOUNT = "33333333-3333-3333-3333-333333333333";
  const wallet = { address: BUYER, chain_family: "solana", removed_at: null, user_id: ACCOUNT };
  /** The intents, the refund rows and the wallets' accounts; the first failInserts refund inserts answer failWith. */
  const withFailures = (rows: Row[], failures: Row[], { failInserts = 0, failWith = { code: "08006", message: "down" } as { code: string; message: string } } = {}) => {
    const client = fakeClient({ generation_payment_intents: rows, generation_failures: failures, user_wallets: [wallet] });
    let left = failInserts;
    return {
      from: (t: string) => {
        const b = client.from(t) as unknown as Builder;
        if (t === "generation_failures") {
          const insert = b.insert.bind(b);
          (b as unknown as { insert: unknown }).insert = (r: Row) => (left-- > 0 ? Promise.resolve({ data: null, error: failWith }) : insert(r));
        }
        return b;
      },
    } as unknown as SupabaseClient;
  };
  const refund = { intentId: INTENT, owner: BUYER, signature: SIGNATURE, totalMicro: 250_000, why: "test" };

  it("voids a prepared intent nobody signed after 300 s, not before: queued wallet windows open late (review 2026-10-18)", async () => {
    const { sweepUnsubmitted, UNSIGNED_AFTER_MS } = await mod();
    expect(UNSIGNED_AFTER_MS).toBe(300_000);
    const fresh = [quotedRow({ status: "building", nonce_account: "N1", updated_at: ago(240_000) })];
    expect(await sweepUnsubmitted(fakeClient(fresh))).toEqual([]);
    // Handed out (its signature recorded) and never signed: the buyer's.
    const stale = [quotedRow({ status: "building", nonce_account: "N1", tx_signature: "Handed", updated_at: ago(310_000) })];
    expect(await sweepUnsubmitted(fakeClient(stale))).toEqual([{ intentId: INTENT, nonceAccount: "N1" }]);
    expect(stale[0].void_reason).toBe("abandoned");
    // Never handed out (/authorize stopped before it answered): Enki's (round 20, 2026-10-20).
    const unsent = [quotedRow({ status: "building", nonce_account: "N1", updated_at: ago(310_000) })];
    expect(await sweepUnsubmitted(fakeClient(unsent))).toEqual([{ intentId: INTENT, nonceAccount: "N1" }]);
    expect(unsent[0].void_reason).toBe("provider_failed");
  });

  it("reads the held transaction's signature, and nothing for a row never signed", async () => {
    const { heldSignatureOf } = await mod();
    const rows = [quotedRow()];
    expect(await heldSignatureOf(fakeClient(rows), INTENT)).toBeNull();
    // Handed out and never submitted: the signature /authorize recorded (review 2026-10-18).
    rows[0].tx_signature = "RecordedAtAuthorize";
    expect(await heldSignatureOf(fakeClient(rows), INTENT)).toBe("RecordedAtAuthorize");
    await authorized(rows);
    expect(await heldSignatureOf(fakeClient(rows), INTENT)).toBe(SIGNATURE);
    // A row it cannot read is not a row never signed (round 4, 2026-10-19).
    const down = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "down" } }) }) }) }) } as unknown as SupabaseClient;
    await expect(heldSignatureOf(down, INTENT)).rejects.toThrow("cannot be read");
  });

  it("turns only a delivered booking into paid-undelivered (round 5, 2026-10-20)", async () => {
    const { unfulfil } = await mod();
    const rows = [
      quotedRow({ id: "delivered", captured_at: ago(1000), fulfilled_at: ago(1000) }),
      quotedRow({ id: "owed", captured_at: ago(1000), fulfilled_at: null }),
      quotedRow({ id: "open", captured_at: null, fulfilled_at: null }),
    ];
    for (const r of rows) expect(await unfulfil(fakeClient(rows), r.id as string)).toBe(true);
    expect(rows.map((r) => [r.id, r.captured_at ? "captured" : "open", r.fulfilled_at ? "fulfilled" : "not"])).toEqual([
      ["delivered", "captured", "not"], ["owed", "captured", "not"], ["open", "open", "not"],
    ]);
    // A write the database refused says so, so the caller tries again.
    const q: Record<string, unknown> = {};
    for (const m of ["update", "eq", "not"]) q[m] = () => q;
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: { message: "down" } }).then(ok);
    expect(await unfulfil({ from: () => q } as unknown as SupabaseClient, "delivered")).toBe(false);
  });

  it("tells a booking that delivered from the sweep's refund-owed one (verification 2026-10-18)", async () => {
    const { bookCaptured, bookingState, bookPaidUndelivered } = await mod();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lease = () => quotedRow({ status: "authorized", authorized_at: ago(3000), consumed_at: ago(2000), capture_started_at: ago(1000) });
    const delivered = [lease()];
    expect(await bookingState(fakeClient(delivered), INTENT)).toBe("open");
    expect(await bookCaptured(fakeClient(delivered), INTENT)).toBe(true);
    expect(await bookingState(fakeClient(delivered), INTENT)).toBe("delivered");
    const owed = [lease()];
    const owedRefund: Row[] = [];
    expect(await bookPaidUndelivered(withFailures(owed, owedRefund), INTENT, SIGNATURE, "test")).toBe(true);
    expect(await bookingState(fakeClient(owed), INTENT)).toBe("owed");
    expect(owedRefund).toEqual([expect.objectContaining({ id: INTENT, user_id: ACCOUNT })]);
    // A refund-owed booking cannot be made twice, nor over a delivered one.
    expect(await bookPaidUndelivered(withFailures(owed, []), INTENT, SIGNATURE, "test")).toBe(false);
    expect(await bookPaidUndelivered(withFailures(delivered, []), INTENT, SIGNATURE, "test")).toBe(false);
  });

  it("writes the refund row once, under the intent's own id and the buyer's account (round 4, 2026-10-19)", async () => {
    const { recordRefundOwed } = await mod();
    const failures: Row[] = [];
    expect(await recordRefundOwed(withFailures([], failures), refund)).toBe(true);
    expect(failures).toEqual([expect.objectContaining({
      id: INTENT, intent_id: INTENT, user_id: ACCOUNT, tx_signature: SIGNATURE, amount_paid_micro: 250_000, error: expect.stringContaining("Refund owed"),
    })]);
    // A second write (a lost answer, a retry, the sweep) adds nothing and reads as written.
    expect(await recordRefundOwed(withFailures([], failures), { ...refund, why: "again" })).toBe(true);
    expect(failures).toHaveLength(1);
    // An owner that is an account is its own account.
    const byAccount: Row[] = [];
    await recordRefundOwed(withFailures([], byAccount), { ...refund, owner: ACCOUNT });
    expect(byAccount[0].user_id).toBe(ACCOUNT);
  });

  it("says when the row could not be written, and writes nothing then (round 4, 2026-10-19)", async () => {
    const { recordRefundOwed } = await mod();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failures: Row[] = [];
    expect(await recordRefundOwed(withFailures([], failures, { failInserts: 1 }), refund)).toBe(false);
    expect(failures).toEqual([]);
  });

  it("writes no refund row while the buyer's account cannot be read: the sweep tries again (round 5, 2026-10-20)", async () => {
    const { recordRefundOwed } = await mod();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failures: Row[] = [];
    const client = fakeClient({ generation_failures: failures });
    const down = { from: (t: string) => (t === "user_wallets"
      ? { select: () => { const q: Record<string, unknown> = {}; for (const m of ["eq", "is"]) q[m] = () => q; q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "down" } }).then(ok); return q; } }
      : client.from(t)) } as unknown as SupabaseClient;
    expect(await recordRefundOwed(down, refund)).toBe(false);
    expect(failures).toEqual([]);
  });

  it("records the refund without the account when the account is gone", async () => {
    const { recordRefundOwed } = await mod();
    const failures: Row[] = [];
    expect(await recordRefundOwed(withFailures([], failures, { failInserts: 1, failWith: { code: "23503", message: "fk" } }), refund)).toBe(true);
    expect(failures).toEqual([expect.objectContaining({ id: INTENT, user_id: null })]);
  });

  it("writes every missing refund row from the sweep, and only for intents paid with the image withheld (round 4, 2026-10-19)", async () => {
    const { sweepRefundsOwed } = await mod();
    const owed = (id: string, over: Row = {}) => quotedRow({ id, nonce_account: "N", status: "captured", captured_at: ago(60_000), fulfilled_at: null, tx_signature: `Sig-${id}`, ...over });
    const rows = [
      owed("a"),
      owed("b"), // its row is already there
      owed("c", { fulfilled_at: ago(60_000) }), // delivered
      owed("d", { captured_at: null, voided_at: ago(60_000) }), // voided, never paid
      owed("e", { nonce_account: null }), // not the intent rail
      owed("f", { captured_at: ago(25 * 60 * 60_000) }), // older than the sweep looks
    ];
    const failures: Row[] = [{ id: "b", intent_id: "b", error: "paid, image not delivered: x. Refund owed." }];
    expect(await sweepRefundsOwed(withFailures(rows, failures))).toBe(1);
    expect(failures.map((r) => r.id)).toEqual(["b", "a"]);
    expect(failures[1]).toMatchObject({ intent_id: "a", tx_signature: "Sig-a", amount_paid_micro: 250_000, user_id: ACCOUNT });
    // Run again: nothing more to write.
    expect(await sweepRefundsOwed(withFailures(rows, failures))).toBe(0);
    expect(failures).toHaveLength(2);
  });

  it("reaches an owed row behind a full page of refunded ones (round 5, 2026-10-20)", async () => {
    const { sweepRefundsOwed } = await mod();
    const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const rows = Array.from({ length: 5 }, (_, i) => quotedRow({ id: id(i), nonce_account: "N", status: "captured", captured_at: ago(60_000), fulfilled_at: null, tx_signature: `S${i}` }));
    // The first four are refunded already; the fifth sits on the third page of two.
    const failures: Row[] = rows.slice(0, 4).map((r) => ({ id: r.id, intent_id: r.id, error: "Refund owed." }));
    expect(await sweepRefundsOwed(withFailures(rows, failures), 2)).toBe(1);
    expect(failures.map((f) => f.id)).toContain(id(4));
  });

  it("books a payment that landed without a delivered image, clears the void and owes the exact amount back", async () => {
    const { bookPaidUndelivered, voidAuthorization } = await mod();
    const rows = [quotedRow()];
    const failures: Row[] = [];
    await authorized(rows);
    await voidAuthorization(fakeClient(rows), INTENT, "provider_failed");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await bookPaidUndelivered(withFailures(rows, failures), INTENT, SIGNATURE, "the buyer broadcast the held payment");
    expect(rows[0]).toMatchObject({ status: "captured", voided_at: null, void_reason: null, tx_signature: SIGNATURE });
    expect(rows[0].captured_at).toBeTruthy();
    expect(failures).toEqual([expect.objectContaining({ intent_id: INTENT, tx_signature: SIGNATURE, amount_paid_micro: 250_000, error: expect.stringContaining("Refund owed") })]);
    // Booked once: a second call owes nothing again.
    await bookPaidUndelivered(withFailures(rows, failures), INTENT, SIGNATURE, "again");
    expect(failures).toHaveLength(1);
  });
});
