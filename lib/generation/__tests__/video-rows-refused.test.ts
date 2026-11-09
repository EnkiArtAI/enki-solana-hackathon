import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";

/**
 * A video row in `models` (SQL 67) never resolves in the image path, on any of its three routes. The worst case is the
 * fixture: the video row has a provider row to Gemini, every key is set and fetch is a recorder, so the guard is what
 * stands between a video id and a host; an image id is the control, it reaches the recorder, so the count can fail.
 * The routes, lib/generation/models.ts and the adapters are real; the `models` read is a double that applies the
 * route's filters (media_type: VERIFIED live 2026-11-03, models.media_type is in the OpenAPI schema and all six rows
 * read "image"), and what lies before the provider (moderation, payment rows, slots) answers yes.
 * Blind spot: x402 is driven up to its 402 and no further, a settled payment needs a chain; past the 402 its one reader
 * is resolveModelByFamily, pinned here directly.
 */
const IMAGE = "11111111-1111-4111-8111-111111111111";
const VIDEO = "22222222-2222-4222-8222-222222222222";
const FREE = "33333333-3333-4333-8333-333333333333";
const USER = "cccccccc-1111-4111-8111-cccccccccccc";
const ROWS: Record<string, unknown>[] = [
  { id: IMAGE, name: "Nano Banana Pro", active: true, media_type: "image", allowed_ratios: ["1:1"], max_reference_images: 14, model_providers: [] },
  { id: FREE, name: "Flux (free)", active: true, media_type: "image", allowed_ratios: ["1:1"], max_reference_images: 0, model_providers: [] },
  {
    id: VIDEO, name: "Seedance 2.5", active: true, media_type: "video", allowed_ratios: ["1:1"], max_reference_images: 30,
    model_providers: [{ id: "mp", role: "normal", provider_model: "gemini-3-pro-image", active: true, priority: 0, provider_id: "p", providers: { id: "p", key: "gemini", audience: "public", active: true } }],
  },
];

const s = vi.hoisted(() => ({ row: {} as Record<string, unknown>, claimed: 0, role: "admin" }));
const db = {
  rpc: async (fn: string) => {
    if (fn === "claim_free_render") return { data: [{ claim_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", refused: null, first_refusal: false }], error: null };
    if (fn === "claim_free_generation") return { data: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", error: null };
    return { data: null, error: null };
  },
  from: (table: string) => {
    const own: [string, unknown][] = [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { own.push([c, v]); return q; },
      in: (c: string, v: unknown[]) => { own.push([c, v]); return q; },
      ilike: (c: string, v: unknown) => { own.push([c, v]); return q; },
      delete: () => q,
      maybeSingle: async () => ({
        data: table === "users" ? { role: s.role }
          : table === "prompts" ? null
          : own.some(([c]) => c === "buyer_wallet") ? { model_id: s.row.model_id, model_family: s.row.model_family, resolution: "2K", quality: null, boost: false, reference_image_count: 0, prompt_id: null, artist_amount_micro: 0, total_micro: 7_560, deposit_signature: "FixtureDeposit" } : null,
        error: null,
      }),
      then: (done: (v: unknown) => unknown) => Promise.resolve(table === "models"
        ? { data: ROWS.filter((r) => own.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v))), error: null }
        : { data: [], error: null }).then(done),
    };
    return q;
  },
};
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db, getSupabaseServerClientSafe: () => db }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), checkRequestRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/webauthn", () => ({ requireActionStepUp: async () => null }));
vi.mock("@/lib/auth", () => ({
  requireAuth: async () => ({ walletAddress: "Owner", userId: "Owner" }),
  authRefusal: () => new Response("", { status: 401 }), checkRateLimit: () => true,
}));
vi.mock("@/lib/session-user", async (orig) => ({ ...(await orig<typeof import("@/lib/session-user")>()), resolveOwnerIds: async () => [USER] }));
vi.mock("@/lib/adult-content", () => ({ ADULT_REFUSAL: { error: "18+" }, adultConfirmed: async () => true }));
vi.mock("@/lib/generation/free-render-prompt", () => ({ freeRenderPrompt: async () => ({ paid: false, adult: false, creditId: null }) }));
vi.mock("@/lib/generation/record", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/record")>()),
  imageIdWithin: async () => null, recordGeneration: async () => null, recordGenerationFailure: async () => undefined, resolveRecordingUserId: async () => USER,
}));
vi.mock("@/lib/generation/derivative-store", () => ({ storeDeadline: () => Date.now() + 100_000, storeGeneratedImage: async () => ({ imageUrl: "https://blob/x.png" }), putDurably: async () => "https://blob/x.png", removeStored: async () => undefined }));
vi.mock("@/lib/generation/concurrency", () => ({ acquireSlot: async () => ({ allowed: true, slotId: "slot" }), releaseSlot: async () => undefined }));
vi.mock("@/lib/generation/reference-images", () => ({ storeReferenceImages: async () => [] }));
vi.mock("@/lib/moderation", () => ({ moderate: async () => ({ allowed: true }), screenFirst: () => null, CLIENT_BLOCK_MESSAGE: "Refused" }));
vi.mock("@/lib/moderation-enforcement", () => ({ childSafetyScore: () => null, recordModerationEvent: async () => undefined }));
vi.mock("@/lib/moderation/prompt-check", async (orig) => ({ ...(await orig<typeof import("@/lib/moderation/prompt-check")>()), NOT_CHECKED: { verdict: "clear" }, checkPrompt: async () => ({ verdict: "clear" }) }));
vi.mock("@/lib/moderation/prompt-pause", async (orig) => ({ ...(await orig<typeof import("@/lib/moderation/prompt-pause")>()), refusePrompt: async () => false, letteringReleased: async () => false }));
vi.mock("@/lib/moderation/warnings", async (orig) => ({ ...(await orig<typeof import("@/lib/moderation/warnings")>()), recordWarning: async () => ({}) }));
vi.mock("@/lib/moderation/image-case", () => ({ recordImageCase: async () => undefined }));
vi.mock("@/lib/moderation/image-check-bytes", async (orig) => ({ ...(await orig<typeof import("@/lib/moderation/image-check-bytes")>()), checkImageBytes: async () => ({ verdict: "clear" }), heldBack: () => false }));
vi.mock("@/lib/payments/generation-settings", () => ({ settingMismatch: () => null }));
vi.mock("@/lib/payments/escrow/server-claims", () => ({
  claimGenerationEscrowUnit: async (_d: unknown, _c: unknown, f: object) => { s.claimed += 1; return { ...f, claimToken: "44444444-4444-4444-8444-444444444444" }; },
  deliverGenerationEscrowUnit: async () => undefined, failGenerationEscrowUnit: async () => undefined, escrowUnitSpent: async () => false, ESCROW_UNIT_CONFLICT: "Spent.",
}));
vi.mock("@/lib/payments/escrow/server-chain", () => {
  class EscrowPaymentError extends Error { constructor(readonly status: number, message: string) { super(message); } }
  return { EscrowPaymentError, escrowServerChain: () => ({ cluster: "solana-devnet", programAddress: "11111111111111111111111111111111" }) };
});
vi.mock("@/lib/payments/escrow/server-lifecycle", () => ({ advanceGenerationEscrow: async () => ({ pending: false }) }));
vi.mock("@/lib/payments/rail", async (orig) => ({ ...(await orig<typeof import("@/lib/payments/rail")>()), paymentRail: async () => "escrow", escrowDeployed: async () => false }));

import { resolveModel, resolveModelByFamily } from "../models";
import { POST as generateFree } from "../../../app/api/generate-free/route";
import { POST as generateImage } from "../../../app/api/generate-image/route";
import { GET as x402Get, POST as x402Post } from "../../../app/api/x402/generate/route";

const hosts: string[] = [];
beforeEach(() => {
  hosts.length = 0; s.claimed = 0; s.role = "admin";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const host = new URL(typeof input === "object" && "url" in input ? input.url : String(input)).host;
    if (host === "challenges.cloudflare.com") return Response.json({ success: true });
    hosts.push(host);
    return new Response("no", { status: 500 });
  });
  for (const key of ["GEMINI_API_KEY", "WAVESPEED_API_KEY", "OPENAI_API_KEY", "TURNSTILE_SECRET_KEY"]) vi.stubEnv(key, "test");
  vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
  vi.stubEnv("SOLANA_PLATFORM_WALLET", "P1atformWa11et111111111111111111111111111111");
  vi.stubEnv("SOLANA_FEE_PAYER_SECRET_KEY", JSON.stringify(Array.from(Keypair.generate().secretKey)));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const free = (modelId: string) => generateFree(new NextRequest("http://enki.test/api/generate-free", {
  method: "POST", headers: { "content-type": "application/json", "X-Session-Token": "t", "x-real-ip": "1.2.3.4" },
  body: JSON.stringify({ prompt: "a cat", modelId, turnstileToken: "token" }),
}));
const paid = (model_id: string, model_family: string) => {
  s.row = { model_id, model_family };
  return generateImage(new NextRequest("http://enki.test/api/generate-image", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": "t" },
    body: JSON.stringify({ intentId: "55555555-5555-4555-8555-555555555555", unitIndex: 0, prompt: "A blue bird", aspectRatio: "1:1" }),
  }));
};

describe("the two resolvers", () => {
  it("answer an image row and refuse a video row, though it has a provider row and is active", async () => {
    const supabase = db as never;
    expect((await resolveModel(supabase, [IMAGE]))?.name).toBe("Nano Banana Pro");
    expect(await resolveModel(supabase, [VIDEO])).toBeNull();
    expect((await resolveModelByFamily(supabase, "nano-banana-pro"))?.name).toBe("Nano Banana Pro");
    expect(await resolveModelByFamily(supabase, "seedance-2-5")).toBeNull();
  });
});

describe("/api/generate-free", () => {
  it("refuses a video id before any host; a free image id reaches the recorder", async () => {
    expect((await free(VIDEO)).status).toBe(422);
    expect(hosts).toEqual([]);
    await free(FREE);
    expect(hosts.length).toBeGreaterThan(0);
  });
});

describe("/api/generate-image", () => {
  it("refuses an order for a video row before the claim and any host; an image row's order reaches the recorder", async () => {
    const res = await paid(VIDEO, "seedance-2-5");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("This paid model is unavailable right now.");
    expect([s.claimed, hosts]).toEqual([0, []]);
    await paid(IMAGE, "nano-banana-pro");
    expect(s.claimed).toBe(1);
    expect(hosts.length).toBeGreaterThan(0);
  });
});

describe("/api/x402/generate", () => {
  const ask = (family: string) => `https://www.enki.gallery/api/x402/generate?modelFamily=${family}&resolution=2K`;
  it("asks no payment for a video family, and does for an image family", async () => {
    for (const answer of [await x402Get(new NextRequest(ask("seedance-2-5"))), await x402Post(new NextRequest(ask("seedance-2-5"), { method: "POST" }))]) {
      expect(answer.status).toBe(422);
      expect(answer.headers.get("PAYMENT-REQUIRED")).toBeNull();
    }
    expect((await x402Get(new NextRequest(ask("nano-banana-pro")))).status).toBe(402);
    expect(hosts).toEqual([]);
  });
});
