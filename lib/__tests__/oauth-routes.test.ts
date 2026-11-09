import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb, type FakeDb } from "./_fake-supabase";
import { completeAuth, HANDOVER_COOKIE, sessionHash, signHandover, signState, STATE_COOKIE, type ProviderIdentity } from "@/lib/auth/oauth";

const state = vi.hoisted(() => ({ db: null as unknown as FakeDb, identity: null as unknown as ProviderIdentity }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => state.db.client }));
// A link's notice runs in after(), which needs a request scope; oauth-connect-notice.test.ts tests it.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));
// This file runs more callbacks than one IP may in ten minutes; the limits are not what it tests.
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  checkRequestRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
// The real session mint, wrapped so a test can run a reset just before it.
vi.mock("@/lib/user-session", async (orig) => {
  const real = await orig<typeof import("@/lib/user-session")>();
  return { ...real, mintUserSession: vi.fn(real.mintUserSession) };
});
vi.mock("@/lib/auth/oauth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth/oauth")>();
  return { ...actual, completeAuth: vi.fn(async () => state.identity) };
});

import { GET as callback } from "../../app/api/auth/oauth/[provider]/callback/route";
import { GET as start, POST as startLink } from "../../app/api/auth/oauth/[provider]/start/route";
import { POST as collect } from "../../app/api/auth/oauth/complete/route";
import { GET as providers } from "../../app/api/auth/oauth/providers/route";
import { proxy } from "../../proxy";
import { mintUserSession } from "@/lib/user-session";
import { readTrial } from "@/lib/trial-cookie";

const UUID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });

beforeAll(() => {
  process.env.AUTH_PEPPER = randomBytes(32).toString("base64");
  process.env.X_OAUTH_CLIENT_ID = "x-client";
  process.env.X_OAUTH_CLIENT_SECRET = "x-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://enki.test";
  process.env.TEAM_ACCESS_CODE = "team-code";
});
beforeEach(() => {
  state.db = fakeDb({ access_allowlist: [{ kind: "x", value: "x1" }] });
  state.identity = { provider: "x", subject: "x1", email: null, emailVerified: false, handle: "kirikev", displayName: "Kev", avatarUrl: null };
});
afterEach(() => vi.useRealTimers());

async function callbackWith(cookie: string | null, query: Record<string, string>) {
  const url = new URL("https://enki.test/api/auth/oauth/x/callback");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const req = new NextRequest(url, { headers: cookie ? { cookie: `${STATE_COOKIE}=${cookie}` } : {} });
  return callback(req, ctx("x"));
}
const fragment = (res: Response) => new URLSearchParams(new URL(res.headers.get("location")!).hash.slice(1));
const cookies = (res: Response) => res.headers.getSetCookie();
const setCookie = (res: Response, name: string) => cookies(res).find((c) => c.startsWith(`${name}=`));
/** The `name=value` pair a browser would send back from that Set-Cookie. */
const pair = (res: Response, name: string) => setCookie(res, name)!.split(";")[0];
const collectWith = (cookie: string | null) =>
  collect(new NextRequest("https://enki.test/api/auth/oauth/complete", { method: "POST", headers: cookie ? { cookie } : {} }));

describe("start", () => {
  it("302s to X with the state cookie set, httpOnly and scoped to the oauth routes", async () => {
    const res = await start(new NextRequest("https://enki.test/api/auth/oauth/x/start?next=/profile"), ctx("x"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/x\.com\/i\/oauth2\/authorize\?/);
    const c = cookies(res).find((c) => c.startsWith(`${STATE_COOKIE}=`))!;
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Path=\/api\/auth\/oauth/);
    expect(c).toMatch(/SameSite=lax/i);
  });

  it("404s an unknown provider and refuses a link without a session", async () => {
    const res = await start(new NextRequest("https://enki.test/api/auth/oauth/facebook/start"), ctx("facebook"));
    expect(res.status).toBe(404);
    const link = await startLink(new NextRequest("https://enki.test/api/auth/oauth/x/start", { method: "POST" }), ctx("x"));
    expect(link.status).toBe(401);
  });

  it("links only through the second factor, or without one on a login younger than ten minutes", async () => {
    const session = (minutesAgo: number) => ({
      token: "tok", wallet_address: UUID, wallet_type: "password",
      expires_at: "2999-01-01T00:00:00.000Z", created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    });
    const linkWith = () => startLink(new NextRequest("https://enki.test/api/auth/oauth/x/start?next=/settings", { method: "POST", headers: { "X-Session-Token": "tok" } }), ctx("x"));

    state.db = fakeDb({ auth_sessions: [session(1)] });
    const fresh = await linkWith();
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).url).toMatch(/^https:\/\/x\.com\/i\/oauth2\/authorize\?/);

    state.db = fakeDb({ auth_sessions: [session(11)] });
    const stale = await linkWith();
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ reauth: true });

    state.db = fakeDb({ auth_sessions: [session(1)], mfa_factors: [{ id: "f1", user_id: UUID, kind: "totp", confirmed_at: "2026-10-01T00:00:00.000Z" }] });
    const factor = await linkWith();
    expect(factor.status).not.toBe(200);
    expect(await factor.json()).not.toHaveProperty("url");
  });

  it("says which providers are configured, and a link to one that is not asks for no factor", async () => {
    expect(await (await providers()).json()).toEqual({ google: false, x: true }); // only the X pair is set here
    state.db = fakeDb({ auth_sessions: [{ token: "tok", wallet_address: UUID, wallet_type: "password", expires_at: "2999-01-01T00:00:00.000Z", created_at: new Date(Date.now() - 11 * 60_000).toISOString() }] });
    const res = await startLink(new NextRequest("https://enki.test/api/auth/oauth/google/start", { method: "POST", headers: { "X-Session-Token": "tok" } }), ctx("google"));
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty("reauth");
  });

  it("sends the visitor to the error page when the provider is not configured", async () => {
    const saved = process.env.X_OAUTH_CLIENT_SECRET;
    delete process.env.X_OAUTH_CLIENT_SECRET;
    const res = await start(new NextRequest("https://enki.test/api/auth/oauth/x/start"), ctx("x"));
    process.env.X_OAUTH_CLIENT_SECRET = saved;
    expect(res.status).toBe(302);
    expect(fragment(res).get("error")).toBe("not_configured");
  });
});

describe("callback", () => {
  const good = () => signState({ provider: "x", intent: { kind: "login" }, next: "/profile", state: "s1", nonce: "n1", verifier: "v1" });

  it("refuses a missing, tampered or foreign cookie and a wrong state, clearing the cookie each time", async () => {
    const cookie = await good();
    for (const [c, q] of [
      [null, { state: "s1", code: "c" }],
      [cookie.slice(0, -2) + "xx", { state: "s1", code: "c" }],
      [cookie, { state: "other", code: "c" }],
      [cookie, { code: "c" }],
      [await signState({ provider: "google", intent: { kind: "login" }, next: "/", state: "s1", nonce: "n1", verifier: "v1" }), { state: "s1", code: "c" }],
    ] as const) {
      const res = await callbackWith(c, q);
      expect(res.status).toBe(302);
      expect(fragment(res).get("error")).toBe("state_mismatch");
      expect(cookies(res).find((x) => x.startsWith(`${STATE_COOKIE}=`))).toMatch(/Max-Age=0/);
      expect(state.db.ops).not.toContain("auth_sessions.insert");
    }
  });

  it("mints a session and hands it over in a short lived httpOnly cookie, never the URL, with the gate cookie", async () => {
    const res = await callbackWith(await good(), { state: "s1", code: "c" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://enki.test/auth/complete");
    expect(loc.search).toBe("");
    expect(res.headers.get("location")).not.toContain(state.db.tables.auth_sessions[0].token);
    const f = fragment(res);
    expect(f.get("next")).toBe("/profile");
    expect(f.get("token")).toBeNull();
    expect(state.db.tables.auth_sessions[0]).toMatchObject({ wallet_type: "password", wallet_address: state.db.tables.users[0].id });
    // The member cookie, signed for the account until its session ends (DEC-434).
    const member = readTrial("member", /^enki_team=([^;]*)/.exec(setCookie(res, "enki_team") ?? "")?.[1], process.env.AUTH_PEPPER!);
    expect(member).toEqual({ subject: state.db.tables.users[0].id, expiresAtMs: Date.parse(String(state.db.tables.auth_sessions[0].expires_at)) });
    const handover = setCookie(res, HANDOVER_COOKIE)!;
    expect(handover).toMatch(/HttpOnly/i);
    expect(handover).toMatch(/SameSite=lax/i);
    expect(handover).toMatch(/Path=\/api\/auth\/oauth/);
    expect(handover).toMatch(/Max-Age=60(;|$)/);

    // the browser that holds the cookie collects the session once
    const got = await collectWith(pair(res, HANDOVER_COOKIE));
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ token: state.db.tables.auth_sessions[0].token, email: null, banned: false });
    expect(setCookie(got, HANDOVER_COOKIE)).toMatch(/Max-Age=0/);
  });

  it("the hand over needs the callback's cookie: none, tampered, a state cookie or an expired one gives 401 and no token", async () => {
    const valid = await signHandover({ token: "secret-session", email: null, banned: false });
    for (const c of [
      null,
      `${HANDOVER_COOKIE}=${valid.slice(0, -2)}xx`,
      `${HANDOVER_COOKIE}=${await good()}`,
      `${STATE_COOKIE}=${valid}`,
    ]) {
      const res = await collectWith(c);
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain("secret-session");
      expect(setCookie(res, HANDOVER_COOKIE)).toMatch(/Max-Age=0/);
    }
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T10:00:00Z"));
    const stale = await signHandover({ token: "secret-session", email: null, banned: false });
    vi.setSystemTime(new Date("2026-09-24T10:01:01Z"));
    expect((await collectWith(`${HANDOVER_COOKIE}=${stale}`)).status).toBe(401);
  });

  it("a banned user gets a session, banned in the hand over, and loses the gate cookie like at every other login; /banned stays open without it", async () => {
    state.db = fakeDb({
      access_allowlist: [{ kind: "x", value: "x1" }],
      auth_identities: [{ provider: "x", subject: "x1", user_id: UUID }],
      bans: [{ id: "b1", user_id: UUID, reason: "spam", lifted_at: null, expires_at: null }],
    });
    const res = await callbackWith(await good(), { state: "s1", code: "c" });
    expect(fragment(res).get("next")).toBe("/profile");
    const got = await collectWith(pair(res, HANDOVER_COOKIE));
    expect(await got.json()).toMatchObject({ token: state.db.tables.auth_sessions[0].token, banned: true });
    expect(setCookie(res, "enki_team")).toMatch(/^enki_team=;.*Max-Age=0/);

    // the proxy lets a browser without the cookie through to /banned, and nowhere else
    const banned = proxy(new NextRequest("https://enki.test/banned"));
    expect(banned.headers.get("x-middleware-next")).toBe("1");
    const home = proxy(new NextRequest("https://enki.test/home"));
    expect(new URL(home.headers.get("location")!).pathname).toBe("/");
  });

  const live = { token: "tok-live", wallet_address: UUID, wallet_type: "password", expires_at: "2999-01-01T00:00:00.000Z" };
  const linkState = () => signState({ provider: "x", intent: { kind: "link", userId: UUID, session: sessionHash("tok-live") }, next: "/settings", state: "s1", nonce: "n1", verifier: "v1" });

  it("a link from Settings attaches the identity and goes back, keeping the session it came from", async () => {
    state.db = fakeDb({ users: [{ id: UUID }], password_credentials: [{ user_id: UUID, email: "kev@example.com" }], auth_sessions: [live] });
    const res = await callbackWith(await linkState(), { state: "s1", code: "c" });
    expect(res.headers.get("location")).toBe("https://enki.test/settings");
    expect(state.db.tables.auth_identities).toEqual([expect.objectContaining({ provider: "x", subject: "x1", user_id: UUID })]);
    expect(state.db.tables.auth_sessions).toEqual([live]);
    expect(setCookie(res, HANDOVER_COOKIE)).toBeUndefined();
    expect(setCookie(res, "enki_team")).toBeUndefined();
    expect(setCookie(res, STATE_COOKIE)).toMatch(/Max-Age=0/);
  });

  it("a link dies with the session that started it: after a reset or logout it attaches nothing", async () => {
    const pending = await linkState();
    for (const sessions of [[], [{ ...live, expires_at: "2000-01-01T00:00:00.000Z" }], [{ ...live, token: "tok-other" }], [{ ...live, wallet_address: "someone-else" }]]) {
      state.db = fakeDb({ users: [{ id: UUID }], auth_sessions: sessions });
      const res = await callbackWith(pending, { state: "s1", code: "c" });
      expect(res.headers.get("location")).toBe("https://enki.test/settings#connect_error=state_mismatch");
      expect(state.db.tables.auth_identities ?? []).toEqual([]);
    }
    // a session that moved to the attached wallet's address still counts
    state.db = fakeDb({ users: [{ id: UUID }], user_wallets: [{ user_id: UUID, address: "So1", removed_at: null }], auth_sessions: [{ ...live, wallet_address: "So1" }] });
    expect((await callbackWith(pending, { state: "s1", code: "c" })).headers.get("location")).toBe("https://enki.test/settings");
  });

  it("a login that resolved before a reset's identity delete and mints after it keeps no session", async () => {
    state.db = fakeDb({ access_allowlist: [{ kind: "x", value: "x1" }], auth_identities: [{ provider: "x", subject: "x1", user_id: UUID }] });
    const realMint = (await vi.importActual<typeof import("@/lib/user-session")>("@/lib/user-session")).mintUserSession;
    vi.mocked(mintUserSession).mockImplementationOnce(async (...args) => {
      state.db.tables.auth_identities = []; // the owner's reset removes the identity after this login looked it up
      return realMint(...args);
    });
    const res = await callbackWith(await good(), { state: "s1", code: "c" });
    expect(fragment(res).get("error")).toBe("state_mismatch");
    expect(state.db.tables.auth_sessions ?? []).toEqual([]);
    expect(setCookie(res, HANDOVER_COOKIE)).toBeUndefined();
  });

  it("a reset that lands during the provider round trip still leaves no identity behind, and touches nobody else's", async () => {
    const bystanders = [{ provider: "x", subject: "x2", user_id: OTHER }, { provider: "google", subject: "x1", user_id: OTHER }];
    state.db = fakeDb({ users: [{ id: UUID }], auth_sessions: [live], auth_identities: bystanders });
    vi.mocked(completeAuth).mockImplementationOnce(async () => {
      state.db.tables.auth_sessions = []; // the owner's reset evicts the session while the provider answers
      return state.identity;
    });
    const res = await callbackWith(await linkState(), { state: "s1", code: "c" });
    expect(res.headers.get("location")).toBe("https://enki.test/settings#connect_error=state_mismatch");
    expect(state.db.tables.auth_identities).toEqual(bystanders);
  });

  it("a deletion that lands during the round trip leaves no identity on the dead account", async () => {
    state.db = fakeDb({ users: [{ id: UUID, deleted_at: null }], auth_sessions: [live] });
    vi.mocked(completeAuth).mockImplementationOnce(async () => {
      // softDelete, in its order: deleted_at, sessions, identities
      state.db.tables.users[0].deleted_at = "2026-10-17T12:00:00.000Z";
      state.db.tables.auth_sessions = [];
      state.db.tables.auth_identities = [];
      return state.identity;
    });
    const res = await callbackWith(await linkState(), { state: "s1", code: "c" });
    expect(res.headers.get("location")).toBe("https://enki.test/settings#connect_error=account_deleted");
    expect(state.db.tables.auth_identities ?? []).toEqual([]);
  });

  it("an undo removes only what the link wrote: an identity the account already held stays", async () => {
    const held = { provider: "x", subject: "x1", user_id: UUID };
    state.db = fakeDb({ users: [{ id: UUID }], auth_sessions: [live], auth_identities: [held] });
    vi.mocked(completeAuth).mockImplementationOnce(async () => {
      state.db.tables.auth_sessions = []; // a logout in another tab during the round trip
      return state.identity;
    });
    const res = await callbackWith(await linkState(), { state: "s1", code: "c" });
    expect(res.headers.get("location")).toBe("https://enki.test/settings#connect_error=state_mismatch");
    expect(state.db.tables.auth_identities).toEqual([expect.objectContaining(held)]);
  });

  it("a refused or cancelled link goes back to Settings with the reason; a login's refusal goes to /auth/complete", async () => {
    state.db = fakeDb({ users: [{ id: UUID }], auth_sessions: [live], auth_identities: [{ provider: "x", subject: "x1", user_id: OTHER }] });
    const taken = await callbackWith(await linkState(), { state: "s1", code: "c" });
    expect(taken.headers.get("location")).toBe("https://enki.test/settings#connect_error=already_linked");
    expect(setCookie(taken, STATE_COOKIE)).toMatch(/Max-Age=0/);
    // a cancel at the provider is no error: a link goes back to Settings, a login to the open login window
    const cancelled = await callbackWith(await linkState(), { state: "s1", error: "access_denied" });
    expect(cancelled.headers.get("location")).toBe("https://enki.test/settings");
    const login = await callbackWith(await good(), { state: "s1", error: "access_denied" });
    expect(login.headers.get("location")).toBe("https://enki.test/?login=1");
    expect(setCookie(login, STATE_COOKIE)).toMatch(/Max-Age=0/);
    // any other provider error, or none at all, still says the sign in did not complete
    const other = await callbackWith(await good(), { state: "s1", error: "server_error" });
    expect(fragment(other).get("error")).toBe("provider_error");
    expect(new URL(other.headers.get("location")!).pathname).toBe("/auth/complete");
    const linkOther = await callbackWith(await linkState(), { state: "s1" });
    expect(linkOther.headers.get("location")).toBe("https://enki.test/settings#connect_error=provider_error");
    const view = readFileSync(join(__dirname, "..", "..", "components", "settings", "use-account.ts"), "utf8");
    expect(view).toContain('.get("connect_error")');
    expect(view).toContain('toast({ title: errorSentence(refused), variant: "destructive" });');
    const complete = readFileSync(join(__dirname, "..", "..", "app", "auth", "complete", "page.tsx"), "utf8");
    expect(complete).toContain("const sentence = (code: string | null) => (code ? errorSentence(code) : null);");
    expect(complete).toContain('href="/?login=1"');
  });

  it("a login by an identity of a password account hands over the account's login email, not the provider's", async () => {
    state.db = fakeDb({
      access_allowlist: [{ kind: "x", value: "x1" }],
      auth_identities: [{ provider: "x", subject: "x1", user_id: UUID }],
      password_credentials: [{ user_id: UUID, email: "kev@example.com" }],
    });
    const res = await callbackWith(await good(), { state: "s1", code: "c" });
    expect(await (await collectWith(pair(res, HANDOVER_COOKIE))).json()).toMatchObject({ email: "kev@example.com" });
  });

  it("a stranger off the whitelist is refused before any session exists", async () => {
    state.identity = { ...state.identity, subject: "x-nobody" };
    const res = await callbackWith(await good(), { state: "s1", code: "c" });
    expect(fragment(res).get("error")).toBe("not_whitelisted");
    expect(state.db.ops).not.toContain("auth_sessions.insert");
    expect(state.db.tables.users ?? []).toEqual([]);
  });

  it("answers 503 with the migration name when auth_identities is missing", async () => {
    state.db = fakeDb({}, { auth_identities: { message: "Could not find the table 'public.auth_identities' in the schema cache", code: "PGRST205" } });
    const res = await callbackWith(await good(), { state: "s1", code: "c" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("2026-09-24-auth-identities.sql");
  });
});
