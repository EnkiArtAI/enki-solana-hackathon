import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { fakePostgrest } from "./_fake-postgrest";
import { completeAuth, sessionHash, signState, STATE_COOKIE, type ProviderIdentity } from "@/lib/auth/oauth";

/**
 * Connecting Google or X is a new way into the account, and a phished password
 * with a fresh login is enough to do it. The owner hears when the link has
 * really landed, and only then. The real callback runs with the real rate limit;
 * the database is a fake, the provider's answer is stubbed, the mail is captured.
 */

const state = vi.hoisted(() => ({ identity: null as unknown as ProviderIdentity, background: [] as Promise<unknown>[] }));
const mailer = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[], mode: "ok" as "ok" | "throw" | "hang" }));
const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (work: Promise<unknown>) => { state.background.push(work); },
}));
vi.mock("@/lib/mailer", () => ({
  sendMail: (m: { to: string; subject: string; text: string }) => {
    if (mailer.mode === "throw") return Promise.reject(new Error("mail down"));
    if (mailer.mode === "hang") return new Promise(() => {});
    mailer.sent.push(m);
    return Promise.resolve({ ok: true });
  },
}));
vi.mock("@/lib/auth/oauth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth/oauth")>();
  return { ...actual, completeAuth: vi.fn(async () => state.identity) };
});
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { GET as callback } from "../../app/api/auth/oauth/[provider]/callback/route";
import { encryptString } from "../crypto";

let U = "";
const identity = (provider: "x" | "google", email: string | null = null): ProviderIdentity =>
  ({ provider, subject: `${provider}-1`, email, emailVerified: !!email, handle: null, displayName: null, avatarUrl: null });

async function run(provider: "x" | "google", intent: "link" | "login" = "link") {
  const cookie = await signState({
    provider,
    intent: intent === "link" ? { kind: "link", userId: U, session: sessionHash("tok-live") } : { kind: "login" },
    next: "/settings",
    state: "s1",
    nonce: "n1",
    verifier: "v1",
  });
  const url = `https://enki.test/api/auth/oauth/${provider}/callback?state=s1&code=c`;
  const res = await callback(new NextRequest(url, { headers: { cookie: `${STATE_COOKIE}=${cookie}`, "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250)}` } }), { params: Promise.resolve({ provider }) });
  await Promise.all(state.background);
  return res;
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://enki.test";
  process.env.TEAM_ACCESS_CODE = "team-code";
});
beforeEach(() => {
  U = randomUUID(); // the notice limit counts per account
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  Object.assign(db.tables, {
    users: [{ id: U, deleted_at: null }],
    auth_sessions: [{ token: "tok-live", wallet_address: U, wallet_type: "password", expires_at: "2999-01-01T00:00:00.000Z" }],
    password_credentials: [{ user_id: U, email: "owner@example.test", email_verified_at: "2026-10-01T00:00:00.000Z" }],
    auth_identities: [],
    user_wallets: [],
    mfa_factors: [],
    access_allowlist: [{ kind: "x", value: "x-1" }],
    bans: [],
    ip_bans: [],
  });
  db.state.failing = null;
  db.state.failNext = null;
  mailer.sent.length = 0;
  mailer.mode = "ok";
  state.background.length = 0;
  state.identity = identity("x");
});

describe("connecting Google or X tells the owner", () => {
  it("says which provider and when, what to do if it was not them, and goes to the login email", async () => {
    const res = await run("x");
    expect(res.headers.get("location")).toBe("https://enki.test/settings");
    expect(mailer.sent).toHaveLength(1);
    const [mail] = mailer.sent;
    expect(mail.to).toBe("owner@example.test");
    expect(mail.subject).toBe("X was connected to your Enki account");
    expect(mail.text).toMatch(/\d{2}:\d{2}:\d{2} GMT/);
    expect(mail.text).toContain("disconnect it in Settings");
    expect(mail.text).toContain("reset your password");
    expect(mail.text).toContain("A reset signs you out on every device");
    expect(mail.text).not.toContain("sign out on every device"); // no such control exists: a reset is what evicts them
    expect(mail.text).toContain("you have no password to reset"); // a Google account connecting X has none
  });

  it("names Google when it is Google", async () => {
    state.identity = identity("google", "new@gmail.test");
    await run("google");
    expect(mailer.sent[0].subject).toBe("Google was connected to your Enki account");
    expect(mailer.sent.map((m) => m.to)).toEqual(["owner@example.test", "new@gmail.test"]);
  });

  it("every address the account held hears, and the address just connected too", async () => {
    db.tables.password_credentials = [];
    const sealed = encryptString("factor@example.test", U);
    db.tables.mfa_factors.push({ user_id: U, kind: "email", confirmed_at: "2026-10-01T00:00:00.000Z", secret_ct: sealed.encrypted, secret_iv: sealed.iv, secret_tag: sealed.authTag, secret_kid: sealed.kid ?? "" });
    state.identity = identity("google", "new@gmail.test");
    await run("google");
    expect(mailer.sent.map((m) => m.to)).toEqual(["new@gmail.test", "factor@example.test"]);
  });

  // DEC-2026-11-05-40 point 2: the phisher's Google joins the list, it never takes the owner's place on it.
  it("an unconfirmed login email hears, beside the phisher who just connected Google", async () => {
    db.tables.password_credentials[0].email_verified_at = null;
    state.identity = identity("google", "phisher@gmail.test");
    await run("google");
    expect(mailer.sent.map((m) => m.to)).toEqual(["owner@example.test", "phisher@gmail.test"]);
  });

  it("an unconfirmed login email hears when X, which gives no address, was connected", async () => {
    db.tables.password_credentials[0].email_verified_at = null;
    await run("x");
    expect(mailer.sent.map((m) => m.to)).toEqual(["owner@example.test"]);
  });

  it("a touch of an identity the account already held mails nothing", async () => {
    db.tables.auth_identities.push({ provider: "x", subject: "x-1", user_id: U });
    expect((await run("x")).headers.get("location")).toBe("https://enki.test/settings");
    expect(mailer.sent).toEqual([]);
  });

  it("a login mails nothing, a new account's first one included", async () => {
    db.tables.auth_sessions = [];
    const res = await run("x", "login");
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/complete");
    expect(db.tables.auth_identities).toHaveLength(1);
    expect(mailer.sent).toEqual([]);
  });

  it("a link undone by the second session check mails nothing", async () => {
    vi.mocked(completeAuth).mockImplementationOnce(async () => {
      db.tables.auth_sessions = []; // a reset or logout while the provider answers
      return state.identity;
    });
    expect((await run("x")).headers.get("location")).toBe("https://enki.test/settings#connect_error=state_mismatch");
    expect(db.tables.auth_identities).toEqual([]);
    expect(mailer.sent).toEqual([]);
  });

  it("a second session check that fails takes the row back, and the retry links and mails", async () => {
    vi.mocked(completeAuth).mockImplementationOnce(async () => {
      db.state.failNext = { table: "auth_sessions", op: "select", code: "XX000" };
      return state.identity;
    });
    expect((await run("x")).headers.get("location")).toBe("https://enki.test/settings#connect_error=provider_error");
    expect(db.tables.auth_identities).toEqual([]);
    expect(mailer.sent).toEqual([]);
    expect((await run("x")).headers.get("location")).toBe("https://enki.test/settings");
    expect(db.tables.auth_identities).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("a second session check that fails leaves a row this call did not write", async () => {
    db.tables.auth_identities.push({ provider: "x", subject: "x-1", user_id: U });
    vi.mocked(completeAuth).mockImplementationOnce(async () => {
      db.state.failNext = { table: "auth_sessions", op: "select", code: "XX000" };
      return state.identity;
    });
    expect((await run("x")).headers.get("location")).toBe("https://enki.test/settings#connect_error=provider_error");
    expect(db.tables.auth_identities).toHaveLength(1);
  });

  it("a ban read that fails cannot strand a link: a link does not ask it, and the mail goes", async () => {
    db.state.failing = { table: "bans", code: "XX000" };
    expect((await run("x")).headers.get("location")).toBe("https://enki.test/settings");
    expect(db.tables.auth_identities).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("a login still asks the ban read: a failed one is no pass", async () => {
    db.state.failing = { table: "bans", code: "XX000" };
    db.tables.auth_sessions = [];
    const res = await run("x", "login");
    expect(res.status).toBe(503);
    expect(db.tables.auth_sessions).toEqual([]);
  });

  it("a link the account already lost to another owner mails nobody", async () => {
    db.tables.auth_identities.push({ provider: "x", subject: "x-1", user_id: randomUUID() });
    expect((await run("x")).headers.get("location")).toBe("https://enki.test/settings#connect_error=already_linked");
    expect(mailer.sent).toEqual([]);
  });

  it("a mail that fails leaves the redirect as it was", async () => {
    mailer.mode = "throw";
    const res = await run("x");
    expect(res.headers.get("location")).toBe("https://enki.test/settings");
    expect(db.tables.auth_identities).toHaveLength(1);
  });

  it("a mail that never answers does not hold up the redirect", async () => {
    mailer.mode = "hang";
    const cookie = await signState({ provider: "x", intent: { kind: "link", userId: U, session: sessionHash("tok-live") }, next: "/settings", state: "s1", nonce: "n1", verifier: "v1" });
    const res = await callback(new NextRequest("https://enki.test/api/auth/oauth/x/callback?state=s1&code=c", { headers: { cookie: `${STATE_COOKIE}=${cookie}` } }), { params: Promise.resolve({ provider: "x" }) });
    expect(res.headers.get("location")).toBe("https://enki.test/settings");
    state.background.length = 0;
  });

  it("three an hour per account, like the export notice", async () => {
    for (let i = 0; i < 4; i++) {
      db.tables.auth_identities = [];
      expect((await run("x")).headers.get("location")).toBe("https://enki.test/settings");
    }
    expect(mailer.sent).toHaveLength(3);
  });
});
