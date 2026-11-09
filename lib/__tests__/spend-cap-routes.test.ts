import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The daily spend breaker on POST /api/generate-image (key-theft measures, M3): the real route with every judge, claim,
 * capture and provider a spy. A refused reservation reaches no provider, charges nobody and leaves the unit voided. The
 * refusals are the real module's own answers: it runs on a client that answers the cap, and on no client at all.
 *
 * Blind spot: the database is a stand-in, so the reservation's own arithmetic is not here but in spend-cap.test.ts.
 */
type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>, rail: "intent", reportFailure: vi.fn(), reportSuccess: vi.fn(),
  reserve: vi.fn(), release: vi.fn(), screen: vi.fn(),
  checkPrompt: vi.fn(), checkImageBytes: vi.fn(), moderate: vi.fn(), loadPromptText: vi.fn(),
  intentClaim: vi.fn(), escrowClaim: vi.fn(), escrowFail: vi.fn(), provider: vi.fn(), voidAuth: vi.fn(), voidUnit: vi.fn(), capture: vi.fn(), slot: vi.fn(), slotBack: vi.fn(), recordFail: vi.fn(),
}));
const ORDER = "22222222-2222-4222-8222-222222222222";
const OWNER = "FixtureOwner";
const NOW = "2026-11-04T00:00:00.000Z";
const HELD = { ok: true, day: "2026-11-04", micro: 411_200 };

const db = {
  from: (table: string) => {
    let cols: string[] = [];
    const filters: [string, unknown][] = [];
    const q = {
      select: (c = "*") => { cols = c.split(",").map((x) => x.trim()); return q; },
      eq: (key: string, value: unknown) => { filters.push([key, value]); return q; },
      ilike: (key: string, value: unknown) => { filters.push([key, value]); return q; },
      maybeSingle: async () => {
        const row = (s.tables[table] ?? []).find((r) => filters.every(([k, v]) => r[k] === v));
        return { data: row ? Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]])) : null, error: null };
      },
    };
    return q;
  },
};
vi.mock("@/lib/generation/spend-cap", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/spend-cap")>()),
  reserveSpend: (...a: unknown[]) => s.reserve(...a), releaseSpend: (...a: unknown[]) => s.release(...a),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db, getSupabaseServerClientSafe: () => db }));
vi.mock("@/lib/auth", () => ({
  requireAuth: async () => ({ walletAddress: OWNER, userId: OWNER }), authRefusal: () => new Response("", { status: 401 }), checkRateLimit: () => true,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRequestRateLimit: () => ({ allowed: true }), rateLimitKey: () => "key", rateLimitResponse: () => new Response("", { status: 429 }),
}));
vi.mock("@/lib/moderation", () => ({ moderate: (...a: unknown[]) => s.moderate(...a), screenFirst: (...a: unknown[]) => s.screen(...a), CLIENT_BLOCK_MESSAGE: "Refused" }));
vi.mock("@/lib/moderation/prompt-check", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/prompt-check")>()), NOT_CHECKED: { verdict: "clear" }, checkPrompt: (...a: unknown[]) => s.checkPrompt(...a),
}));
vi.mock("@/lib/moderation/image-check-bytes", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/image-check-bytes")>()), checkImageBytes: (...a: unknown[]) => s.checkImageBytes(...a), heldBack: () => false, providerReference: async () => "checked-reference",
}));
vi.mock("@/lib/moderation/extraction-hits", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/extraction-hits")>()), recordExtractionHit: async () => undefined, silentFailure: async () => new Response(JSON.stringify({ error: "failed" }), { status: 500 }),
}));
vi.mock("@/lib/generation/prompt-text", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/prompt-text")>()), loadPromptText: (...a: unknown[]) => s.loadPromptText(...a),
}));
vi.mock("@/lib/generation/models", () => ({
  resolveModel: async () => ({ id: "model-one", name: "GPT Image 2", supportsQuality: false, supportsResolution: true, maxRefs: 4, allowedRatios: ["1:1"] }),
  chooseRoute: async () => ({ provider: "openai", providerModel: "real-server-model", modelProviderId: "route-1", providerId: "host-1", primary: true }),
}));
vi.mock("@/lib/generation/provider-health", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/provider-health")>()),
  reportFailure: (...a: unknown[]) => s.reportFailure(...a), reportSuccess: (...a: unknown[]) => s.reportSuccess(...a),
}));
vi.mock("@/lib/generation/model-family", () => ({ toModelFamily: () => "gpt-image-2" }));
vi.mock("@/lib/payments/generation-settings", () => ({ settingMismatch: () => null }));
vi.mock("@/lib/payments/generation-claim", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/generation-claim")>()), claimForGeneration: (...a: unknown[]) => s.intentClaim(...a),
}));
vi.mock("@/lib/payments/escrow/server-claims", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/escrow/server-claims")>()), claimGenerationEscrowUnit: (...a: unknown[]) => s.escrowClaim(...a), failGenerationEscrowUnit: (...a: unknown[]) => s.escrowFail(...a),
}));
vi.mock("@/lib/payments/escrow/server-chain", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/escrow/server-chain")>()), escrowServerChain: () => ({ cluster: "solana-devnet" }),
}));
vi.mock("@/lib/payments/escrow/server-lifecycle", () => ({ advanceGenerationEscrow: async () => ({ pending: false }) }));
vi.mock("@/lib/payments/rail", async (orig) => ({ ...(await orig<typeof import("@/lib/payments/rail")>()), paymentRail: async () => s.rail }));
vi.mock("@/lib/payments/settle", () => ({ captureHeld: (...a: unknown[]) => s.capture(...a), voidAndFlush: (...a: unknown[]) => s.voidUnit(...a), settleVoided: vi.fn() }));
vi.mock("@/lib/payments/authorization", () => ({ voidAuthorization: (...a: unknown[]) => s.voidAuth(...a), bookingState: async () => "open" }));
vi.mock("@/lib/payments/authorize-flow", () => ({ buyerCovers: async () => ({ ok: true }), CoverageUnknown: class extends Error {} }));
vi.mock("@/lib/payments/solana", async (orig) => ({ ...(await orig<typeof import("@/lib/payments/solana")>()), solanaConnection: () => "fixture", solanaChainKey: () => "solana-devnet" }));
vi.mock("@/lib/generation/record", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/record")>()), resolveRecordingUserId: async () => "11111111-1111-4111-8111-111111111111", recordGenerationFailure: (...a: unknown[]) => s.recordFail(...a),
}));
vi.mock("@/lib/generation/concurrency", () => ({ acquireSlot: (...a: unknown[]) => s.slot(...a), releaseSlot: (...a: unknown[]) => s.slotBack(...a) }));
vi.mock("@/lib/moderation-enforcement", () => ({ childSafetyScore: () => null, recordModerationEvent: async () => undefined }));
vi.mock("@/backend/services/openai-image-generation", () => ({ generateImagesWithOpenAI: (...a: unknown[]) => s.provider(...a) }));
vi.mock("@/backend/services/gemini-image-generation", async (orig) => ({ ...(await orig<typeof import("@/backend/services/gemini-image-generation")>()), generateImagesWithGemini: (...a: unknown[]) => s.provider(...a) }));
vi.mock("@/backend/services/wavespeed-image-generation", () => ({ generateImagesWithWaveSpeed: (...a: unknown[]) => s.provider(...a) }));

import { POST } from "../../app/api/generate-image/route";

const REFERENCE = `data:image/png;base64,${Buffer.from("fixture").toString("base64")}`;
const call = (overrides: Row = {}) => POST(new NextRequest("http://enki.test/api/generate-image", {
  method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": "fixture-session" },
  body: JSON.stringify({ intentId: ORDER, unitIndex: 0, prompt: "A blue bird", referenceImages: [REFERENCE], ...overrides }),
}));
const order = (fields: Row = {}): Row => ({
  id: ORDER, buyer_wallet: OWNER, model_id: "model-one", model_family: "gpt-image-2", resolution: "2K", quality: null, boost: false,
  reference_image_count: 1, prompt_id: null, artist_amount_micro: 0, total_micro: 450_000, model_cost_micro: 411_200,
  ...(s.rail === "intent" ? { nonce_account: "FixtureNonce", authorized_at: NOW, status: "authorized" } : { deposit_signature: "FixtureDeposit", status: "confirmed" }),
  ...fields,
});

/** The real module's two refusals, so the route's words cannot drift from it. */
async function refusals() {
  const real = await vi.importActual<typeof import("@/lib/generation/spend-cap")>("@/lib/generation/spend-cap");
  const reached = await real.reserveSpend({ rpc: async () => ({ data: [{ allowed: false, first_refusal: false, spend_day: "2026-11-04" }], error: null }) } as never, 1);
  const unread = await real.reserveSpend(null, 1);
  if (reached.ok || unread.ok) throw new Error("the fixture was allowed");
  return { reached, unread };
}

beforeEach(() => {
  vi.clearAllMocks();
  s.tables = {}; s.rail = "intent";
  s.reserve.mockImplementation(async (_db, micro: number) => ({ ...HELD, micro }));
  s.release.mockResolvedValue(undefined);
  s.screen.mockReturnValue(null);
  s.checkPrompt.mockResolvedValue({ verdict: "clear" });
  s.checkImageBytes.mockResolvedValue({ verdict: "clear" });
  s.moderate.mockResolvedValue({ allowed: true });
  s.slot.mockResolvedValue({ allowed: true, slotId: "slot" });
  s.slotBack.mockResolvedValue(undefined);
  s.recordFail.mockResolvedValue(undefined);
  s.intentClaim.mockResolvedValue({ ok: true, mode: "authorized", resolution: "2K", modelFamily: "gpt-image-2" });
  s.escrowClaim.mockImplementation(async (_d, _c, f) => ({ ...f, claimToken: "44444444-4444-4444-8444-444444444444" }));
  s.escrowFail.mockResolvedValue(undefined);
  s.provider.mockResolvedValue({ success: false, error: "fixture outage" });
  s.voidUnit.mockResolvedValue(undefined);
  s.voidAuth.mockResolvedValue({ nonceAccount: null });
  vi.stubEnv("OPENAI_API_KEY", "test");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe.each(["intent", "escrow"])("the %s rail", (rail) => {
  beforeEach(() => { s.rail = rail; s.tables.generation_payment_intents = [order()]; });
  // The escrow's deposit may still await its refund, so it never says "nothing was charged".
  const wordsOf = (error: string) => rail === "intent" ? error : error.replace("Nothing was generated and nothing was charged.", "No image was generated. Check your payment status before trying again.");

  it.each(["reached", "unread"] as const)("the judges' reservation refused (%s): no judge, no claim, no provider, nothing captured", async (which) => {
    const refusal = (await refusals())[which];
    s.reserve.mockResolvedValueOnce(refusal);
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: wordsOf(refusal.error) });
    for (const spy of [s.checkPrompt, s.checkImageBytes, s.moderate, s.intentClaim, s.escrowClaim, s.provider, s.capture, s.slot]) expect(spy).not.toHaveBeenCalled();
    // Reached: the intent unit is closed as Enki's, so the buyer's cancel cannot count it. Unread: it stays open, so a retry can
    // use it. The escrow's stays pending and funded either way, for its refund.
    if (rail === "intent" && which === "reached") expect(s.voidAuth).toHaveBeenCalledWith(db, ORDER, "provider_failed", { unclaimed: true });
    else expect(s.voidAuth).not.toHaveBeenCalled();
  });

  it("an unreadable cap never says two things: no retry word beside the status check", async () => {
    const refusal = (await refusals()).unread;
    s.reserve.mockResolvedValueOnce(refusal);
    const { error } = await (await call()).json() as { error: string };
    expect(error).not.toMatch(/please try again/i);
    expect(error).toBe(rail === "intent"
      ? "Enki could not check its daily limit right now. Nothing was generated and nothing was charged."
      : "Enki could not check its daily limit right now. No image was generated. Check your payment status before trying again.");
  });

  it.each(["reached", "unread"] as const)("the render's reservation refused (%s): judged and claimed, no provider, nothing captured, the unit voided, the slot back", async (which) => {
    const refusal = (await refusals())[which];
    s.reserve.mockResolvedValueOnce({ ...HELD, micro: 900 }).mockResolvedValueOnce(refusal);
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: wordsOf(refusal.error) });
    expect(s.checkPrompt).toHaveBeenCalledOnce();
    expect(s.provider).not.toHaveBeenCalled();
    expect(s.capture).not.toHaveBeenCalled();
    expect(s.release).not.toHaveBeenCalled();
    if (rail === "intent") expect(s.voidUnit).toHaveBeenCalledWith(db, ORDER, "provider_failed");
    else expect(s.escrowFail).toHaveBeenCalledOnce();
    expect(s.slotBack).toHaveBeenCalledOnce();
    expect(s.recordFail).toHaveBeenCalledOnce();
  });

  it("reserves the judges before they run and the bill before the provider, each with its own amount", async () => {
    const seen: string[] = [];
    s.reserve.mockImplementation(async (_d, micro: number) => { seen.push(`reserve ${micro}`); return { ...HELD, micro }; });
    s.checkPrompt.mockImplementation(async () => { seen.push("judge"); return { verdict: "clear" }; });
    s.provider.mockImplementation(async () => { seen.push("provider"); return { success: false, error: "fixture outage" }; });
    await call();
    expect(seen).toEqual(["reserve 900", "judge", "reserve 411200", "provider"]);
    expect(s.reserve.mock.calls[0][0]).toBe(db);
  });

  it("no reference: the allowance is the prompt check alone", async () => {
    s.tables.generation_payment_intents = [order({ reference_image_count: 0 })];
    await call({ referenceImages: [] });
    expect(s.reserve.mock.calls[0][1]).toBe(300);
  });

  it("the regex refused and no reference: nothing was called, nothing is reserved", async () => {
    s.tables.generation_payment_intents = [order({ reference_image_count: 0 })];
    s.screen.mockReturnValue({ allowed: false, tier: 1, category: "fixture", rules: [], scores: {} });
    expect((await call({ referenceImages: [] })).status).toBeGreaterThanOrEqual(400);
    for (const spy of [s.reserve, s.checkPrompt, s.checkImageBytes, s.provider]) expect(spy).not.toHaveBeenCalled();
  });

  it("the regex refused beside a reference: only the reference's two views are reserved, they still run", async () => {
    s.screen.mockReturnValue({ allowed: false, tier: 1, category: "fixture", rules: [], scores: {} });
    await call();
    expect(s.reserve.mock.calls[0][1]).toBe(600);
    expect(s.checkPrompt).not.toHaveBeenCalled();
    expect(s.checkImageBytes).toHaveBeenCalledOnce();
  });

  it("a reference sent as a link is refused with nothing reserved: it never reaches a judge", async () => {
    expect((await call({ referenceImages: ["https://x.test/a.png"] })).status).toBe(422);
    for (const spy of [s.reserve, s.checkPrompt, s.checkImageBytes]) expect(spy).not.toHaveBeenCalled();
  });

  it("a row without a price reserves nothing, and the module's raise refuses it", async () => {
    s.tables.generation_payment_intents = [order({ model_cost_micro: null })];
    s.reserve.mockImplementation(async (_d, micro: number) => (micro > 0 ? { ...HELD, micro } : (await refusals()).unread));
    expect((await call()).status).toBe(503);
    expect(s.reserve.mock.calls[1][1]).toBe(0);
    expect(s.provider).not.toHaveBeenCalled();
  });

  it("a provider that refused the content gives the reservation back", async () => {
    s.provider.mockResolvedValue({ success: false, error: "blocked by content_policy" });
    await call();
    expect(s.release).toHaveBeenCalledOnce();
    expect(s.release).toHaveBeenCalledWith(db, { ...HELD, micro: 411_200 });
  });

  it.each(["fixture outage", "rate limit exceeded", "upstream timeout"])("an outage may be billed: %s keeps the reservation", async (error) => {
    s.provider.mockResolvedValue({ success: false, error });
    await call();
    expect(s.provider).toHaveBeenCalledOnce();
    expect(s.release).not.toHaveBeenCalled();
  });

  it.each(["GEMINI_API_KEY is not set", "OpenAI 401 invalid api key", "429 quota exceeded", "Insufficient credits", "Invalid image: unsupported dimensions"])("answered before any work: %s gives the reservation back, whatever the unit is voided as", async (error) => {
    s.provider.mockResolvedValue({ success: false, error });
    await call();
    expect(s.release).toHaveBeenCalledOnce();
    expect(s.release).toHaveBeenCalledWith(db, { ...HELD, micro: 411_200 });
  });

  it("a provider that throws keeps the reservation", async () => {
    s.provider.mockRejectedValue(new Error("socket hang up"));
    await call();
    expect(s.provider).toHaveBeenCalledOnce();
    expect(s.release).not.toHaveBeenCalled();
  });

  describe("a throw the breaker must see, and one it must not", () => {
    const told = () => s.reportFailure.mock.calls.map((c) => c.slice(1));

    // No real adapter rejects on a dropped host (it answers { success: false }), so a rejection here is Enki's own, whatever its words.
    it.each(["socket hang up", "fetch failed", "Cannot read properties of undefined (reading 'timeout')", "socket is not a function", "fetchAborted is not defined", 'Unsupported resolution tier "9K"'])("the adapter's own throw, %s: answered the same, no outage counted", async (message) => {
      s.provider.mockRejectedValue(new Error(message));
      expect((await call()).status).toBeGreaterThanOrEqual(500);
      expect(told()).toEqual([]);
    });

    const hostGets = (ms: number) => {
      const real = Date.now;
      let shift = 0;
      vi.spyOn(Date, "now").mockImplementation(() => real() + shift);
      s.reserve.mockImplementation(async (_d, micro: number) => {
        // The store's clock less the intent rail's reserve for the capture: what is left when the host is asked.
        if (micro === 411_200) shift = (rail === "intent" ? 230_000 : 285_000) - ms;
        return { ...HELD, micro };
      });
      s.provider.mockReturnValue(new Promise(() => {}));
      const realTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, wait?: number) => realTimeout(fn, (wait ?? 0) > 60_000 ? 1 : wait)) as typeof setTimeout);
    };

    it.each([1, 110_000])("a host handed %i ms because Enki spent the rest: asked, and nothing said of it", async (ms) => {
      hostGets(ms);
      expect((await call()).status).toBeGreaterThanOrEqual(500);
      expect(s.provider).toHaveBeenCalledOnce();
      expect(told()).toEqual([]);
    });

    it("a host handed more than the two minutes, that does not answer, is told", async () => {
      hostGets(125_000);
      expect((await call()).status).toBeGreaterThanOrEqual(500);
      expect(told()).toHaveLength(1);
    });

    it("the timeout around the adapter is reported, and the breaker reads it as this route's outage", async () => {
      const { classifyFailure } = await vi.importActual<typeof import("@/lib/generation/provider-health")>("@/lib/generation/provider-health");
      s.provider.mockReturnValue(new Promise(() => {}));
      const real = globalThis.setTimeout;
      // Only the long wait is cut short: the route's timers below a minute keep their length.
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => real(fn, (ms ?? 0) > 60_000 ? 1 : ms)) as typeof setTimeout);
      expect((await call()).status).toBe(500);
      expect(told()).toHaveLength(1);
      expect(told()[0].slice(0, 2)).toEqual(["route-1", "host-1"]);
      expect(told()[0][2]).toMatch(/timed out/);
      expect(classifyFailure(told()[0][2] as string)).toEqual({ kind: "infrastructure", scope: "route" });
    });

    it("a throw before the provider was asked says nothing of the host, whatever its words", async () => {
      s.reserve.mockRejectedValue(new Error("socket hang up"));
      expect((await call()).status).toBe(500);
      expect(s.provider).not.toHaveBeenCalled();
      expect(told()).toEqual([]);
    });

    it("a host's answered failure is told once, as before", async () => {
      expect((await call()).status).toBe(500);
      expect(told()).toEqual([["route-1", "host-1", "fixture outage"]]);
    });
  });

  it("a request refused silently reserves no render: nothing was called", async () => {
    s.checkPrompt.mockResolvedValue({ verdict: "extraction", confidence: 0.9 });
    await call();
    expect(s.reserve).toHaveBeenCalledOnce();
    expect(s.provider).not.toHaveBeenCalled();
  });
});
