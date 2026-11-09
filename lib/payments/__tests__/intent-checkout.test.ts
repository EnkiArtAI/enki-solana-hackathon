import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The web checkout on the intent rail (2026-10-18): an order is paused, refused
 * or opened exactly as decided; the plan rides on the quoted row before the
 * units are cloned from it; every signed payment must be the one built, fully
 * signed and payable, and the buyer's USDC must cover all open units, or the
 * whole order is voided and nothing is held.
 */
const s = vi.hoisted(() => ({
  pause: vi.fn(), dropped: vi.fn(), promptText: vi.fn(), wallet: vi.fn(), covers: vi.fn(), plan: vi.fn(), open: vi.fn(), authFor: vi.fn(), sign: vi.fn(),
  matches: vi.fn(), signed: vi.fn(), store: vi.fn(), nonce: vi.fn(), simulate: vi.fn(), voidFlush: vi.fn(), rail: vi.fn(), settleVoided: vi.fn(),
  updateError: null as null | { message: string }, planError: null as null | { message: string }, unitsError: null as null | { message: string }, slowVoid: false, voidLost: false, selects: [] as string[], missing: vi.fn(), renderable: vi.fn(), openCount: 0 as number | null, liveCount: 0 as number | null, countFilters: [] as unknown[][],
  order: [] as string[], queries: [] as { table: string; filters: [string, unknown][] }[],
}));
vi.mock("@/lib/payments/authorize-flow", () => ({
  capturePause: (...a: unknown[]) => s.pause(...a), droppedPause: (...a: unknown[]) => s.dropped(...a), buyerWallet: (...a: unknown[]) => s.wallet(...a), buyerCovers: (...a: unknown[]) => s.covers(...a),
  planFor: (...a: unknown[]) => { s.order.push("plan"); return s.plan(...a); }, openIntentBatch: (...a: unknown[]) => { s.order.push("open"); return s.open(...a); },
  authorizationFor: (...a: unknown[]) => s.authFor(...a), enkiWallet: () => "EnkiTreasury", INTENT_MAX_OPEN_PER_BUYER: 8, DROPPED_UNIT_LIMIT: 13,
  CoverageUnknown: class CoverageUnknown extends Error {},
}));
vi.mock("@/lib/payments/authorize-tx", () => ({
  signAsEnki: (...a: unknown[]) => s.sign(...a), matchesBuiltTransaction: (...a: unknown[]) => s.matches(...a), hasRequiredSignatures: (...a: unknown[]) => s.signed(...a),
  feePayerSignature: (tx: { built: string }) => `sig-of:${tx.built}`,
}));
vi.mock("@/lib/payments/authorization", () => ({ storeAuthorization: (...a: unknown[]) => s.store(...a) }));
vi.mock("@/lib/payments/nonce", () => ({ readNonce: (...a: unknown[]) => s.nonce(...a) }));
vi.mock("@/lib/payments/x402-settle", () => ({ simulatePayment: (...a: unknown[]) => s.simulate(...a) }));
vi.mock("@/lib/payments/settle", () => ({ voidAndFlush: (...a: unknown[]) => s.voidFlush(...a), settleVoided: (...a: unknown[]) => s.settleVoided(...a) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => { void fn(); } }));
vi.mock("@/lib/payments/solana-transfer", () => ({ findMissingAtas: (...a: unknown[]) => s.missing(...a) }));
vi.mock("@/lib/generation/renderable", () => ({ renderableRoute: (...a: unknown[]) => s.renderable(...a) }));
vi.mock("@/lib/generation/prompt-text", async (orig) => ({ ...(await orig<typeof import("@/lib/generation/prompt-text")>()), loadPromptText: (...a: unknown[]) => s.promptText(...a) }));
vi.mock("@/lib/payments/solana", () => ({ feePayerKeypair: () => ({ publicKey: { toBase58: () => "FeePayer" } }) }));
vi.mock("@/lib/payments/rail", async (orig) => ({ ...(await orig<typeof import("@/lib/payments/rail")>()), paymentRail: () => s.rail() }));
vi.mock("@solana/web3.js", async (orig) => {
  const real = await orig<typeof import("@solana/web3.js")>();
  return { ...real, Transaction: { ...real.Transaction, from: () => ({ serialize: () => Buffer.alloc(0) }) }, VersionedTransaction: { ...real.VersionedTransaction, deserialize: () => ({}) } };
});

import { authorizeIntent, submitIntent, intentStatus, cancelIntent, railFor } from "@/lib/payments/intent-checkout";
import { EscrowPaymentError } from "@/lib/payments/escrow/server-chain";
import { CoverageUnknown } from "@/lib/payments/authorize-flow";

const ID = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-1111-4111-8111-111111111111";
const quoted = { id: ID, buyer_wallet: OWNER, status: "quoted", total_micro: 7_560, artist_amount_micro: 0, model_cost_micro: 6_300, enki_fee_micro: 1_260, artist_wallet: null, nonce_account: null, fronted_atas: null, batch_intent_id: null, unit_index: null, authorized_at: null, consumed_at: null, captured_at: null, voided_at: null };
const unit = (i: number, over: Record<string, unknown> = {}) => ({ ...quoted, id: i === 0 ? ID : `unit-${i}`, status: "building", batch_intent_id: ID, unit_index: i, nonce_account: `N${i}`, ...over });

type Update = { patch: Record<string, unknown>; filters: [string, unknown][] };
function db(state: { intent?: Record<string, unknown> | null; units?: Record<string, unknown>[]; gens?: Record<string, unknown>[]; imgs?: Record<string, unknown>[]; row?: Record<string, unknown> | null; escrow?: string[] }) {
  const updates: Update[] = [];
  const query = (table: string) => {
    const filters: [string, unknown][] = [];
    s.queries.push({ table, filters });
    const q: Record<string, unknown> = {};
    for (const m of ["eq", "is", "in", "order", "neq"]) q[m] = (c: string, v: unknown) => { filters.push([c, v]); return q; };
    q.maybeSingle = async () => {
      if (table === "generation_escrow_deposits" || table === "generation_escrow_recovery") return { data: state.escrow?.includes(table) ? { intent_id: ID } : null, error: null };
      if (filters.some(([c]) => c === "id") && table === "generation_payment_intents") return { data: state.row !== undefined ? state.row : state.intent ?? null, error: null };
      return { data: null, error: null };
    };
    q.then = (ok: (v: unknown) => unknown) => {
      const data = table === "generations" ? state.gens ?? [] : table === "generated_images" ? state.imgs ?? [] : state.units ?? [];
      if (table === "generation_payment_intents" && s.unitsError) return Promise.resolve({ data: null, error: s.unitsError }).then(ok);
      return Promise.resolve({ data, error: null }).then(ok);
    };
    return q;
  };
  return {
    updates,
    client: {
      from: (table: string) => ({
        select: (cols: string, opts?: { count?: string }) => {
          s.selects.push(cols);
          if (!opts?.count) return query(table);
          // A head count: the buyer's open payments.
          const c: Record<string, unknown> = {};
          const mine: unknown[][] = [];
          for (const m of ["eq", "not", "is"]) c[m] = (...a: unknown[]) => { mine.push([m, ...a]); s.countFilters.push([m, ...a]); return c; };
          // The live count asks for units neither captured nor voided.
          c.then = (ok: (v: unknown) => unknown) => Promise.resolve({ count: mine.some((f) => f[1] === "captured_at") ? s.liveCount : s.openCount, error: null }).then(ok);
          return c;
        },
        update: (patch: Record<string, unknown>) => {
          const u: Update = { patch, filters: [] };
          updates.push(u);
          s.order.push(`update:${Object.keys(patch).join(",")}`);
          const q: Record<string, unknown> = {};
          for (const m of ["eq", "is"]) q[m] = (c: string, v: unknown) => { u.filters.push([c, v]); return q; };
          q.select = () => ({ maybeSingle: async () => ({ data: s.voidLost ? null : { id: u.filters.find(([c]) => c === "id")?.[1] }, error: null }) });
          // A slow write: whoever does not await it answers before it is done (round 9, 2026-10-20).
          if (s.slowVoid) q.then = (ok: (v: unknown) => unknown) => new Promise((r) => setTimeout(r, 5)).then(() => { s.order.push("void-done"); return { error: null }; }).then(ok);
          else q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: "tx_signature" in patch ? s.updateError : "fronted_atas" in patch ? s.planError : null }).then(ok);
          return q;
        },
      }),
    } as never,
  };
}
const conn = {} as never;
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof EscrowPaymentError ? { status: e.status, message: e.message } : String(e); } };

beforeEach(() => {
  for (const f of Object.values(s)) if (typeof f === "function" && "mockReset" in f) (f as ReturnType<typeof vi.fn>).mockReset();
  s.order.length = 0; s.queries.length = 0; s.updateError = null; s.planError = null; s.unitsError = null; s.slowVoid = false; s.voidLost = false; s.selects.length = 0; s.openCount = 0; s.liveCount = 0; s.countFilters.length = 0;
  s.pause.mockResolvedValue({ paused: false });
  s.dropped.mockResolvedValue({ paused: false });
  s.missing.mockResolvedValue([]);
  s.renderable.mockResolvedValue({ provider: "openai", providerModel: "gpt-image-2", primary: true });
  s.wallet.mockResolvedValue("BuyerWallet");
  s.covers.mockResolvedValue({ ok: true, wallet: "BuyerWallet" });
  s.plan.mockResolvedValue({ cuPriceMicroLamports: 10, artistWithheld: false });
  s.open.mockResolvedValue({ ok: true, units: [{ id: ID, unitIndex: 0, nonceAccount: "N0", nonce: "v0" }, { id: "unit-1", unitIndex: 1, nonceAccount: "N1", nonce: "v1" }] });
  s.nonce.mockImplementation(async (_c: unknown, a: string) => `value-${a}`);
  s.authFor.mockImplementation((u: { id: string }) => ({ transaction: { built: u.id } }));
  s.sign.mockImplementation((tx: { built: string }) => `signed-by-enki:${tx.built}`);
  s.matches.mockReturnValue(true); s.signed.mockReturnValue(true);
  s.simulate.mockResolvedValue({ ok: true });
  s.store.mockResolvedValue(true);
  s.voidFlush.mockResolvedValue(true);
});

describe("authorizing an order on the intent rail", () => {
  it("opens nothing for an artist's prompt whose own words cannot render on the host (round 11, 2026-10-20)", async () => {
    const artistOrder = { ...quoted, prompt_id: "p1", artist_amount_micro: 1_000 };
    const cannot = { status: 409, message: "This prompt cannot be rendered right now. Nothing was charged — choose another prompt or model." };
    const gemini = { provider: "gemini", providerModel: "gemini-3-pro-image", primary: true };
    // Its own words past Gemini's limit, slots emptied.
    s.renderable.mockResolvedValue(gemini);
    s.promptText.mockResolvedValue({ ok: true, text: `${"y".repeat(5_001)}[subject]`, variables: [{ name: "subject" }], adult: false });
    expect(await refusal(authorizeIntent(db({ intent: artistOrder }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual(cannot);
    expect(s.promptText).toHaveBeenCalledWith(expect.anything(), "p1");
    // Nothing opened, and the order's prompt id comes from the row read (round 12, 2026-10-20).
    expect(s.open).not.toHaveBeenCalled();
    expect(s.selects.some((cols) => /(^|, )prompt_id(,|$)/.test(cols))).toBe(true);
    // One past the limit once the composer's shortest value is in (round 12): nothing opens.
    s.promptText.mockResolvedValue({ ok: true, text: `${"y".repeat(5_000)}[subject]`, variables: [{ name: "subject" }], adult: false });
    expect(await refusal(authorizeIntent(db({ intent: artistOrder }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual(cannot);
    // A text no web buyer can fill: nothing opens (round 12).
    s.promptText.mockResolvedValue({ ok: true, text: "a photo of [猫] in the rain", variables: [{ name: "var_1" }], adult: false });
    expect(await refusal(authorizeIntent(db({ intent: artistOrder }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual(cannot);
    expect(s.open).not.toHaveBeenCalled();
    // Two checkboxes left unticked add nothing: opens (round 13).
    s.promptText.mockResolvedValue({ ok: true, text: `${"y".repeat(4_998)}[subject][sunset][grain]`, variables: [{ name: "subject" }, { name: "sunset", type: "checkbox", choices: ["at sunset"] }, { name: "grain", type: "checkbox", choices: ["film grain"] }], adult: false });
    expect(await authorizeIntent(db({ intent: artistOrder, units: [unit(0), unit(1)] }).client, conn, { intentId: ID, owner: OWNER, units: 2 })).toMatchObject({ units: 2 });
    // A literal bracket, or an orphan variable, still lets a web buyer fill it: opens (round 13). Both at once do not:
    // the composer sends the orphan's value too, so the bracket and the value both stay unplaced.
    s.promptText.mockResolvedValue({ ok: true, text: "a [sic] [subject]", variables: [{ name: "subject" }], adult: false });
    expect(await authorizeIntent(db({ intent: artistOrder, units: [unit(0), unit(1)] }).client, conn, { intentId: ID, owner: OWNER, units: 2 })).toMatchObject({ units: 2 });
    s.promptText.mockResolvedValue({ ok: true, text: "a [subject]", variables: [{ name: "subject" }, { name: "orphan" }], adult: false });
    expect(await authorizeIntent(db({ intent: artistOrder, units: [unit(0), unit(1)] }).client, conn, { intentId: ID, owner: OWNER, units: 2 })).toMatchObject({ units: 2 });
    // A field with no slot whose every option is longer than a value may be: the composer still asks it, so nothing
    // opens either (round 14).
    s.open.mockClear();
    s.promptText.mockResolvedValue({ ok: true, text: "a [subject] at night", variables: [{ name: "subject" }, { name: "style", type: "single_select", required: true, choices: ["l".repeat(301)] }], adult: false });
    expect(await refusal(authorizeIntent(db({ intent: artistOrder }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual(cannot);
    expect(s.open).not.toHaveBeenCalled();
    // Exactly 300 is sendable, opens; any one field past it, optional or not, refuses (round 15).
    s.promptText.mockResolvedValue({ ok: true, text: "a [subject] at night", variables: [{ name: "subject" }, { name: "style", type: "single_select", choices: ["l".repeat(300)] }], adult: false });
    expect(await authorizeIntent(db({ intent: artistOrder, units: [unit(0), unit(1)] }).client, conn, { intentId: ID, owner: OWNER, units: 2 })).toMatchObject({ units: 2 });
    s.open.mockClear();
    s.promptText.mockResolvedValue({ ok: true, text: "a [subject] at night", variables: [{ name: "subject" }, { name: "fine", type: "radio", choices: ["dawn"] }, { name: "style", type: "radio", required: false, choices: ["l".repeat(301)] }], adult: false });
    expect(await refusal(authorizeIntent(db({ intent: artistOrder }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual(cannot);
    expect(s.open).not.toHaveBeenCalled();
    // A required choice whose every option is longer than a value may be: its shortest fill places nothing, so nothing
    // opens (round 13).
    s.open.mockClear();
    s.promptText.mockResolvedValue({ ok: true, text: "a [s]", variables: [{ name: "s", type: "single_select", required: true, choices: ["l".repeat(301), "m".repeat(302)] }], adult: false });
    expect(await refusal(authorizeIntent(db({ intent: artistOrder }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual(cannot);
    expect(s.open).not.toHaveBeenCalled();
    // Exactly at the limit, or on a host without one: opens.
    s.promptText.mockResolvedValue({ ok: true, text: `${"y".repeat(4_999)}[subject]`, variables: [{ name: "subject" }], adult: false });
    expect(await authorizeIntent(db({ intent: artistOrder, units: [unit(0), unit(1)] }).client, conn, { intentId: ID, owner: OWNER, units: 2 })).toMatchObject({ units: 2 });
    s.renderable.mockResolvedValue({ ...gemini, provider: "openai" });
    // OpenAI's documented 32000 (round 12): one past it opens nothing, 9000 opens.
    s.open.mockClear();
    s.promptText.mockResolvedValue({ ok: true, text: "y".repeat(32_001), variables: [], adult: false });
    expect(await refusal(authorizeIntent(db({ intent: artistOrder }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual(cannot);
    expect(s.open).not.toHaveBeenCalled();
    s.promptText.mockResolvedValue({ ok: true, text: "y".repeat(9_000), variables: [], adult: false });
    expect(await authorizeIntent(db({ intent: artistOrder, units: [unit(0), unit(1)] }).client, conn, { intentId: ID, owner: OWNER, units: 2 })).toMatchObject({ units: 2 });
    // A text with nothing to render: the prompt's; one that cannot be read: our side.
    s.open.mockClear();
    s.promptText.mockResolvedValue({ ok: false, status: 422, error: "This prompt has no readable text to generate from" });
    expect(await refusal(authorizeIntent(db({ intent: artistOrder }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual(cannot);
    for (const failed of [{ ok: false, status: 500, error: "Failed to load prompt" }, { ok: false, status: 503, error: "down", code: "DB_UNAVAILABLE" }]) {
      s.promptText.mockResolvedValue(failed);
      expect(await refusal(authorizeIntent(db({ intent: artistOrder }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual({
        status: 503, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly.",
      });
    }
    expect(s.open).not.toHaveBeenCalled();
    // A prompt without an artist share is not read here.
    s.promptText.mockClear();
    await authorizeIntent(db({ intent: { ...quoted, prompt_id: "p2" }, units: [unit(0), unit(1)] }).client, conn, { intentId: ID, owner: OWNER, units: 2 });
    expect(s.promptText).not.toHaveBeenCalled();
  });

  it("stores the plan on the quoted row BEFORE cloning units from it, then hands one Enki-signed payment per image", async () => {
    const plan = { cuPriceMicroLamports: 10, artistWithheld: false };
    const d = db({ intent: quoted, units: [unit(0, { fronted_atas: plan }), unit(1, { fronted_atas: plan })] });
    const r = await authorizeIntent(d.client, conn, { intentId: ID, owner: OWNER, units: 2 });
    expect(r).toEqual({ intentId: ID, paymentScheme: "intent", units: 2, transactions: [`signed-by-enki:${ID}`, "signed-by-enki:unit-1"] });
    // The plan before the clones; each payment's signature recorded after the open, before it goes out.
    expect(s.order).toEqual(["plan", "update:fronted_atas", "open", "update:tx_signature", "update:tx_signature"]);
    expect(d.updates[0]).toEqual({ patch: { fronted_atas: { cuPriceMicroLamports: 10, artistWithheld: false } }, filters: [["id", ID], ["status", "quoted"], ["batch_intent_id", null]] });
    expect(s.covers).toHaveBeenCalledWith(d.client, conn, OWNER, 2 * 7_560);
    // Each unit is built with its own row id, nonce account and the plan.
    expect(s.authFor.mock.calls.map((c) => [c[0].id, c[0].nonce_account, c[0].fronted_atas.cuPriceMicroLamports, c[1], c[2], c[3]])).toEqual([
      [ID, "N0", 10, "BuyerWallet", "value-N0", "EnkiTreasury"], ["unit-1", "N1", 10, "BuyerWallet", "value-N1", "EnkiTreasury"],
    ]);
  });

  it("opens nothing while the buyer is paused, and says until when", async () => {
    s.pause.mockResolvedValue({ paused: true, until: "2026-10-18T16:30:00.000Z" });
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 1 }))).toEqual({ status: 429, message: expect.stringContaining("paused until 16:30 UTC") });
    expect(s.open).not.toHaveBeenCalled();
  });

  it("opens nothing for a buyer whose USDC does not cover all their open images", async () => {
    s.covers.mockResolvedValue({ ok: false, reason: "payer_usdc", needMicro: 4_000_000, haveMicro: 1_000_000 });
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 1 })))
      .toEqual({ status: 402, message: "Your wallet holds 1 USDC, but your open images need 4 USDC. Add USDC and pay again — nothing was charged." });
    s.covers.mockResolvedValue({ ok: false, reason: "payer_no_account", needMicro: 7_560, haveMicro: 0 });
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 1 }))).toMatchObject({ status: 402, message: expect.stringContaining("no USDC yet") });
    expect(s.open).not.toHaveBeenCalled();
    // Coverage that cannot be decided or read opens nothing either: Enki's, before anything is held (DEC-239) (round 30).
    for (const thrown of [new CoverageUnknown("x"), new Error("rpc down")]) {
      s.covers.mockRejectedValueOnce(thrown);
      expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 1 }))).not.toBeNull();
      expect(s.open).not.toHaveBeenCalled();
    }
  });

  it("refuses a missing order and an account without a wallet", async () => {
    expect(await refusal(authorizeIntent(db({ intent: null }).client, conn, { intentId: ID, owner: OWNER, units: 1 }))).toMatchObject({ status: 404 });
    s.wallet.mockResolvedValue(null);
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 1 }))).toMatchObject({ status: 409 });
  });

  it("maps the batch refusals: caps 429, a closed quote 409, our side 503", async () => {
    s.openCount = 8; s.liveCount = 8;
    for (const [refusalCode, status] of [["cap", 429], ["not_open", 409], ["fee_payer_low", 503], ["nonce_failed", 503]] as const) {
      s.open.mockResolvedValue({ ok: false, refusal: refusalCode });
      expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 1 })), refusalCode).toMatchObject({ status });
    }
  });

  it("hands a retry the same unsigned payments without opening again, and never re-opens a signed order", async () => {
    const opened = { ...quoted, batch_intent_id: ID };
    const r = await authorizeIntent(db({ intent: opened, units: [unit(0), unit(1)] }).client, conn, { intentId: ID, owner: OWNER, units: 2 });
    expect(r.transactions).toEqual([`signed-by-enki:${ID}`, "signed-by-enki:unit-1"]);
    expect(s.open).not.toHaveBeenCalled();
    expect(await refusal(authorizeIntent(db({ intent: opened, units: [unit(0, { authorized_at: "t" }), unit(1)] }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toMatchObject({ status: 409 });
    expect(await refusal(authorizeIntent(db({ intent: opened, units: [unit(0)] }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toMatchObject({ status: 409 });
  });
});

describe("submitting the signed payments", () => {
  const units = [unit(0), unit(1)];
  const signedTxs = ["s0", "s1"];

  it("stores each verified payment sealed under its own unit, then answers the status", async () => {
    const r = await submitIntent(db({ units }).client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs });
    expect(s.store.mock.calls.map((c) => [c[1].intentId, c[1].signedTx, c[1].nonceAccount, c[1].nonceAuthority, c[1].buyerWallet])).toEqual([
      [ID, "s0", "N0", "FeePayer", OWNER], ["unit-1", "s1", "N1", "FeePayer", OWNER],
    ]);
    expect(s.covers).toHaveBeenCalledWith(expect.anything(), conn, OWNER, 0);
    expect(r).toMatchObject({ paymentScheme: "intent" });
  });

  it("voids the whole order and stores nothing when a payment is not the one built, or not fully signed", async () => {
    for (const bad of ["matches", "signed"] as const) {
      s.store.mockClear(); s[bad].mockReturnValueOnce(true).mockReturnValueOnce(false);
      const d = db({ units: [unit(0), unit(1)] });
      expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs })), bad).toMatchObject({ status: 400 });
      expect(s.store).not.toHaveBeenCalled();
      expect(d.updates.filter((u) => u.patch.void_reason === "rejected")).toHaveLength(2);
      s[bad].mockReturnValue(true);
    }
  });

  it("refuses a payment the chain would refuse, in words, voiding the order", async () => {
    s.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "payer_usdc" });
    const d = db({ units: [unit(0), unit(1)] });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs })))
      .toEqual({ status: 402, message: "Your wallet holds less than the 0.00756 USDC this image costs. Add USDC and pay again — nothing was charged." });
    expect(s.store).not.toHaveBeenCalled();
    expect(d.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["rejected", "rejected"]);
    // Enki's fee payer: our side, voided as provider_failed (never the buyer's dropped units).
    s.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "fee_payer" });
    const ours = db({ units: [unit(0), unit(1)] });
    expect(await refusal(submitIntent(ours.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 409 });
    expect(ours.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
    // A simulation the RPC could not run is our side too, and final.
    s.simulate.mockResolvedValue({ ok: false, error: "fetch failed", reason: "rpc" });
    const rpc = db({ units: [unit(0), unit(1)] });
    expect(await refusal(submitIntent(rpc.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly.",
    });
    expect(rpc.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
    // The node refusing the payer's signature (DEC-267): the payer's, counted, never our side (round 31).
    s.simulate.mockResolvedValue({ ok: false, error: "failed to simulate transaction: Transaction signature verification failure", reason: "other" });
    const forged = db({ units: [unit(0), unit(1)] });
    expect(await refusal(submitIntent(forged.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 402, message: "Your payment could not be checked. Nothing was charged — start again.",
    });
    expect(forged.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["rejected", "rejected"]);
    expect(s.store).not.toHaveBeenCalled();
  });

  it("reads an expired simulation as the buyer's only when the payment itself was sent (round 6, 2026-10-20)", async () => {
    s.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "expired" });
    const statuses = (status: unknown) => ({ getSignatureStatuses: vi.fn(async (_s: string[], o: { searchTransactionHistory?: boolean }) => ({ value: [o?.searchTransactionHistory ? status : null] })) }) as never;
    const lagging = db({ units: [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })] });
    expect(await refusal(submitIntent(lagging.client, statuses(null), { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 409 });
    expect(lagging.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
    // Settled at once: the nonce was just read, and a fresh "gone" is not believed (round 7, 2026-10-20).
    expect(s.settleVoided).toHaveBeenCalledTimes(2);
    // The buyer's own broadcast landed: told so, voided, the void books it with a refund owed.
    const landed = db({ units: [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })] });
    expect(await refusal(submitIntent(landed.client, statuses({ slot: 1, err: null }), { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "This order's payment was already sent from your wallet. Nothing more will be charged; if it went through without an image, it is refunded.",
    });
    expect(landed.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["rejected", "rejected"]);
    // Sent and failed on chain: the buyer's, nothing charged.
    const failed = db({ units: [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })] });
    expect(await refusal(submitIntent(failed.client, statuses({ slot: 1, err: { InstructionError: [2, { Custom: 1 }] } }), { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 402 });
    expect(failed.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["rejected", "rejected"]);
  });

  it("asks about every payment of the order once, and a lookup that throws is our side (round 7; round 8, 2026-10-20)", async () => {
    const ALREADY = "This order's payment was already sent from your wallet. Nothing more will be charged; if it went through without an image, it is refunded.";
    // The chain knows only the payments in `landed` (each landed without error).
    const chain = (landed: string[], failed: string[] = []) => {
      const asked: string[][] = [];
      const status = (x: string) => (landed.includes(x) ? { slot: 1, err: null } : failed.includes(x) ? { slot: 1, err: { InstructionError: [2, { Custom: 1 }] } } : null);
      return { asked, conn: { getSignatureStatuses: vi.fn(async (sigs: string[]) => { asked.push(sigs); return { value: sigs.map(status) }; }) } as never };
    };
    const order = () => db({ units: [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })] });
    // Unit 1 expired because the buyer broadcast it; unit 0 checked out: its own landed payment is told.
    s.simulate.mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, error: "raw", reason: "expired" });
    const one = chain(["Sig1"]);
    expect(await refusal(submitIntent(order().client, one.conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: ALREADY });
    expect(one.asked).toEqual([["Sig0", "Sig1"]]);
    // Unit 0 expired on a lagging node, nothing of its own was sent, but unit 1's payment landed: told, not "our side".
    s.simulate.mockReset(); s.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "expired" });
    const other = chain(["Sig1"]);
    expect(await refusal(submitIntent(order().client, other.conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: ALREADY });
    expect(other.asked).toHaveLength(1);
    // Unit 0 refused for its USDC while unit 1's payment had landed: told, not "nothing was charged".
    s.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "payer_usdc" });
    const usdc = order();
    expect(await refusal(submitIntent(usdc.client, chain(["Sig1"]).conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: ALREADY });
    expect(usdc.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["rejected", "rejected"]);
    // Nothing landed: the buyer's refusal stands as worded.
    expect(await refusal(submitIntent(order().client, chain([]).conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 402 });
    // The same for a wallet without a USDC account (round 9, 2026-10-20).
    s.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "payer_no_account" });
    expect(await refusal(submitIntent(order().client, chain(["Sig1"]).conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: ALREADY });
    // Its own sentence, not the unchecked one (round 10, 2026-10-20).
    expect(await refusal(submitIntent(order().client, chain([]).conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 402, message: "Your wallet has no USDC yet. Add at least 0.00756 USDC and pay again — nothing was charged.",
    });
    // An expiring unit whose own payment was sent and failed on chain: the buyer's (round 9, 2026-10-20) ...
    s.simulate.mockReset(); s.simulate.mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, error: "raw", reason: "expired" });
    const ownFailed = order();
    expect(await refusal(submitIntent(ownFailed.client, chain([], ["Sig1"]).conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 402, message: "Your payment could not be checked. Nothing was charged — start again." });
    expect(ownFailed.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["rejected", "rejected"]);
    // ... but another unit's failed payment does not make a lagging node's "expired" the buyer's.
    s.simulate.mockReset(); s.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "expired" });
    const otherFailed = order();
    expect(await refusal(submitIntent(otherFailed.client, chain([], ["Sig1"]).conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly." });
    expect(otherFailed.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
    // The usual order of a buyer's own broadcast: it landed, its nonce moved, so the signed payment no longer matches.
    s.simulate.mockResolvedValue({ ok: true });
    s.matches.mockReturnValue(false);
    const moved = order();
    expect(await refusal(submitIntent(moved.client, chain(["Sig0"]).conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: ALREADY });
    expect(moved.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["rejected", "rejected"]);
    expect(await refusal(submitIntent(order().client, chain([]).conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 400 });
    // A lookup that throws before a refusal of the buyer's is our side too (round 9, 2026-10-20).
    const throwing = order();
    expect(await refusal(submitIntent(throwing.client, { getSignatureStatuses: vi.fn(async () => { throw new Error("rpc down"); }) } as never, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly." });
    expect(throwing.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
    s.matches.mockReturnValue(true);
    s.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "expired" });
    const down = { getSignatureStatuses: vi.fn(async () => { throw new Error("rpc down"); }) } as never;
    const e = db({ units: [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })] });
    expect(await refusal(submitIntent(e.client, down, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly.",
    });
    expect(e.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
  });

  it("tells a landed payment on our side too, wherever the RPC still answers (round 10, 2026-10-20)", async () => {
    const ALREADY = "This order's payment was already sent from your wallet. Nothing more will be charged; if it went through without an image, it is refunded.";
    const OUR = "Payments are paused for a moment on our side. Nothing was charged — try again shortly.";
    const asked: string[][] = [];
    const chain = { getSignatureStatuses: vi.fn(async (sigs: string[]) => { asked.push(sigs); return { value: sigs.map((x) => (x === "Sig1" ? { slot: 1, err: null } : null)) }; }) } as never;
    const order = () => db({ units: [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })] });
    const reasons = (d: ReturnType<typeof db>) => d.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason);
    // A wallet the database could not read, and Enki's fee payer short of SOL: the RPC answers, so it is asked.
    s.wallet.mockRejectedValueOnce(new Error("db down"));
    const wallet = order();
    expect(await refusal(submitIntent(wallet.client, chain, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: ALREADY });
    expect(reasons(wallet)).toEqual(["provider_failed", "provider_failed"]);
    s.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "fee_payer" });
    const fee = order();
    expect(await refusal(submitIntent(fee.client, chain, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: ALREADY });
    expect(reasons(fee)).toEqual(["provider_failed", "provider_failed"]);
    // A nonce that read as no account, and a store the database failed: the RPC answers, so asked too (round 11).
    s.nonce.mockResolvedValueOnce(null);
    expect(await refusal(submitIntent(order().client, chain, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: ALREADY });
    s.simulate.mockResolvedValue({ ok: true });
    s.store.mockRejectedValueOnce(new Error("db down"));
    expect(await refusal(submitIntent(order().client, chain, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: ALREADY });
    // The RPC failed, or a read threw: not asked, the plain answer.
    asked.length = 0;
    s.simulate.mockResolvedValue({ ok: false, error: "fetch failed", reason: "rpc" });
    expect(await refusal(submitIntent(order().client, chain, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: OUR });
    s.simulate.mockResolvedValue({ ok: true });
    s.nonce.mockRejectedValueOnce(new Error("rpc down"));
    expect(await refusal(submitIntent(order().client, chain, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: OUR });
    expect(asked).toEqual([]);
    // A lookup that fails inside ours() reads as nothing landed.
    s.wallet.mockRejectedValueOnce(new Error("db down"));
    const down = { getSignatureStatuses: vi.fn(async () => { throw new Error("rpc down"); }) } as never;
    expect(await refusal(submitIntent(order().client, down, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: OUR });
  });

  it("asks the chain and settles at once when coverage cannot place a capture against the balance (round 22, 2026-10-20)", async () => {
    const ALREADY = "This order's payment was already sent from your wallet. Nothing more will be charged; if it went through without an image, it is refunded.";
    s.covers.mockRejectedValue(new CoverageUnknown("A capture in flight cannot be placed against the buyer's balance"));
    const statuses = (landed: string[]) => ({ getSignatureStatuses: vi.fn(async (sigs: string[]) => ({ value: sigs.map((x) => (landed.includes(x) ? { slot: 1, err: null } : null)) })) }) as never;
    const order = () => db({ units: [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })] });
    // A payment of the order the buyer broadcast after its unit was checked: told.
    const landed = order();
    expect(await refusal(submitIntent(landed.client, statuses(["Sig1"]), { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: ALREADY });
    expect(landed.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
    // Every nonce was read: closed at once, not left for the cron.
    expect(s.settleVoided).toHaveBeenCalledTimes(2);
    s.settleVoided.mockClear();
    expect(await refusal(submitIntent(order().client, statuses([]), { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly." });
    expect(s.settleVoided).toHaveBeenCalledTimes(2);
    // Stored whole by an overlapping /submit while coverage was asked: read fresh, it is that one's (round 23).
    const both: Record<string, unknown>[] = [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })];
    s.covers.mockImplementationOnce(async () => { both[0] = { ...both[0], authorized_at: "t" }; both[1] = { ...both[1], authorized_at: "t" }; throw new CoverageUnknown("x"); });
    const g = db({ get units() { return both.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(g.client, statuses([]), { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "This image request is already paid or closed." });
    expect(g.updates.filter((u) => u.patch.void_reason)).toEqual([]);
  });

  it("answers a lookup that throws at the coverage refusal as our side (round 12, 2026-10-20)", async () => {
    s.covers.mockResolvedValue({ ok: false, reason: "payer_usdc", needMicro: 15_120, haveMicro: 7_560 });
    const down = { getSignatureStatuses: vi.fn(async () => { throw new Error("rpc down"); }) } as never;
    const d = db({ units: [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })] });
    expect(await refusal(submitIntent(d.client, down, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly.",
    });
    expect(d.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
  });

  it("tells a payment that landed after its unit was checked at the coverage refusal too (round 11, 2026-10-20)", async () => {
    const statuses = (landed: string[]) => ({ getSignatureStatuses: vi.fn(async (sigs: string[]) => ({ value: sigs.map((x) => (landed.includes(x) ? { slot: 1, err: null } : null)) })) }) as never;
    const order = () => db({ units: [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })] });
    s.covers.mockResolvedValue({ ok: false, reason: "payer_usdc", needMicro: 15_120, haveMicro: 7_560 });
    const landed = order();
    expect(await refusal(submitIntent(landed.client, statuses(["Sig0"]), { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "This order's payment was already sent from your wallet. Nothing more will be charged; if it went through without an image, it is refunded.",
    });
    expect(landed.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["rejected", "rejected"]);
    expect(await refusal(submitIntent(order().client, statuses([]), { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 402, message: "Your wallet holds 0.00756 USDC, but your open images need 0.01512 USDC. Add USDC and pay again — nothing was charged.",
    });
    expect(s.store).not.toHaveBeenCalled();
  });

  it("voids as our side when a read throws, and answers finally (verification 2026-10-18)", async () => {
    for (const fail of [() => s.nonce.mockRejectedValue(new Error("rpc down")), () => s.covers.mockRejectedValue(new Error("rpc down"))]) {
      s.nonce.mockImplementation(async (_c: unknown, a: string) => `value-${a}`);
      s.covers.mockResolvedValue({ ok: true, wallet: "BuyerWallet" });
      fail();
      const d = db({ units: [unit(0), unit(1)] });
      expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 409 });
      expect(d.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
    }
    expect(s.store).not.toHaveBeenCalled();
    // A read that threw may be a nonce nobody can see yet: left for the cron (round 5, 2026-10-20).
    expect(s.settleVoided).not.toHaveBeenCalled();
  });

  it("voids as our side, never the buyer's, when a unit's nonce cannot be read at submit (verification 2026-10-18)", async () => {
    s.nonce.mockResolvedValue(null);
    const d = db({ units: [unit(0), unit(1)] });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly.",
    });
    expect(d.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
    expect(s.store).not.toHaveBeenCalled();
    // Left for the cron: a close now could see the unread account "gone" and record it closed for good (round 4).
    expect(s.settleVoided).not.toHaveBeenCalled();
  });

  it("voids the order's unsigned units as Enki's when its first read fails (round 8, 2026-10-20)", async () => {
    s.unitsError = { message: "TypeError: fetch failed" };
    s.slowVoid = true;
    const d = db({ units: [unit(0), unit(1)] });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 503, message: "The payment is temporarily unavailable. Please check its status later.",
    });
    expect(d.updates).toEqual([{
      patch: { status: "voided", voided_at: expect.any(String), void_reason: "provider_failed", updated_at: expect.any(String) },
      filters: [["batch_intent_id", ID], ["buyer_wallet", OWNER], ["authorized_at", null], ["voided_at", null], ["captured_at", null]],
    }]);
    // Written before the answer: a function frozen after its response would lose it (round 9, 2026-10-20).
    expect(s.order).toContain("void-done");
    expect(s.store).not.toHaveBeenCalled();
  });

  it("voids nothing when a /submit of the same order that overlapped stored it first (round 20, 2026-10-20)", async () => {
    const units: Record<string, unknown>[] = [unit(0), unit(1)];
    // The overlapping request stored the unit this one raced for and is still storing the rest (round 21).
    s.store.mockImplementation(async () => { units[0] = { ...units[0], authorized_at: "t" }; return false; });
    const d = db({ get units() { return units.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "This image request is already paid or closed.",
    });
    expect(d.updates.filter((u) => u.patch.void_reason)).toEqual([]);
    expect(s.voidFlush).not.toHaveBeenCalled();
    // Stored by the overlap and voided since (a render of it failed), its other unit still funded: nothing voided
    // either (round 21, 2026-10-20).
    s.store.mockReset();
    const since: Record<string, unknown>[] = [unit(0), unit(1)];
    s.store.mockImplementation(async () => { since[0] = { ...since[0], authorized_at: "t", voided_at: "t", void_reason: "provider_failed" }; since[1] = { ...since[1], authorized_at: "t" }; return false; });
    const f = db({ get units() { return since.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(f.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "This image request is already paid or closed.",
    });
    expect(f.updates.filter((u) => u.patch.void_reason)).toEqual([]);
    expect(s.voidFlush).not.toHaveBeenCalled();
    // A unit voided meanwhile is the order changing: voided "rejected", as before.
    s.store.mockReset();
    const changed: Record<string, unknown>[] = [unit(0), unit(1)];
    s.store.mockImplementation(async () => { changed[0] = { ...changed[0], voided_at: "t" }; return false; });
    const e = db({ get units() { return changed.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(e.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 409, message: "This image request changed while paying. Nothing was charged — start again." });
    expect(e.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["rejected"]);
    expect(s.settleVoided).toHaveBeenCalledTimes(1);
  });

  it("leaves an order an overlapping /submit stored during this one's checks to it, when our side refuses (round 21, 2026-10-20)", async () => {
    const OUR = "Payments are paused for a moment on our side. Nothing was charged — try again shortly.";
    // Stored whole while unit 1 was simulated, and the simulation could not run: nothing is voided.
    const whole: Record<string, unknown>[] = [unit(0), unit(1)];
    s.simulate.mockResolvedValueOnce({ ok: true }).mockImplementationOnce(async () => {
      whole[0] = { ...whole[0], authorized_at: "t" }; whole[1] = { ...whole[1], authorized_at: "t" };
      return { ok: false, error: "fetch failed", reason: "rpc" };
    });
    const d = db({ get units() { return whole.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "This image request is already paid or closed.",
    });
    expect(d.updates.filter((u) => u.patch.void_reason)).toEqual([]);
    expect(s.voidFlush).not.toHaveBeenCalled();
    // Stored whole, and a render of unit 0 failed since: unit 1 stays funded (round 22).
    const since: Record<string, unknown>[] = [unit(0), unit(1)];
    s.simulate.mockResolvedValueOnce({ ok: true }).mockImplementationOnce(async () => {
      since[0] = { ...since[0], authorized_at: "t", voided_at: "t", void_reason: "provider_failed" }; since[1] = { ...since[1], authorized_at: "t" };
      return { ok: false, error: "fetch failed", reason: "rpc" };
    });
    const f = db({ get units() { return since.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(f.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "This image request is already paid or closed.",
    });
    expect(f.updates.filter((u) => u.patch.void_reason)).toEqual([]);
    expect(s.voidFlush).not.toHaveBeenCalled();
    // Stored in part: the stored unit is voided as signed, the other as unsigned, both Enki's.
    const part: Record<string, unknown>[] = [unit(0), unit(1)];
    s.simulate.mockResolvedValueOnce({ ok: true }).mockImplementationOnce(async () => {
      part[0] = { ...part[0], authorized_at: "t" };
      return { ok: false, error: "fetch failed", reason: "rpc" };
    });
    const e = db({ get units() { return part.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(e.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: OUR });
    expect(s.voidFlush).toHaveBeenCalledWith(e.client, ID, "provider_failed", { unclaimed: true });
    expect(e.updates.filter((u) => u.patch.void_reason).map((u) => [u.filters.find(([c]) => c === "id")?.[1], u.patch.void_reason])).toEqual([["unit-1", "provider_failed"]]);
    expect(s.store).not.toHaveBeenCalled();
  });

  it("falls back to the first read when the fresh one fails, and the store loop keeps its own read (round 22, 2026-10-20)", async () => {
    // The wallet read fails, and so does the fresh read of the order: the first read is voided, as Enki's.
    s.wallet.mockImplementationOnce(async () => { s.unitsError = { message: "down" }; throw new Error("db down"); });
    const d = db({ units: [unit(0), unit(1)] });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly." });
    expect(d.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
    // The last store committed but its answer was lost: every unit reads stored by this request, which is no overlap,
    // so the order is voided as Enki's, as the store loop has done since round 4.
    s.unitsError = null;
    const units: Record<string, unknown>[] = [unit(0), unit(1)];
    s.store.mockImplementationOnce(async () => { units[0] = { ...units[0], authorized_at: "t" }; return true; })
      .mockImplementationOnce(async () => { units[1] = { ...units[1], authorized_at: "t" }; throw new Error("fetch failed"); });
    const e = db({ get units() { return units.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(e.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly." });
    expect(s.voidFlush.mock.calls.map((c) => [c[1], c[2]])).toEqual([[ID, "provider_failed"], ["unit-1", "provider_failed"]]);
  });

  it("voids the unit it stored when the next one was closed under it, reading the unit it lost on (round 21, 2026-10-20)", async () => {
    const units: Record<string, unknown>[] = [unit(0), unit(1)];
    // This request stores unit 0; the buyer's cancel voids unit 1 (its write skips a stored unit) before it is stored.
    s.store.mockImplementationOnce(async () => { units[0] = { ...units[0], authorized_at: "t" }; return true; })
      .mockImplementationOnce(async () => { units[1] = { ...units[1], voided_at: "t", void_reason: "cancelled" }; return false; });
    const d = db({ get units() { return units.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "This image request changed while paying. Nothing was charged — start again.",
    });
    expect(s.voidFlush).toHaveBeenCalledWith(d.client, ID, "rejected", { unclaimed: true });
    // Closed as Enki's (another /submit of the order failed on our side): the rest is Enki's too.
    s.store.mockReset(); s.voidFlush.mockClear();
    const ours: Record<string, unknown>[] = [unit(0), unit(1)];
    s.store.mockImplementationOnce(async () => { ours[0] = { ...ours[0], authorized_at: "t" }; return true; })
      .mockImplementationOnce(async () => { ours[1] = { ...ours[1], voided_at: "t", void_reason: "provider_failed" }; return false; });
    const e = db({ get units() { return ours.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(e.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 409 });
    expect(s.voidFlush).toHaveBeenCalledWith(e.client, ID, "provider_failed", { unclaimed: true });
    // The reason is read with the order.
    expect(s.selects.some((cols) => cols.split(", ").includes("void_reason"))).toBe(true);
  });

  it("tells a payment of the order that landed while its store lost (round 21, 2026-10-20)", async () => {
    const ALREADY = "This order's payment was already sent from your wallet. Nothing more will be charged; if it went through without an image, it is refunded.";
    const CHANGED = "This image request changed while paying. Nothing was charged — start again.";
    for (const [chain, message] of [
      [{ getSignatureStatuses: vi.fn(async (sigs: string[]) => ({ value: sigs.map((x) => (x === "Sig0" ? { slot: 1, err: null } : null)) })) }, ALREADY],
      [{ getSignatureStatuses: vi.fn(async (sigs: string[]) => ({ value: sigs.map(() => null) })) }, CHANGED],
      [{ getSignatureStatuses: vi.fn(async () => { throw new Error("rpc down"); }) }, CHANGED],
    ] as const) {
      s.store.mockReset();
      const units: Record<string, unknown>[] = [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })];
      // Cancelled while this request ran its checks; the buyer's own broadcast of unit 0 landed.
      s.store.mockImplementation(async () => { units[0] = { ...units[0], voided_at: "t", void_reason: "cancelled" }; units[1] = { ...units[1], voided_at: "t", void_reason: "cancelled" }; return false; });
      const d = db({ get units() { return units.map((u) => ({ ...u })); } });
      expect(await refusal(submitIntent(d.client, chain as never, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message });
    }
  });

  it("voids as our side when the buyer's wallet cannot be read, settling at once (round 5, 2026-10-20)", async () => {
    s.wallet.mockRejectedValue(new Error("db down"));
    const d = db({ units: [unit(0), unit(1)] });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly.",
    });
    expect(d.updates.filter((u) => u.patch.void_reason).map((u) => u.patch.void_reason)).toEqual(["provider_failed", "provider_failed"]);
    // Every nonce was readable: nothing argues against closing them now.
    expect(s.settleVoided).toHaveBeenCalledTimes(2);
    expect(s.store).not.toHaveBeenCalled();
  });

  it("voids as our side when Enki's database fails a store, the stored unit as signed (round 4, 2026-10-19)", async () => {
    const units: Record<string, unknown>[] = [unit(0), unit(1)];
    s.store.mockImplementationOnce(async () => { units[0] = { ...units[0], authorized_at: "t" }; return true; }).mockRejectedValueOnce(new Error("db down"));
    // Every read a fresh copy, as the database answers: the order read before the stores still shows unit 0 unsigned.
    const d = db({ get units() { return units.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({
      status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly.",
    });
    expect(s.voidFlush).toHaveBeenCalledWith(d.client, ID, "provider_failed", { unclaimed: true });
    expect(d.updates.filter((u) => u.patch.void_reason).map((u) => [u.filters.find(([c]) => c === "id")?.[1], u.patch.void_reason])).toEqual([["unit-1", "provider_failed"]]);
    // Every nonce was read before the stores: closed at once, not left for the cron (DEC-151) (round 24).
    expect(s.settleVoided).toHaveBeenCalledTimes(1);
  });

  it("leaves an order an overlapping /submit stored whole to it when this one's first store throws (round 23, 2026-10-21)", async () => {
    // The other /submit stored both units; this one's write matched nothing and its answer was lost.
    const units: Record<string, unknown>[] = [unit(0), unit(1)];
    s.store.mockImplementationOnce(async () => { units[0] = { ...units[0], authorized_at: "t" }; units[1] = { ...units[1], authorized_at: "t" }; throw new Error("fetch failed"); });
    const d = db({ get units() { return units.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "This image request is already paid or closed." });
    expect(d.updates.filter((u) => u.patch.void_reason)).toEqual([]);
    expect(s.voidFlush).not.toHaveBeenCalled();
    // This request's own first store committed and threw on a multi-unit order: only unit 0 reads stored, which is no
    // proof of an overlap, so it is voided as signed and the rest unsigned, both Enki's (round 24).
    s.store.mockReset();
    const own: Record<string, unknown>[] = [unit(0), unit(1)];
    s.store.mockImplementationOnce(async () => { own[0] = { ...own[0], authorized_at: "t" }; throw new Error("fetch failed"); });
    const o = db({ get units() { return own.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(o.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly." });
    expect(s.voidFlush.mock.calls.map((c) => [c[1], c[2]])).toEqual([[ID, "provider_failed"]]);
    expect(o.updates.filter((u) => u.patch.void_reason).map((u) => [u.filters.find(([c]) => c === "id")?.[1], u.patch.void_reason])).toEqual([["unit-1", "provider_failed"]]);
    // Stored whole by the other /submit and a render of unit 0 failed since: unit 1 stays funded (round 24).
    s.store.mockReset(); s.voidFlush.mockClear();
    const since: Record<string, unknown>[] = [unit(0), unit(1)];
    s.store.mockImplementationOnce(async () => { since[0] = { ...since[0], authorized_at: "t", voided_at: "t", void_reason: "provider_failed" }; since[1] = { ...since[1], authorized_at: "t" }; throw new Error("fetch failed"); });
    const v = db({ get units() { return since.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(v.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "This image request is already paid or closed." });
    expect(v.updates.filter((u) => u.patch.void_reason)).toEqual([]);
    expect(s.voidFlush).not.toHaveBeenCalled();
    // A one-unit order cannot tell its own committed store from the other's: voided as Enki's, as before.
    s.store.mockReset();
    const one: Record<string, unknown>[] = [unit(0)];
    s.store.mockImplementationOnce(async () => { one[0] = { ...one[0], authorized_at: "t" }; throw new Error("fetch failed"); });
    const e = db({ get units() { return one.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(e.client, conn, { intentId: ID, owner: OWNER, signedTransactions: ["s0"] }))).toEqual({ status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly." });
    expect(s.voidFlush.mock.calls.map((c) => [c[1], c[2]])).toEqual([[ID, "provider_failed"]]);
  });

  it("voids what this /submit stored as signed when the order cannot be read again (round 22, 2026-10-20)", async () => {
    // A store that threw, then the read that should show what was stored fails too.
    const units: Record<string, unknown>[] = [unit(0), unit(1)];
    s.store.mockImplementationOnce(async () => { units[0] = { ...units[0], authorized_at: "t" }; return true; })
      .mockImplementationOnce(async () => { s.unitsError = { message: "down" }; throw new Error("db down"); });
    const d = db({ get units() { return units.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly." });
    expect(s.voidFlush.mock.calls.map((c) => [c[1], c[2]])).toEqual([[ID, "provider_failed"]]);
    expect(d.updates.filter((u) => u.patch.void_reason).map((u) => [u.filters.find(([c]) => c === "id")?.[1], u.patch.void_reason])).toEqual([["unit-1", "provider_failed"]]);
    // A lost store at the second unit, and the read fails: the same.
    s.unitsError = null; s.store.mockReset(); s.voidFlush.mockClear();
    const lost: Record<string, unknown>[] = [unit(0), unit(1)];
    s.store.mockImplementationOnce(async () => { lost[0] = { ...lost[0], authorized_at: "t" }; return true; })
      .mockImplementationOnce(async () => { s.unitsError = { message: "down" }; return false; });
    const e = db({ get units() { return lost.map((u) => ({ ...u })); } });
    expect(await refusal(submitIntent(e.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly." });
    expect(s.voidFlush.mock.calls.map((c) => [c[1], c[2]])).toEqual([[ID, "provider_failed"]]);
    // Both exits settle unit 1's unsigned void at once (round 24).
    expect(s.settleVoided).toHaveBeenCalledTimes(2);
    // Lost at the first unit: nothing of this request's is stored, so the read's answer stands and nothing is voided.
    s.unitsError = null; s.store.mockReset(); s.voidFlush.mockClear();
    s.store.mockImplementationOnce(async () => { s.unitsError = { message: "down" }; return false; });
    const f = db({ units: [unit(0), unit(1)] });
    expect(await refusal(submitIntent(f.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 503, message: "The payment is temporarily unavailable. Please check its status later." });
    expect(f.updates.filter((u) => u.patch.void_reason)).toEqual([]);
    expect(s.voidFlush).not.toHaveBeenCalled();
    // The later unit's exit asks the chain: a payment of the order the buyer broadcast that landed is told (DEC-234) (round 23).
    s.unitsError = null; s.store.mockReset(); s.voidFlush.mockClear();
    const sent: Record<string, unknown>[] = [unit(0, { tx_signature: "Sig0" }), unit(1, { tx_signature: "Sig1" })];
    s.store.mockImplementationOnce(async () => { sent[0] = { ...sent[0], authorized_at: "t" }; return true; })
      .mockImplementationOnce(async () => { s.unitsError = { message: "down" }; return false; });
    const g = db({ get units() { return sent.map((u) => ({ ...u })); } });
    const chain = { getSignatureStatuses: vi.fn(async (sigs: string[]) => ({ value: sigs.map((x) => (x === "Sig1" ? { slot: 1, err: null } : null)) })) } as never;
    expect(await refusal(submitIntent(g.client, chain, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toEqual({ status: 409, message: "This order's payment was already sent from your wallet. Nothing more will be charged; if it went through without an image, it is refunded." });
    expect(s.voidFlush.mock.calls.map((c) => [c[1], c[2]])).toEqual([[ID, "provider_failed"]]);
  });

  it("voids the order when the buyer's USDC no longer covers all open images", async () => {
    s.covers.mockResolvedValue({ ok: false, reason: "payer_usdc", needMicro: 15_120, haveMicro: 7_560 });
    const d = db({ units: [unit(0), unit(1)] });
    expect(await refusal(submitIntent(d.client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 402 });
    expect(s.store).not.toHaveBeenCalled();
    expect(d.updates.filter((u) => u.patch.void_reason === "rejected")).toHaveLength(2);
  });

  it("refuses a wrong count, an order already signed or closed, and an unknown order", async () => {
    expect(await refusal(submitIntent(db({ units }).client, conn, { intentId: ID, owner: OWNER, signedTransactions: ["s0"] }))).toMatchObject({ status: 400 });
    expect(await refusal(submitIntent(db({ units: [unit(0, { authorized_at: "t" }), unit(1)] }).client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 409 });
    expect(await refusal(submitIntent(db({ units: [] }).client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 404 });
  });

  it("voids the order when a store loses a race", async () => {
    s.store.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await refusal(submitIntent(db({ units }).client, conn, { intentId: ID, owner: OWNER, signedTransactions: signedTxs }))).toMatchObject({ status: 409 });
  });
});

describe("a plan that did not land (round 5, 2026-10-20)", () => {
  it("opens nothing, as our side", async () => {
    s.planError = { message: "down" };
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual({
      status: 503, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly.",
    });
    expect(s.open).not.toHaveBeenCalled();
  });
});

describe("status and cancel", () => {
  it("reports each unit in the escrow status's shape: pending, running, delivered with its generation and image, failed", async () => {
    const units = [unit(0, { authorized_at: "t" }), unit(1, { authorized_at: "t", consumed_at: "t" }), unit(2, { authorized_at: "t", captured_at: "t", fulfilled_at: "t" }), unit(3, { authorized_at: "t", voided_at: "t" }),
      unit(4, { authorized_at: "t", captured_at: "t", fulfilled_at: "t" }), unit(5, { authorized_at: "t", captured_at: "t" })];
    const r = await intentStatus(db({ units, gens: [{ id: "g-2", payment_intent_id: "unit-2" }], imgs: [{ generation_id: "g-2", storage_url: "https://img/2.png" }] }).client, ID, OWNER);
    expect(r).toMatchObject({ paymentScheme: "intent", funded: true, state: "funded" });
    expect(r.units).toEqual([
      { unit_index: 0, state: "pending", generation_id: null }, { unit_index: 1, state: "running", generation_id: null },
      { unit_index: 2, state: "delivered", generation_id: "g-2", imageUrl: "https://img/2.png" }, { unit_index: 3, state: "failed", generation_id: null },
      // Paid and handed over, but its gallery record was lost (DEC-88): no generation, no image link.
      { unit_index: 4, state: "delivered", generation_id: null },
      // Paid while its image was withheld (refund owed): failed, never "already in your gallery" (review 2026-10-18).
      { unit_index: 5, state: "failed", generation_id: null },
    ]);
  });

  it("cancels only what has not started: unsigned units directly, signed ones through a void that closes their nonce", async () => {
    const units = [unit(0), unit(1, { authorized_at: "t" }), unit(2, { authorized_at: "t", consumed_at: "t" }), unit(3, { authorized_at: "t", captured_at: "t" })];
    const d = db({ units });
    expect(await cancelIntent(d.client, ID, OWNER)).toMatchObject({ cancelled: true, paymentScheme: "intent" });
    expect(d.updates.map((u) => u.filters.find((f) => f[0] === "id")?.[1])).toEqual([ID]);
    expect(s.voidFlush).toHaveBeenCalledTimes(1);
    expect(s.voidFlush).toHaveBeenCalledWith(d.client, "unit-1", "cancelled", { unclaimed: true });
    // The direct void is for a unit still unsigned at the write: a signature landing meanwhile wins (DEC-98), and so does
    // a booking of the buyer's own landed broadcast, which clears voided_at (round 8, 2026-10-20).
    expect(d.updates[0].filters).toEqual([["id", ID], ["authorized_at", null], ["voided_at", null], ["captured_at", null]]);
  });

  it("settles nothing when its direct void lost the race to a signature (round 5, 2026-10-20)", async () => {
    s.voidLost = true;
    await cancelIntent(db({ units: [unit(0)] }).client, ID, OWNER);
    expect(s.settleVoided).not.toHaveBeenCalled();
    s.voidLost = false;
    await cancelIntent(db({ units: [unit(0)] }).client, ID, OWNER);
    expect(s.settleVoided).toHaveBeenCalledTimes(1);
  });

  it("reads an order's units only under its owner, in order (round 4, 2026-10-19)", async () => {
    for (const run of [
      (c: never) => cancelIntent(c, ID, OWNER),
      (c: never) => intentStatus(c, ID, OWNER),
      (c: never) => submitIntent(c, conn, { intentId: ID, owner: OWNER, signedTransactions: ["s0", "s1"] }),
    ]) {
      s.queries.length = 0;
      await run(db({ units: [unit(0), unit(1)] }).client).catch(() => undefined);
      expect(s.queries[0]).toEqual({ table: "generation_payment_intents", filters: [["batch_intent_id", ID], ["buyer_wallet", OWNER], ["unit_index", undefined]] });
    }
  });
});

describe("the rail of an order", () => {
  it("follows the row, and the switch only for a quote no rail opened yet", async () => {
    expect(await railFor(db({ row: { nonce_account: "N" } }).client, ID, OWNER)).toBe("intent");
    expect(await railFor(db({ row: { deposit_signature: "s" } }).client, ID, OWNER)).toBe("escrow");
    s.rail.mockResolvedValue("escrow");
    expect(await railFor(db({ row: {} }).client, ID, OWNER)).toBe("escrow");
    s.rail.mockResolvedValue("intent");
    expect(await railFor(db({ row: null }).client, ID, OWNER)).toBe("intent");
  });

  it("keeps an escrow deposit that is prepared but not yet confirmed on escrow when the switch says intent (review 2026-10-18)", async () => {
    s.rail.mockResolvedValue("intent");
    expect(await railFor(db({ row: {}, escrow: ["generation_escrow_deposits"] }).client, ID, OWNER)).toBe("escrow");
    expect(await railFor(db({ row: {}, escrow: ["generation_escrow_recovery"] }).client, ID, OWNER)).toBe("escrow");
    expect(await railFor(db({ row: {} }).client, ID, OWNER)).toBe("intent");
  });
});

describe("every payment handed out can be found again (review 2026-10-18)", () => {
  it("records each unit's signature before the payments go out, retry included", async () => {
    const d = db({ intent: quoted, units: [unit(0), unit(1)] });
    await authorizeIntent(d.client, conn, { intentId: ID, owner: OWNER, units: 2 });
    const sigs = d.updates.filter((u) => "tx_signature" in u.patch);
    expect(sigs.map((u) => [u.patch.tx_signature, u.filters])).toEqual([
      ["sig-of:" + ID, [["id", ID], ["authorized_at", null], ["tx_signature", null]]],
      ["sig-of:unit-1", [["id", "unit-1"], ["authorized_at", null], ["tx_signature", null]]],
    ]);
    const retry = db({ intent: { ...quoted, batch_intent_id: ID, nonce_account: "N0" }, units: [unit(0), unit(1)] });
    await authorizeIntent(retry.client, conn, { intentId: ID, owner: OWNER, units: 2 });
    expect(retry.updates.filter((u) => "tx_signature" in u.patch)).toHaveLength(2);
  });

  it("hands out nothing when a signature cannot be recorded", async () => {
    s.updateError = { message: "down" };
    // Stored units, so the count check passes and the signature write is what refuses (verification 2026-10-18).
    const d = db({ intent: quoted, units: [unit(0), unit(1)] });
    expect(await refusal(authorizeIntent(d.client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toMatchObject({ status: 503 });
    expect(d.updates.some((u) => "tx_signature" in u.patch)).toBe(true);
  });

  it("voids nothing when a retried /authorize cannot hand the order out: the first call may still be creating its nonces (rounds 21, 22, 2026-10-20)", async () => {
    const opened = { ...quoted, batch_intent_id: ID, nonce_account: "N0" };
    // The first call still waits on N1's creation; this retry records unit 0's signature, then cannot read N1 yet.
    s.nonce.mockImplementation(async (_c: unknown, a: string) => (a === "N1" ? null : `value-${a}`));
    for (const units of [[unit(0), unit(1)], [unit(0, { tx_signature: "sig-of:" + ID }), unit(1)]]) {
      const d = db({ intent: opened, units });
      expect(await refusal(authorizeIntent(d.client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual({ status: 503, message: "The payment could not be prepared. Please try again." });
      // Left as it is: the first call hands it out, or the sweep voids it as Enki's (DEC-237).
      expect(d.updates.filter((u) => u.patch.void_reason)).toEqual([]);
    }
  });

  it("never overwrites a recorded signature: an unchanged retry writes nothing", async () => {
    const opened = { ...quoted, batch_intent_id: ID, nonce_account: "N0" };
    const d = db({ intent: opened, units: [unit(0, { tx_signature: "sig-of:" + ID }), unit(1, { tx_signature: "sig-of:unit-1" })] });
    await authorizeIntent(d.client, conn, { intentId: ID, owner: OWNER, units: 2 });
    expect(d.updates.filter((u) => "tx_signature" in u.patch)).toEqual([]);
  });

  it("voids an order whose handed-out payment the buyer already sent, keeping its signature for the lookup", async () => {
    const opened = { ...quoted, batch_intent_id: ID, nonce_account: "N0" };
    const d = db({ intent: opened, units: [unit(0, { tx_signature: "SentByTheBuyer" }), unit(1, { tx_signature: "sig-of:unit-1" })] });
    expect(await refusal(authorizeIntent(d.client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual({
      status: 409, message: "This order's payment was already sent from your wallet. Nothing more will be charged; if it went through without an image, it is refunded.",
    });
    expect(d.updates.filter((u) => "tx_signature" in u.patch)).toEqual([]);
    expect(d.updates.filter((u) => u.patch.void_reason === "rejected").map((u) => u.filters.find(([c]) => c === "id")?.[1])).toEqual([ID, "unit-1"]);
    expect(s.settleVoided).toHaveBeenCalledWith(d.client, ID, "N0");
  });

  it("closes a cancelled unsigned unit's nonce at once and asks whether its payment landed", async () => {
    const units = [unit(0), unit(1, { authorized_at: "t" })];
    const d = db({ units });
    await cancelIntent(d.client, ID, OWNER);
    expect(s.settleVoided).toHaveBeenCalledTimes(1);
    expect(s.settleVoided).toHaveBeenCalledWith(d.client, ID, "N0");
    expect(s.voidFlush).toHaveBeenCalledWith(d.client, "unit-1", "cancelled", { unclaimed: true });
  });
});

describe("an order that ended void (review 2026-10-18)", () => {
  it("is prepared, not funded, while a /submit is still storing the order (round 31, 2026-10-21)", async () => {
    const units = [unit(0, { authorized_at: "t" }), unit(1)];
    expect(await intentStatus(db({ units }).client, ID, OWNER)).toMatchObject({ state: "prepared", funded: false });
  });

  it("is expired and not funded, even when every unit had been signed", async () => {
    const units = [unit(0, { authorized_at: "t", voided_at: "t" }), unit(1, { authorized_at: "t", voided_at: "t" })];
    expect(await intentStatus(db({ units }).client, ID, OWNER)).toMatchObject({ state: "expired", funded: false });
  });

  it("reads whether each unit was handed over, not only paid", async () => {
    await intentStatus(db({ units: [unit(0, { authorized_at: "t" })] }).client, ID, OWNER);
    expect(s.selects[0].split(", ")).toContain("fulfilled_at");
  });

  it("stays funded while any unit is still live", async () => {
    const units = [unit(0, { authorized_at: "t", voided_at: "t" }), unit(1, { authorized_at: "t" })];
    expect(await intentStatus(db({ units }).client, ID, OWNER)).toMatchObject({ state: "funded", funded: true });
  });
});

describe("open-then-drop loops (review 2026-10-18)", () => {
  it("refuses a new order while the buyer is paused for dropped units, opening nothing", async () => {
    s.dropped.mockResolvedValue({ paused: true, until: "2026-10-18T15:42:00.000Z" });
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 1 }))).toEqual({
      status: 429, message: "You left 13 images unpaid in the last hour, so new orders are paused until 15:42 UTC. Nothing was charged.",
    });
    expect(s.dropped).toHaveBeenCalledWith(expect.anything(), OWNER);
    expect(s.open).not.toHaveBeenCalled();
  });
});

describe("a signature that came too late (review 2026-10-18)", () => {
  it("tells a payment of an expired order the buyer broadcast themselves that landed (round 24, 2026-10-21)", async () => {
    const EXPIRED = "This payment expired before it was signed. Nothing was charged — start again.";
    const voided = () => db({ units: [unit(0, { voided_at: "t", tx_signature: "Sig0" }), unit(1, { voided_at: "t", tx_signature: "Sig1" })] });
    const chain = (lookup: (sigs: string[]) => unknown) => ({ getSignatureStatuses: vi.fn(async (sigs: string[]) => lookup(sigs)) }) as never;
    expect(await refusal(submitIntent(voided().client, chain((sigs) => ({ value: sigs.map((x) => (x === "Sig1" ? { slot: 1, err: null } : null)) })), { intentId: ID, owner: OWNER, signedTransactions: ["a", "b"] }))).toEqual({ status: 409, message: "This order's payment was already sent from your wallet. Nothing more will be charged; if it went through without an image, it is refunded." });
    expect(await refusal(submitIntent(voided().client, chain((sigs) => ({ value: sigs.map(() => null) })), { intentId: ID, owner: OWNER, signedTransactions: ["a", "b"] }))).toEqual({ status: 409, message: EXPIRED });
    expect(await refusal(submitIntent(voided().client, chain(() => { throw new Error("rpc down"); }), { intentId: ID, owner: OWNER, signedTransactions: ["a", "b"] }))).toEqual({ status: 409, message: EXPIRED });
    expect(s.store).not.toHaveBeenCalled();
  });

  it("hears the order expired before it was signed, not that it was paid", async () => {
    const units = [unit(0, { voided_at: "t" }), unit(1, { voided_at: "t" })];
    expect(await refusal(submitIntent(db({ units }).client, conn, { intentId: ID, owner: OWNER, signedTransactions: ["a", "b"] }))).toEqual({
      status: 409, message: "This payment expired before it was signed. Nothing was charged — start again.",
    });
    expect(s.store).not.toHaveBeenCalled();
    // A signed order keeps its own sentence.
    const signed = [unit(0, { authorized_at: "t" }), unit(1, { authorized_at: "t" })];
    expect(await refusal(submitIntent(db({ units: signed }).client, conn, { intentId: ID, owner: OWNER, signedTransactions: ["a", "b"] }))).toMatchObject({ message: "This image request is already paid or closed." });
  });
});

describe("a treasury without a USDC account (review 2026-10-18)", () => {
  it("opens no order: every capture would fail after the provider was paid", async () => {
    s.missing.mockResolvedValue(["EnkiTreasury"]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 1 }))).toEqual({
      status: 503, message: "Payments are paused for a moment on our side. Nothing was charged — try again shortly.",
    });
    expect(s.missing).toHaveBeenCalledWith(["EnkiTreasury"]);
    expect(s.open).not.toHaveBeenCalled(); expect(s.covers).not.toHaveBeenCalled();
  });
});

describe("two /authorize calls on one quote (review 2026-10-18)", () => {
  it("builds the payments from the plan the stored units carry, not the one this call computed", async () => {
    const stored = { cuPriceMicroLamports: 99, artistWithheld: false };
    const d = db({ intent: quoted, units: [unit(0, { fronted_atas: stored }), unit(1, { fronted_atas: stored })] });
    await authorizeIntent(d.client, conn, { intentId: ID, owner: OWNER, units: 2 });
    expect(s.authFor.mock.calls.map((c) => c[0].fronted_atas.cuPriceMicroLamports)).toEqual([99, 99]);
  });

  it("hands out nothing when the stored units do not match the order", async () => {
    expect(await refusal(authorizeIntent(db({ intent: quoted, units: [unit(0)] }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toMatchObject({ status: 503 });
    expect(s.sign).not.toHaveBeenCalled();
  });
});

describe("which cap refused (review 2026-10-18)", () => {
  beforeEach(() => s.open.mockResolvedValue({ ok: false, refusal: "cap" }));

  it("tells a buyer at their own limit how many payments they can still finish or cancel", async () => {
    s.openCount = 7; s.liveCount = 5;
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual({
      status: 429, message: "You already have 5 open payments, and at most 8 can be open at once. Finish or cancel some first — nothing was charged.",
    });
    expect(s.countFilters.slice(0, 3)).toEqual([["eq", "buyer_wallet", OWNER], ["not", "nonce_account", "is", null], ["is", "nonce_closed_at", null]]);
    expect(s.countFilters.slice(3)).toEqual([["eq", "buyer_wallet", OWNER], ["not", "nonce_account", "is", null], ["is", "nonce_closed_at", null], ["is", "captured_at", null], ["is", "voided_at", null]]);
  });

  it("says busy when only finished payments, whose accounts are still closing, hold the limit (verification 2026-10-18)", async () => {
    s.openCount = 8; s.liveCount = 0;
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 1 }))).toMatchObject({ status: 503 });
  });

  it("says Enki is busy when the buyer is under their limit: the overall cap refused", async () => {
    s.openCount = 6;
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toEqual({
      status: 503, message: "Payments are busy right now. Nothing was charged — try again in a few minutes.",
    });
    s.openCount = null;
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toMatchObject({ status: 503 });
  });
});

describe("an order the rail cannot hold or hand out (verification 2026-10-18)", () => {
  it("refuses more than 8 images before anything opens", async () => {
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 9 }))).toEqual({
      status: 429, message: "At most 8 images can be paid for at once. Choose fewer images — nothing was charged.",
    });
    expect(s.open).not.toHaveBeenCalled(); expect(s.covers).not.toHaveBeenCalled();
    s.open.mockResolvedValue({ ok: true, units: Array.from({ length: 8 }, (_, i) => ({ id: i ? `unit-${i}` : ID, unitIndex: i, nonceAccount: `N${i}`, nonce: "v" })) });
    await authorizeIntent(db({ intent: quoted, units: Array.from({ length: 8 }, (_, i) => unit(i)) }).client, conn, { intentId: ID, owner: OWNER, units: 8 });
    expect(s.open).toHaveBeenCalledTimes(1);
  });

  it("voids units it opened but could not hand out, as its own failure", async () => {
    s.nonce.mockResolvedValue(null);
    const d = db({ intent: quoted, units: [unit(0), unit(1)] });
    expect(await refusal(authorizeIntent(d.client, conn, { intentId: ID, owner: OWNER, units: 2 }))).toMatchObject({ status: 503 });
    expect(d.updates.filter((u) => u.patch.void_reason).map((u) => [u.patch.void_reason, u.filters.find(([c]) => c === "id")?.[1]])).toEqual([
      ["provider_failed", ID], ["provider_failed", "unit-1"],
    ]);
    // Left for the cron: a fresh account an RPC cannot see yet must not be recorded closed (verification 2026-10-18).
    expect(s.settleVoided).not.toHaveBeenCalled();
  });
});

describe("a model nobody can render here (verification 2026-10-18)", () => {
  it("opens nothing, and says so", async () => {
    s.renderable.mockResolvedValue(false);
    expect(await refusal(authorizeIntent(db({ intent: quoted }).client, conn, { intentId: ID, owner: OWNER, units: 1 }))).toEqual({
      status: 503, message: "This model cannot be rendered right now. Nothing was charged — choose another model or try again later.",
    });
    expect(s.renderable).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: ID }));
    expect(s.open).not.toHaveBeenCalled(); expect(s.covers).not.toHaveBeenCalled();
  });

  it("reads the paid settings the check needs", async () => {
    await authorizeIntent(db({ intent: quoted, units: [unit(0)] }).client, conn, { intentId: ID, owner: OWNER, units: 1 });
    expect(s.selects[0].split(", ")).toEqual(expect.arrayContaining(["model_id", "model_family", "resolution", "quality", "boost", "reference_image_count"]));
  });
});
