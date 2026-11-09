import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID, createHash } from "node:crypto";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * One inbox is never enough to take a factor away (Kev, 2026-11-05: "fix the offene sachen", on DEC-2026-11-05-49 point 1).
 * The mail path sends a code to every address and needs two or more (DEC-2026-11-07-10; its rules in mfa-recovery-mail.test.ts),
 * so an inbox that resets the password is never enough alone, and a reset tells every address, naming the Google or X logins
 * it leaves standing (DEC-2026-11-07-16). The real routes and the real session lookup run; the
 * database is a fake, the mail is captured, the wallet JWT's signer is stubbed.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
const mailFails = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/mailer", () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    if (mailFails.on) throw new Error("mail down");
    mails.push(m);
    return { ok: true };
  },
}));
vi.mock("@/lib/wallet-jwt", () => ({ mintWalletJwt: async () => "wallet-jwt" }));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
  process.env.OAUTH_APP_URL = "https://enki.test";
});

import { POST as mailRoute } from "../../app/api/auth/mfa/recovery/mail/route";
import { POST as mailConfirm } from "../../app/api/auth/mfa/recovery/mail/confirm/route";
import { GET as status } from "../../app/api/auth/mfa/recovery/route";
import { POST as walletJwt } from "../../app/api/auth/wallet/jwt/route";
import { POST as forgot } from "../../app/api/auth/password/forgot/route";
import { POST as resetCode } from "../../app/api/auth/password/reset-code/route";
import { POST as guardianComplete } from "../../app/api/recovery/complete/route";
import { hashPassword } from "../password-auth";
import { encryptString } from "../crypto";
import { X_NEEDS_EMAIL } from "../security-notice";

// Every reset runs Argon2id (64 MiB, 3 passes): under a full parallel run one test takes seconds.
vi.setConfig({ testTimeout: 60_000 });

type Row = Record<string, unknown>;
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const LOGIN = "owner-login@example.test";
const SECOND = "owner-second@gmail.test";
let U = "";

// Another account's rows stand first in every table a read could hit: a read or a write with no account filter lands on them.
const STRANGER = "99999999-9999-4999-8999-999999999999";
const STRANGER_REQUEST = { user_id: STRANGER, failed_attempts: 0, lockouts: 0, locked_until: null, factor: "totp", code_hashes: ["stranger-1", "stranger-2"], code_expires_at: FUTURE, code_sent_at: null, sends_day: null, sends_count: 0 };
const strangerRows = () => {
  const users = encryptString("stranger-users@example.test");
  const factor = encryptString("stranger-factor@example.test", STRANGER);
  return {
    users: [{ id: STRANGER, handle: "stranger", email_ct: users.encrypted, email_iv: users.iv, email_tag: users.authTag, email_kid: users.kid ?? null, email_verified_at: "2026-10-01T00:00:00Z" }],
    password_credentials: [{ user_id: STRANGER, email: "stranger-login@example.test", email_verified_at: "2026-10-01T00:00:00Z", pw_hash: "x", pw_salt: "y", must_change_password: false }],
    // Its X login too: an X lookup with no account filter would take this account for an X one.
    auth_identities: [{ user_id: STRANGER, provider: "google", subject: "stranger", email: "stranger-google@example.test" }, { user_id: STRANGER, provider: "x", subject: "stranger-x", email: null }],
    mfa_factors: [
      { id: randomUUID(), user_id: STRANGER, kind: "email", secret_ct: factor.encrypted, secret_iv: factor.iv, secret_tag: factor.authTag, secret_kid: factor.kid ?? "", confirmed_at: "2026-10-07T00:00:00Z" },
      { id: randomUUID(), user_id: STRANGER, kind: "totp", secret_ct: "x", confirmed_at: "2026-10-07T00:00:00Z" },
    ],
    mfa_recovery: [{ ...STRANGER_REQUEST }],
    auth_sessions: [{ token: "stranger-session", wallet_address: STRANGER, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() }],
  };
};

const req = (url: string, body: unknown, { token = "s" as string | null, method = "POST" } = {}) => new NextRequest(`http://enki.test${url}`, {
  method,
  headers: token ? { "X-Session-Token": token } : {},
  ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
});
const session = (token: string) => db.tables.auth_sessions.push({ token, wallet_address: U, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() });
const ask = (factor: string, token = "s") => mailRoute(req("/api/auth/mfa/recovery/mail", { factor }, { token }));
const read = async (token = "s") => (await status(new NextRequest("http://enki.test/api/auth/mfa/recovery", { headers: { "X-Session-Token": token } }))).json() as Promise<Row>;
const jwt = (token: string) => walletJwt(req("/api/auth/wallet/jwt", {}, { token }));
const resetMails = () => mails.filter((m) => m.subject === "The password of your Enki account was reset");

const login = (email = LOGIN) => db.tables.password_credentials.push({ user_id: U, email, email_verified_at: "2026-10-01T00:00:00Z", pw_hash: "x", pw_salt: "y", must_change_password: false });
const google = (email: string) => db.tables.auth_identities.push({ user_id: U, provider: "google", subject: `g-${email}`, email });
const usersEmail = (address: string) => {
  const e = encryptString(address);
  Object.assign(db.tables.users.find((u) => u.id === U)!, { email_ct: e.encrypted, email_iv: e.iv, email_tag: e.authTag, email_kid: e.kid ?? null, email_verified_at: "2026-10-01T00:00:00Z" });
};
const emailFactor = (address: string) => {
  const e = encryptString(address, U);
  db.tables.mfa_factors.push({ id: randomUUID(), user_id: U, kind: "email", secret_ct: e.encrypted, secret_iv: e.iv, secret_tag: e.authTag, secret_kid: e.kid ?? "", confirmed_at: "2026-10-07T00:00:00Z" });
};
const totp = () => db.tables.mfa_factors.push({ id: randomUUID(), user_id: U, kind: "totp", secret_ct: "x", confirmed_at: "2026-10-07T00:00:00Z" });
const passkey = () => db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: randomUUID(), created_at: "2026-10-07T00:00:00Z" });

let strangerSeed: ReturnType<typeof strangerRows>;
beforeEach(() => {
  U = randomUUID();
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  strangerSeed = strangerRows();
  Object.assign(db.tables, {
    ...structuredClone(strangerSeed),
    webauthn_credentials: [], mfa_recovery_codes: [], consumed_stepup_tokens: [], bans: [], user_wallets: [], password_reset_tokens: [],
    recovery_requests: [], recovery_guardians: [],
  });
  db.tables.users.push({ id: U, handle: "kev" });
  session("s");
  db.state.failing = null;
  db.state.failNext = null;
  mails.length = 0;
  mailFails.on = false;
});
afterEach(() => {
  expect(mails.filter((m) => m.to.startsWith("stranger"))).toEqual([]);
  for (const table of ["users", "password_credentials", "auth_identities", "mfa_factors", "mfa_recovery", "auth_sessions"] as const) {
    expect(db.tables[table].filter((r) => r.user_id === STRANGER || r.id === STRANGER || r.wallet_address === STRANGER), table).toEqual(strangerSeed[table]);
  }
});

describe("what Settings says where the mail path is not offered: fewer than two addresses, true for the codes left, and the step that opens it", () => {
  // Another account's unused code stands first: a count with no account filter would read one left.
  const code = (user: string, used_at: string | null = null) => db.tables.mfa_recovery_codes.push({ id: randomUUID(), user_id: user, code_hash: randomUUID(), used_at });
  const HAS = (n: string) => `Emailing codes needs two email addresses or more, one code to each, and this account has ${n}.`;
  const NO_CODE = "No recovery code is left either, and fewer than two guardians can be asked, so a lost factor cannot be removed now.";
  const BY_GOOGLE = "A second address: a Google account with another email address, connected in Settings, Profile, Connected accounts. That takes every factor";
  const BY_EMAIL = "A second address: Code by email at another address, added in Settings. That takes every factor";
  beforeEach(() => code(STRANGER));

  it("a password account with a code left: use it, or connect Google at another address, which takes every factor", async () => {
    login();
    totp();
    code(U);
    code(U, "2026-11-01T00:00:00Z");
    expect(await read()).toMatchObject({ codesLeft: 1, mailRefused: `${HAS("one")} Use a recovery code. ${BY_GOOGLE}.` });
  });

  it("a password account with no code left: a lost factor cannot be removed now, and New codes takes every factor too", async () => {
    login();
    totp();
    code(U, "2026-11-01T00:00:00Z");
    expect(await read()).toMatchObject({ codesLeft: 0, mailRefused: `${HAS("one")} ${NO_CODE} ${BY_GOOGLE}, as New codes does.` });
  });

  it("an account with no password, its Google address alone: Code by email at another address is its step", async () => {
    usersEmail(SECOND);
    google(SECOND);
    passkey();
    expect(await read()).toMatchObject({ codesLeft: 0, mailRefused: `${HAS("one")} ${NO_CODE} ${BY_EMAIL}, as New codes does.` });
    code(U);
    expect(await read()).toMatchObject({ codesLeft: 1, mailRefused: `${HAS("one")} Use a recovery code. ${BY_EMAIL}.` });
  });

  // Kev, 2026-11-07: "das muss in der meldung stehen bzw unsere settings müssen das widerspiegeln, dass das wichtig ist".
  it("an X account with no address hears why an email matters and what it cannot do; with one address it does not, and its step is Google", async () => {
    db.tables.auth_identities.push({ user_id: U, provider: "x", subject: "x-owner", email: null });
    passkey();
    expect(await read()).toMatchObject({ mailRefused: `${HAS("none")} ${NO_CODE} ${BY_EMAIL}, as New codes does. ${X_NEEDS_EMAIL}` });
    code(U);
    expect(await read()).toMatchObject({ mailRefused: `${HAS("none")} Use a recovery code. ${BY_EMAIL}. ${X_NEEDS_EMAIL}` });
    // Code by email is set up already, and an account has one (mfa_factors UNIQUE (user_id, kind)): Google is the step it can take.
    emailFactor("owner-factor@example.test");
    expect(await read()).toMatchObject({ mailRefused: `${HAS("one")} Use a recovery code. ${BY_GOOGLE}.` });
  });

  it("one address that signs in by nothing, an email factor's alone, is not enough either, and its step is Google; no address at all says none", async () => {
    emailFactor("owner-factor@example.test");
    passkey();
    expect(await read()).toMatchObject({ mailRefused: `${HAS("one")} ${NO_CODE} ${BY_GOOGLE}, as New codes does.` });
    db.tables.mfa_factors = db.tables.mfa_factors.filter((f) => f.user_id !== U);
    expect(await read()).toMatchObject({ mailRefused: `${HAS("none")} ${NO_CODE} ${BY_EMAIL}, as New codes does.` });
  });

  it("with two guardians to ask, the words name them: beside a code left, or as the only way left", async () => {
    login();
    totp();
    for (const value of ["g1@friends.test", "g2@friends.test"]) db.tables.recovery_guardians.push({ id: randomUUID(), user_id: U, guardian_type: "email", value, status: "confirmed" });
    expect(await read()).toMatchObject({ mailRefused: `${HAS("one")} No recovery code is left either, so only your guardians can remove a lost factor now. ${BY_GOOGLE}, as New codes does.` });
    code(U);
    expect(await read()).toMatchObject({ mailRefused: `${HAS("one")} Use a recovery code or ask your guardians. ${BY_GOOGLE}.` });
  });

  it("with a second address nothing is refused", async () => {
    login();
    google(SECOND);
    totp();
    expect(await read()).toMatchObject({ codesLeft: 0, mailRefused: null });
  });
});

describe("a hijacked login inbox, no stolen session (DEC-2026-11-05-49 point 1)", () => {
  it("resets the password, and that is all: the Google login stays, every address hears, the mail path needs the Google inbox too, the wallet stays locked", async () => {
    const { hash, salt } = hashPassword("the owner's password");
    db.tables.password_credentials.push({ user_id: U, email: LOGIN, email_verified_at: "2026-10-01T00:00:00Z", pw_hash: hash, pw_salt: salt, must_change_password: false });
    google(SECOND);
    passkey();
    session("owner-session");
    expect((await jwt("owner-session")).status).toBe(403);

    expect((await forgot(req("/api/auth/password/forgot", { email: LOGIN }, { token: null }))).status).toBe(200);
    const code = /is:\s+(\d{7})/.exec(mails.at(-1)!.text)![1];
    const reset = await resetCode(req("/api/auth/password/reset-code", { email: LOGIN, code, password: "attacker-pass-1" }, { token: null }));
    expect(reset.status).toBe(200);
    const stolen = ((await reset.json()) as { token: string }).token;
    expect(db.tables.auth_identities.filter((i) => i.user_id === U)).toHaveLength(1);
    expect(resetMails().map((m) => m.to).sort()).toEqual([LOGIN, SECOND].sort());

    // Codes go to both addresses; the attacker reads only the login inbox's.
    mails.length = 0;
    expect((await ask("passkey", stolen)).status).toBe(200);
    expect(mails.map((m) => m.to).sort()).toEqual([LOGIN, SECOND].sort());
    const loginCode = /code for this address is (\d{6})/.exec(mails.find((m) => m.to === LOGIN)!.text)![1];
    const sorted = [LOGIN, SECOND].sort((a, b) => (a < b ? -1 : 1));
    const guess = sorted.map((a) => (a === LOGIN ? loginCode : "000000"));
    const confirmed = await mailConfirm(req("/api/auth/mfa/recovery/mail/confirm", { codes: guess }, { token: stolen }));
    expect(confirmed.status).toBe(400);
    expect((await jwt(stolen)).status).toBe(403);
    expect(db.tables.webauthn_credentials).toHaveLength(1);
  });
});

describe("a password reset tells every address it had", () => {
  // reset-code allows five tries per address in 15 minutes: a test past the fifth reset of this file takes its own address.
  const seedReset = async (email = LOGIN) => {
    const { hash, salt } = hashPassword("the owner's password");
    db.tables.password_credentials.push({ user_id: U, email, email_verified_at: null, pw_hash: hash, pw_salt: salt, must_change_password: false });
    expect((await forgot(req("/api/auth/password/forgot", { email }, { token: null }))).status).toBe(200);
    const code = /is:\s+(\d{7})/.exec(mails.at(-1)!.text)![1];
    mails.length = 0;
    return () => resetCode(req("/api/auth/password/reset-code", { email, code, password: "a new password" }, { token: null }));
  };

  // Kev, 2026-11-07: a reset is the native email login's; "bei x und google nur für die plattformen".
  const STILL = "still sign in to it, as a reset changes only the Enki password. If a login is not yours, disconnect it in Settings, Profile, Connected accounts. If the account has security factors, disconnecting asks you to confirm with every one of them.\n\n";

  it("every address hears; the Google and X logins stay and are named, masked, with how to disconnect one", async () => {
    const reset = await seedReset();
    google(SECOND);
    db.tables.auth_identities.push({ user_id: U, provider: "x", subject: "x1", email: null, handle: "kevx" });
    usersEmail("owner-users@example.test");
    emailFactor("owner-factor@example.test");
    const before = Date.now();
    expect((await reset()).status).toBe(200);
    expect(resetMails().map((m) => m.to)).toEqual([LOGIN, SECOND, "owner-users@example.test", "owner-factor@example.test"]);
    const { text } = resetMails()[0];
    const stamp = /was reset \((.+?)\)/.exec(text)![1];
    expect(Date.parse(stamp)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(text).toContain(`). This signed out every device.\n\nGoogle (ow…@gmail.test) and X (@ke…) ${STILL}If that was you, there is nothing to do.\n\n`);
    expect(text).toContain("If it was not you, someone reset it with a code sent to your login email, or with your guardians' approval.");
    expect(text).toContain("Secure that email account first, then reset your password again: that signs them out.");
    expect(text).not.toMatch(/contact|support|removed|connect (Google|X) again/i);
    expect(text).not.toContain(SECOND);
    expect(mails).toHaveLength(4);
    expect(db.tables.auth_identities.filter((i) => i.user_id === U).map((i) => i.provider)).toEqual(["google", "x"]);
  });

  it("with no login connected the mail says only that every device was signed out", async () => {
    const reset = await seedReset("owner-alone@example.test");
    expect((await reset()).status).toBe(200);
    const { text } = resetMails()[0];
    expect(text).toMatch(/^The password of your Enki account was reset \([^)]+\)\. This signed out every device\.\n\nIf that was you, there is nothing to do\.\n\nIf it was not you, /);
    expect(text).not.toMatch(/Google|X login|connect/i);
  });

  it("one login is named in the singular, and an X login without a handle by its name", async () => {
    const reset = await seedReset("owner-one@example.test");
    db.tables.auth_identities.push({ user_id: U, provider: "x", subject: "x1", email: null });
    expect((await reset()).status).toBe(200);
    expect(resetMails()[0].text).toContain(`. This signed out every device.\n\nX still signs in to it, as a reset changes only the Enki password. If a login`);
  });

  it("a login list that cannot be read: the mail says any Google or X login still signs in, and every address still hears", async () => {
    const reset = await seedReset("owner-unread@example.test");
    google(SECOND);
    db.state.failNext = { table: "auth_identities", op: "select", code: "XX000" };
    expect((await reset()).status).toBe(200);
    expect(db.state.failNext).toBeNull();
    expect(resetMails().map((m) => m.to)).toEqual(["owner-unread@example.test", SECOND]);
    expect(resetMails()[0].text).toContain(". This signed out every device.\n\nA Google or X login connected to it still signs in, as a reset changes only the Enki password. If a login is not yours, disconnect it");
  });

  it("a mail that fails undoes nothing: the new password stands and the session opens", async () => {
    const reset = await seedReset();
    google(SECOND);
    mailFails.on = true;
    const res = await reset();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
    expect(db.tables.password_credentials.find((c) => c.user_id === U)!.email_verified_at).toBeTruthy();
    expect(db.tables.auth_identities.filter((i) => i.user_id === U)).toHaveLength(1);
  });

  it("an address list that cannot be read undoes nothing either", async () => {
    const reset = await seedReset();
    google(SECOND);
    db.state.failNext = { table: "mfa_factors", op: "select", code: "XX000" };
    const res = await reset();
    expect(res.status).toBe(200);
    expect(db.state.failNext).toBeNull();
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
    expect(resetMails()).toEqual([]);
  });

  it("a guardian recovery's reset tells them too", async () => {
    const R = randomUUID();
    const KEY = "owner-key-kept-in-the-browser";
    db.tables.recovery_requests.push({ id: R, user_id: U, status: "approved", owner_key_hash: createHash("sha256").update(KEY).digest("hex"), expires_at: FUTURE });
    login();
    google(SECOND);
    const res = await guardianComplete(req("/api/recovery/complete", { requestId: R, ownerKey: KEY, password: "a new password" }, { token: null }));
    expect(res.status).toBe(200);
    expect(resetMails().map((m) => m.to)).toEqual([LOGIN, SECOND]);
    expect(resetMails()[0].text).toContain(`. This signed out every device.\n\nGoogle (ow…@gmail.test) still signs in to it, as a reset changes only the Enki password. If a login`);
    expect(db.tables.auth_identities.filter((i) => i.user_id === U)).toHaveLength(1);
  });
});
