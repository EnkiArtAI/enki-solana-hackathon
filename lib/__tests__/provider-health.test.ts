import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[], fail: false, refuses: "" }));
vi.mock("@/lib/mailer", () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    if (mail.fail || m.to === mail.refuses) return { ok: false, error: "send failed" }; // As the real one: it answers and never throws.
    mail.sent.push(m);
    return { ok: true };
  },
}));

import {
  classifyFailure,
  breakerVerdict,
  shouldOpen,
  probeFor,
  reportFailure,
  reportSuccess,
  runProbe,
  FAILURE_THRESHOLD,
  PROBE_COOLDOWN_MS,
} from "@/lib/generation/provider-health";

/**
 * The breaker decides where a paying customer's generation goes. Both ways of
 * being wrong cost real money: opening on the wrong signal sends everyone to
 * the dearer route, and not opening keeps feeding buyers into a dead host.
 */

describe("what must never open the breaker", () => {
  it("does not blame the provider for a refused prompt", () => {
    for (const msg of [
      "Your request was rejected as a result of our safety system",
      "content_policy_violation",
      "The prompt was blocked by the moderation filter",
      "This request produces prohibited content",
      // Gemini's own words for a refused prompt (backend/services/gemini-image-generation.ts; round 5, 2026-10-20).
      "No images generated. The request may have been blocked by safety filters.",
      "Image generation blocked by safety filters. Please modify your prompt.",
    ]) {
      expect(classifyFailure(msg).kind, msg).toBe("content");
      expect(shouldOpen(classifyFailure(msg), 99), msg).toBe(false);
    }
  });

  it("does not blame the provider for a request we built wrong", () => {
    for (const msg of [
      "size must be a multiple of 16",
      "Invalid value for parameter 'quality'",
      "aspect_ratio is not a valid ratio",
      "image too large",
      // Gemini's own check, which an artist's long prompt reaches (round 6, 2026-10-20).
      "Prompt is too long (max 5000 characters)",
    ]) {
      expect(classifyFailure(msg).kind, msg).toBe("request");
      expect(shouldOpen(classifyFailure(msg), 99), msg).toBe(false);
    }
  });

  it("does not blame the provider for a key this deployment does not have (ENV-01)", () => {
    // The breaker state lives in a database other deployments share: a
    // developer environment without the key must not take production down.
    for (const msg of ["OPENAI_API_KEY is not set", "WAVESPEED_API_KEY is not set", "GEMINI_API_KEY is not set"]) {
      expect(classifyFailure(msg).kind, msg).toBe("config");
      expect(shouldOpen(classifyFailure(msg), 99), msg).toBe(false);
    }
    // ...while a provider that refuses our key still counts.
    expect(classifyFailure("invalid api key").kind).toBe("infrastructure");
    expect(classifyFailure("the setting is not settled").kind).not.toBe("config");
  });

  it("still reads a quota or a rate limit beside a safety word as the account's", () => {
    for (const msg of ["safety system: rate limit reached", "moderation quota exceeded", "blocked: insufficient credits", "safety check failed, balance too low"]) {
      expect(classifyFailure(msg).kind, msg).not.toBe("content");
    }
  });

  it("keeps counting content refusals harmless however many arrive", () => {
    // A user hammering a banned prompt must not take the model offline.
    expect(shouldOpen(classifyFailure("safety system rejected"), 1000)).toBe(false);
  });
});

describe("failures that are about the account, not the model", () => {
  it("treats money and credentials as provider-wide and immediate", () => {
    for (const msg of [
      "WaveSpeed account is out of credits",
      "Insufficient credits",
      "quota exceeded for this month",
      "invalid api key",
      "Unauthorized",
      "authentication failed",
      "getaddrinfo ENOTFOUND api.example.com",
    ]) {
      const c = classifyFailure(msg);
      expect(c.kind, msg).toBe("infrastructure");
      expect(c.scope, msg).toBe("provider");
      // No threshold: a revoked key does not recover on the second attempt.
      expect(shouldOpen(c, 0), msg).toBe(true);
    }
  });

  it("reads 'invalid api key' as a credential, not as a bad parameter", () => {
    // Both the credential rule and the generic "invalid" rule match this
    // string; only one of the two readings is useful, and order decides it.
    const c = classifyFailure("invalid api key provided");
    expect(c.kind).toBe("infrastructure");
    expect(c.scope).toBe("provider");
  });

  it("classifies by status code when the message says nothing", () => {
    expect(classifyFailure("", 401).scope).toBe("provider");
    expect(classifyFailure("", 402).scope).toBe("provider");
    expect(classifyFailure("", 429).scope).toBe("provider");
    expect(classifyFailure("", 503)).toEqual({ kind: "infrastructure", scope: "route" });
    expect(classifyFailure("", 400).kind).toBe("request");
  });
});

describe("failures that are about this route only", () => {
  it("needs three strikes before giving up on a model", () => {
    const c = classifyFailure("upstream timed out");
    expect(c).toEqual({ kind: "infrastructure", scope: "route" });
    // Literal counts, not FAILURE_THRESHOLD arithmetic: a loop bounded by the
    // constant passes for any value of it, including 1, which would send
    // everyone to the dearer route on a single hiccup.
    expect(shouldOpen(c, 0)).toBe(false);
    expect(shouldOpen(c, 1)).toBe(false);
    expect(shouldOpen(c, 2)).toBe(true);
    expect(FAILURE_THRESHOLD).toBe(3);
  });

  it("fails closed on an error nobody anticipated", () => {
    // Unknown text must not read as healthy — one fallback generation is
    // cheaper than a queue of customers hitting a hole.
    const c = classifyFailure("¡qué pasa!");
    expect(c.kind).toBe("infrastructure");
    expect(c.scope).toBe("route");
  });
});

describe("when the breaker lets traffic through", () => {
  const now = 1_800_000_000_000;

  it("uses a route it has never heard of", () => {
    expect(breakerVerdict(null, now)).toBe("use");
  });

  it("uses a healthy route without probing", () => {
    expect(breakerVerdict({ status: "healthy", last_probe_at: null }, now)).toBe("use");
  });

  it("skips a route that was just probed and found dead", () => {
    const justNow = new Date(now - 1000).toISOString();
    expect(breakerVerdict({ status: "down", last_probe_at: justNow }, now)).toBe("skip");
  });

  it("re-probes once the cooldown has passed", () => {
    const old = new Date(now - PROBE_COOLDOWN_MS - 1).toISOString();
    expect(breakerVerdict({ status: "down", last_probe_at: old }, now)).toBe("probe");
  });

  it("probes a route marked down that has never been probed", () => {
    expect(breakerVerdict({ status: "down", last_probe_at: null }, now)).toBe("probe");
  });

  it("waits the FULL cooldown, so a dead host is not hammered", () => {
    const almost = new Date(now - PROBE_COOLDOWN_MS + 1).toISOString();
    expect(breakerVerdict({ status: "down", last_probe_at: almost }, now)).toBe("skip");
  });
});

describe("the liveness probe", () => {
  it("exists for acedata and not for providers without a free check", () => {
    expect(probeFor("acedata")).toBeTypeOf("function");
    expect(probeFor("wavespeed")).toBeNull();
    expect(probeFor("nonsense")).toBeNull();
  });

  it("asks the path the route actually uses, and never sends a prompt", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return {
        status: 402,
        json: async () => ({
          accepts: [{ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", maxAmountRequired: "49054" }],
        }),
      };
    }) as unknown as typeof fetch;

    try {
      const probe = probeFor("acedata")!;
      const nano = await probe("nano-banana-pro:official");
      const gpt = await probe("gpt-image-2");

      expect(calls[0].url).toContain("/nano-banana/images");
      expect(calls[1].url).toContain("/openai/images/generations");
      // A probe that carried a prompt could generate — and cost money.
      expect(calls.every((c) => !("prompt" in (c.body as object)))).toBe(true);
      expect(nano).toEqual({ alive: true, quotedMicro: 49054 });
      expect(gpt.alive).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports dead when the gateway does not answer with a quote", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({ status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    try {
      expect(await probeFor("acedata")!("gpt-image-2")).toEqual({ alive: false });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("insists on 402 — a 200 carrying a quote-shaped body is not liveness", async () => {
    // The body alone must not decide it. A cache, a proxy or an error page can
    // return 200 with anything in it; only 402 means "I am here and this is
    // the price".
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 200,
      json: async () => ({
        accepts: [{ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", maxAmountRequired: "49054" }],
      }),
    })) as unknown as typeof fetch;
    try {
      expect(await probeFor("acedata")!("gpt-image-2")).toEqual({ alive: false });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports dead when the quote carries no Solana leg we can pay", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 402,
      json: async () => ({ accepts: [{ network: "eip155:8453", maxAmountRequired: "49054" }] }),
    })) as unknown as typeof fetch;
    try {
      expect(await probeFor("acedata")!("gpt-image-2")).toEqual({ alive: false });
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * The mail when a breaker opens, on the real table. Blind spot: PGlite is one session, so parallel calls run one after
 * the other and row locks are never contended: "one winner" rests on the statement's shape (update ... where status <>
 * 'down') and READ COMMITTED's re-read, not on a run against contending connections.
 */
describe("the mail when a breaker opens", () => {
  const P = "00000000-0000-4000-8000-0000000000aa";
  const OTHER = "00000000-0000-4000-8000-0000000000bb";
  const A = "00000000-0000-4000-8000-000000000001";
  const B = "00000000-0000-4000-8000-000000000002";
  const C = "00000000-0000-4000-8000-000000000003";
  const SOON = "upstream timed out"; // route scope: counts to three
  const NOW = "Insufficient credits"; // provider scope: opens at once
  const START = Date.parse("2026-11-04T12:00:00Z");
  const MIN = 60_000;
  let db: PGlite;
  let client: SupabaseClient;
  const at = (ms: number) => vi.setSystemTime(START + ms);
  const row = async (id: string) => (await db.query<{ status: string; opened_at: Date | null }>(`select status, opened_at from model_provider_health where model_provider_id = $1`, [id])).rows[0];

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role' $$;
      CREATE TABLE providers (id uuid PRIMARY KEY);
      CREATE TABLE model_providers (id uuid PRIMARY KEY);
      INSERT INTO providers VALUES ('${P}'), ('${OTHER}');
      INSERT INTO model_providers VALUES ('${A}'), ('${B}'), ('${C}');
    `);
    await db.exec(readFileSync(join(__dirname, "..", "..", "migrations", "2026-08-07-provider-health.sql"), "utf8"));
    client = pglitePostgrest(db).client as unknown as SupabaseClient;
  }, 60_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.exec(`DELETE FROM model_provider_health`);
    mail.sent.length = 0;
    mail.fail = false;
    mail.refuses = "";
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    vi.stubEnv("OPS_ALERT_EMAILS", "ops@enki.test, kev@enki.test");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("a route: the third failure mails every recipient once, a fourth nobody", async () => {
    await reportFailure(client, A, P, SOON);
    await reportFailure(client, A, P, SOON);
    expect(mail.sent).toEqual([]);
    expect(await reportFailure(client, A, P, SOON)).toEqual({ opened: "route" });
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([["ops@enki.test", "Enki: a provider breaker opened"], ["kev@enki.test", "Enki: a provider breaker opened"]]);
    expect(mail.sent[0].text).toContain(`Provider ${P}, route ${A}, at 2026-11-04T12:00:00.000Z`);
    expect(await reportFailure(client, A, P, SOON)).toEqual({ opened: "route" });
    expect(mail.sent).toHaveLength(2);
    expect((await row(A)).status).toBe("down");
  });

  it("a provider: the first failure mails once, says all routes, and a route it never saw gets its row", async () => {
    expect(await reportFailure(client, B, P, NOW)).toEqual({ opened: "provider" });
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[0].text).toContain(`Provider ${P}, all routes, at`);
    expect((await row(B)).status).toBe("down");
  });

  it("two parallel failures of one provider mail once", async () => {
    await db.exec(`INSERT INTO model_provider_health (model_provider_id, provider_id) VALUES ('${A}', '${P}'), ('${B}', '${P}')`);
    await Promise.all([reportFailure(client, A, P, NOW), reportFailure(client, B, P, NOW)]);
    expect(mail.sent).toHaveLength(2);
  });

  it("another provider's breaker is its own: its rows stay healthy and its first failure still mails", async () => {
    await db.exec(`INSERT INTO model_provider_health (model_provider_id, provider_id) VALUES ('${B}', '${OTHER}')`);
    await reportFailure(client, A, P, NOW);
    expect((await row(B)).status).toBe("healthy");
    await reportFailure(client, B, OTHER, NOW);
    expect(mail.sent.map((m) => m.text.split(",")[0])).toEqual([`Provider ${P}`, `Provider ${P}`, `Provider ${OTHER}`, `Provider ${OTHER}`]);
  });

  it("a refused prompt and our own bad request mail nobody", async () => {
    for (let i = 0; i < 4; i++) {
      await reportFailure(client, A, P, "blocked by safety filters");
      await reportFailure(client, A, P, "size must be a multiple of 16");
    }
    expect(mail.sent).toEqual([]);
  });

  it("a flap: reopening within the hour mails nobody, and past the first opening's hour it mails again though it never stopped", async () => {
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(2);
    at(30 * MIN);
    await reportSuccess(client, A, P);
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(2);
    at(59 * MIN);
    await reportSuccess(client, A, P);
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(2);
    at(60 * MIN);
    await reportSuccess(client, A, P);
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(4);
  });

  it("an outage that never closes mails once, however long it lasts", async () => {
    await reportFailure(client, A, P, NOW);
    at(120 * MIN);
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(2);
    expect((await row(A)).status).toBe("down");
  });

  it("a route reopened by the threshold keeps to the same hour", async () => {
    for (let i = 0; i < 3; i++) await reportFailure(client, A, P, SOON);
    expect(mail.sent).toHaveLength(2);
    at(30 * MIN);
    await reportSuccess(client, A, P);
    for (let i = 0; i < 3; i++) await reportFailure(client, A, P, SOON);
    expect(mail.sent).toHaveLength(2);
    at(61 * MIN);
    await reportSuccess(client, A, P);
    for (let i = 0; i < 3; i++) await reportFailure(client, A, P, SOON);
    expect(mail.sent).toHaveLength(4);
  });

  it("a probe that closes the breaker keeps the hour too", async () => {
    await reportFailure(client, A, P, NOW);
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 402, json: async () => ({ accepts: [{ network: "solana:x", maxAmountRequired: "1" }] }) })));
    expect(await runProbe(client, A, P, "acedata", "gpt-image-2")).toBe(true);
    vi.unstubAllGlobals();
    expect((await row(A)).status).toBe("healthy");
    expect((await row(A)).opened_at).not.toBeNull();
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(2);
  });

  it("the provider's error text stays out of the mail", async () => {
    const said = "invalid api key sk-test-SECRETSHAPED1234567890";
    await reportFailure(client, A, P, said);
    expect(mail.sent).toHaveLength(2);
    expect(JSON.stringify(mail.sent)).not.toContain("SECRETSHAPED");
    expect(JSON.stringify(mail.sent)).not.toContain("invalid api key");
  });

  it("the provider's error text stays out of the logs too, at both scopes", async () => {
    const said = "invalid api key sk-test-SECRETSHAPED1234567890";
    await reportFailure(client, A, P, said);
    for (let i = 0; i < 3; i++) await reportFailure(client, B, OTHER, "upstream timed out SECRETSHAPED");
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("breaker OPEN for ALL routes");
    expect(logged).toContain(`breaker OPEN for route ${B}`);
    expect(logged).not.toContain("SECRETSHAPED");
  });

  it("a mail nobody got fails nothing, says so, gives the hour back, and the next failure tells", async () => {
    mail.fail = true;
    expect(await reportFailure(client, A, P, NOW)).toEqual({ opened: "provider" });
    expect((await row(A)).status).toBe("down");
    expect(mail.sent).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith("[provider-health] breaker mail not sent");
    expect((await row(A)).opened_at).toBeNull();
    mail.fail = false;
    at(MIN);
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(2);
  });

  it("a route's mail nobody got gives only that route's hour back", async () => {
    await reportFailure(client, B, P, NOW);
    expect(mail.sent).toHaveLength(2);
    at(61 * MIN);
    await reportSuccess(client, B, P);
    mail.fail = true;
    for (let i = 0; i < 3; i++) await reportFailure(client, A, P, SOON);
    expect((await row(A)).opened_at).toBeNull();
    expect((await row(B)).opened_at).not.toBeNull();
  });

  it("one recipient reached is a mail sent: the hour stands", async () => {
    mail.refuses = "kev@enki.test";
    await reportFailure(client, A, P, NOW);
    expect((await row(A)).opened_at).not.toBeNull();
    at(MIN);
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(1);
  });

  it("a key that dies inside a blip's hour is told by its first failure past that hour, once", async () => {
    for (let i = 0; i < 3; i++) await reportFailure(client, A, P, SOON);
    expect(mail.sent).toHaveLength(2);
    at(5 * MIN);
    await reportSuccess(client, A, P);
    at(10 * MIN);
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(2);
    at(120 * MIN);
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(4);
    expect(mail.sent[2].text).toContain("all routes");
    for (const hours of [5, 24, 72]) {
      at(hours * 60 * MIN);
      await reportFailure(client, A, P, NOW);
    }
    expect(mail.sent).toHaveLength(4);
  });

  it("a route not told yet inside another route's hour waits, and past it tells while it still fails", async () => {
    for (let i = 0; i < 3; i++) await reportFailure(client, A, P, SOON);
    expect(mail.sent).toHaveLength(2);
    at(10 * MIN);
    for (let i = 0; i < 3; i++) await reportFailure(client, B, P, SOON);
    expect(mail.sent).toHaveLength(2);
    at(61 * MIN);
    await reportFailure(client, B, P, SOON);
    expect(mail.sent).toHaveLength(4);
    expect(mail.sent[2].text).toContain(`route ${B}`);
  });

  it("two routes of one provider flapping all day mail once an hour between them, not once each", async () => {
    for (let hour = 0; hour < 24; hour++) {
      at(hour * 60 * MIN);
      for (const route of [A, B]) {
        await reportSuccess(client, route, P);
        for (let i = 0; i < 3; i++) await reportFailure(client, route, P, SOON);
      }
    }
    expect(mail.sent).toHaveLength(24 * 2);
  });

  it("a provider's failure on a route with a told sibling still tells when the hour has passed and a row is new", async () => {
    await reportFailure(client, A, P, NOW);
    at(61 * MIN);
    await reportFailure(client, B, P, NOW);
    expect(mail.sent).toHaveLength(4);
  });

  it("no recipients: nothing thrown, the breaker open, nothing to retry so the hour stands", async () => {
    vi.stubEnv("OPS_ALERT_EMAILS", "");
    expect(await reportFailure(client, A, P, NOW)).toEqual({ opened: "provider" });
    expect(mail.sent).toEqual([]);
    expect((await row(A)).status).toBe("down");
    expect((await row(A)).opened_at).not.toBeNull();
  });

  it("an open route's mail marks that route, not a sibling not yet told: a later failure of it stays silent", async () => {
    await reportFailure(client, B, P, SOON);
    for (let i = 0; i < 3; i++) await reportFailure(client, A, P, SOON);
    expect(mail.sent).toHaveLength(2);
    expect((await row(A)).opened_at).not.toBeNull();
    expect((await row(B)).opened_at).toBeNull();
  });

  it("an account-wide mail marks every route, so one outage is one mail across them", async () => {
    await reportFailure(client, B, P, SOON);
    await reportFailure(client, C, P, SOON);
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(2);
    at(120 * MIN);
    await reportFailure(client, A, P, NOW);
    expect(mail.sent).toHaveLength(2);
  });
});
