import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID, createHash } from "node:crypto";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * A signed-in password account confirms its login email with a code (Kev, 2026-11-07: "enter code oder request code").
 * The real routes and the real session lookup run; the database is a fake, the mail is captured, the wallet JWT's signer
 * is stubbed. Another account's rows stand first in every table a read could hit, its login email unconfirmed and its own
 * code live: a read or a write with no account filter lands on them, and the afterEach sees it.
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
vi.mock("@/lib/wallet-jwt", () => ({ mintWalletJwt: async () => "wallet-jwt" }));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import * as confirmEmail from "../../app/api/auth/password/confirm-email/route";
import { POST as verifyRoute } from "../../app/api/auth/password/confirm-email/verify/route";
import { POST as walletJwt } from "../../app/api/auth/wallet/jwt/route";
import { POST as forgot } from "../../app/api/auth/password/forgot/route";
import { POST as resetCode } from "../../app/api/auth/password/reset-code/route";
import { hashPassword } from "../password-auth";

// A reset runs Argon2id: under a full parallel run one test takes seconds.
vi.setConfig({ testTimeout: 60_000 });

type Row = Record<string, unknown>;
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const STRANGER = "99999999-9999-4999-8999-999999999999";
const STRANGER_CODE = "7654321";
// Its live wallet and a session keyed on it: a confirm whose wallet read had no account filter would sign that session out.
const STRANGER_WALLET = "StrangerWa11et1111111111111111111111111111111";
const strangerRows = () => ({
  users: [{ id: STRANGER, handle: "stranger" }],
  password_credentials: [{ user_id: STRANGER, email: "stranger-login@example.test", email_verified_at: null, pw_hash: "x", pw_salt: "y", must_change_password: false }],
  password_reset_tokens: [{ token: sha(STRANGER_CODE), user_id: STRANGER, expires_at: FUTURE }],
  auth_sessions: [
    { token: "stranger-session", wallet_address: STRANGER, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() },
    { token: "stranger-wallet-session", wallet_address: STRANGER_WALLET, wallet_type: "phantom", expires_at: FUTURE, created_at: new Date().toISOString() },
  ],
  bans: [{ id: "stranger-ban", user_id: STRANGER, reason: "x", lifted_at: null, expires_at: null, created_at: "2026-10-01T00:00:00Z" }],
  user_wallets: [{ user_id: STRANGER, address: STRANGER_WALLET, removed_at: null }],
});

let U = "";
let LOGIN = "";
// Each request from its own network unless a test names one: only a limiter's own test can reach its limit.
const call = (url: string, body: unknown, { token = "s" as string | null, method = "POST", ip = randomUUID() as string } = {}) => new NextRequest(`http://enki.test${url}`, {
  method,
  headers: { ...(token ? { "X-Session-Token": token } : {}), "x-real-ip": ip },
  ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
});
const status = async (token: string | null = "s") => confirmEmail.GET(call("/api/auth/password/confirm-email", null, { token, method: "GET" }));
const ask = (opts: { token?: string | null; ip?: string; body?: unknown } = {}) => confirmEmail.POST(call("/api/auth/password/confirm-email", opts.body ?? {}, opts));
const verify = (code: unknown, opts: { token?: string | null; ip?: string } = {}) => verifyRoute(call("/api/auth/password/confirm-email/verify", { code }, opts));
const jwt = () => walletJwt(call("/api/auth/wallet/jwt", {}));
const mailedCode = () => /is:\s+(\d{7})/.exec(mails.at(-1)!.text)![1];
const cred = () => db.tables.password_credentials.find((c) => c.user_id === U)!;
const myCodes = () => db.tables.password_reset_tokens.filter((t) => t.user_id === U);
const passwordAccount = (over: Row = {}) => db.tables.password_credentials.push({ user_id: U, email: LOGIN, email_verified_at: null, pw_hash: "h", pw_salt: "s", must_change_password: false, ...over });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

let seed: ReturnType<typeof strangerRows>;
beforeEach(() => {
  U = randomUUID();
  LOGIN = `owner-${U.slice(0, 8)}@example.test`;
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  seed = strangerRows();
  Object.assign(db.tables, { ...structuredClone(seed), webauthn_credentials: [], mfa_factors: [], auth_identities: [] });
  db.tables.users.push({ id: U, handle: "kev" });
  db.tables.auth_sessions.push({ token: "s", wallet_address: U, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() });
  db.state.failNext = null;
  mails.length = 0;
  mailFails.on = false;
});
afterEach(() => {
  expect(mails.filter((m) => m.to.startsWith("stranger"))).toEqual([]);
  for (const table of ["users", "password_credentials", "password_reset_tokens", "auth_sessions", "bans", "user_wallets"] as const) {
    expect(db.tables[table].filter((r) => r.user_id === STRANGER || r.id === STRANGER || r.wallet_address === STRANGER || r.wallet_address === STRANGER_WALLET), table).toEqual(seed[table]);
  }
});

describe("the status read", () => {
  it("says needed, with the address masked, only while a password account's login email waits", async () => {
    passwordAccount();
    expect(await json(await status())).toEqual({ status: 200, body: { needed: true, email: "ow…@example.test" } });
    cred().email_verified_at = "2026-10-01T00:00:00Z";
    expect(await json(await status())).toEqual({ status: 200, body: { needed: false, email: null } });
    Object.assign(cred(), { email_verified_at: null, must_change_password: true });
    expect(await json(await status())).toEqual({ status: 200, body: { needed: false, email: null } });
  });

  it("is not for an account without a password: Google, X or a wallet", async () => {
    db.tables.auth_identities.push({ user_id: U, provider: "google", subject: "g", email: "owner@gmail.test" });
    expect(await json(await status())).toEqual({ status: 200, body: { needed: false, email: null } });
  });

  it("needs a session that the server knows", async () => {
    passwordAccount();
    expect((await status(null)).status).toBe(401);
    expect((await status("nobody")).status).toBe(401);
  });

  it("a banned account reads it too: its wallet still opens", async () => {
    passwordAccount();
    db.tables.bans.push({ id: "b", user_id: U, reason: "x", lifted_at: null, expires_at: null, created_at: "2026-10-01T00:00:00Z" });
    expect((await json(await status())).body).toEqual({ needed: true, email: "ow…@example.test" });
  });

  it("a failed read is a 503, never a no", async () => {
    passwordAccount();
    db.state.failNext = { table: "password_credentials", op: "select", code: "XX000" };
    expect((await status()).status).toBe(503);
  });
});

describe("requesting a code", () => {
  it("mails a 7 digit code to the account's own login email, never to an address in the request, and keeps only its hash", async () => {
    passwordAccount();
    const before = Date.now();
    expect(await json(await ask({ body: { email: "attacker@evil.test", to: "attacker@evil.test" } }))).toEqual({ status: 200, body: { sent: true } });
    expect(mails.map((m) => m.to)).toEqual([LOGIN]);
    const code = mailedCode();
    expect(mails[0].subject).toBe(`${code} is your Enki code to confirm your email`);
    // It is a reset code too (DEC-2026-11-07-01 (1)), so the mail says so to whoever might be asked to read it out.
    expect(mails[0].text).toContain("This code also resets your password, so never give it to anyone: Enki never asks for it.");
    expect(myCodes()).toHaveLength(1);
    expect(myCodes()[0].token).toBe(sha(code));
    const ttl = Date.parse(String(myCodes()[0].expires_at)) - before;
    expect(ttl).toBeGreaterThanOrEqual(15 * 60_000);
    expect(ttl).toBeLessThan(15 * 60_000 + 5_000);
    expect(cred().email_verified_at).toBeNull();
  });

  it("keeps one live code per account: a new one replaces the last, a reset code included", async () => {
    passwordAccount();
    db.tables.password_reset_tokens.push({ token: sha("1111111"), user_id: U, expires_at: FUTURE });
    await ask();
    const first = mailedCode();
    expect(myCodes().map((t) => t.token)).toEqual([sha(first)]);
    await ask();
    expect(myCodes().map((t) => t.token)).toEqual([sha(mailedCode())]);
  });

  it("already confirmed: says so and sends nothing", async () => {
    passwordAccount({ email_verified_at: "2026-10-01T00:00:00Z" });
    expect(await json(await ask())).toEqual({ status: 200, body: { confirmed: true } });
    expect(mails).toEqual([]);
    expect(myCodes()).toEqual([]);
  });

  it("an account without a password, or one still on its invitation's password, gets no code", async () => {
    expect((await ask()).status).toBe(404);
    passwordAccount({ must_change_password: true });
    const invited = await json(await ask());
    expect(invited).toEqual({ status: 409, body: { error: "Log in once with the password from your invitation and choose your own: that confirms your email." } });
    expect(mails).toEqual([]);
    expect(myCodes()).toEqual([]);
  });

  it("says so in plain words when the mail could not go out", async () => {
    passwordAccount();
    mailFails.on = true;
    expect(await json(await ask())).toEqual({ status: 502, body: { error: "The code could not be sent. Try again in a minute." } });
  });

  it("a new code whose mail fails, or whose mailer throws, leaves the code already in the inbox working and keeps none nobody got", async () => {
    passwordAccount();
    await ask();
    const inInbox = mailedCode();
    for (const fails of [true, "throws"] as const) {
      mailFails.on = fails;
      expect((await ask()).status).toBe(502);
      expect(myCodes().map((t) => t.token)).toEqual([sha(inInbox)]);
    }
    mailFails.on = false;
    expect(await json(await verify(inInbox))).toEqual({ status: 200, body: { confirmed: true } });
  });

  it("racing requests leave at most one live code, and only one that was mailed", async () => {
    passwordAccount();
    await Promise.all([ask(), ask(), ask()]);
    expect(mails).toHaveLength(3);
    const mailed = mails.map((m) => sha(/is:\s+(\d{7})/.exec(m.text)![1]));
    expect(myCodes().length).toBeLessThanOrEqual(1);
    for (const t of myCodes()) expect(mailed).toContain(t.token);
  });

  it("a code that could not be stored is never mailed", async () => {
    passwordAccount();
    db.state.failNext = { table: "password_reset_tokens", op: "insert", code: "XX000" };
    expect((await ask()).status).toBe(503);
    expect(mails).toEqual([]);
    expect(myCodes()).toEqual([]);
  });

  it("older codes that could not be cleared after the mail went out: a 503, never sent, and the mailed code still works", async () => {
    passwordAccount();
    db.tables.password_reset_tokens.push({ token: sha("1111111"), user_id: U, expires_at: FUTURE });
    db.state.failNext = { table: "password_reset_tokens", op: "delete", code: "XX000" };
    expect((await ask()).status).toBe(503);
    expect(myCodes().map((t) => t.token)).toContain(sha(mailedCode()));
    expect((await verify(mailedCode())).status).toBe(200);
  });

  it("in production a mail that fails never puts the code in the server log", async () => {
    passwordAccount();
    mailFails.on = true;
    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect((await ask()).status).toBe(502);
      expect(log.mock.calls.flat().join(" ")).not.toMatch(/code for/);
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("three codes per account in 15 minutes, each from its own network", async () => {
    passwordAccount();
    for (let i = 0; i < 3; i++) expect((await ask()).status).toBe(200);
    const fourth = await ask();
    expect(await json(fourth)).toEqual({ status: 429, body: { error: "Too many codes asked for. Try again in a few minutes." } });
    expect(Number(fourth.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(mails).toHaveLength(3);
  });

  it("ten requests per network in 10 minutes, whatever they ask", async () => {
    passwordAccount({ email_verified_at: "2026-10-01T00:00:00Z" });
    const ip = randomUUID();
    for (let i = 0; i < 10; i++) expect((await ask({ ip })).status).toBe(200);
    expect((await ask({ ip })).status).toBe(429);
    expect((await ask()).status).toBe(200);
  });

  it("needs a session", async () => {
    passwordAccount();
    expect((await ask({ token: null })).status).toBe(401);
    expect(mails).toEqual([]);
  });
});

describe("confirming with the code", () => {
  it("the right code sets email_verified_at and nothing else, spends the code, and the wallet opens", async () => {
    passwordAccount();
    // The window opens on this answer, so its words send nobody to Forgot password.
    expect(await json(await jwt())).toEqual({ status: 403, body: { error: "Confirm your email to open your wallet.", confirmEmail: true } });
    await ask();
    const before = structuredClone(cred());
    expect(await json(await verify(mailedCode()))).toEqual({ status: 200, body: { confirmed: true } });
    const after = cred();
    expect(Date.parse(String(after.email_verified_at))).toBeGreaterThan(Date.now() - 5_000);
    expect({ ...after, email_verified_at: null }).toEqual(before);
    expect(myCodes()).toEqual([]);
    expect((await json(await status())).body).toEqual({ needed: false, email: null });
    expect(await json(await jwt())).toEqual({ status: 200, body: { jwt: "wallet-jwt", userId: U } });
  });

  it("a code works once", async () => {
    passwordAccount();
    await ask();
    const code = mailedCode();
    expect((await verify(code)).status).toBe(200);
    cred().email_verified_at = null;
    expect(await json(await verify(code))).toEqual({ status: 400, body: { error: "No code is waiting. Request a new code." } });
  });

  it("a wrong code, the other account's code, an expired one and none at all, each in its own words, and nothing changes", async () => {
    passwordAccount();
    expect(await json(await verify("1234567"))).toEqual({ status: 400, body: { error: "No code is waiting. Request a new code." } });
    await ask();
    const code = mailedCode();
    const wrong = code === "1234567" ? "1234568" : "1234567";
    expect(await json(await verify(wrong))).toEqual({ status: 400, body: { error: "Wrong code. Check the email and try again." } });
    expect(await json(await verify(STRANGER_CODE))).toEqual({ status: 400, body: { error: "Wrong code. Check the email and try again." } });
    myCodes()[0].expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await json(await verify(code))).toEqual({ status: 400, body: { error: "This code has expired. Request a new code." } });
    expect(cred().email_verified_at).toBeNull();
    expect(myCodes()).toHaveLength(1);
  });

  it("five tries per account in 15 minutes, and the right code waits too", async () => {
    passwordAccount();
    await ask();
    const code = mailedCode();
    const wrong = code === "1234567" ? "1234568" : "1234567";
    for (let i = 0; i < 5; i++) expect((await verify(wrong)).status).toBe(400);
    const sixth = await verify(code);
    expect(await json(sixth)).toEqual({ status: 429, body: { error: "Too many tries. Wait 15 minutes, then try again." } });
    expect(Number(sixth.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(cred().email_verified_at).toBeNull();
  });

  // DEC-2026-11-07-22: the reset-code route needs no session, so its tries per address were a stranger's way to lock this window.
  it("the tries are the account's own: a stranger's five wrong reset codes for the address leave the window's confirm working", async () => {
    passwordAccount();
    await ask();
    const code = mailedCode();
    const wrong = code === "1234567" ? "1234568" : "1234567";
    for (let i = 0; i < 5; i++) {
      expect((await resetCode(call("/api/auth/password/reset-code", { email: LOGIN, code: wrong, password: "a new password" }, { token: null }))).status).toBe(400);
    }
    expect((await resetCode(call("/api/auth/password/reset-code", { email: LOGIN, code: wrong, password: "a new password" }, { token: null }))).status).toBe(429);
    expect(await json(await verify(code))).toEqual({ status: 200, body: { confirmed: true } });
  });

  it("another account's five wrong codes do not touch this account's tries", async () => {
    passwordAccount();
    for (let i = 0; i < 5; i++) expect((await verify("1234567", { token: "stranger-session" })).status).toBe(400);
    expect((await verify("1234567", { token: "stranger-session" })).status).toBe(429);
    await ask();
    expect(await json(await verify(mailedCode()))).toEqual({ status: 200, body: { confirmed: true } });
  });

  it("a code that is no code costs no try", async () => {
    passwordAccount();
    await ask();
    for (let i = 0; i < 5; i++) {
      expect(await json(await verify("12ab"))).toEqual({ status: 400, body: { error: "Enter the 7 digit code from the email." } });
    }
    expect((await verify(mailedCode())).status).toBe(200);
  });

  it("twenty tries per network in 15 minutes, whatever they ask", async () => {
    passwordAccount({ email_verified_at: "2026-10-01T00:00:00Z" });
    const ip = randomUUID();
    for (let i = 0; i < 20; i++) expect((await verify("1234567", { ip })).status).toBe(200);
    expect(await json(await verify("1234567", { ip }))).toEqual({ status: 429, body: { error: "Too many tries. Wait 15 minutes, then try again." } });
  });

  it("already confirmed: says so without a code; no password: 404; no session: 401", async () => {
    expect((await verify("1234567")).status).toBe(404);
    passwordAccount({ email_verified_at: "2026-10-01T00:00:00Z" });
    expect(await json(await verify("0000000"))).toEqual({ status: 200, body: { confirmed: true } });
    expect((await verify("0000000", { token: null })).status).toBe(401);
  });

  it("a banned account confirms too", async () => {
    passwordAccount();
    db.tables.bans.push({ id: "b", user_id: U, reason: "x", lifted_at: null, expires_at: null, created_at: "2026-10-01T00:00:00Z" });
    await ask();
    expect((await verify(mailedCode())).status).toBe(200);
    expect(cred().email_verified_at).not.toBeNull();
  });

  it("a failed read of the codes is a 503, never a confirm", async () => {
    passwordAccount();
    await ask();
    db.state.failNext = { table: "password_reset_tokens", op: "select", code: "XX000" };
    expect((await verify(mailedCode())).status).toBe(503);
    expect(cred().email_verified_at).toBeNull();
  });

  it("a code that could not be spent is a 503, never a confirm", async () => {
    passwordAccount();
    await ask();
    db.state.failNext = { table: "password_reset_tokens", op: "delete", code: "XX000" };
    expect((await verify(mailedCode())).status).toBe(503);
    expect(cred().email_verified_at).toBeNull();
  });

  it("a confirm that could not be written is a 503, never { confirmed: true }", async () => {
    passwordAccount();
    await ask();
    db.state.failNext = { table: "password_credentials", op: "update", code: "XX000" };
    expect((await json(await verify(mailedCode()))).status).toBe(503);
    expect(cred().email_verified_at).toBeNull();
  });
});

describe("a right code signs out every other session of the account first, and keeps the one that typed it (DEC-2026-11-07-21)", () => {
  const W = "So1anaWa11etOfTheOwner11111111111111111111";
  const sessionOn = (token: string, key: string) => db.tables.auth_sessions.push({ token, wallet_address: key, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() });
  const tokens = () => db.tables.auth_sessions.filter((s) => s.wallet_address !== STRANGER && s.wallet_address !== STRANGER_WALLET).map((s) => s.token).sort();
  beforeEach(() => {
    passwordAccount();
    db.tables.user_wallets.push({ user_id: U, address: W, removed_at: null }, { user_id: U, address: "RemovedWa11et", removed_at: "2026-10-01T00:00:00Z" });
    sessionOn("stolen", U);
    sessionOn("stolen-on-wallet", W);
    sessionOn("on-a-removed-wallet", "RemovedWa11et");
  });

  it("a session stolen before the confirm, on either key, no longer gets the wallet; the one that typed the code does", async () => {
    await ask();
    expect((await verify(mailedCode())).status).toBe(200);
    expect(tokens()).toEqual(["on-a-removed-wallet", "s"]);
    expect((await walletJwt(call("/api/auth/wallet/jwt", {}, { token: "stolen" }))).status).toBe(401);
    expect(await json(await jwt())).toEqual({ status: 200, body: { jwt: "wallet-jwt", userId: U } });
  });

  it("a wrong code signs nobody out", async () => {
    await ask();
    const code = mailedCode();
    expect((await verify(code === "1234567" ? "1234568" : "1234567")).status).toBe(400);
    expect(tokens()).toEqual(["on-a-removed-wallet", "s", "stolen", "stolen-on-wallet"]);
  });

  it.each([["the wallets read", "user_wallets", "select"], ["the sign-out", "auth_sessions", "delete"]] as const)("%s failing is a 503: no confirm, every session stays", async (_, table, op) => {
    await ask();
    db.state.failNext = { table, op, code: "XX000" };
    expect((await verify(mailedCode())).status).toBe(503);
    expect(db.state.failNext).toBeNull();
    expect(cred().email_verified_at).toBeNull();
    expect(tokens()).toEqual(["on-a-removed-wallet", "s", "stolen", "stolen-on-wallet"]);
  });
});

describe("a database that cannot be read", () => {
  it("the session lookup failing is a 503 for the status, the request and the code, and sends nothing", async () => {
    passwordAccount();
    for (const run of [() => status(), () => ask(), () => verify("1234567")]) {
      db.state.failNext = { table: "auth_sessions", op: "select", code: "XX000" };
      expect((await run()).status).toBe(503);
    }
    expect(mails).toEqual([]);
  });
});

describe("the code shares the forgot route's table (DEC-2026-11-07-01)", () => {
  it("a reset code from the forgot route confirms the email: it proves the same inbox", async () => {
    passwordAccount();
    expect((await forgot(call("/api/auth/password/forgot", { email: LOGIN }, { token: null }))).status).toBe(200);
    expect(await json(await verify(mailedCode()))).toEqual({ status: 200, body: { confirmed: true } });
  });

  it("a confirm code resets the password, and the reset confirms the email as it always did", async () => {
    const { hash, salt } = hashPassword("the owner's password");
    passwordAccount({ pw_hash: hash, pw_salt: salt });
    await ask();
    const reset = await resetCode(call("/api/auth/password/reset-code", { email: LOGIN, code: mailedCode(), password: "a new password" }, { token: null }));
    expect(reset.status).toBe(200);
    expect(cred().pw_hash).not.toBe(hash);
    expect(cred().email_verified_at).not.toBeNull();
  });
});
