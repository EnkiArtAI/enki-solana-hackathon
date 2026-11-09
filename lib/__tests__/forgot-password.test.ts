import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Forgot password, through the real forgot, reset-code and confirm-email routes: the database is a fake, the mail is
 * captured. Another account's rows stand first in every table a read could hit, its own reset code live: a read or a
 * write with no account filter lands on them, and the afterEach sees it.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
const mailFails = vi.hoisted(() => ({ on: false as boolean | "throws" }));
vi.mock("@/lib/mailer", () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    if (mailFails.on === "throws") throw new Error("the mailer is down");
    if (mailFails.on) return { ok: false };
    mails.push(m);
    return { ok: true };
  },
}));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { POST as forgotRoute } from "../../app/api/auth/password/forgot/route";
import { POST as resetCode } from "../../app/api/auth/password/reset-code/route";
import * as confirmEmail from "../../app/api/auth/password/confirm-email/route";

// A reset runs Argon2id: under a full parallel run one test takes seconds.
vi.setConfig({ testTimeout: 60_000 });

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const STRANGER = "99999999-9999-4999-8999-999999999999";
const strangerRows = () => ({
  users: [{ id: STRANGER, handle: "stranger", deleted_at: null }],
  password_credentials: [{ user_id: STRANGER, email: "stranger-login@example.test", email_verified_at: null, pw_hash: "x", pw_salt: "y", must_change_password: false }],
  password_reset_tokens: [{ token: sha("7654321"), user_id: STRANGER, expires_at: FUTURE }],
  auth_identities: [{ user_id: STRANGER, provider: "google", subject: "g-stranger", email: "stranger-google@example.test" }],
  auth_sessions: [{ token: "stranger-session", wallet_address: STRANGER, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() }],
});

let U = "";
let LOGIN = "";
// Each request from its own network: only a limiter's own test can reach its limit.
const call = (url: string, body: unknown, token: string | null = null) => new NextRequest(`http://enki.test${url}`, {
  method: "POST",
  headers: { ...(token ? { "X-Session-Token": token } : {}), "x-real-ip": randomUUID() },
  body: JSON.stringify(body),
});
const forgot = (email = LOGIN) => forgotRoute(call("/api/auth/password/forgot", { email }));
const reset = (code: string, email = LOGIN) => resetCode(call("/api/auth/password/reset-code", { email, code, password: "a new password" }));
const codeOf = (m: { text: string }) => /is:\s+(\d{7})/.exec(m.text)![1];
const myCodes = () => db.tables.password_reset_tokens.filter((t) => t.user_id === U);

let seed: ReturnType<typeof strangerRows>;
beforeEach(() => {
  U = randomUUID();
  LOGIN = `owner-${U.slice(0, 8)}@example.test`;
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  seed = strangerRows();
  Object.assign(db.tables, { ...structuredClone(seed), user_wallets: [], webauthn_credentials: [], mfa_factors: [], bans: [] });
  db.tables.users.push({ id: U, handle: "kev", deleted_at: null });
  db.tables.password_credentials.push({ user_id: U, email: LOGIN, email_verified_at: null, pw_hash: "h", pw_salt: "s", must_change_password: false });
  db.state.failNext = null;
  db.state.holdNext = null;
  mails.length = 0;
  mailFails.on = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
  expect(mails.filter((m) => m.to.startsWith("stranger"))).toEqual([]);
  for (const table of ["users", "password_credentials", "password_reset_tokens", "auth_identities", "auth_sessions"] as const) {
    expect(db.tables[table].filter((r) => r.user_id === STRANGER || r.id === STRANGER || r.wallet_address === STRANGER), table).toEqual(seed[table]);
  }
});

describe("a forgot request stores its code before the older ones go, and they go only once its mail is out (DEC-2026-11-07-17)", () => {
  it("a second request leaves only the newest code, and the earlier mail's code no longer resets", async () => {
    await forgot();
    await forgot();
    expect(mails).toHaveLength(2);
    expect(myCodes().map((c) => c.token)).toEqual([sha(codeOf(mails[1]))]);
    expect((await reset(codeOf(mails[0]))).status).toBe(400);
    expect((await reset(codeOf(mails[1]))).status).toBe(200);
  });

  it("racing requests leave at most one live code, and only one that was mailed", async () => {
    await Promise.all([forgot(), forgot(), forgot()]);
    expect(mails).toHaveLength(3);
    const mailed = mails.map((m) => sha(codeOf(m)));
    expect(myCodes().length).toBeLessThanOrEqual(1);
    for (const c of myCodes()) expect(mailed).toContain(c.token);
  });

  it("a forgot request racing a confirm request leaves at most one live code", async () => {
    db.tables.auth_sessions.push({ token: "s", wallet_address: U, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() });
    await Promise.all([forgot(), confirmEmail.POST(call("/api/auth/password/confirm-email", {}, "s"))]);
    expect(mails).toHaveLength(2);
    expect(myCodes().length).toBeLessThanOrEqual(1);
  });

  it.each([["fails", true], ["throws", "throws"]] as const)("in production, a mail that %s keeps the code already in the inbox working and no code nobody got", async (_, how) => {
    await forgot();
    const first = codeOf(mails[0]);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const log = vi.spyOn(console, "log");
    mailFails.on = how;
    expect(await (await forgot()).json()).toEqual({ ok: true });
    expect(myCodes().map((c) => c.token)).toEqual([sha(first)]);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    vi.unstubAllEnvs();
    mailFails.on = false;
    expect((await reset(first)).status).toBe(200);
  });

  it("outside production, an unsent mail logs the code, and that code is the one that works", async () => {
    await forgot();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mailFails.on = true;
    expect(await (await forgot()).json()).toEqual({ ok: true });
    const logged = /reset code for .+: (\d{7})/.exec(String(log.mock.calls.at(-1)?.[0]))![1];
    log.mockRestore();
    expect(myCodes().map((c) => c.token)).toEqual([sha(logged)]);
  });

  it("a code that could not be stored is not mailed, and the code already in the inbox keeps working", async () => {
    await forgot();
    const first = codeOf(mails[0]);
    db.state.failNext = { table: "password_reset_tokens", op: "insert", code: "XX000" };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await (await forgot()).json()).toEqual({ ok: true });
    quiet.mockRestore();
    expect(mails).toHaveLength(1);
    expect(myCodes().map((c) => c.token)).toEqual([sha(first)]);
  });
});

describe("an address of a Google or X login with no password gets that platform's own reset (DEC-2026-11-07-18)", () => {
  const GMAIL = "owner.g@gmail.test";
  const GOOGLE_RESET = "If you cannot sign in to Google, reset your Google password there: https://accounts.google.com/signin/recovery";
  const X_RESET = "If you cannot sign in to X, reset your X password there: https://help.x.com/en/managing-your-account/forgotten-or-lost-password-reset";
  // An account made by a Google login: no password row, the email on users (lib/auth/oauth.ts emailColumns), the identity.
  const googleAccount = (identityEmail = GMAIL, usersEmail: string | null = GMAIL) => {
    db.tables.password_credentials = db.tables.password_credentials.filter((c) => c.user_id !== U);
    Object.assign(db.tables.users.find((u) => u.id === U)!, { email_lookup_hash: usersEmail ? sha(usersEmail.toLowerCase()) : null });
    db.tables.auth_identities.push({ user_id: U, provider: "google", subject: "g-owner", email: identityEmail });
  };
  const sameAnswer = async (email: string) => {
    const res = await forgot(email);
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 200, body: { ok: true } });
  };

  it("says the account signs in with Google, that Enki has no password and changed nothing, and links Google's reset; no code is stored", async () => {
    googleAccount();
    const before = Date.now();
    await sameAnswer(GMAIL);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: GMAIL, subject: "Your Enki account signs in with Google" });
    const stamp = /for this address \((.+?)\)/.exec(mails[0].text)![1];
    expect(Date.parse(stamp)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(mails[0].text).toContain("). Your Enki account signs in with Google, so Enki has no password for it, and nothing was changed.\n\n" + GOOGLE_RESET + "\n\nIf you did not ask for this, you can ignore this email: nothing changes.");
    expect(mails[0].text).not.toMatch(/\b\d{7}\b|X password/);
    expect(myCodes()).toEqual([]);
  });

  it("names X too when the account has both, each with its own reset", async () => {
    googleAccount();
    db.tables.auth_identities.push({ user_id: U, provider: "x", subject: "x-owner", email: null, handle: "kevx" });
    await sameAnswer(GMAIL);
    expect(mails[0].subject).toBe("Your Enki account signs in with Google and X");
    expect(mails[0].text).toContain(`signs in with Google and X, so Enki has no password for it, and nothing was changed.\n\n${GOOGLE_RESET}\n${X_RESET}\n\n`);
  });

  it("finds the address on the identity in any case, and on users alone", async () => {
    googleAccount("Owner.G@Gmail.test", null);
    await sameAnswer(GMAIL);
    expect(mails.map((m) => m.to)).toEqual([GMAIL]);
    mails.length = 0;
    db.tables.auth_identities = db.tables.auth_identities.filter((i) => i.user_id !== U);
    googleAccount("other-address@gmail.test", GMAIL);
    await sameAnswer(GMAIL);
    expect(mails.map((m) => m.to)).toEqual([GMAIL]);
  });

  it("an underscore is a literal for LIKE, not its one-character wildcard", () => {
    const src = readFileSync(join(__dirname, "..", "..", "app", "api", "auth", "password", "forgot", "route.ts"), "utf8");
    expect(src).toContain('.ilike("email", email.replace(/_/g, "\\\\_"))');
  });

  it("tells nobody when the account has a password, was deleted, lost its Google login, or the address is unknown", async () => {
    googleAccount();
    db.tables.password_credentials.push({ user_id: U, email: LOGIN, email_verified_at: null, pw_hash: "h", pw_salt: "s", must_change_password: false });
    await sameAnswer(GMAIL);
    db.tables.password_credentials = db.tables.password_credentials.filter((c) => c.user_id !== U);
    db.tables.users.find((u) => u.id === U)!.deleted_at = "2026-11-01T00:00:00Z";
    await sameAnswer(GMAIL);
    db.tables.users.find((u) => u.id === U)!.deleted_at = null;
    db.tables.auth_identities = db.tables.auth_identities.filter((i) => i.user_id !== U);
    await sameAnswer(GMAIL);
    await sameAnswer("nobody@example.test");
    await sameAnswer("stranger-google@example.test");
    expect(mails).toEqual([]);
  });

  it("an email factor's address is sealed per account and has no lookup, so it is not found: nothing is sent", async () => {
    db.tables.password_credentials = db.tables.password_credentials.filter((c) => c.user_id !== U);
    db.tables.auth_identities.push({ user_id: U, provider: "x", subject: "x-owner", email: null });
    db.tables.mfa_factors.push({ id: randomUUID(), user_id: U, kind: "email", secret_ct: "sealed", confirmed_at: "2026-10-07T00:00:00Z" });
    await sameAnswer("owner-factor@example.test");
    expect(mails).toEqual([]);
  });

  it("a read that fails sends nothing, and the answer is the same", async () => {
    googleAccount();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const table of ["auth_identities", "users", "password_credentials"]) {
      db.state.failNext = { table, op: "select", code: "XX000" };
      await sameAnswer(GMAIL);
      expect(db.state.failNext).toBeNull();
    }
    db.state.failNext = { table: "auth_identities", op: "select", code: "XX000", skip: 1 };
    await sameAnswer(GMAIL);
    expect(db.state.failNext).toBeNull();
    quiet.mockRestore();
    expect(mails).toEqual([]);
  });
});
