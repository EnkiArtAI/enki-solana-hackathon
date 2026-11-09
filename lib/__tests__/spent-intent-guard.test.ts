import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * A request naming a spent intent is answered before any metered check, with the claim's own answer, so replaying a
 * spent id cannot spend Enki's money on judges (key-theft measures, M2). The real route, the real claimRefusal and the
 * real escrowUnitSpent run. Every judge, the claims and the provider are spies.
 *
 * The fake database honours select and the filters: a column the route forgets to ask for reads as absent, and a unit
 * filter it forgets finds another unit's row.
 */

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>, errors: {} as Record<string, { code?: string; message: string }>, rail: "escrow",
  checkPrompt: vi.fn(), checkImageBytes: vi.fn(), moderate: vi.fn(), loadPromptText: vi.fn(),
  intentClaim: vi.fn(), escrowClaim: vi.fn(), provider: vi.fn(), voidAuth: vi.fn(), voidUnit: vi.fn(), slot: vi.fn(),
}));
const ORDER = "22222222-2222-4222-8222-222222222222";
const OTHER = "55555555-5555-4555-8555-555555555555";
const UNIT3 = "66666666-6666-4666-8666-666666666666";
const OWNER = "FixtureOwner";
const NOW = "2026-11-04T00:00:00.000Z";

const db = {
  from: (table: string) => {
    let cols: string[] = [];
    const filters: [string, unknown][] = [];
    const q = {
      select: (c = "*") => { cols = c.split(",").map((x) => x.trim()); return q; },
      eq: (key: string, value: unknown) => { filters.push([key, value]); return q; },
      ilike: (key: string, value: unknown) => { filters.push([key, value]); return q; },
      maybeSingle: async () => {
        if (s.errors[table]) return { data: null, error: s.errors[table] };
        const row = (s.tables[table] ?? []).find((r) => filters.every(([k, v]) => r[k] === v));
        return { data: row ? Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]])) : null, error: null };
      },
    };
    return q;
  },
};
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db, getSupabaseServerClientSafe: () => db }));
vi.mock("@/lib/auth", () => ({
  requireAuth: async () => ({ walletAddress: OWNER, userId: OWNER }), authRefusal: () => new Response("", { status: 401 }), checkRateLimit: () => true,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRequestRateLimit: () => ({ allowed: true }), rateLimitKey: () => "key", rateLimitResponse: () => new Response("", { status: 429 }),
}));
vi.mock("@/lib/moderation", () => ({ moderate: (...a: unknown[]) => s.moderate(...a), screenFirst: () => null, CLIENT_BLOCK_MESSAGE: "Refused" }));
vi.mock("@/lib/moderation/prompt-check", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/prompt-check")>()), NOT_CHECKED: { verdict: "clear" }, checkPrompt: (...a: unknown[]) => s.checkPrompt(...a),
}));
vi.mock("@/lib/moderation/image-check-bytes", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/image-check-bytes")>()), checkImageBytes: (...a: unknown[]) => s.checkImageBytes(...a), heldBack: () => false, providerReference: async () => "checked-reference",
}));
vi.mock("@/lib/generation/prompt-text", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/prompt-text")>()), loadPromptText: (...a: unknown[]) => s.loadPromptText(...a),
}));
vi.mock("@/lib/generation/models", () => ({
  resolveModel: async () => ({ id: "model-one", name: "GPT Image 2", supportsQuality: false, supportsResolution: true, maxRefs: 4, allowedRatios: ["1:1"] }),
  chooseRoute: async () => ({ provider: "openai", providerModel: "real-server-model", primary: true }),
}));
vi.mock("@/lib/generation/model-family", () => ({ toModelFamily: () => "gpt-image-2" }));
vi.mock("@/lib/payments/generation-settings", () => ({ settingMismatch: () => null }));
vi.mock("@/lib/payments/generation-claim", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/generation-claim")>()), claimForGeneration: (...a: unknown[]) => s.intentClaim(...a),
}));
vi.mock("@/lib/payments/escrow/server-claims", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/escrow/server-claims")>()), claimGenerationEscrowUnit: (...a: unknown[]) => s.escrowClaim(...a), failGenerationEscrowUnit: async () => undefined,
}));
vi.mock("@/lib/payments/escrow/server-chain", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/escrow/server-chain")>()), escrowServerChain: () => ({ cluster: "solana-devnet" }),
}));
vi.mock("@/lib/payments/escrow/server-lifecycle", () => ({ advanceGenerationEscrow: async () => ({ pending: false }) }));
vi.mock("@/lib/payments/rail", async (orig) => ({ ...(await orig<typeof import("@/lib/payments/rail")>()), paymentRail: async () => s.rail }));
vi.mock("@/lib/payments/settle", () => ({ captureHeld: vi.fn(), voidAndFlush: (...a: unknown[]) => s.voidUnit(...a), settleVoided: vi.fn() }));
vi.mock("@/lib/payments/authorization", () => ({ voidAuthorization: (...a: unknown[]) => s.voidAuth(...a), bookingState: async () => "open" }));
vi.mock("@/lib/payments/authorize-flow", () => ({ buyerCovers: async () => ({ ok: true }), CoverageUnknown: class extends Error {} }));
vi.mock("@/lib/payments/solana", async (orig) => ({ ...(await orig<typeof import("@/lib/payments/solana")>()), solanaConnection: () => "fixture", solanaChainKey: () => "solana-devnet" }));
vi.mock("@/lib/generation/record", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/record")>()), resolveRecordingUserId: async () => "11111111-1111-4111-8111-111111111111", recordGenerationFailure: async () => undefined,
}));
vi.mock("@/lib/generation/concurrency", () => ({ acquireSlot: (...a: unknown[]) => s.slot(...a), releaseSlot: async () => undefined }));
vi.mock("@/lib/moderation-enforcement", () => ({ childSafetyScore: () => null, recordModerationEvent: async () => undefined }));
vi.mock("@/backend/services/openai-image-generation", () => ({ generateImagesWithOpenAI: (...a: unknown[]) => s.provider(...a) }));
vi.mock("@/backend/services/gemini-image-generation", async (orig) => ({ ...(await orig<typeof import("@/backend/services/gemini-image-generation")>()), generateImagesWithGemini: (...a: unknown[]) => s.provider(...a) }));
vi.mock("@/backend/services/wavespeed-image-generation", () => ({ generateImagesWithWaveSpeed: (...a: unknown[]) => s.provider(...a) }));

import { POST } from "../../app/api/generate-image/route";

const REFERENCE = `data:image/png;base64,${Buffer.from("fixture").toString("base64")}`;
function call(overrides: Row = {}) {
  return POST(new NextRequest("http://enki.test/api/generate-image", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": "fixture-session" },
    body: JSON.stringify({ intentId: ORDER, unitIndex: 0, prompt: "A blue bird", referenceImages: [REFERENCE], ...overrides }),
  }));
}
/** A marketplace order, so the artist's text is one of the reads the guard must come before. */
const order = (fields: Row = {}): Row => ({
  id: ORDER, buyer_wallet: OWNER, model_id: "model-one", model_family: "gpt-image-2", resolution: "2K", quality: null, boost: false,
  reference_image_count: 1, prompt_id: "77777777-7777-4777-8777-777777777777", artist_amount_micro: 1000, total_micro: 7_560, ...fields,
});
const intentOrder = (fields: Row = {}): Row => order({ nonce_account: "FixtureNonce", authorized_at: NOW, status: "authorized", ...fields });
const escrowOrder = (fields: Row = {}): Row => order({ deposit_signature: "FixtureDeposit", status: "confirmed", ...fields });
const clone = (fields: Row = {}): Row => ({ id: UNIT3, buyer_wallet: OWNER, batch_intent_id: ORDER, unit_index: 3, status: "authorized", authorized_at: NOW, ...fields });

/** Nothing metered, nothing claimed, nothing closed. */
function expectUntouched() {
  for (const spy of [s.checkPrompt, s.checkImageBytes, s.moderate, s.loadPromptText, s.intentClaim, s.escrowClaim, s.provider, s.voidAuth, s.voidUnit, s.slot]) {
    expect(spy).not.toHaveBeenCalled();
  }
}
/** Every judge ran, the rail's claim ran once and the provider was called once. */
function expectPassed(claim: typeof s.intentClaim) {
  for (const spy of [s.checkPrompt, s.checkImageBytes, s.moderate, s.loadPromptText]) expect(spy).toHaveBeenCalled();
  expect(claim).toHaveBeenCalledOnce();
  expect(s.provider).toHaveBeenCalledOnce();
}

beforeEach(() => {
  vi.clearAllMocks();
  s.tables = {}; s.errors = {}; s.rail = "escrow";
  s.checkPrompt.mockResolvedValue({ verdict: "clear" });
  s.checkImageBytes.mockResolvedValue({ verdict: "clear" });
  s.moderate.mockResolvedValue({ allowed: true });
  s.loadPromptText.mockResolvedValue({ ok: true, text: "A bird", variables: [], adult: false });
  s.slot.mockResolvedValue({ allowed: true, slotId: "slot" });
  s.intentClaim.mockResolvedValue({ ok: true, mode: "authorized", resolution: "2K", modelFamily: "gpt-image-2" });
  s.escrowClaim.mockImplementation(async (_d, _c, f) => ({ ...f, claimToken: "44444444-4444-4444-8444-444444444444" }));
  // The provider's failure ends the run right after the call this file counts.
  s.provider.mockResolvedValue({ success: false, error: "fixture failure" });
  s.voidUnit.mockResolvedValue(undefined);
  vi.stubEnv("OPENAI_API_KEY", "test");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** The answer the real claim gives this row, so the guard's words cannot drift from it. */
async function claimsAnswer(row: Row) {
  const real = await vi.importActual<typeof import("@/lib/payments/generation-claim")>("@/lib/payments/generation-claim");
  const q: Record<string, unknown> = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }) };
  const answer = await real.claimForGeneration({ from: () => q } as never, { intentId: String(row.id), buyerWallet: OWNER });
  if (answer.ok) throw new Error("the fixture row was claimable");
  return { status: answer.status, body: { error: answer.error } };
}

describe("the intent rail", () => {
  const SPENT: [string, Row, number, string][] = [
    ["captured", { captured_at: NOW }, 409, "Payment intent already used"],
    ["voided", { voided_at: NOW }, 409, "Payment intent was cancelled"],
    ["a running duplicate", { consumed_at: NOW }, 409, "Payment intent already used"],
    ["unsigned", { authorized_at: null }, 402, "Payment intent is not ready"],
    ["confirmed and authorised", { status: "confirmed" }, 409, "Payment intent is in an inconsistent state"],
  ];
  it.each(SPENT)("%s, order row: the claim's answer, with no judge and no provider", async (_name, fields, status, error) => {
    s.tables.generation_payment_intents = [intentOrder(fields)];
    const res = await call();
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toEqual({ error });
    expect({ status: res.status, body }).toEqual(await claimsAnswer(intentOrder(fields)));
    expectUntouched();
  });
  it.each(SPENT)("%s, unit 3's own row while the order is open: the same answer", async (_name, fields, status, error) => {
    s.tables.generation_payment_intents = [intentOrder({ batch_intent_id: ORDER }), clone(fields)];
    const res = await call({ unitIndex: 3 });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expectUntouched();
  });
  it("an authorised, unclaimed unit passes every judge and reaches the claim and the provider", async () => {
    s.tables.generation_payment_intents = [intentOrder()];
    await call();
    expectPassed(s.intentClaim);
  });
  it.each([["captured", { captured_at: NOW }], ["voided", { voided_at: NOW }], ["claimed", { consumed_at: NOW }]])("unit 3 still open while unit 0 is %s: passes, since the order's row says nothing of unit 3", async (_name, fields) => {
    s.tables.generation_payment_intents = [intentOrder({ batch_intent_id: ORDER, ...fields }), clone()];
    await call({ unitIndex: 3 });
    expectPassed(s.intentClaim);
    expect(s.intentClaim.mock.calls[0][1]).toMatchObject({ intentId: UNIT3 });
  });
  it("a fresh order after a voided one passes: a new id", async () => {
    s.tables.generation_payment_intents = [intentOrder({ voided_at: NOW }), intentOrder({ id: OTHER })];
    await call({ intentId: OTHER });
    expectPassed(s.intentClaim);
  });
  it("a unit that does not exist keeps its 404", async () => {
    s.tables.generation_payment_intents = [intentOrder({ batch_intent_id: ORDER })];
    const res = await call({ unitIndex: 3 });
    expect(res.status).toBe(404);
    expectUntouched();
  });
  it("a race the guard cannot see stays with the claim: its refusal is still answered, with no provider", async () => {
    s.tables.generation_payment_intents = [intentOrder()];
    s.intentClaim.mockResolvedValue({ ok: false, status: 409, error: "Payment intent already used" });
    const res = await call();
    expect(res.status).toBe(409);
    expect(s.provider).not.toHaveBeenCalled();
  });
});

describe("the escrow rail", () => {
  const CONFLICT = { error: "This image request cannot continue. Please check its status before trying again." };
  const rows = (unit: string | null, batch: string | null, order: Row = escrowOrder()) => {
    s.tables.generation_payment_intents = [order];
    s.tables.generation_escrow_units = unit ? [{ intent_id: ORDER, unit_index: 0, state: unit }] : [];
    s.tables.generation_escrow_batches = batch ? [{ intent_id: ORDER, state: batch }] : [];
  };
  it("answers in the words the claim itself refuses with", async () => {
    const real = await vi.importActual<typeof import("@/lib/payments/escrow/server-claims")>("@/lib/payments/escrow/server-claims");
    // deliver and the claim share one conflict(), and deliver reaches it without a chain.
    await expect(real.deliverGenerationEscrowUnit(db as never, { intentId: "not a uuid" } as never, ORDER)).rejects.toThrow(CONFLICT.error);
  });
  it.each(["running", "delivered", "failed"])("a unit %s: 409, with no judge and no provider", async (unit) => {
    rows(unit, "open");
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(CONFLICT);
    expectUntouched();
  });
  it.each(["closing", "ready", "settled", "refunded", "closed"])("a pending unit in a batch %s: 409, with no judge and no provider", async (batch) => {
    rows("pending", batch);
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(CONFLICT);
    expectUntouched();
  });
  it("a running unit whose lease expired stays refused: the SQL claims only pending", async () => {
    rows("running", "open");
    s.tables.generation_escrow_units[0].lease_expires_at = "2020-01-01T00:00:00.000Z";
    expect((await call()).status).toBe(409);
    expectUntouched();
  });
  it("an order with no funded deposit on the escrow switch: 409, with no judge and no provider", async () => {
    rows("pending", "open", order());
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(CONFLICT);
    expectUntouched();
  });
  it("tx_signature and status confirmed are not spent: a pending unit in an open batch passes", async () => {
    rows("pending", "open", escrowOrder({ tx_signature: "FixtureSignature", status: "confirmed", authorized_at: null }));
    await call();
    expectPassed(s.escrowClaim);
  });
  it("no rows yet pass: the claim creates them", async () => {
    rows(null, null);
    await call();
    expectPassed(s.escrowClaim);
  });
  it("another unit's state says nothing of this one", async () => {
    rows(null, "open");
    s.tables.generation_escrow_units = [{ intent_id: ORDER, unit_index: 3, state: "delivered" }, { intent_id: ORDER, unit_index: 0, state: "pending" }];
    await call();
    expectPassed(s.escrowClaim);
  });
  it("another order's rows say nothing of this one", async () => {
    rows(null, null);
    s.tables.generation_escrow_units = [{ intent_id: OTHER, unit_index: 0, state: "delivered" }];
    s.tables.generation_escrow_batches = [{ intent_id: OTHER, state: "settled" }];
    await call();
    expectPassed(s.escrowClaim);
  });
  it.each(["generation_escrow_units", "generation_escrow_batches"])("%s unreadable short of an outage: passes, and the claim decides", async (table) => {
    rows("pending", "open");
    s.errors[table] = { code: "PGRST000", message: "some other failure" };
    await call();
    expectPassed(s.escrowClaim);
  });
  it.each(["generation_escrow_units", "generation_escrow_batches"])("%s unreachable: the outage's 503, with no judge and no claim", async (table) => {
    rows("pending", "open");
    s.errors[table] = { message: "TypeError: fetch failed" };
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("DB_UNAVAILABLE");
    expectUntouched();
  });
});
