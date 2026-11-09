import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { fakeDb, type FakeDb } from "./_fake-supabase";
import { stubRequiredEnv } from "./_required-env";
import { readTrial, signTrial, TRIAL_COOKIE, TRIAL_PASS_COOKIE } from "@/lib/trial-cookie";

/**
 * DEC-434 (Kev, 2026-10-27: signed out, the app is locked on the server too). The proxy opens the app for the member
 * cookie a login signs for an admitted account until its session ends, or for a running trial; the team code itself
 * opens nothing. A logout and a session the server no longer knows take the cookie; a walled page goes to the landing,
 * which renews a signed-in browser's missing cookie and opens /home.
 */
const USER = "11111111-1111-4111-8111-111111111111";
const END = "2999-01-01T00:00:00.000Z";
const state = vi.hoisted(() => ({ db: null as unknown as FakeDb, userId: null as string | null, listed: false }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => state.db.client, getSupabaseServerClientSafe: () => state.db.client }));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserWithBan: async () => ({ userId: state.userId, ban: null, wallet: state.userId }),
  resolveSessionUserId: async () => state.userId,
  activeBanFor: async () => null,
}));
vi.mock("@/lib/auth/oauth", () => ({ accountAllowed: async () => state.listed }));
vi.mock("@/lib/trial", async (orig) => ({ ...(await orig<typeof import("@/lib/trial")>()), activeTrial: async () => null }));

import { grantGateCookie, revokeGateCookie } from "@/lib/allowlist";
import { proxy } from "../../proxy";
import { DELETE as logout } from "../../app/api/auth/session/route";
import { GET as identity } from "../../app/api/users/handle/route";
import { GET as banMe } from "../../app/api/ban/me/route";
import { POST as gatePost } from "../../app/api/gate/route";

const pepper = () => process.env.AUTH_PEPPER!;
const setCookies = (res: Response) => res.headers.getSetCookie();
const member = (res: Response) => readTrial("member", /^enki_team=([^;]*)/.exec(setCookies(res).find((c) => c.startsWith("enki_team=")) ?? "")?.[1], pepper());
const revoked = (res: Response) => ["enki_team", TRIAL_COOKIE].every((n) => setCookies(res).some((c) => new RegExp(`^${n}=;.*Max-Age=0`, "i").test(c)));
const withSession = (url: string, init: { method?: string } = {}) => new NextRequest(url, { ...init, headers: { "X-Session-Token": "tok" } });

beforeEach(() => {
  stubRequiredEnv();
  vi.stubEnv("TEAM_ACCESS_CODE", "team-code");
  state.db = fakeDb({ users: [{ id: USER, role: "beta" }], auth_sessions: [{ token: "tok", wallet_address: USER, expires_at: END }] });
  state.userId = USER;
  state.listed = true;
});
afterEach(() => vi.unstubAllEnvs());

describe("the member cookie a login sets", () => {
  it("is signed for the account until its session ends, httpOnly, never the team code", () => {
    const res = grantGateCookie(NextResponse.json({}), USER, END);
    expect(member(res)).toEqual({ subject: USER, expiresAtMs: Date.parse(END) });
    const raw = setCookies(res).find((c) => c.startsWith("enki_team="))!;
    expect(raw).toMatch(/HttpOnly/i);
    // Relative, so a browser whose clock runs ahead keeps it (review wf_866ba07b-01a).
    const maxAge = Number(/Max-Age=(\d+)/i.exec(raw)?.[1]);
    expect(Math.abs(maxAge - (Date.parse(END) - Date.now()) / 1000)).toBeLessThan(5);
    // Next adds an Expires beside it; Max-Age wins where both are set (RFC 6265 5.3).
    expect(raw).not.toContain("team-code");
  });

  it("is not set outside the whitelist stage, without the pepper, or without a readable session end", () => {
    expect(setCookies(grantGateCookie(NextResponse.json({}), USER, ""))).toEqual([]);
    vi.stubEnv("AUTH_PEPPER", "");
    expect(setCookies(grantGateCookie(NextResponse.json({}), USER, END))).toEqual([]);
    stubRequiredEnv();
    vi.stubEnv("TEAM_ACCESS_CODE", "");
    expect(setCookies(grantGateCookie(NextResponse.json({}), USER, END))).toEqual([]);
  });

  it("goes with the trial's on a revoke", () => {
    expect(revoked(revokeGateCookie(NextResponse.json({})))).toBe(true);
  });
});

describe("the proxy", () => {
  const visit = (path: string, cookie?: string) => proxy(new NextRequest(`http://enki.test${path}`, cookie ? { headers: { cookie } } : {}));
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("opens pages and APIs to a signed-in member", () => {
    const ok = signTrial("member", USER, Date.now() + 60_000, pepper());
    expect(passes(visit("/home", `enki_team=${ok}`))).toBe(true);
    expect(passes(visit("/api/prompts", `enki_team=${ok}`))).toBe(true);
  });

  it("walls the bare team code, an ended or forged cookie, another kind, and a member cookie under the trial's name", () => {
    const ended = signTrial("member", USER, Date.now() - 1, pepper());
    const forged = signTrial("member", USER, Date.now() + 60_000, "someone-elses-pepper");
    const pass = signTrial("pass", USER, Date.now() + 60_000, pepper());
    const ok = signTrial("member", USER, Date.now() + 60_000, pepper());
    const trial = signTrial("trial", USER, Date.now() + 60_000, pepper());
    for (const cookie of ["enki_team=team-code", `enki_team=${ended}`, `enki_team=${forged}`, `enki_team=${pass}`, `enki_team=${trial}`, `${TRIAL_PASS_COOKIE}=${pass}`, `${TRIAL_COOKIE}=${ok}`]) {
      expect(passes(visit("/home", cookie)), cookie).toBe(false);
    }
  });

  it("sends a walled page to the landing, with nothing appended, and answers a walled API with its own 401", async () => {
    expect(visit("/generator/abc?tab=2").headers.get("location")).toBe("http://enki.test/");
    const api = visit("/api/prompts");
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: "Access code required" });
  });
});

describe("a session's cookie that ends soon", () => {
  it("lives what is left of the session, never less than nothing", () => {
    const soon = new Date(Date.now() + 90_000).toISOString();
    const raw = setCookies(grantGateCookie(NextResponse.json({}), USER, soon)).find((c) => c.startsWith("enki_team="))!;
    expect(Number(/Max-Age=(\d+)/i.exec(raw)?.[1])).toBeGreaterThanOrEqual(88);
    expect(Number(/Max-Age=(\d+)/i.exec(raw)?.[1])).toBeLessThanOrEqual(90);
  });
});

describe("the access cookie goes", () => {
  it("at a logout, with the session row, and even without a token", async () => {
    const out = await logout(withSession("http://enki.test/api/auth/session", { method: "DELETE" }));
    expect(out.status).toBe(200);
    expect(state.db.tables.auth_sessions).toEqual([]);
    expect(revoked(out)).toBe(true);
    expect(revoked(await logout(new NextRequest("http://enki.test/api/auth/session", { method: "DELETE" })))).toBe(true);
  });

  it("when the shell's identity check finds no session", async () => {
    state.userId = null;
    const res = await identity(withSession("http://enki.test/api/users/handle"));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Not signed in");
    expect(revoked(res)).toBe(true);
  });

  it("when the banned door finds no session", async () => {
    state.userId = null;
    const res = await banMe(withSession("http://enki.test/api/ban/me"));
    expect(res.status).toBe(401);
    expect(revoked(res)).toBe(true);
  });
});

describe("the banned door renews it", () => {
  it("for a listed account, until its session ends, and says the app is open again", async () => {
    const res = await banMe(withSession("http://enki.test/api/ban/me"));
    expect(await res.json()).toEqual({ banned: false, admitted: true });
    expect(member(res)).toEqual({ subject: USER, expiresAtMs: Date.parse(END) });
  });

  it("never for an account off the list without a trial", async () => {
    state.listed = false;
    const res = await banMe(withSession("http://enki.test/api/ban/me"));
    expect(await res.json()).toEqual({ banned: false });
    expect(setCookies(res).some((c) => c.startsWith("enki_team="))).toBe(false);
  });
});

describe("the team code at /gate", () => {
  it("opens nothing by itself: no cookie, the page goes on to the sign-in", async () => {
    const res = await gatePost(new NextRequest("http://enki.test/api/gate", { method: "POST", body: JSON.stringify({ code: "team-code" }) }));
    expect(await res.json()).toEqual({ ok: true, signIn: true });
    expect(setCookies(res)).toEqual([]);
  });
});

describe("the landing", () => {
  const PAGE = readSource(join(__dirname, "..", "..", "app", "page.tsx"));

  it("renews a signed-in browser's missing cookie once a minute at most, and opens /home only when the server admitted it", () => {
    const effect = PAGE.slice(PAGE.indexOf("const headers = sessionAuthHeaders();"), PAGE.indexOf("}, []);", PAGE.indexOf("const headers = sessionAuthHeaders();")));
    expect(effect).toContain('if (!headers["X-Session-Token"]) return;');
    expect(effect).toContain("if (Date.now() - Number(sessionStorage.getItem(RENEWED) ?? 0) < 60_000) return;");
    expect(effect).toContain("if (!gate?.whitelistActive || gate.team) return;");
    expect(effect).toContain('const me = await fetch("/api/ban/me", { headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null);');
    expect(effect).toContain('if (me?.admitted === true) window.location.replace("/home");');
  });
});
