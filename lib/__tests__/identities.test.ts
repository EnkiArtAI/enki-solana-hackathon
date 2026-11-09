import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { fakeDb, type FakeDb } from "./_fake-supabase";
import { readSource } from "./_read-source";

/** Connected accounts in Settings: list the Google and X logins, disconnect one unless it is the last way in. */
// password-auth derives its decoy hash at import time, so the pepper must exist before the route loads.
const state = await vi.hoisted(async () => {
  const { randomBytes } = await import("node:crypto");
  process.env.AUTH_PEPPER = randomBytes(32).toString("base64");
  return { db: null as unknown as FakeDb };
});
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => state.db.client }));
import { GET as listIdentities } from "../../app/api/auth/identities/route";
import { DELETE as removeIdentity } from "../../app/api/auth/identities/[provider]/route";

const UUID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const session = { token: "tok", wallet_address: UUID, wallet_type: "password", expires_at: "2999-01-01T00:00:00.000Z" };
const google = { provider: "google", subject: "g1", user_id: UUID, email: "kev@example.com", email_verified: true, handle: null };
const x = { provider: "x", subject: "x1", user_id: UUID, email: null, email_verified: false, handle: "kirikev" };

const req = (path: string, init: { method?: string; body?: unknown } = {}) =>
  new NextRequest(`https://enki.test${path}`, {
    method: init.method ?? "GET",
    headers: { "X-Session-Token": "tok", "Content-Type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });

beforeEach(() => { state.db = fakeDb({ auth_sessions: [session] }); });

describe("GET /api/auth/identities", () => {
  it("lists providers with handles plus hasPassword and hasWallet", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [google, x], user_wallets: [{ user_id: UUID, address: "So1", removed_at: null }] });
    const body = await (await listIdentities(req("/api/auth/identities"))).json();
    expect(body).toMatchObject({ hasPassword: false, hasWallet: true });
    expect(body.identities.map((i: { provider: string; handle: string | null }) => [i.provider, i.handle])).toEqual([["google", null], ["x", "kirikev"]]);
  });

  it("401s without a session and still answers when auth_identities is missing", async () => {
    expect((await listIdentities(new NextRequest("https://enki.test/api/auth/identities"))).status).toBe(401);
    state.db = fakeDb({ auth_sessions: [session], password_credentials: [{ user_id: UUID, email: "k@e.c" }] }, { auth_identities: { message: "Could not find the table", code: "PGRST205" } });
    expect(await (await listIdentities(req("/api/auth/identities"))).json()).toMatchObject({ identities: [], hasPassword: true });
  });
});

describe("DELETE /api/auth/identities/[provider]", () => {
  it("refuses to remove the last way to sign in", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x] });
    const res = await removeIdentity(req("/api/auth/identities/x", { method: "DELETE" }), ctx("x"));
    expect(res.status).toBe(409);
    expect(state.db.tables.auth_identities).toHaveLength(1);
    // A wallet provisioned from a session cannot open one: it does not count.
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x], user_wallets: [{ user_id: UUID, address: "So1", removed_at: null }], users: [{ id: UUID, origin: "email" }] });
    expect((await removeIdentity(req("/api/auth/identities/x", { method: "DELETE" }), ctx("x"))).status).toBe(409);
  });

  it("counts the wallet of an account made by a wallet sign-in as a way in, while that wallet is there", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x], user_wallets: [{ user_id: UUID, address: "So1", removed_at: null }], users: [{ id: UUID, origin: "wallet" }] });
    expect((await removeIdentity(req("/api/auth/identities/x", { method: "DELETE" }), ctx("x"))).status).toBe(200);
    // an account made for an x402 payer's wallet signs in with it the same way
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x], user_wallets: [{ user_id: UUID, address: "So1", removed_at: null }], users: [{ id: UUID, origin: "agent" }] });
    expect((await removeIdentity(req("/api/auth/identities/x", { method: "DELETE" }), ctx("x"))).status).toBe(200);
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x], user_wallets: [{ user_id: UUID, address: "So1", removed_at: "2026-10-01T00:00:00Z" }], users: [{ id: UUID, origin: "wallet" }] });
    expect((await removeIdentity(req("/api/auth/identities/x", { method: "DELETE" }), ctx("x"))).status).toBe(409);
  });

  it("removes one when a password or another provider remains, and only the user's own", async () => {
    const someoneElse = { ...x, subject: "x2", user_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", handle: "other" };
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x, someoneElse], password_credentials: [{ user_id: UUID, email: "k@e.c" }] });
    expect((await removeIdentity(req("/api/auth/identities/x", { method: "DELETE" }), ctx("x"))).status).toBe(200);
    expect(state.db.tables.auth_identities).toEqual([someoneElse]);

    state.db = fakeDb({ auth_sessions: [session], auth_identities: [google, x] });
    expect((await removeIdentity(req("/api/auth/identities/google", { method: "DELETE" }), ctx("google"))).status).toBe(200);
    expect(state.db.tables.auth_identities).toEqual([expect.objectContaining({ provider: "x" })]);
  });

  it("two disconnects at once never leave an account without a way in", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [google, x] });
    const answers = await Promise.all([
      removeIdentity(req("/api/auth/identities/google", { method: "DELETE" }), ctx("google")),
      removeIdentity(req("/api/auth/identities/x", { method: "DELETE" }), ctx("x")),
    ]);
    expect(state.db.tables.auth_identities.length).toBeGreaterThanOrEqual(1);
    expect(answers.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(answers.every((r) => r.status === 200 || r.status === 409)).toBe(true);
  });

  it("never puts a disconnected identity back on an account deleted during the request", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [google, x], users: [{ id: UUID, deleted_at: "2026-10-17T12:00:00.000Z" }] });
    await Promise.all([
      removeIdentity(req("/api/auth/identities/google", { method: "DELETE" }), ctx("google")),
      removeIdentity(req("/api/auth/identities/x", { method: "DELETE" }), ctx("x")),
    ]);
    expect(state.db.tables.auth_identities).toEqual([]);
  });

  it("404s a provider that is not connected or not known", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x], password_credentials: [{ user_id: UUID, email: "k@e.c" }] });
    expect((await removeIdentity(req("/api/auth/identities/google", { method: "DELETE" }), ctx("google"))).status).toBe(404);
    expect((await removeIdentity(req("/api/auth/identities/facebook", { method: "DELETE" }), ctx("facebook"))).status).toBe(404);
  });
});

describe("the Settings tiles", () => {
  const view = readSource(join(__dirname, "..", "..", "components", "settings", "SettingsView.tsx"));
  // The reads and the calls live in Settings' account hooks (DEC-2026-11-08-41); the tiles stay in the view.
  const hook = readSource(join(__dirname, "..", "..", "components", "settings", "use-account.ts"));
  it("list the connected accounts, connect through the second factor and back to Settings, and disconnect by provider", () => {
    expect(hook).toContain('fetch("/api/auth/identities", { headers })');
    expect(hook).toMatch(/guarded\("add-factor", \(h\) =>\s+fetch\(`\/api\/auth\/oauth\/\$\{provider\}\/start\?next=\/settings`, \{ method: "POST"/);
    expect(hook).toContain('fetch(`/api/auth/identities/${provider}`, { method: "DELETE", headers: { ...sessionAuthHeaders(), ...h } })');
    expect(view).toContain('connect: () => connectAccount("google")');
    expect(view).toContain('connect: () => connectAccount("x")');
    expect(hook).toContain('fetch("/api/auth/oauth/providers")');
    expect(view).toContain('if (s.key !== "instagram" && !configured[s.key] && !linked) return null;');
  });
});
