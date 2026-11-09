import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The render switch's server side (Kev, 2026-10-17). A paid render is asked at
 * POST /api/payments/generation/intent, before anything is priced, built or
 * signed; a free one at the top of POST /api/generate-free, before anything
 * is checked or claimed. Factors key on the stable users.id, so the intent
 * route maps the session's wallet to it first. The real gate and real tokens
 * run; the database is in memory.
 */

const db = vi.hoisted(() => ({ wallets: [] as { address: string; user_id: string }[], users: [] as Record<string, unknown>[], walletsFail: false as boolean | string }));
const factors = vi.hoisted(() => ({ list: [] as string[], fail: null as Error | null }));
const priced = vi.hoisted(() => ({ calls: 0 }));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64"); });

const from = (table: string) => {
  const filters: ((r: Record<string, unknown>) => boolean)[] = [];
  const rows = () => (table === "user_wallets" ? db.wallets : table === "users" ? db.users : []) as Record<string, unknown>[];
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    ilike: (c: string, v: string) => { filters.push((r) => String(r[c]).toLowerCase() === v.toLowerCase()); return q; },
    is: () => q,
    maybeSingle: async () => (table === "user_wallets" && db.walletsFail
      ? { data: null, error: { code: "XX000", message: db.walletsFail === true ? "boom" : db.walletsFail } }
      : { data: rows().find((r) => filters.every((f) => f(r))) ?? null, error: null }),
  };
  return q;
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from }) }));
vi.mock("@/lib/mfa", () => ({ enrolledFactors: async () => { if (factors.fail) throw factors.fail; return factors.list; } }));
vi.mock("@/lib/auth", () => ({
  requireAuth: async () => ({ userId: WALLET }),
  authRefusal: () => new Response(null, { status: 401 }),
  checkRateLimit: () => true,
}));
vi.mock("@/lib/payments/generation-settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/generation-settings")>()),
  // Past the gate: the pricing would start here. Stops the request with a mark.
  resolvePaidSettings: async () => { priced.calls++; return { ok: false, status: 418, error: "priced" }; },
}));

const WALLET = "7Yk3r9dQmPvZx1aBcDeFgHiJkLmNoPqRsTuVwXyZ1234";
const USER = "0b5f2c1e-1111-4222-8333-444455556666";
import { POST } from "../../app/api/payments/generation/intent/route";
import { mintStepUpToken } from "../webauthn";

const intent = (stepUp?: string) => POST(new Request("http://enki.test/api/payments/generation/intent", {
  method: "POST", headers: { "content-type": "application/json", "X-Session-Token": "tok", ...(stepUp ? { "X-StepUp-Token": stepUp } : {}) },
  body: JSON.stringify({ modelId: "6f2a1c04-1111-4222-8333-444455556666", resolution: "1K" }),
}) as unknown as NextRequest);

beforeEach(() => {
  factors.list = ["passkey"];
  factors.fail = null;
  priced.calls = 0;
  db.wallets = [{ address: WALLET, user_id: USER }];
  db.users = [{ id: USER }];
  db.walletsFail = false;
});

describe("a paid render's intent", () => {
  it("is not asked while the account has rendering off (the default)", async () => {
    expect((await intent()).status).toBe(418);
    expect(priced.calls).toBe(1);
  });

  it("is asked before anything is priced once the account switched rendering on", async () => {
    db.users[0].stepup_actions = { render: true };
    const res = await intent();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ stepUp: true, scope: "render" });
    expect(priced.calls).toBe(0);
    // A token for another scope opens nothing; a render token for the wallet's account does.
    expect((await intent(await mintStepUpToken(USER, "add-prompt"))).status).toBe(401);
    expect((await intent(await mintStepUpToken(WALLET, "render"))).status).toBe(401);
    expect((await intent(await mintStepUpToken(USER, "render"))).status).toBe(418);
  });

  it("refuses a session that resolves to no account: nothing is priced, the switch cannot be walked around", async () => {
    db.wallets = [];
    db.users[0].stepup_actions = { render: true };
    const res = await intent();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(priced.calls).toBe(0);
  });

  it("an account that cannot be read is no pass: the request stops before anything is priced", async () => {
    db.walletsFail = true;
    db.users[0].stepup_actions = { render: true };
    await expect(intent()).rejects.toMatchObject({ code: "XX000" });
    expect(priced.calls).toBe(0);
  });

  it("a dead database answers the honest 503, nothing priced: the wallet read", async () => {
    db.walletsFail = "TypeError: fetch failed";
    const res = await intent();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "DB_UNAVAILABLE" });
    expect(priced.calls).toBe(0);
  });

  it("a factors read that fails behind the switch stops too: the gate's own 503, nothing priced", async () => {
    db.users[0].stepup_actions = { render: true };
    factors.fail = new Error("TypeError: fetch failed");
    const res = await intent();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Could not verify security settings" });
    expect(priced.calls).toBe(0);
  });
});

describe("a free render", () => {
  it("is asked at the top of its only request, before the prompt check and the daily claim", () => {
    const free = readSource(join(__dirname, "..", "..", "app", "api", "generate-free", "route.ts"));
    const gate = free.indexOf('const blocked = await requireActionStepUp(request, quotaUserId, "render", "render");');
    expect(gate).toBeGreaterThan(-1);
    expect(free.indexOf("const quotaUserId = await resolveRecordingUserId(supabaseForChecks, request);")).toBeLessThan(gate);
    expect(gate).toBeLessThan(free.indexOf("const first = screenFirst({ prompt });"));
    expect(gate).toBeLessThan(free.indexOf("freeGenerationDecision(supabaseForChecks, quotaUserId)"));
    expect(gate).toBeLessThan(free.indexOf("await generateImageWithPollinations("));
  });
});
