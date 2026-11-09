import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { Connection } from "@solana/web3.js";
import { resetKeyringCache } from "@/lib/crypto";
import { paidUnit, setOperator, videoDb, WALLET, type VideoDb } from "@/lib/video/__tests__/_video-db";

/**
 * /authorize for a video's row, on PGlite with the real routes: one unit always, its operator's row asked in place of an image's
 * route, and the escrow switch never takes it. The chain is stubbed, and the batch's refusal is the proof it got past the gates: a
 * later hand-out is the image's own code, tested in intent-checkout.test.ts. Blind spot: no real nonce, no real wallet.
 */
const a = vi.hoisted(() => ({ opened: 0, renderable: 0, rail: "intent" }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/generation/renderable", () => ({ renderableRoute: async () => { a.renderable++; return { provider: "gemini" }; } }));
vi.mock("@/lib/payments/rail", async (original) => ({ ...(await original<typeof import("@/lib/payments/rail")>()), paymentRail: async () => a.rail }));
vi.mock("@/lib/payments/solana-transfer", () => ({ findMissingAtas: async () => [] }));
vi.mock("@/lib/payments/authorize-flow", async (original) => ({
  ...(await original<typeof import("@/lib/payments/authorize-flow")>()),
  capturePause: async () => ({ paused: false }),
  droppedPause: async () => ({ paused: false }),
  buyerWallet: async () => "BuyerWa11et",
  buyerCovers: async () => ({ ok: true, wallet: "BuyerWa11et" }),
  planFor: async () => ({ cuPriceMicroLamports: 1, artistWithheld: false }),
  enkiWallet: () => "Enki",
  openIntentBatch: async () => { a.opened++; return { ok: false, refusal: "not_open" }; },
}));
import { authorizeIntent, railFor } from "@/lib/payments/intent-checkout";
import { VIDEO_MODELS } from "@/lib/video/models";

const CONNECTION = {} as Connection;

describe("a video's row at /authorize", () => {
  let v: VideoDb;
  const quoted = async (over: { family?: string; resolution?: string } = {}) => {
    const unit = await paidUnit(v.db);
    await v.db.query("update public.generation_payment_intents set status = 'quoted', authorized_at = null, batch_intent_id = null, unit_index = null, nonce_account = null, model_family = $2, resolution = $3 where id = $1",
      [unit, over.family ?? "Seedance 2.5", over.resolution ?? "480p"]);
    return unit;
  };
  const authorize = (intentId: string, units = 1) => authorizeIntent(v.client, CONNECTION, { intentId, owner: WALLET, units });

  beforeAll(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    resetKeyringCache();
    v = await videoDb();
    await v.db.exec("create table public.generation_escrow_deposits (intent_id uuid); create table public.generation_escrow_recovery (intent_id uuid);");
  }, 60_000);
  afterAll(async () => { await v.close(); });
  beforeEach(() => {
    Object.assign(a, { opened: 0, renderable: 0, rail: "intent" });
    vi.stubEnv("ARK_API_KEY", "stub");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("no operator: not available, nothing opened, and no image route asked", async () => {
    await expect(authorize(await quoted())).rejects.toMatchObject({ status: 503, message: "Not available yet. Nothing was charged." });
    expect([a.opened, a.renderable]).toEqual([0, 0]);
  });

  describe("with its operator", () => {
    beforeAll(() => setOperator(v.db, "Seedance 2.5", "byteplus"));

    it("past the gate to the batch, without an image route", async () => {
      await expect(authorize(await quoted())).rejects.toMatchObject({ status: 409 });
      expect([a.opened, a.renderable]).toEqual([1, 0]);
    });

    it("no key: not available", async () => {
      vi.stubEnv("ARK_API_KEY", "");
      await expect(authorize(await quoted())).rejects.toMatchObject({ status: 503 });
      expect(a.opened).toBe(0);
    });

    it("a resolution it has no rate for: not available", async () => {
      await v.db.exec(`update public.video_routes set cost = '{"720p": 1}' where model_id = (select id from public.models where name = 'Seedance 2.0')`);
      await setOperator(v.db, "Seedance 2.0", "byteplus");
      await expect(authorize(await quoted({ family: "Seedance 2.0", resolution: "480p" }))).rejects.toMatchObject({ status: 503 });
      await expect(authorize(await quoted({ family: "Seedance 2.0", resolution: "720p" }))).rejects.toMatchObject({ status: 409 });
    });

    it.each([2, 3, 24])("%i units are refused, for any prompt, before anything opens", async (units) => {
      await expect(authorize(await quoted(), units)).rejects.toMatchObject({ status: 422, message: "One press makes one video. Nothing was charged." });
      expect(a.opened).toBe(0);
    });
  });

  it("an image's row keeps its image route and takes more than one unit", async () => {
    const unit = await quoted({ family: "nano-banana-pro", resolution: "2K" });
    await expect(authorize(unit, 3)).rejects.toMatchObject({ status: 409 });
    expect([a.opened, a.renderable]).toEqual([1, 1]);
  });

  it("every capability row is known as a video", async () => {
    for (const m of VIDEO_MODELS) await expect(authorize(await quoted({ family: m.label }), 2)).rejects.toMatchObject({ status: 422 });
  });

  describe("the rail", () => {
    it("a video's fresh quote stays on the intent rail when escrow is switched on; an image's follows the switch", async () => {
      a.rail = "escrow";
      expect(await railFor(v.client, await quoted(), WALLET)).toBe("intent");
      expect(await railFor(v.client, await quoted({ family: "nano-banana-pro", resolution: "2K" }), WALLET)).toBe("escrow");
    });
  });
});
