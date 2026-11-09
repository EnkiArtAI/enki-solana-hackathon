import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";

/**
 * A first factor needs an address (Kev, 2026-11-05: "fix the offene sachen", on DEC-2026-11-05-49 point 2). An account with
 * no email anywhere (an X account that gave none, a wallet account) adds Code by email before a first passkey or authenticator
 * app, so a lost factor has a way out and the security mails reach someone. Code by email itself stays allowed first: its
 * confirm is the address. The real routes and the real session lookup run; the database is a fake, the mail is captured.
 * Honest limit: a planter with a fresh session can add his own address first; this is for the owner, not against him.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string; subject: string; text: string }) => { mails.push(m); return { ok: true }; } }));
let U = "";
vi.mock("@/lib/auth", () => ({ requireAuth: async () => ({ walletAddress: U }), authRefusal: () => NextResponse.json({}, { status: 401 }) }));
vi.mock("@simplewebauthn/server", async (orig) => ({
  ...(await orig<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: async () => ({ verified: true, registrationInfo: { credential: { id: "cred", publicKey: new Uint8Array(4), counter: 0, transports: [] } } }),
}));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { POST as setup } from "../../app/api/auth/mfa/[kind]/route";
import { POST as confirm } from "../../app/api/auth/mfa/[kind]/confirm/route";
import { POST as passkeyOptions } from "../../app/api/auth/passkey/register/options/route";
import { POST as passkeyVerify } from "../../app/api/auth/passkey/register/verify/route";
import { GET as factorsRead } from "../../app/api/auth/stepup/route";
import { ADDRESS_FIRST, ADDRESS_FIRST_X, mintStepUpToken, setChallengeCookie } from "../webauthn";
import { encryptString } from "../crypto";
import { totpCode } from "../totp";

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
// Another account's rows stand first in every table a read could hit: an address read with no account filter would find them.
const STRANGER = "99999999-9999-4999-8999-999999999999";
const strangerRows = () => {
  const e = encryptString("stranger-users@example.test");
  const f = encryptString("stranger-factor@example.test", STRANGER);
  return {
    users: [{ id: STRANGER, handle: "stranger", email_ct: e.encrypted, email_iv: e.iv, email_tag: e.authTag, email_kid: e.kid ?? null, email_verified_at: "2026-10-01T00:00:00Z" }],
    password_credentials: [{ user_id: STRANGER, email: "stranger-login@example.test", email_verified_at: "2026-10-01T00:00:00Z" }],
    // Its X login too: an X lookup with no account filter would take a wallet account for an X one.
    auth_identities: [{ user_id: STRANGER, provider: "google", subject: "sg", email: "stranger-google@example.test" }, { user_id: STRANGER, provider: "x", subject: "sx", email: null }],
    mfa_factors: [{ id: randomUUID(), user_id: STRANGER, kind: "email", secret_ct: f.encrypted, secret_iv: f.iv, secret_tag: f.authTag, secret_kid: f.kid ?? "", confirmed_at: "2026-10-07T00:00:00Z" }],
    webauthn_credentials: [{ id: randomUUID(), user_id: STRANGER, credential_id: "stranger", created_at: "2026-10-07T00:00:00Z" }],
  };
};

const kind = (k: string) => ({ params: Promise.resolve({ kind: k }) });
const post = (url: string, body: unknown, { stepUp = "", cookie = "" } = {}) => new NextRequest(`http://enki.test${url}`, {
  method: "POST",
  headers: { "X-Session-Token": "s", ...(stepUp ? { "X-StepUp-Token": stepUp } : {}), ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
const startTotp = (stepUp = "") => setup(post("/api/auth/mfa/totp", {}, { stepUp }), kind("totp"));
const verify = () => {
  const issued = NextResponse.json({});
  setChallengeCookie(issued, "pk_reg_challenge", "challenge", U);
  return passkeyVerify(post("/api/auth/passkey/register/verify", { response: { id: "cred" } }, { cookie: `pk_reg_challenge=${issued.cookies.get("pk_reg_challenge")!.value}` }));
};
const read = async () => (await factorsRead(new NextRequest("http://enki.test/api/auth/stepup", { headers: { "X-Session-Token": "s" } }))).json() as Promise<Record<string, unknown>>;
const mineFactors = () => db.tables.mfa_factors.filter((f) => f.user_id === U);
const minePasskeys = () => db.tables.webauthn_credentials.filter((c) => c.user_id === U);
const refused = async (res: Response) => {
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: ADDRESS_FIRST, addressFirst: true });
};

let seed: ReturnType<typeof strangerRows>;
beforeEach(() => {
  U = randomUUID();
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  seed = strangerRows();
  Object.assign(db.tables, structuredClone(seed), {
    auth_sessions: [{ token: "s", wallet_address: U, wallet_type: "wallet", expires_at: FUTURE, created_at: new Date().toISOString() }],
    mfa_recovery: [], mfa_recovery_codes: [], consumed_stepup_tokens: [], user_wallets: [], bans: [],
  });
  db.tables.users.push({ id: U, handle: "kev", origin: "wallet" });
  db.state.failing = null;
  db.state.failNext = null;
  mails.length = 0;
});
afterEach(() => {
  expect(mails.filter((m) => m.to.startsWith("stranger"))).toEqual([]);
  for (const table of ["users", "password_credentials", "auth_identities", "mfa_factors", "webauthn_credentials"] as const) {
    expect(db.tables[table].filter((r) => r.user_id === STRANGER || r.id === STRANGER), table).toEqual(seed[table]);
  }
});

describe("an account with no email anywhere", () => {
  it("is told to add Code by email before a first authenticator app or passkey, and nothing is written", async () => {
    // One address warns, it removes nothing: the mail path needs two (DEC-2026-11-07-30).
    expect(ADDRESS_FIRST).toBe("Add Code by email first: that address is where we warn you when someone adds a way to sign in, adds a security factor or moves your money. " +
      "It cannot remove a lost factor by itself: that takes a recovery code, two guardians, or a code to each of two email addresses.");
    await refused(await startTotp());
    expect(mineFactors()).toEqual([]);
    const options = await passkeyOptions(post("/api/auth/passkey/register/options", {}));
    await refused(options);
    expect(options.cookies.get("pk_reg_challenge")).toBeUndefined();
    expect(await read()).toMatchObject({ factors: [], addressFirst: ADDRESS_FIRST });
    expect(mails).toEqual([]);
  });

  it("hears it before it is sent to sign in again: a fresh login would not change it", async () => {
    db.tables.auth_sessions[0].created_at = new Date(Date.now() - 11 * 60_000).toISOString();
    await refused(await startTotp());
    await refused(await passkeyOptions(post("/api/auth/passkey/register/options", {})));
  });

  it("an X login that gave no email has none either, and hears it in X's words", async () => {
    db.tables.auth_identities.push({ user_id: U, provider: "x", subject: "x1", email: null });
    const res = await startTotp();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: ADDRESS_FIRST_X, addressFirst: true });
  });

  it("asked again at the confirm and the passkey's verify: an address gone since the setup adds nothing", async () => {
    db.tables.auth_identities.push({ user_id: U, provider: "google", subject: "g1", email: "kev@gmail.test" });
    const { secret } = (await (await startTotp()).json()) as { secret: string };
    db.tables.auth_identities = db.tables.auth_identities.filter((i) => i.user_id !== U);
    await refused(await confirm(post("/api/auth/mfa/totp/confirm", { code: totpCode(secret) }), kind("totp")));
    expect(mineFactors()[0].confirmed_at).toBeNull();
    expect(db.tables.mfa_recovery_codes).toEqual([]);
    const res = await verify();
    await refused(res);
    expect(res.cookies.get("pk_reg_challenge")?.value).toBe("");
    expect(minePasskeys()).toEqual([]);
    expect(mails).toEqual([]);
  });

  it("Code by email may come first: its confirm is the address, and then the others are open", async () => {
    expect((await setup(post("/api/auth/mfa/email", { email: "kev@example.test" }), kind("email"))).status).toBe(200);
    const code = /verification code is (\d{6})/.exec(mails.at(-1)!.text)![1];
    expect((await confirm(post("/api/auth/mfa/email/confirm", { code }), kind("email"))).status).toBe(200);
    expect(await read()).toMatchObject({ factors: ["email"], addressFirst: null });
    const stepUp = await mintStepUpToken(U, "add-factor", "email");
    expect((await startTotp(stepUp)).status).toBe(200);
  });

  it("a factor that already counts opens the next one, even with no address: only the first waits", async () => {
    db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: "planted-before", created_at: "2026-10-07T00:00:00Z" });
    expect((await startTotp(await mintStepUpToken(U, "add-factor", "passkey"))).status).toBe(200);
    expect(await read()).toMatchObject({ addressFirst: null });
  });

  it("a factor read that fails at the passkey's verify is read again: a passkey in place, no address, and the next one goes in", async () => {
    db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: "planted-before", created_at: "2026-10-07T00:00:00Z" });
    db.state.failNext = { table: "webauthn_credentials", op: "select", code: "XX000" }; // the read before the insert
    const res = await verify();
    expect(res.status).toBe(200);
    expect(db.state.failNext).toBeNull();
    expect(minePasskeys().map((c) => c.credential_id)).toEqual(["planted-before", "cred"]);
  });

  it("a read that fails is a 503, never a pass, and writes nothing", async () => {
    db.state.failNext = { table: "auth_identities", op: "select", code: "XX000" };
    expect((await startTotp()).status).toBe(503);
    expect(mineFactors()).toEqual([]);
  });
});

describe("any address opens it", () => {
  it.each([
    ["a Google login's", () => db.tables.auth_identities.push({ user_id: U, provider: "google", subject: "g1", email: "kev@gmail.test" })],
    ["the email on users", () => {
      const e = encryptString("kev@gmail.test");
      Object.assign(db.tables.users.find((u) => u.id === U)!, { email_ct: e.encrypted, email_iv: e.iv, email_tag: e.authTag, email_kid: e.kid ?? null, email_verified_at: "2026-10-01T00:00:00Z" });
    }],
    ["a password account's login, confirmed or not", () => db.tables.password_credentials.push({ user_id: U, email: "kev@example.test", email_verified_at: null })],
  ])("%s", async (_name, seedAddress) => {
    seedAddress();
    expect((await startTotp()).status).toBe(200);
    expect((await verify()).status).toBe(200);
    expect(minePasskeys()).toHaveLength(1);
    expect(await read()).toMatchObject({ addressFirst: null });
  });
});

describe("an account that signs in with X and has no email (Kev, 2026-11-07: \"das muss in der meldung stehen\")", () => {
  const x = () => db.tables.auth_identities.push({ user_id: U, provider: "x", subject: "x-owner", email: null, handle: "kevx" });
  const X_REFUSED = "Add Code by email first. You sign in with X, and X does not share your email with us. Without one we cannot warn you when someone adds a way to sign in, adds a security factor or moves your money. An email warns you, it cannot unlock your account: it is usually the inbox that resets your X password, so it cannot prove it is you. Lose a factor and your recovery codes without two guardians, and your wallet stays locked.";

  it("is told why an email matters and what it cannot do, in the refusal and in the factors read", async () => {
    x();
    expect(ADDRESS_FIRST_X).toBe(X_REFUSED);
    for (const res of [await startTotp(), await passkeyOptions(post("/api/auth/passkey/register/options", {}))]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: X_REFUSED, addressFirst: true });
    }
    expect(await read()).toMatchObject({ factors: [], addressFirst: X_REFUSED });
    expect(mineFactors()).toEqual([]);
  });

  it("a wallet account keeps its own words, though another account's X login stands first in the table", async () => {
    expect(db.tables.auth_identities.some((i) => i.user_id === STRANGER && i.provider === "x")).toBe(true);
    // A Google login that gave no address is no X login either.
    db.tables.auth_identities.push({ user_id: U, provider: "google", subject: "g-noemail", email: null });
    await refused(await startTotp());
    expect(await read()).toMatchObject({ addressFirst: ADDRESS_FIRST });
  });

  it("with an address it is not refused", async () => {
    x();
    db.tables.auth_identities.push({ user_id: U, provider: "google", subject: "g-owner", email: "owner@gmail.test" });
    expect((await startTotp()).status).toBe(200);
    expect(await read()).toMatchObject({ addressFirst: null });
  });
});

describe("Settings", () => {
  it("says it where the factors are offered, from the factors read, as the mock's card: Add an email, important", () => {
    const panel = readSource(join(__dirname, "..", "..", "components", "settings", "RecoveryPanel.tsx"));
    expect(panel).toContain("const { emailCodes = false, addressFirst = null } = useStepUpFactors().data ?? {};");
    expect(panel).toContain(
      '{addressFirst && (\n          <div className="set-list-item set-soft" role="note" style={{ marginBottom: 12 }}>\n            <div className="set-item-content">\n' +
      '              <div className="set-item-title">Add an email <span className="set-badge-warn">important</span></div>\n' +
      '              <div className="set-item-sub">{addressFirst}</div>\n            </div>\n          </div>\n        )}\n        <div className="set-list-item set-soft">',
    );
  });
});
