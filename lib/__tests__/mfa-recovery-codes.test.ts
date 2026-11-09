import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";

/**
 * Recovery codes (Kev, 2026-11-05: "was is mit wiederherstellungs codes, fix that"; "support weg"). A factor is removed
 * only with every factor, so one code and a signed-in session are the way out for someone who lost one. The real routes
 * and the real session lookup run; the database is a fake, the mail is captured.
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
import { POST as registerVerify } from "../../app/api/auth/passkey/register/verify/route";
import { GET as status } from "../../app/api/auth/mfa/recovery/route";
import { POST as newSet } from "../../app/api/auth/mfa/recovery/codes/route";
import { POST as redeem } from "../../app/api/auth/mfa/recovery/redeem/route";
import { POST as stepUp } from "../../app/api/auth/stepup/route";
import { POST as walletJwt } from "../../app/api/auth/wallet/jwt/route";
import { isStepUpScope, mintStepUpToken, setChallengeCookie } from "../webauthn";
import { normalizeCode } from "../mfa-recovery";
import { everyAddress } from "../security-notice";
import { totpCode } from "../totp";
import { encryptString } from "../crypto";

type Row = Record<string, unknown>;
type Res = Response;
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const SESSION = "sess";
// Another account's rows stand first in every table they could be read from, in every test: a read or a write with no account
// filter lands on them, and the afterEach below sees it. A fake answers maybeSingle with the first row that matches.
const STRANGER = "99999999-9999-4999-8999-999999999999";
const STRANGER_REQUEST = { user_id: STRANGER, failed_attempts: 2, lockouts: 1, locked_until: null, factor: "totp", code_hashes: ["stranger-1", "stranger-2"], code_expires_at: FUTURE, code_sent_at: null, sends_day: null, sends_count: 0 };
// Other accounts' running guardian asks, one of each kind (one ask per account): a new factor's cancel with no account filter
// would close the one of its kind.
const STRANGER_ASKS = (["totp", "passkey", "email"] as const).map((factor, i) => ({ id: `stranger-ask-${factor}`, user_id: `9999999${i}-9999-4999-8999-999999999999`, status: "pending", factor, expires_at: FUTURE }));
const strangerUser = () => {
  const e = encryptString("stranger-users@example.test");
  return { id: STRANGER, handle: "stranger", email_ct: e.encrypted, email_iv: e.iv, email_tag: e.authTag, email_kid: e.kid ?? null, email_verified_at: "2026-10-01T00:00:00Z" };
};

const kind = (k: string) => ({ params: Promise.resolve({ kind: k }) });
const post = (url: string, body: unknown, { token = SESSION, stepUpTokens = [] as string[], cookie = "" } = {}) => new NextRequest(`http://enki.test${url}`, {
  method: "POST",
  headers: { "X-Session-Token": token, ...(stepUpTokens.length ? { "X-StepUp-Token": stepUpTokens.join(",") } : {}), ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
const use = (code: unknown, factor: unknown, token = SESSION) => redeem(post("/api/auth/mfa/recovery/redeem", { code, factor }, { token }));
const asked = (scope: string, f: "passkey" | "totp" | "email", user = U) => mintStepUpToken(user, scope, f);
const newCodes = async (...f: ("passkey" | "totp" | "email")[]) =>
  newSet(post("/api/auth/mfa/recovery/codes", {}, { stepUpTokens: await Promise.all(f.map((x) => asked("recovery-codes", x))) }));

const codes = () => db.tables.mfa_recovery_codes;
const unused = (user = U) => codes().filter((c) => c.user_id === user && !c.used_at);
const attempts = (user = U) => db.tables.mfa_recovery.find((r) => r.user_id === user);

const hashOf = (user: string, code: string) => createHmac("sha256", Buffer.from(hkdfSync("sha256", Buffer.from(process.env.AUTH_PEPPER!, "base64"), new Uint8Array(0), Buffer.from("enki-mfa-recovery-v1"), 32)))
  .update(`${user}:${code.replace(/-/g, "")}`).digest("hex");
const seedCode = (code: string, user = U): Row => {
  const row = { id: randomUUID(), user_id: user, code_hash: hashOf(user, code), used_at: null, created_at: new Date().toISOString() };
  codes().push(row);
  return row;
};
const seedTotp = (user = U) => db.tables.mfa_factors.push({ id: randomUUID(), user_id: user, kind: "totp", secret_ct: "x", confirmed_at: "2026-10-07T00:00:00Z" });
const seedPasskey = (user = U, id = randomUUID()) => db.tables.webauthn_credentials.push({ id, user_id: user, credential_id: id, created_at: "2026-10-07T00:00:00Z" });
const seedEmailFactor = (address: string, user = U) => {
  const e = encryptString(address, user);
  db.tables.mfa_factors.push({ id: randomUUID(), user_id: user, kind: "email", secret_ct: e.encrypted, secret_iv: e.iv, secret_tag: e.authTag, secret_kid: e.kid ?? "", confirmed_at: "2026-10-07T00:00:00Z" });
};
const factorKinds = (user = U) => db.tables.mfa_factors.filter((f) => f.user_id === user).map((f) => f.kind);
const A = "AAAA-BBBB-CCCC-DDDD";
const B = "EEEE-FFFF-GGGG-HHHH";

const startTotp = async () => ((await (await setup(post("/api/auth/mfa/totp", {}), kind("totp"))).json()) as { secret: string }).secret;
const confirmTotp = async (secret: string) => confirm(post("/api/auth/mfa/totp/confirm", { code: totpCode(secret) }), kind("totp"));
const register = () => {
  const issued = NextResponse.json({});
  setChallengeCookie(issued, "pk_reg_challenge", "challenge", U);
  return registerVerify(post("/api/auth/passkey/register/verify", { response: { id: "cred" } }, { cookie: `pk_reg_challenge=${issued.cookies.get("pk_reg_challenge")!.value}` }));
};

beforeEach(() => {
  U = randomUUID(); // the notice limit counts per account
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  Object.assign(db.tables, {
    auth_sessions: [{ token: SESSION, wallet_address: U, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() }],
    users: [strangerUser(), { id: U, handle: "kev" }],
    webauthn_credentials: [],
    mfa_factors: [],
    mfa_recovery: [{ ...STRANGER_REQUEST }],
    mfa_recovery_codes: [],
    consumed_stepup_tokens: [],
    password_credentials: [{ user_id: STRANGER, email: "stranger-login@example.test", email_verified_at: "2026-10-01T00:00:00Z" }],
    auth_identities: [{ user_id: STRANGER, provider: "google", email: "stranger-google@example.test" }],
    bans: [],
    user_wallets: [],
    recovery_requests: structuredClone(STRANGER_ASKS),
  });
  db.state.failing = null;
  db.state.failNext = null;
  db.state.holdNext = null;
  db.state.missing = null;
  db.state.pauseNextRead = null;
  mails.length = 0;
  mailFails.on = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(mails.filter((m) => m.to.startsWith("stranger"))).toEqual([]);
  expect(db.tables.mfa_recovery.find((r) => r.user_id === STRANGER)).toEqual(STRANGER_REQUEST);
  expect((db.tables.recovery_requests ?? []).filter((r) => String(r.id).startsWith("stranger-ask-"))).toEqual(STRANGER_ASKS);
});

describe("a first factor issues the codes", () => {
  // A Google login's address: a first passkey or authenticator needs one (first-factor-address.test.ts).
  beforeEach(() => { db.tables.auth_identities.push({ user_id: U, provider: "google", email: "owner-google@example.test" }); });

  it("an authenticator's confirm answers ten codes in the shown form, once, stored only as a keyed hash", async () => {
    const body = (await (await confirmTotp(await startTotp())).json()) as { confirmed: boolean; recoveryCodes: string[] };
    expect(body.confirmed).toBe(true);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(new Set(body.recoveryCodes).size).toBe(10);
    for (const code of body.recoveryCodes) expect(code).toMatch(CODE);
    expect(codes()).toHaveLength(10);
    const stored = JSON.stringify(codes());
    for (const code of body.recoveryCodes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(code.replace(/-/g, ""));
      expect(codes().some((c) => c.code_hash === hashOf(U, code))).toBe(true);
    }
    expect(codes().every((c) => c.user_id === U && c.used_at === null)).toBe(true);
  });

  it("an email factor's confirm answers them too", async () => {
    await setup(post("/api/auth/mfa/email", { email: "me@example.test" }), kind("email"));
    const code = /code is (\d{6})/.exec(mails[0].text)![1];
    const body = (await (await confirm(post("/api/auth/mfa/email/confirm", { code }), kind("email"))).json()) as { recoveryCodes: string[] };
    expect(body.recoveryCodes).toHaveLength(10);
  });

  it("a passkey's registration answers them too", async () => {
    const body = (await (await register()).json()) as { verified: boolean; recoveryCodes: string[] };
    expect(body.verified).toBe(true);
    expect(body.recoveryCodes).toHaveLength(10);
  });

  it("a second factor with unused codes answers none and leaves them", async () => {
    seedPasskey();
    seedCode(A);
    const secret = await startTotpWithEveryFactor();
    const body = (await (await confirm(post("/api/auth/mfa/totp/confirm", { code: totpCode(secret) }, { stepUpTokens: [await asked("add-factor", "passkey")] }), kind("totp"))).json()) as Row;
    expect(body.confirmed).toBe(true);
    expect(body).not.toHaveProperty("recoveryCodes");
    expect(codes()).toHaveLength(1);
  });

  it("a first factor gets its own set whatever the table holds: the codes from before it stop working", async () => {
    seedCode(A);
    seedCode(B);
    const body = (await (await confirmTotp(await startTotp())).json()) as { recoveryCodes: string[] };
    expect(body.recoveryCodes).toHaveLength(10);
    expect(unused()).toHaveLength(10);
    expect(codes().some((c) => c.code_hash === hashOf(U, A) || c.code_hash === hashOf(U, B))).toBe(false);
  });

  it("whoever planted the first factor loses his codes when the owner sets up his own, and cannot strip it", async () => {
    const planted = ((await (await confirmTotp(await startTotp())).json()) as { recoveryCodes: string[] }).recoveryCodes;
    expect((await use(planted[0], "totp")).status).toBe(200);
    expect(factorKinds()).toEqual([]);
    const own = (await (await register()).json()) as { recoveryCodes: string[] };
    expect(own.recoveryCodes).toHaveLength(10);
    expect(unused()).toHaveLength(10);
    expect((await use(planted[1], "passkey")).status).toBe(400);
    expect(db.tables.webauthn_credentials).toHaveLength(1);
    expect((await use(own.recoveryCodes[0], "passkey")).status).toBe(200);
    expect(db.tables.webauthn_credentials).toEqual([]);
  });

  it("a passkey on an account with a factor and no unused code answers a set; with unused codes none", async () => {
    seedTotp();
    const first = (await (await register()).json()) as { recoveryCodes: string[] };
    expect(first.recoveryCodes).toHaveLength(10);
    const second = (await (await register()).json()) as Row;
    expect(second).toEqual({ verified: true });
    expect(unused()).toHaveLength(10);
  });

  it("a passkey on a further factor leaves the unused codes alone", async () => {
    seedTotp();
    seedCode(A);
    expect(await (await register()).json()).toEqual({ verified: true });
    expect(codes()).toHaveLength(1);
    expect(unused()[0].code_hash).toBe(hashOf(U, A));
  });

  it("factors that cannot be read before a passkey goes in do not cost the passkey: it stands, with no codes", async () => {
    db.state.failNext = { table: "mfa_factors", op: "select", code: "XX000" };
    const res = await register();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true });
    expect(db.tables.webauthn_credentials).toHaveLength(1);
    expect(codes()).toEqual([]);
  });

  it("a first factor whose older rows cannot go still stands, with none in the answer", async () => {
    seedCode(A);
    const secret = await startTotp();
    db.state.failNext = { table: "mfa_recovery_codes", op: "delete", code: "XX000" };
    const res = await confirmTotp(secret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ confirmed: true });
  });

  it("a request that cannot be closed issues no codes: the factor stands, and the panel still offers a set", async () => {
    db.tables.mfa_recovery.push({ user_id: U, failed_attempts: 0, lockouts: 0, locked_until: null, factor: "totp", code_hashes: ["h1", "h2"], sends_count: 0 });
    const secret = await startTotp();
    db.state.failNext = { table: "mfa_recovery", op: "update", code: "XX000" };
    expect(await (await confirmTotp(secret)).json()).toEqual({ confirmed: true });
    expect(codes()).toEqual([]);
  });

  it("mailed codes naming the factor that cannot be closed issue none either: they could remove the new one", async () => {
    const secret = await startTotp();
    db.state.failNext = { table: "mfa_recovery", op: "update", code: "XX000" };
    expect(await (await confirmTotp(secret)).json()).toEqual({ confirmed: true });
    expect(codes()).toEqual([]);
  });

  it("confirming a factor that already counts issues nothing, or one factor could get itself a set", async () => {
    const secret = await startTotp();
    await confirmTotp(secret);
    db.tables.mfa_recovery_codes.length = 0; // every code used up, as on an account from before SQL 74
    db.tables.mfa_factors[0].last_step = 0; // an unused step, so the second confirm passes on its code
    const res = await confirm(post("/api/auth/mfa/totp/confirm", { code: totpCode(secret) }, { stepUpTokens: [await asked("add-factor", "totp")] }), kind("totp"));
    expect(res.status).toBe(200);
    expect((await res.json()) as Row).not.toHaveProperty("recoveryCodes");
    expect(codes()).toEqual([]);
  });

  it.each(["mfa_recovery_codes"])("factor setup still works before SQL 74 ran, with no codes in the answer", async (table) => {
    db.state.missing = table;
    const totp = (await (await confirmTotp(await startTotp())).json()) as Row;
    expect(totp).toEqual({ confirmed: true });
    const passkey = (await (await register()).json()) as Row;
    expect(passkey).toEqual({ verified: true });
  });

  it("a factor whose codes could not be written still stands, with none in the answer", async () => {
    const secret = await startTotp();
    db.state.failNext = { table: "mfa_recovery_codes", op: "insert", code: "XX000" };
    const res = await confirmTotp(secret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ confirmed: true });
    expect(db.tables.mfa_factors[0].confirmed_at).toBeTruthy();
  });

  it("registering a passkey that is already there issues nothing", async () => {
    db.state.failNext = { table: "webauthn_credentials", op: "insert", code: "23505" };
    expect(await (await register()).json()).toEqual({ verified: true });
    expect(codes()).toEqual([]);
  });
});

async function startTotpWithEveryFactor(): Promise<string> {
  const res = await setup(post("/api/auth/mfa/totp", {}, { stepUpTokens: [await asked("add-factor", "passkey")] }), kind("totp"));
  expect(res.status).toBe(200);
  return ((await res.json()) as { secret: string }).secret;
}

describe("a new set", () => {
  it("needs every factor: one of two moves nothing and names what is missing", async () => {
    seedPasskey();
    seedTotp();
    seedCode(A);
    const res = await newCodes("totp");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ stepUp: true, all: true, missing: ["passkey"] });
    expect(codes()).toHaveLength(1);
  });

  it("with every factor answers ten new ones and kills the old set", async () => {
    seedPasskey();
    seedTotp();
    seedCode(A);
    const res = await newCodes("passkey", "totp");
    expect(res.status).toBe(200);
    const { recoveryCodes } = (await res.json()) as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    expect(codes()).toHaveLength(10);
    expect((await use(A, "totp")).status).toBe(400);
    expect((await use(recoveryCodes[0], "totp")).status).toBe(200);
  });

  it("an account with no factor is told to set one up", async () => {
    const res = await newCodes();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ enroll: true });
    expect(codes()).toEqual([]);
  });

  it("a token for another scope does not pass", async () => {
    seedTotp();
    const res = await newSet(post("/api/auth/mfa/recovery/codes", {}, { stepUpTokens: [await asked("wallet", "totp")] }));
    expect(res.status).toBe(401);
    expect(codes()).toEqual([]);
  });

  it("a failed insert leaves the old set working", async () => {
    seedTotp();
    seedCode(A);
    db.state.failNext = { table: "mfa_recovery_codes", op: "insert", code: "XX000" };
    expect((await newCodes("totp")).status).toBe(500);
    expect(unused()).toHaveLength(1);
    expect((await use(A, "totp")).status).toBe(200);
  });

  it("older rows that cannot be read make no new set", async () => {
    seedTotp();
    seedCode(A);
    db.state.failNext = { table: "mfa_recovery_codes", op: "select", code: "XX000", skip: 1 }; // the route's check, then this read
    expect((await newCodes("totp")).status).toBe(500);
    expect(codes()).toHaveLength(1);
  });

  it("a failed delete never leaves zero", async () => {
    seedTotp();
    seedCode(A);
    db.state.failNext = { table: "mfa_recovery_codes", op: "delete", code: "XX000" };
    expect((await newCodes("totp")).status).toBe(500);
    expect((await use(A, "totp")).status).toBe(200);
  });

  it("leaves another account's codes alone", async () => {
    seedTotp();
    const other = randomUUID();
    seedCode(B, other);
    expect((await newCodes("totp")).status).toBe(200);
    expect(unused(other)).toHaveLength(1);
  });

  it("two at once never leave zero: the one that read last holds working codes", async () => {
    seedTotp();
    seedCode(A);
    let release = () => {};
    db.state.holdNext = { table: "mfa_recovery_codes", until: new Promise<void>((r) => { release = r; }), skip: 3 }; // the route's check, its read, its insert
    const slow = newCodes("totp");
    await vi.waitFor(() => expect(codes().length).toBe(11));
    const fast = await newCodes("totp");
    release();
    const late = await slow;
    expect([late.status, fast.status]).toEqual([200, 200]);
    expect(unused()).toHaveLength(10);
    const { recoveryCodes } = (await fast.json()) as { recoveryCodes: string[] };
    expect((await use(recoveryCodes[0], "totp")).status).toBe(200);
  });

  describe("tells the owner when codes he may hold die", () => {
    const told = () => mails.filter((m) => m.subject === "New recovery codes were made for your Enki account");
    const addresses = () => {
      db.tables.password_credentials.push({ user_id: U, email: "owner@example.test", email_verified_at: null });
      db.tables.auth_identities.push({ user_id: U, provider: "google", email: "google@example.test" });
    };

    it("every address, with no code in the text", async () => {
      addresses();
      seedTotp();
      seedCode(A);
      const { recoveryCodes } = (await (await newCodes("totp")).json()) as { recoveryCodes: string[] };
      expect(told().map((m) => m.to).sort()).toEqual(["google@example.test", "owner@example.test"]);
      expect(told()[0].text).toContain("The old ones no longer work.");
      expect(told()[0].text).toContain("reset your password right away");
      for (const code of [A, ...recoveryCodes]) expect(JSON.stringify(told())).not.toContain(code);
    });

    it("nothing when no unused code died: not with none at all, not with another account's, not with used ones", async () => {
      addresses();
      seedTotp();
      seedCode(B, randomUUID());
      expect((await newCodes("totp")).status).toBe(200);
      expect(told()).toEqual([]);
      for (const row of unused()) row.used_at = "2026-11-01T00:00:00Z";
      expect((await newCodes("totp")).status).toBe(200);
      expect(told()).toEqual([]);
    });

    it("the set stands when the notice fails, by mail or by address", async () => {
      addresses();
      seedTotp();
      seedCode(A);
      mailFails.on = true;
      expect((await newCodes("totp")).status).toBe(200);
      mailFails.on = false;
      db.state.failNext = { table: "auth_identities", op: "select", code: "XX000" };
      expect((await newCodes("totp")).status).toBe(200);
      expect(unused()).toHaveLength(10);
    });

    it("a first factor's set over a planter's codes tells them too, and over none it says nothing new", async () => {
      addresses();
      await confirmTotp(await startTotp());
      expect(told()).toEqual([]);
      db.tables.mfa_factors.length = 0;
      expect((await register()).status).toBe(200);
      expect(told().map((m) => m.to).sort()).toEqual(["google@example.test", "owner@example.test"]);
    });
  });
});

describe("using a code", () => {
  it("works exactly once", async () => {
    seedTotp();
    seedCode(A);
    const first = await use(A, "totp");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ removed: true, codesLeft: 1 });
    seedTotp();
    expect((await use(A, "totp")).status).toBe(400);
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("of two at once, one wins: one removal, one replacement", async () => {
    seedTotp();
    seedCode(A);
    const answers = await Promise.all([use(A, "totp"), use(A, "totp")]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(unused()).toHaveLength(1);
    expect(codes().filter((c) => c.used_at)).toHaveLength(1);
  });

  it("two requests past the attempt claim still spend it once: the update's condition holds, not the claim", async () => {
    seedTotp();
    seedPasskey();
    seedCode(A);
    let release = () => {};
    db.state.holdNext = { table: "mfa_recovery_codes", until: new Promise<void>((r) => { release = r; }) }; // the slow one's update, past its claim
    const slow = use(A, "totp");
    await vi.waitFor(() => expect(attempts()?.failed_attempts).toBe(1));
    await new Promise((r) => setTimeout(r, 5));
    const fast = await use(A, "passkey");
    expect(fast.status).toBe(200);
    release();
    expect((await slow).status).toBe(400);
    expect(factorKinds()).toEqual(["totp"]);
    expect(db.tables.webauthn_credentials).toEqual([]);
    expect(codes().filter((c) => c.used_at)).toHaveLength(1);
    expect(unused()).toHaveLength(1);
  });

  it("removes only the named factor", async () => {
    seedPasskey();
    seedTotp();
    seedCode(A);
    expect((await use(A, "totp")).status).toBe(200);
    expect(factorKinds()).toEqual([]);
    expect(db.tables.webauthn_credentials).toHaveLength(1);
  });

  it("leaves the account's other code factor alone", async () => {
    seedTotp();
    seedEmailFactor("me@example.test");
    seedCode(A);
    expect((await use(A, "totp")).status).toBe(200);
    expect(factorKinds()).toEqual(["email"]);
  });

  it("a passkey removal takes every passkey of this account, and only of this one", async () => {
    seedPasskey();
    seedPasskey();
    seedTotp();
    const other = randomUUID();
    seedPasskey(other);
    seedCode(A);
    expect((await use(A, "passkey")).status).toBe(200);
    expect(db.tables.webauthn_credentials.map((c) => c.user_id)).toEqual([other]);
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("leaves another account's factor of that kind alone", async () => {
    seedTotp();
    const other = randomUUID();
    seedTotp(other);
    seedCode(A);
    expect((await use(A, "totp")).status).toBe(200);
    expect(factorKinds(other)).toEqual(["totp"]);
  });

  it("refuses a factor that is not enrolled, spending neither the code nor an attempt", async () => {
    seedTotp();
    seedCode(A);
    const res = await use(A, "passkey");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "That factor is not set up" });
    expect(unused()).toHaveLength(1);
    expect(attempts()?.failed_attempts ?? 0).toBe(0);
    expect(factorKinds()).toEqual(["totp"]);
  });

  // DEC-2026-11-07-36: its yes must not reach a factor of that kind added later. Other accounts' asks of every kind stay (afterEach).
  it("closes a running guardians' ask for the factor it removed, and only that one; a close that fails is logged and removes it anyway", async () => {
    seedTotp();
    seedPasskey();
    seedCode(A);
    seedCode(B);
    db.tables.recovery_requests.push({ id: "mine-totp", user_id: U, status: "pending", factor: "totp", expires_at: FUTURE }, { id: "mine-reset", user_id: U, status: "pending", factor: null, owner_key_hash: "k", expires_at: FUTURE });
    expect((await use(A, "totp")).status).toBe(200);
    const mine = () => db.tables.recovery_requests.filter((r) => r.user_id === U).map((r) => [r.id, r.status]);
    expect(mine()).toEqual([["mine-totp", "cancelled"], ["mine-reset", "pending"]]);
    db.tables.recovery_requests.push({ id: "mine-passkey", user_id: U, status: "pending", factor: "passkey", expires_at: FUTURE });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    db.state.failNext = { table: "recovery_requests", op: "update", code: "XX000" };
    expect((await use(B, "passkey")).status).toBe(200);
    expect(db.state.failNext).toBeNull();
    expect(db.tables.webauthn_credentials.filter((c) => c.user_id === U)).toEqual([]);
    expect(mine()).toEqual([["mine-totp", "cancelled"], ["mine-reset", "pending"], ["mine-passkey", "pending"]]);
    expect(logged).toHaveBeenCalledWith("[mfa-recovery] an ask for a removed factor stays open:", "boom");
  });

  it("before SQL 74 ran (no factor column), a code still removes its factor and logs nothing of the ask", async () => {
    seedTotp();
    seedCode(A);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    db.state.failNext = { table: "recovery_requests", op: "update", code: "42703" };
    expect((await use(A, "totp")).status).toBe(200);
    expect(db.state.failNext).toBeNull();
    expect(factorKinds()).toEqual([]);
    expect(logged.mock.calls.filter((c) => String(c[0]).includes("an ask for a removed factor"))).toEqual([]);
  });

  it("refuses an email factor that does not count on a password account", async () => {
    db.tables.password_credentials.push({ user_id: U, email: "owner@example.test", email_verified_at: "2026-10-01T00:00:00Z" });
    seedEmailFactor("old@example.test");
    seedCode(A);
    expect((await use(A, "email")).status).toBe(404);
    expect(unused()).toHaveLength(1);
  });

  it("refuses an unknown factor and a missing code", async () => {
    seedCode(A);
    expect((await use(A, "sms")).status).toBe(400);
    expect((await use(A, "constructor")).status).toBe(400);
    expect((await use(undefined, "totp")).status).toBe(400);
    expect((await use(12, "totp")).status).toBe(400);
    expect(unused()).toHaveLength(1);
  });

  it("needs a session", async () => {
    seedTotp();
    seedCode(A);
    expect((await use(A, "totp", "nobody")).status).toBe(401);
    expect(unused()).toHaveLength(1);
  });

  it("does not care about case, dashes and spaces, and reads the left-out letters as digits", async () => {
    seedTotp();
    seedCode("0123456789ABCDEF");
    expect((await use(" o123 4567-89ab cdef ", "totp")).status).toBe(200);
    expect(normalizeCode("il-LI oO")).toBe("111100");
  });

  // The dialog numbers the list, and a copy made by selecting it keeps the numbers (DEC-2026-11-07-29).
  it("reads a line copied from the numbered list as its code, spending no try; a code that starts with digits stays whole", async () => {
    seedTotp();
    seedPasskey();
    seedCode(A);
    seedCode("12AB-CDEF-GHJK-MNPQ");
    expect((await use(`10. ${A}`, "totp")).status).toBe(200);
    expect(attempts()?.failed_attempts ?? 0).toBe(0);
    expect((await use(" 3) 12ab-cdef-ghjk-mnpq", "passkey")).status).toBe(200);
    expect(normalizeCode("12AB-CDEF-GHJK-MNPQ")).toBe("12ABCDEFGHJKMNPQ");
  });

  it("replacement: one new code replaces the used one, is answered once and works", async () => {
    seedTotp();
    seedPasskey();
    seedCode(A);
    const body = (await (await use(A, "totp")).json()) as { recoveryCodes: string[]; codesLeft: number };
    expect(body.recoveryCodes).toHaveLength(1);
    expect(body.recoveryCodes[0]).toMatch(CODE);
    expect(body.codesLeft).toBe(1);
    expect(unused()).toHaveLength(1);
    expect((await use(body.recoveryCodes[0], "passkey")).status).toBe(200);
    expect(db.tables.webauthn_credentials).toEqual([]);
  });

  it("a replacement that cannot be written leaves the removal standing, and the answer says none", async () => {
    seedTotp();
    seedCode(A);
    seedCode(B);
    db.state.failNext = { table: "mfa_recovery_codes", op: "insert", code: "XX000" };
    const res = await use(A, "totp");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recoveryCodes: [], codesLeft: 1 });
    expect(factorKinds()).toEqual([]);
  });

  it("if removing the factor fails the code comes back, the factor stays, and it works again", async () => {
    seedTotp();
    seedCode(A);
    db.state.failNext = { table: "mfa_factors", op: "delete", code: "XX000" };
    expect((await use(A, "totp")).status).toBe(500);
    expect(unused()).toHaveLength(1);
    expect(factorKinds()).toEqual(["totp"]);
    expect(mails).toEqual([]);
    expect((await use(A, "totp")).status).toBe(200);
  });

  it("a failed removal brings back the code it spent and no other: one used earlier stays used", async () => {
    seedTotp();
    seedCode(A);
    const earlier = seedCode(B);
    earlier.used_at = "2026-11-01T00:00:00Z";
    db.state.failNext = { table: "mfa_factors", op: "delete", code: "XX000" };
    expect((await use(A, "totp")).status).toBe(500);
    expect(unused()).toHaveLength(1);
    expect(earlier.used_at).toBe("2026-11-01T00:00:00Z");
  });

  it("the same for a passkey", async () => {
    seedPasskey();
    seedCode(A);
    db.state.failNext = { table: "webauthn_credentials", op: "delete", code: "XX000" };
    expect((await use(A, "passkey")).status).toBe(500);
    expect(unused()).toHaveLength(1);
    expect(db.tables.webauthn_credentials).toHaveLength(1);
  });

  it("an address list that cannot be read spends nothing: nobody loses a factor unheard", async () => {
    seedTotp();
    seedCode(A);
    db.state.failing = { table: "auth_identities", code: "XX000" };
    expect((await use(A, "totp")).status).toBe(500);
    expect(unused()).toHaveLength(1);
    expect(factorKinds()).toEqual(["totp"]);
    expect(attempts()?.failed_attempts).toBe(0);
  });

  it("a banned account can use one: its money sits behind the factor", async () => {
    db.tables.bans.push({ id: "b", user_id: U, reason: "x", expires_at: null, lifted_at: null, created_at: "2026-10-01T00:00:00Z" });
    seedTotp();
    seedCode(A);
    expect((await use(A, "totp")).status).toBe(200);
  });
});

describe("wrong codes", () => {
  const wrong = (n: number) => Array.from({ length: n }, (_, i) => `ZZZZ-ZZZZ-ZZZZ-ZZZ${i}`);
  const lockMinutes = () => (Date.parse(String(attempts()?.locked_until)) - Date.now()) / 60_000;

  it("count, and the fifth locks with the fifteen minutes lib/mfa.ts uses", async () => {
    seedTotp();
    seedCode(A);
    const [a, b, c, d, e] = wrong(5);
    for (const [i, guess] of [a, b, c, d].entries()) {
      expect((await use(guess, "totp")).status).toBe(400);
      expect(attempts()?.failed_attempts).toBe(i + 1);
    }
    expect((await use(e, "totp")).status).toBe(429);
    expect(attempts()).toMatchObject({ failed_attempts: 0, lockouts: 1 });
    expect(lockMinutes()).toBeGreaterThan(14.9);
    expect(lockMinutes()).toBeLessThanOrEqual(15);
  });

  it("while locked the right code is refused and stays unused", async () => {
    seedTotp();
    seedCode(A);
    for (const guess of wrong(5)) await use(guess, "totp");
    const res = await use(A, "totp");
    expect(res.status).toBe(429);
    expect(unused()).toHaveLength(1);
    expect(factorKinds()).toEqual(["totp"]);
    expect(attempts()?.failed_attempts).toBe(0);
  });

  it("the lock doubles", async () => {
    seedTotp();
    db.tables.mfa_recovery.push({ user_id: U, failed_attempts: 4, lockouts: 1, locked_until: null, sends_count: 0 });
    expect((await use("wrong", "totp")).status).toBe(429);
    expect(attempts()?.lockouts).toBe(2);
    expect(lockMinutes()).toBeGreaterThan(29.9);
    expect(lockMinutes()).toBeLessThanOrEqual(30);
  });

  it("after the lock a right code works and clears the count", async () => {
    seedTotp();
    seedCode(A);
    db.tables.mfa_recovery.push({ user_id: U, failed_attempts: 2, lockouts: 2, locked_until: new Date(Date.now() - 1000).toISOString(), sends_count: 0 });
    expect((await use(A, "totp")).status).toBe(200);
    expect(attempts()).toMatchObject({ failed_attempts: 0, lockouts: 0, locked_until: null });
  });

  it("a right code on the last try passes and clears the lock that try wrote", async () => {
    seedTotp();
    seedCode(A);
    db.tables.mfa_recovery.push({ user_id: U, failed_attempts: 4, lockouts: 0, locked_until: null, sends_count: 0 });
    expect((await use(A, "totp")).status).toBe(200);
    expect(attempts()).toMatchObject({ failed_attempts: 0, lockouts: 0, locked_until: null });
  });

  it("twenty at once buy one try", async () => {
    seedTotp();
    seedCode(A);
    const answers = await Promise.all(wrong(10).concat(wrong(10)).map((g) => use(g, "totp")));
    expect(answers.filter((r) => r.status === 400)).toHaveLength(1);
    expect(answers.filter((r) => r.status === 409)).toHaveLength(19);
    expect(attempts()?.failed_attempts).toBe(1);
  });

  it("on the last try, parallel requests cannot pass the lock: not even with the right code", async () => {
    seedTotp();
    seedCode(A);
    db.tables.mfa_recovery.push({ user_id: U, failed_attempts: 4, lockouts: 0, locked_until: null, sends_count: 0 });
    const answers = await Promise.all([use("wrong-1", "totp"), use(A, "totp"), use("wrong-2", "totp")]);
    expect(answers[0].status).toBe(429);
    expect(answers[1].status).toBe(409);
    expect(answers[2].status).toBe(409);
    expect(unused()).toHaveLength(1);
    expect(attempts()?.lockouts).toBe(1);
  });

  it("a lock written after the row was read makes the claim miss, in the database", async () => {
    seedTotp();
    seedCode(A);
    db.tables.mfa_recovery.push({ user_id: U, failed_attempts: 1, lockouts: 1, locked_until: null, sends_count: 0 });
    let release = () => {};
    db.state.pauseNextRead = { table: "mfa_recovery", until: new Promise<void>((r) => { release = r; }) };
    const pending = use(A, "totp");
    await new Promise((r) => setTimeout(r, 5));
    attempts()!.locked_until = FUTURE;
    release();
    expect((await pending).status).toBe(409);
    expect(unused()).toHaveLength(1);
  });

  it("a code of another account does not work here, and pays from the caller's attempts", async () => {
    const other = randomUUID();
    seedCode(B, other);
    seedTotp();
    const res = await use(B, "totp");
    expect(res.status).toBe(400);
    expect(unused(other)).toHaveLength(1);
    expect(attempts()?.failed_attempts).toBe(1);
    expect(attempts(other)).toBeUndefined();
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("a row of another account never matches, whatever its hash", async () => {
    const other = randomUUID();
    codes().push({ id: randomUUID(), user_id: other, code_hash: hashOf(U, A), used_at: null });
    seedTotp();
    expect((await use(A, "totp")).status).toBe(400);
    expect(unused(other)).toHaveLength(1);
  });

  it("an attempt counts for this account alone", async () => {
    const other = randomUUID();
    db.tables.mfa_recovery.push({ user_id: other, failed_attempts: 0, lockouts: 0, locked_until: null, sends_count: 0 });
    seedTotp();
    expect((await use("wrong", "totp")).status).toBe(400);
    expect(attempts(other)?.failed_attempts).toBe(0);
    expect(attempts()?.failed_attempts).toBe(1);
  });

  it("a used code is wrong, and counts", async () => {
    seedTotp();
    seedCode(A).used_at = "2026-11-01T00:00:00Z";
    expect((await use(A, "totp")).status).toBe(400);
    expect(attempts()?.failed_attempts).toBe(1);
  });
});

describe("a code removes a factor and does nothing else", () => {
  it("is no step-up factor: the code route knows totp and email only", async () => {
    seedTotp();
    seedCode(A);
    const asCode = await stepUp(post("/api/auth/stepup", { scope: "wallet", factor: "recovery", code: A }));
    expect(asCode.status).toBe(400);
    expect(unused()).toHaveLength(1);
  });

  it("opens no wallet: with another factor left the wallet stays locked", async () => {
    db.tables.auth_sessions[0].stepup_at = null;
    db.tables.password_credentials.push({ user_id: U, email: "owner@example.test", email_verified_at: "2026-10-01T00:00:00Z" });
    seedPasskey();
    seedTotp();
    seedCode(A);
    expect((await use(A, "totp")).status).toBe(200);
    const res = await walletJwt(post("/api/auth/wallet/jwt", {}));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ locked: true });
  });

  it("the scope a new set asks for is a step-up scope, a code's is none", () => {
    expect(isStepUpScope("recovery-codes")).toBe(true);
    expect(isStepUpScope("recovery-redeem")).toBe(false);
  });
});

describe("the owner hears", () => {
  const seedEveryAddress = () => {
    db.tables.password_credentials.push({ user_id: U, email: "Login@Example.test", email_verified_at: null });
    db.tables.auth_identities.push({ user_id: U, provider: "google", email: "google@example.test" }, { user_id: U, provider: "x", email: null }, { user_id: U, provider: "x", email: "login@example.test" });
    const e = encryptString("users@example.test");
    Object.assign(db.tables.users.find((u) => u.id === U)!, { email_ct: e.encrypted, email_iv: e.iv, email_tag: e.authTag, email_kid: e.kid ?? null, email_verified_at: null });
    seedEmailFactor("Factor@example.test");
  };

  it("at every address, deduplicated ignoring case, the factor's own address included once it is the one going", async () => {
    seedEveryAddress();
    seedCode(A);
    seedCode(B);
    expect((await use(A, "email")).status).toBe(404); // a password account's email factor does not count
    db.tables.password_credentials.length = 0;
    expect((await use(A, "email")).status).toBe(200);
    expect(mails.map((m) => m.to).sort()).toEqual(["Factor@example.test", "google@example.test", "login@example.test", "users@example.test"].sort());
    const mail = mails[0];
    expect(mail.subject).toBe("A recovery code was used on your Enki account");
    expect(mail.text).toContain("A recovery code removed your email code from your Enki account");
    expect(mail.text).toContain("2 recovery codes are left.");
    expect(mail.text).toContain("reset your password right away");
  });

  it("everyAddress reads the four sources and keeps the first spelling", async () => {
    seedEveryAddress();
    expect(await everyAddress(db.client, U)).toEqual(["Login@Example.test", "google@example.test", "users@example.test", "Factor@example.test"]);
  });

  it("another account's email factor is no address here", async () => {
    seedEmailFactor("stranger-factor@example.test", STRANGER);
    db.tables.password_credentials.push({ user_id: U, email: "owner@example.test", email_verified_at: null });
    expect(await everyAddress(db.client, U)).toEqual(["owner@example.test"]);
    seedEmailFactor("mine@example.test");
    expect(await everyAddress(db.client, U)).toEqual(["owner@example.test", "mine@example.test"]);
  });

  it("everyAddress throws on any failed read: an outage is not an empty list", async () => {
    db.state.failNext = { table: "password_credentials", op: "select", code: "XX000" };
    await expect(everyAddress(db.client, U)).rejects.toMatchObject({ code: "XX000" });
    db.state.failNext = { table: "auth_identities", op: "select", code: "XX000" };
    await expect(everyAddress(db.client, U)).rejects.toMatchObject({ code: "XX000" });
    db.state.failNext = { table: "users", op: "select", code: "XX000" };
    await expect(everyAddress(db.client, U)).rejects.toMatchObject({ code: "XX000" });
  });

  it("a users email that does not open is no address and stops nothing", async () => {
    Object.assign(db.tables.users.find((u) => u.id === U)!, { email_ct: "broken", email_iv: "broken", email_tag: "broken", email_kid: null });
    db.tables.password_credentials.push({ user_id: U, email: "owner@example.test", email_verified_at: null });
    expect(await everyAddress(db.client, U)).toEqual(["owner@example.test"]);
  });

  it("names the passkeys and the authenticator app, and one code in the singular", async () => {
    db.tables.password_credentials.push({ user_id: U, email: "owner@example.test", email_verified_at: null });
    seedPasskey();
    seedTotp();
    seedCode(A);
    const { recoveryCodes } = (await (await use(A, "totp")).json()) as { recoveryCodes: string[] };
    expect(mails[0].text).toContain("removed your authenticator app");
    expect(mails[0].text).toContain("1 recovery code is left.");
    await use(recoveryCodes[0], "passkey");
    expect(mails[1].text).toContain("removed your passkeys");
  });

  it("past the limiter: a fourth removal in an hour is still told", async () => {
    db.tables.password_credentials.push({ user_id: U, email: "owner@example.test", email_verified_at: null });
    for (const code of [A, B, "JJJJ-KKKK-MMMM-NNNN", "PPPP-QQQQ-RRRR-SSSS"]) {
      seedTotp();
      seedCode(code);
      expect((await use(code, "totp")).status).toBe(200);
    }
    expect(mails).toHaveLength(4);
  });

  it("the raw code reaches no mail and no log", async () => {
    const logged: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
    db.tables.password_credentials.push({ user_id: U, email: "owner@example.test", email_verified_at: null });
    seedTotp();
    seedCode(A);
    const { recoveryCodes } = (await (await use(A, "totp")).json()) as { recoveryCodes: string[] };
    await use("WRNG-WRNG-WRNG-WRNG", "totp");
    db.state.failNext = { table: "mfa_recovery_codes", op: "update", code: "XX000" };
    await use(recoveryCodes[0], "totp");
    const heard = JSON.stringify(mails) + logged.join("\n");
    for (const raw of [A, A.replace(/-/g, ""), recoveryCodes[0], recoveryCodes[0].replace(/-/g, ""), "WRNG"]) expect(heard).not.toContain(raw);
  });

  it("a mail that fails leaves the removal standing", async () => {
    db.tables.password_credentials.push({ user_id: U, email: "owner@example.test", email_verified_at: null });
    seedTotp();
    seedCode(A);
    mailFails.on = true;
    expect((await use(A, "totp")).status).toBe(200);
    expect(factorKinds()).toEqual([]);
  });
});

describe("what Settings reads", () => {
  const read = () => status(new NextRequest("http://enki.test/api/auth/mfa/recovery", { headers: { "X-Session-Token": SESSION } }));

  it("counts this account's unused codes", async () => {
    seedCode(A);
    seedCode(B);
    seedCode("JJJJ-KKKK-MMMM-NNNN").used_at = "2026-11-01T00:00:00Z";
    seedCode("PPPP-QQQQ-RRRR-SSSS", randomUUID());
    expect(await (await read()).json()).toMatchObject({ available: true, codesLeft: 2 });
  });

  it("needs a session", async () => {
    expect((await status(new NextRequest("http://enki.test/api/auth/mfa/recovery"))).status).toBe(401);
  });

  it.each(["PGRST205", "42P01"])("before SQL 74 ran (%s) says so, with every new route answering 503", async (code) => {
    seedTotp();
    db.state.failing = { table: "mfa_recovery_codes", code };
    expect(await (await read()).json()).toEqual({ available: false, codesLeft: 0, addresses: 0, mailRefused: null, guardians: null });
    const res = await newCodes("totp");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "This is not available yet" });
    db.state.failing = { table: "mfa_recovery", code };
    const used = await use(A, "totp");
    expect(used.status).toBe(503);
    expect(await used.json()).toEqual({ error: "This is not available yet" });
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("any other read error is no 'not available': it is an error", async () => {
    db.state.failing = { table: "mfa_recovery_codes", code: "XX000" };
    expect((await read()).status).toBe(500);
  });
});

describe("what the owner sees", () => {
  const source = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));
  const area = source("components", "settings", "RecoveryCodes.tsx");

  it("the dialog says it once, with Copy and I saved them, and only that closes it, once one code is typed back", () => {
    expect(area).toContain("Save these recovery codes. Each works once. If you lose a factor, one code removes it. They are not shown again.");
    expect(area).toContain("navigator.clipboard.writeText(codes.join");
    expect(area).toContain("onClick={done} disabled={!typed.trim()}>I saved them</button>");
    expect(area).toContain("const done = () => (sameCode(typed, codes[n - 1]) ? onClose() : setWrong(true));");
    expect(area).toContain('<div className="set-pay-overlay">');
  });

  it("a first factor's codes open it before anything else, from the code factors and from a passkey", () => {
    const factors = source("components", "settings", "CodeFactors.tsx");
    expect(factors).toContain("if (recoveryCodes?.length) onCodes?.(recoveryCodes);");
    const panel = source("components", "settings", "RecoveryPanel.tsx");
    expect(panel).toContain("<CodeFactors onChange={recoveryChanged} onCodes={setFirstCodes} />");
    expect(panel).toContain("if (codes?.length) setFirstCodes(codes);");
    expect(panel).toContain("{firstCodes && <RecoveryCodesDialog codes={firstCodes} onClose={() => setFirstCodes(null)} />}");
    expect(source("hooks", "usePasskey.ts")).toContain("return (verify.data.recoveryCodes ?? null) as string[] | null;");
  });

  it("Settings shows codes left and New codes, and asks every factor for them", () => {
    expect(area).toContain('guarded("recovery-codes"');
    expect(area).toContain("{data.codesLeft} left");
  });

  it("a removal refetches the factors, so every surface updates, and the panel's passkey list", () => {
    expect(area).toContain("queryClient.invalidateQueries({ queryKey: STEPUP_FACTORS_KEY })");
    expect(source("components", "settings", "RecoveryPanel.tsx")).toContain("<RecoveryCodes onRemoved={loadPasskeys} />");
  });
});
