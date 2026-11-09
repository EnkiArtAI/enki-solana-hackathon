import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * A session under ten minutes old can plant the first factor on a factor-free
 * account (a token stolen at login, an inbox holder after a reset), and every
 * step-up is then the planter's. The owner hears when the factor counts, not
 * after the wallet moved. The real routes run; the database is a fake, the mail
 * is captured.
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
let U = "";
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async () => U,
  resolveSessionUserWithBan: async () => ({ userId: U, ban: null, wallet: U }),
}));
vi.mock("@/lib/auth", () => ({ requireAuth: async () => ({ walletAddress: U }), authRefusal: () => NextResponse.json({}, { status: 401 }) }));
const verified = vi.hoisted(() => ({ on: true }));
vi.mock("@simplewebauthn/server", async (orig) => ({
  ...(await orig<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: async () => (verified.on
    ? { verified: true, registrationInfo: { credential: { id: "cred", publicKey: new Uint8Array(4), counter: 0, transports: [] } } }
    : { verified: false }),
}));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { POST as setup } from "../../app/api/auth/mfa/[kind]/route";
import { POST as confirm } from "../../app/api/auth/mfa/[kind]/confirm/route";
import { POST as registerVerify } from "../../app/api/auth/passkey/register/verify/route";
import { mintStepUpToken, setChallengeCookie } from "../webauthn";
import { totpCode } from "../totp";
import { RESET_ADVICE } from "../mfa";

const kind = (k: string) => ({ params: Promise.resolve({ kind: k }) });
const post = (url: string, body: unknown, cookie?: string) => new NextRequest(`http://enki.test${url}`, {
  method: "POST",
  headers: { "X-Session-Token": "sess", ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
const startTotp = async () => ((await (await setup(post("/api/auth/mfa/totp", {}), kind("totp"))).json()) as { secret: string }).secret;
const register = () => {
  const issued = NextResponse.json({});
  setChallengeCookie(issued, "pk_reg_challenge", "challenge", U);
  return registerVerify(post("/api/auth/passkey/register/verify", { response: { id: "cred" } }, `pk_reg_challenge=${issued.cookies.get("pk_reg_challenge")!.value}`));
};

beforeEach(() => {
  U = randomUUID(); // the notice limit counts per account
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  Object.assign(db.tables, {
    auth_sessions: [{ token: "sess", wallet_address: U, created_at: new Date().toISOString() }],
    users: [{ id: U, handle: "kev" }],
    webauthn_credentials: [],
    mfa_factors: [],
    consumed_stepup_tokens: [],
    auth_identities: [],
    password_credentials: [{ user_id: U, email: "owner@example.test", email_verified_at: "2026-10-01T00:00:00.000Z" }],
  });
  db.state.failing = null;
  db.state.failNext = null;
  mails.length = 0;
  mailFails.on = false;
  verified.on = true;
});

describe("a factor that starts to count tells the owner", () => {
  it("an authenticator: at the confirm, not at the setup, and not for a wrong code", async () => {
    const secret = await startTotp();
    expect(mails).toEqual([]);
    expect((await confirm(post("/x", { code: "000000" }), kind("totp"))).status).toBe(400);
    expect(mails).toEqual([]);
    expect((await confirm(post("/x", { code: totpCode(secret) }), kind("totp"))).status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("owner@example.test");
    expect(mails[0].subject).toBe("A security factor was added to your Enki account");
    expect(mails[0].text).toContain("An authenticator app was added");
    expect(mails[0].text).toMatch(/\d{2}:\d{2}:\d{2} GMT/);
    expect(mails[0].text).toMatch(/If it was not/);
    expect(mails[0].text).toContain("reset your password right away. A reset signs you out on every device.");
    expect(mails[0].text).toContain("you have no password to reset");
    expect(mails[0].text).not.toContain("Then open Settings, Recovery, Lost a factor, to remove it.");
  });

  it("a wallet account, which has no password and no Google or X, reads what holds for it, in the code mail and the notice", async () => {
    const advice = "If you only sign in with a wallet, Google or X you have no password to reset: secure that wallet or account.";
    db.tables.password_credentials = [];
    db.tables.users = [{ id: U, origin: "wallet" }];
    expect((await setup(post("/api/auth/mfa/email", { email: "mine@example.test" }), kind("email"))).status).toBe(200);
    const code = mails[0].text.match(/\b(\d{6})\b/)![1];
    expect(mails[0].text).toContain(advice);
    mails.length = 0;
    expect((await confirm(post("/x", { code }), kind("email"))).status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("mine@example.test");
    expect(mails[0].text).toContain(advice);
  });

  it("an email code, to the account's own address and to the one just planted, never only to that one", async () => {
    db.tables.password_credentials = [];
    db.tables.auth_identities.push({ user_id: U, provider: "google", email: "owner@gmail.test" });
    expect((await setup(post("/api/auth/mfa/email", { email: "planted@example.test" }), kind("email"))).status).toBe(200);
    const code = mails[0].text.match(/\b(\d{6})\b/)![1];
    expect(mails[0].text).toContain("reset your password right away. A reset signs you out on every device.");
    expect(mails[0].text).toContain("you have no password to reset");
    mails.length = 0;
    expect((await confirm(post("/x", { code }), kind("email"))).status).toBe(200);
    expect(mails.map((m) => m.to)).toEqual(["owner@gmail.test", "planted@example.test"]);
    expect(mails[0].text).toContain("An email code was added");
  });

  it("a passkey, once it is stored", async () => {
    expect((await register()).status).toBe(200);
    expect(db.tables.webauthn_credentials).toHaveLength(1);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("owner@example.test");
    expect(mails[0].text).toContain("A passkey was added");
  });

  it("reaches an unconfirmed login email", async () => {
    db.tables.password_credentials[0].email_verified_at = null;
    expect((await register()).status).toBe(200);
    expect(mails.map((m) => m.to)).toEqual(["owner@example.test"]);
  });

  it("a passkey already registered, refused or not stored tells nobody", async () => {
    db.state.failNext = { table: "webauthn_credentials", op: "insert", code: "23505" };
    expect((await register()).status).toBe(200);
    db.state.failNext = { table: "webauthn_credentials", op: "insert", code: "XX000" };
    expect((await register()).status).toBe(500);
    verified.on = false;
    expect((await register()).status).toBe(400);
    expect(mails).toEqual([]);
  });

  it("a mail that fails blocks nothing, and neither does an account with no address", async () => {
    mailFails.on = true;
    expect((await register()).status).toBe(200);
    mailFails.on = false;
    // A further factor, as a first passkey or authenticator needs an address (first-factor-address.test.ts).
    db.tables.password_credentials = [];
    const withToken = async (r: NextRequest) => { r.headers.set("X-StepUp-Token", await mintStepUpToken(U, "add-factor", "passkey")); return r; };
    const { secret } = (await (await setup(await withToken(post("/api/auth/mfa/totp", {})), kind("totp"))).json()) as { secret: string };
    expect((await confirm(await withToken(post("/x", { code: totpCode(secret) })), kind("totp"))).status).toBe(200);
    expect(mails).toEqual([]);
  });
});

describe("the factor-added mail names only the ways this account has to remove a factor it did not add (DEC-2026-11-07-20)", () => {
  const STRANGER = "99999999-9999-4999-8999-999999999999";
  const added = () => mails.filter((m) => m.subject === "A security factor was added to your Enki account");
  const ends = (text: string, tail: string) => expect(text.endsWith(`${RESET_ADVICE}${tail}`), text).toBe(true);
  const NO_WAY = " This account has no way to remove it now: no recovery code from before this factor, fewer than two guardians who can be asked, and fewer than two email addresses";
  const guardian = (user: string, value: string) => db.tables.recovery_guardians.push({ id: randomUUID(), user_id: user, guardian_type: "email", value, status: "confirmed" });
  const unusedCode = (user: string) => db.tables.mfa_recovery_codes.push({ id: randomUUID(), user_id: user, code_hash: randomUUID(), used_at: null });
  const withToken = async (r: NextRequest) => { r.headers.set("X-StepUp-Token", await mintStepUpToken(U, "add-factor", "passkey")); return r; };
  // Another account's unused code and two confirmed guardians stand first: a read with no account filter would count them.
  beforeEach(() => {
    Object.assign(db.tables, { mfa_recovery: [], mfa_recovery_codes: [], recovery_guardians: [], recovery_requests: [], recovery_settings: [] });
    unusedCode(STRANGER);
    guardian(STRANGER, "s1@friends.test");
    guardian(STRANGER, "s2@friends.test");
  });

  it("a first authenticator on a password account with only its login and one guardian: no way, said plainly, and the set goes to whoever added it", async () => {
    guardian(U, "only@friends.test");
    const secret = await startTotp();
    const res = await confirm(post("/x", { code: totpCode(secret) }), kind("totp"));
    expect(((await res.json()) as { recoveryCodes?: string[] }).recoveryCodes).toHaveLength(10);
    expect(added()).toHaveLength(1);
    ends(added()[0].text, `${NO_WAY}.`);
  });

  it("a further authenticator or passkey that came with a new set, as none was left: no code is named", async () => {
    db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: "pk", created_at: "2026-10-07T00:00:00Z" });
    const { secret } = (await (await setup(await withToken(post("/api/auth/mfa/totp", {})), kind("totp"))).json()) as { secret: string };
    const res = await confirm(await withToken(post("/x", { code: totpCode(secret) })), kind("totp"));
    expect(((await res.json()) as { recoveryCodes?: string[] }).recoveryCodes).toHaveLength(10);
    ends(added()[0].text, `${NO_WAY}.`);
    mails.length = 0;
    db.tables.mfa_recovery_codes = db.tables.mfa_recovery_codes.filter((c) => c.user_id !== U);
    db.tables.mfa_factors = db.tables.mfa_factors.filter((f) => f.user_id !== U);
    const second = await register();
    expect(((await second.json()) as { recoveryCodes?: string[] }).recoveryCodes).toHaveLength(10);
    ends(added()[0].text, `${NO_WAY}.`);
  });

  it("a first factor whose set could not be written, beside older codes, names no code: those may be whoever planted before", async () => {
    unusedCode(U);
    db.state.failNext = { table: "mfa_recovery_codes", op: "insert", code: "XX000" };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await register();
    quiet.mockRestore();
    expect(((await res.json()) as { recoveryCodes?: string[] }).recoveryCodes).toBeUndefined();
    ends(added()[0].text, `${NO_WAY}.`);
  });

  it("a passkey whose factor read failed counts as a first factor here, so no code is named", async () => {
    db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: "pk", created_at: "2026-10-07T00:00:00Z" });
    unusedCode(U);
    db.state.failNext = { table: "webauthn_credentials", op: "select", code: "XX000" };
    expect((await register()).status).toBe(200);
    expect(db.state.failNext).toBeNull();
    ends(added()[0].text, `${NO_WAY}.`);
  });

  it("a further authenticator beside a passkey, with an unused code from before: that code", async () => {
    db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: "pk", created_at: "2026-10-07T00:00:00Z" });
    unusedCode(U);
    const { secret } = (await (await setup(await withToken(post("/api/auth/mfa/totp", {})), kind("totp"))).json()) as { secret: string };
    const res = await confirm(await withToken(post("/x", { code: totpCode(secret) })), kind("totp"));
    expect(((await res.json()) as { recoveryCodes?: string[] }).recoveryCodes).toBeUndefined();
    ends(added()[0].text, " Then remove it in Settings, Recovery, Lost a factor, with a recovery code you saved before it.");
  });

  it("a first passkey with two guardians and two addresses: those two, and no code, as its set went to whoever added it", async () => {
    db.tables.auth_identities.push({ user_id: U, provider: "google", subject: "g-owner", email: "owner@gmail.test" });
    guardian(U, "g1@friends.test");
    guardian(U, "g2@friends.test");
    unusedCode(U); // an older code: a first factor's set replaces it
    expect((await register()).status).toBe(200);
    expect(added().map((m) => m.to)).toEqual(["owner@example.test", "owner@gmail.test"]);
    ends(added()[0].text, " Then remove it in Settings, Recovery, Lost a factor, with your guardians' yes or a code to each of your email addresses.");
  });

  it("a first email code whose own address would be the second: its address does not count", async () => {
    db.tables.password_credentials = [];
    db.tables.users = [{ id: U, origin: "wallet" }];
    db.tables.auth_identities.push({ user_id: U, provider: "google", subject: "g-owner", email: "owner@gmail.test" });
    expect((await setup(post("/api/auth/mfa/email", { email: "mine@example.test" }), kind("email"))).status).toBe(200);
    const code = mails[0].text.match(/\b(\d{6})\b/)![1];
    expect((await confirm(post("/x", { code }), kind("email"))).status).toBe(200);
    ends(added()[0].text, `${NO_WAY} besides the new code's.`);
  });

  it("before SQL 74 ran, and when a read fails, it names no way at all", async () => {
    db.state.missing = "mfa_recovery";
    expect((await register()).status).toBe(200);
    ends(added()[0].text, "");
    db.state.missing = null;
    mails.length = 0;
    db.tables.webauthn_credentials = [];
    db.state.failNext = { table: "recovery_guardians", op: "select", code: "XX000" };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await register()).status).toBe(200);
    quiet.mockRestore();
    expect(db.state.failNext).toBeNull();
    ends(added()[0].text, "");
  });
});
