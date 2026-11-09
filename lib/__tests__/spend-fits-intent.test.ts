import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/payments/generation/intent asks the daily spend breaker before anything is signed or deposited (DEC-2026-11-04-72):
 * a refusal there costs the buyer nothing, past it a signature. Blind spot: the quote and the database are stand-ins; the
 * reservation's arithmetic is in spend-cap.test.ts.
 */
const s = vi.hoisted(() => ({ fits: vi.fn(), insert: vi.fn() }));
const db = { from: () => ({ insert: s.insert }) };
vi.mock("@/lib/generation/spend-cap", async (orig) => ({ ...(await orig<typeof import("@/lib/generation/spend-cap")>()), spendFits: (...a: unknown[]) => s.fits(...a) }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db }));
vi.mock("@/lib/auth", () => ({ requireAuth: async () => ({ walletAddress: "Owner", userId: "Owner" }), authRefusal: () => new Response("", { status: 401 }), checkRateLimit: () => true }));
vi.mock("@/lib/rate-limit", () => ({ checkRequestRateLimit: () => ({ allowed: true }), rateLimitKey: () => "key", rateLimitResponse: () => new Response("", { status: 429 }) }));
vi.mock("@/lib/webauthn", () => ({ resolveStableUserId: async () => "owner-id", requireActionStepUp: async () => null }));
vi.mock("@/lib/payments/generation-settings", () => ({
  settingsSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
  resolvePaidSettings: async () => ({ ok: true, settings: { modelId: "m", modelFamily: "f", resolution: "2K", quality: null, boost: false, referenceImageCount: 0 } }),
}));
vi.mock("@/lib/payments/generation-quote", () => ({
  computeQuote: async () => ({ ok: true, artistWallet: null, appliedRule: null, split: { modelCostMicro: 411_200, artistAmountMicro: 0, enkiFeeMicro: 1, totalMicro: 450_000 } }),
}));

import { POST } from "../../app/api/payments/generation/intent/route";

const intent = () => POST(new NextRequest("http://enki.test/api/payments/generation/intent", { method: "POST", body: "{}" }));

beforeEach(() => {
  vi.clearAllMocks();
  s.insert.mockReturnValue({ select: () => ({ single: async () => ({ data: { id: "order" }, error: null }) }) });
});

describe("the intent asks the daily spend breaker", () => {
  it("a bill that does not fit is refused with the module's words, and no order is written", async () => {
    s.fits.mockResolvedValue({ ok: false, status: 503, why: "w", error: "fixture refusal", retry: false });
    const res = await intent();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "fixture refusal" });
    expect(s.insert).not.toHaveBeenCalled();
  });

  it("a bill that fits is asked with Enki's bill, not the buyer's total, and the order is written", async () => {
    s.fits.mockResolvedValue({ ok: true, day: "2026-11-04", micro: 411_200 });
    expect((await intent()).status).toBe(200);
    expect(s.fits.mock.calls[0][1]).toBe(411_200);
    expect(s.insert).toHaveBeenCalledOnce();
  });
});
