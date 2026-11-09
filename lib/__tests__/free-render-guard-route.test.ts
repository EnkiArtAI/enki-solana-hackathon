import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The bot guard on /api/generate-free (Kev, 2026-10-30: "only humans are allowed to have 1 for free"): session, then the
 * token, then the daily caps, all before any model call and before the account's claim, so a refused try costs nothing
 * and uses no free image; every answer but a delivered image gives the day's place back. The route, free-quota,
 * free-render-caps and turnstile are real; the database double, Cloudflare and everything that would spend are stubs.
 * SQL 63 itself: free-render-caps.test.ts. Blind spot: no real Turnstile token and no real siteverify answer.
 */
const CAPS_CLAIM = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ACCOUNT_CLAIM = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const USER = "cccccccc-1111-4111-8111-cccccccccccc";

const s = vi.hoisted(() => ({
  log: [] as string[],
  deleted: [] as string[],
  mails: [] as { to: string }[],
  role: "admin",
  user: "" as string | null,
  stepUp: null as Response | null,
  caps: null as { data: unknown; error: unknown } | null,
  account: "" as string | null,
  verify: null as null | (() => Promise<Response>),
  firstScreen: null as unknown,
  check: { verdict: "clear" } as Record<string, unknown>,
  verdict: { allowed: true } as Record<string, unknown>,
  named: { paid: false, adult: false, creditId: null } as Record<string, unknown> | null,
  render: { success: true, imageBuffers: [Buffer.from("x")], generationTime: 1 } as Record<string, unknown> | Error,
  seen: { verdict: "clear" } as { verdict: string },
}));

const db = {
  rpc: async (fn: string) => {
    s.log.push(fn);
    if (fn === "claim_free_render") return s.caps!;
    if (fn === "claim_free_generation") return { data: s.account, error: null };
    if (fn === "free_generation_quota") return { data: [{ used: 2, limit: 2, remaining: 0, exhausted: true, resets_at: null }], error: null };
    throw new Error(`unscripted rpc ${fn}`);
  },
  from: (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: table === "users" ? { role: s.role } : null, error: null }),
      delete: () => ({ eq: async (_: string, id: string) => { s.deleted.push(`${table}:${id}`); return { error: null }; } }),
    };
    return q;
  },
};

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: () => undefined,
}));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db, getSupabaseServerClientSafe: () => db }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), checkRequestRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string }) => { s.mails.push(m); return { ok: true }; } }));
vi.mock("@/lib/webauthn", () => ({ requireActionStepUp: async () => { s.log.push("stepUp"); return s.stepUp; } }));
vi.mock("@/lib/session-user", () => ({ resolveOwnerIds: async () => [USER] }));
vi.mock("@/lib/adult-content", () => ({ ADULT_REFUSAL: { error: "18+" }, adultConfirmed: async () => true }));
vi.mock("@/lib/generation/free-render-prompt", () => ({ freeRenderPrompt: async () => s.named }));
vi.mock("@/lib/generation/models", () => ({
  resolveModel: async () => ({ id: "m", name: "Flux (free)", maxResolution: "1K", normal: { provider: "pollinations", providerModel: "flux" } }),
}));
vi.mock("@/lib/generation/record", () => ({
  imageIdWithin: async () => null,
  recordGeneration: async () => null,
  recordGenerationFailure: async () => undefined,
  resolveRecordingUserId: async () => { s.log.push("session"); return s.user; },
}));
vi.mock("@/lib/generation/derivative-store", () => ({
  storeDeadline: () => Date.now() + 100_000,
  storeGeneratedImage: async () => ({ imageUrl: "https://blob/image.png" }),
}));
vi.mock("@/lib/moderation", () => ({
  moderate: async () => { s.log.push("moderate"); return s.verdict; },
  screenFirst: () => s.firstScreen,
  CLIENT_BLOCK_MESSAGE: "Refused",
}));
vi.mock("@/lib/moderation-enforcement", () => ({ recordModerationEvent: async () => undefined }));
vi.mock("@/lib/moderation/prompt-check", () => ({
  NOT_CHECKED: { verdict: "clear" },
  checkPrompt: async () => { s.log.push("checkPrompt"); return s.check; },
}));
vi.mock("@/lib/moderation/warnings", () => ({ recordWarning: async () => ({}), warningMessage: () => "Warned" }));
vi.mock("@/lib/moderation/extraction-hits", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/extraction-hits")>()),
  silentFailure: async () => new Response(JSON.stringify({ error: "silent" }), { status: 500 }),
}));
vi.mock("@/lib/moderation/image-check-bytes", () => ({
  IMAGE_REFUSED: "refused", IMAGE_UNCHECKED: "unchecked",
  checkImageBytes: async () => s.seen,
  heldBack: (seen: { verdict: string }) => seen.verdict !== "clear",
}));
vi.mock("@/lib/moderation/image-case", () => ({ recordImageCase: async () => undefined }));
vi.mock("@/backend/services/gemini-image-generation", () => ({ readImageDimensions: () => ({ width: 1, height: 1, format: "png" }) }));
vi.mock("@/backend/services/pollinations-image-generation", () => ({
  generateImageWithPollinations: async () => {
    s.log.push("render");
    if (s.render instanceof Error) throw s.render;
    return s.render;
  },
}));

import { POST } from "../../app/api/generate-free/route";

const SPENDING = ["checkPrompt", "moderate", "claim_free_generation", "render"];
const passed = (over: object = { success: true }) => new Response(JSON.stringify(over), { status: 200 });

const post = (body: object = {}, headers: Record<string, string> = {}) => POST(new NextRequest("http://enki.test/api/generate-free", {
  method: "POST",
  headers: { "content-type": "application/json", "X-Session-Token": "t", "x-real-ip": "1.2.3.4", ...headers },
  body: JSON.stringify({ prompt: "a cat", modelId: "fee61592-88fc-4235-b060-2fc76b49bf89", turnstileToken: "token", ...body }),
}));
const answer = async (res: Response) => ({ status: res.status, error: (await res.json()).error });

beforeEach(() => {
  s.log = []; s.deleted = []; s.mails = [];
  s.role = "admin"; s.user = USER; s.stepUp = null;
  s.caps = { data: [{ claim_id: CAPS_CLAIM, refused: null, first_refusal: false }], error: null };
  s.account = ACCOUNT_CLAIM;
  s.verify = async () => passed();
  s.firstScreen = null; s.check = { verdict: "clear" }; s.verdict = { allowed: true };
  s.named = { paid: false, adult: false, creditId: null };
  s.render = { success: true, imageBuffers: [Buffer.from("x")], generationTime: 1 };
  s.seen = { verdict: "clear" };
  process.env.TURNSTILE_SECRET_KEY = "the-secret";
  process.env.OPS_ALERT_EMAILS = "ops@enki.test";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    s.log.push(String(url).includes("challenges.cloudflare.com") ? "siteverify" : `fetch ${url}`);
    return s.verify!();
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.OPS_ALERT_EMAILS;
});

describe("the order", () => {
  it("session, step-up, token, caps, then the checks, the account's claim and the render; delivered keeps both claims", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).imageUrl).toBe("https://blob/image.png");
    expect(s.log).toEqual(["session", "stepUp", "siteverify", "claim_free_render", "checkPrompt", "moderate", "claim_free_generation", "render"]);
    expect(s.deleted).toEqual([]);
  });

  it("a step-up it still wants does not use the token up", async () => {
    s.stepUp = new Response(JSON.stringify({ stepUp: true }), { status: 401 });
    expect((await post()).status).toBe(401);
    expect(s.log).toEqual(["session", "stepUp"]);
  });

  it("nobody past the admin gate reaches the token, the caps or a model", async () => {
    s.role = "user";
    expect((await post()).status).toBe(403);
    expect(s.log).toEqual(["session"]);
    s.log = [];
    s.user = null;
    expect((await post()).status).toBe(403);
    expect(s.log).toEqual(["session"]);
  });
});

describe("a refused token costs nothing", () => {
  it("none at all", async () => {
    expect(await answer(await post({ turnstileToken: undefined }))).toEqual({ status: 403, error: "The human check did not pass. Try again. Nothing was generated." });
    expect(s.log).toEqual(["session", "stepUp"]);
  });

  it("Cloudflare says no; a new token on the retry passes", async () => {
    s.verify = async () => passed({ success: false, "error-codes": ["timeout-or-duplicate"] });
    expect(await answer(await post())).toEqual({ status: 403, error: "The human check did not pass. Try again. Nothing was generated." });
    expect(s.log).toEqual(["session", "stepUp", "siteverify"]);
    for (const step of SPENDING) expect(s.log).not.toContain(step);
    s.verify = async () => passed();
    expect((await post({ turnstileToken: "new" })).status).toBe(200);
  });
});

describe("on a production build no check means no free render, on a preview too", () => {
  beforeEach(() => { vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL_ENV", "preview"); });
  const PAUSED = { status: 503, error: "Free renders are paused right now. Nothing was generated." };

  it("the secret is missing: paused, and Cloudflare is not asked", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(await answer(await post())).toEqual(PAUSED);
    expect(s.log).toEqual(["session", "stepUp"]);
  });

  it("Cloudflare is not answering or fails: paused", async () => {
    for (const verify of [
      async () => { throw new TypeError("fetch failed"); },
      async () => new Response("bad gateway", { status: 502 }),
    ]) {
      s.log = [];
      s.verify = verify;
      expect(await answer(await post())).toEqual(PAUSED);
      expect(s.log).toEqual(["session", "stepUp", "siteverify"]);
    }
  });
});

describe("in next dev", () => {
  beforeEach(() => { vi.stubEnv("NODE_ENV", "development"); });

  it("no secret: the check is skipped and the render goes on", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    expect((await post({ turnstileToken: undefined })).status).toBe(200);
    expect(s.log).not.toContain("siteverify");
    expect(s.log).toContain("claim_free_render");
  });

  it("Cloudflare down: the same", async () => {
    s.verify = async () => { throw new TypeError("fetch failed"); };
    expect((await post()).status).toBe(200);
  });
});

describe("a full cap costs nothing", () => {
  const nothingSpent = () => {
    expect(s.log).toEqual(["session", "stepUp", "siteverify", "claim_free_render"]);
    expect(s.deleted).toEqual([]);
  };

  it("the day's: says so, and the first refusal sends the day's mail", async () => {
    s.caps = { data: [{ claim_id: null, refused: "day", first_refusal: true }], error: null };
    expect(await answer(await post())).toEqual({ status: 429, error: "Free renders are used up for today. Try again tomorrow or choose a paid model. Nothing was generated." });
    nothingSpent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.mails.map((m) => m.to)).toEqual(["ops@enki.test"]);
  });

  it("the day's, a later refusal: no second mail", async () => {
    s.caps = { data: [{ claim_id: null, refused: "day", first_refusal: false }], error: null };
    expect((await post()).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.mails).toEqual([]);
  });

  it("the address's: says so, no mail", async () => {
    s.caps = { data: [{ claim_id: null, refused: "ip", first_refusal: false }], error: null };
    expect(await answer(await post())).toEqual({ status: 429, error: "This network has had its free render today. Try again tomorrow or choose a paid model. Nothing was generated." });
    nothingSpent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.mails).toEqual([]);
  });

  it("the database cannot say: 503 or the failure answer, and nothing runs after it", async () => {
    s.caps = { data: null, error: { message: "TypeError: fetch failed" } };
    expect((await post()).status).toBe(503);
    nothingSpent();
    s.log = [];
    s.caps = { data: null, error: { code: "42501", message: "denied" } };
    expect((await post()).status).toBe(500);
    nothingSpent();
  });
});

describe("before SQL 63", () => {
  it("renders as today, on the account's own allowance, and gives nothing back", async () => {
    s.caps = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    expect((await post()).status).toBe(200);
    expect(s.log).toContain("render");
    expect(s.log).toContain("claim_free_generation");
    s.render = { success: false, error: "down" };
    expect((await post()).status).toBe(500);
    expect(s.deleted).toEqual([`free_generation_claims:${ACCOUNT_CLAIM}`]);
  });
});

describe("every answer without an image gives the day's place back", () => {
  const CAPS = `free_render_claims:${CAPS_CLAIM}`;
  const ACCOUNT = `free_generation_claims:${ACCOUNT_CLAIM}`;

  it("a prompt the check refuses, before the account's claim", async () => {
    s.check = { verdict: "minor_sexual", confidence: 1 };
    expect((await post()).status).toBe(422);
    expect(s.deleted).toEqual([CAPS]);
    expect(s.log).not.toContain("claim_free_generation");
  });

  it("a prompt moderation refuses", async () => {
    s.verdict = { allowed: false };
    expect((await post()).status).toBe(422);
    expect(s.deleted).toEqual([CAPS]);
  });

  it("a paid prompt named, or one that cannot be read", async () => {
    s.named = { paid: true, adult: false, creditId: null };
    expect((await post()).status).toBe(402);
    expect(s.deleted).toEqual([CAPS]);
    s.deleted = [];
    s.named = null;
    expect((await post()).status).toBe(503);
    expect(s.deleted).toEqual([CAPS]);
  });

  it("an account with both free images used", async () => {
    s.account = null;
    const res = await post();
    expect(res.status).toBe(402);
    expect((await res.json()).freeQuotaExhausted).toBe(true);
    expect(s.deleted).toEqual([CAPS]);
    expect(s.log).not.toContain("render");
  });

  it("a silent refusal: both claims", async () => {
    s.check = { verdict: "unavailable", reason: "down" };
    expect((await post()).status).toBe(500);
    expect(s.log).not.toContain("render");
    expect(s.deleted.sort()).toEqual([ACCOUNT, CAPS].sort());
  });

  it("a failed render, an image held back, a thrown error: both claims", async () => {
    s.render = { success: false, error: "down" };
    expect((await post()).status).toBe(500);
    expect(s.deleted.sort()).toEqual([ACCOUNT, CAPS].sort());

    s.deleted = [];
    s.render = { success: true, imageBuffers: [Buffer.from("x")], generationTime: 1 };
    s.seen = { verdict: "unavailable" };
    expect((await post()).status).toBe(503);
    expect(s.deleted.sort()).toEqual([ACCOUNT, CAPS].sort());

    s.deleted = [];
    s.render = new Error("boom");
    expect((await post()).status).toBe(500);
    expect(s.deleted.sort()).toEqual([ACCOUNT, CAPS].sort());
  });
});
