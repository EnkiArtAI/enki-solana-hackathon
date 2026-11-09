import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";
import { stubRequiredEnv } from "./_required-env";

/**
 * No recovery code left: one code to EVERY address of the account, all entered, removes the lost factor at once (Kev, 2026-11-07:
 * "keine wartezeit"). Fewer than two addresses: not offered. The real routes and the real session lookup run; the database is a
 * fake, the mail is captured. Another account's rows stand first in every table a read could hit, and stay as they were.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
const mailFails = vi.hoisted(() => ({ on: false, only: null as string | null }));
vi.mock("@/lib/mailer", () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    if (mailFails.on) throw new Error("mail down");
    if (mailFails.only && m.to !== mailFails.only) return { ok: false };
    mails.push(m);
    return { ok: true };
  },
}));
vi.mock("@simplewebauthn/server", async (orig) => ({
  ...(await orig<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: async () => ({ verified: true, registrationInfo: { credential: { id: "cred", publicKey: new Uint8Array(4), counter: 0, transports: [] } } }),
}));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { POST as sendRoute } from "../../app/api/auth/mfa/recovery/mail/route";
import { POST as confirmRoute } from "../../app/api/auth/mfa/recovery/mail/confirm/route";
import { POST as redeem } from "../../app/api/auth/mfa/recovery/redeem/route";
import { POST as newSet } from "../../app/api/auth/mfa/recovery/codes/route";
import { GET as status } from "../../app/api/auth/mfa/recovery/route";
import * as guardiansRoute from "../../app/api/auth/mfa/recovery/guardians/route";
import { POST as registerVerify } from "../../app/api/auth/passkey/register/verify/route";
import { setChallengeCookie } from "../webauthn";
import { RESET_ADVICE } from "../mfa";
import { encryptString } from "../crypto";

const TWO = "Emailing codes needs two email addresses or more, one code to each, not counting the address of an email code you lost.";
// The mail path's refusal for an account with no code left and fewer than two guardians to ask (lib/mfa-recovery.ts tooFew).
const TOO_FEW = `${TWO} No recovery code is left either, and fewer than two guardians can be asked, so a lost factor cannot be removed now.`;

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const SESSION = "sess";
const LOGIN = "owner@example.test";
const GOOGLE = "google@example.test";
const STRANGER = "99999999-9999-4999-8999-999999999999";
// Its live set names passkeys, as a further passkey of this account closes a set naming passkeys: an unfiltered close lands here.
const STRANGER_REQUEST = { user_id: STRANGER, failed_attempts: 2, lockouts: 1, locked_until: null, factor: "passkey", code_hashes: ["stranger-1", "stranger-2"], code_expires_at: FUTURE, code_sent_at: "2026-11-07T00:00:00.000Z", sends_day: null, sends_count: 0 };
const strangerRows = () => {
  const users = encryptString("stranger-users@example.test");
  const factor = encryptString("stranger-factor@example.test", STRANGER);
  return {
    users: [{ id: STRANGER, handle: "stranger", email_ct: users.encrypted, email_iv: users.iv, email_tag: users.authTag, email_kid: users.kid ?? null, email_verified_at: "2026-10-01T00:00:00Z" }],
    password_credentials: [{ user_id: STRANGER, email: "stranger-login@example.test", email_verified_at: "2026-10-01T00:00:00Z" }],
    auth_identities: [{ user_id: STRANGER, provider: "google", email: "stranger-google@example.test" }],
    mfa_factors: [
      { id: randomUUID(), user_id: STRANGER, kind: "email", secret_ct: factor.encrypted, secret_iv: factor.iv, secret_tag: factor.authTag, secret_kid: factor.kid ?? "", confirmed_at: "2026-10-07T00:00:00Z" },
      { id: randomUUID(), user_id: STRANGER, kind: "totp", secret_ct: "x", confirmed_at: "2026-10-07T00:00:00Z" },
    ],
    webauthn_credentials: [{ id: randomUUID(), user_id: STRANGER, credential_id: "stranger", created_at: "2026-10-07T00:00:00Z" }],
    mfa_recovery: [{ ...STRANGER_REQUEST }],
    mfa_recovery_codes: [{ id: "stranger-code", user_id: STRANGER, code_hash: "stranger-hash", used_at: null }],
  };
};

let U = "";
const post = (url: string, body: unknown, { token = SESSION as string | null, cookie = "" } = {}) => new NextRequest(`http://enki.test${url}`, {
  method: "POST",
  headers: { ...(token ? { "X-Session-Token": token } : {}), ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
const send = (factor: unknown, token = SESSION) => sendRoute(post("/api/auth/mfa/recovery/mail", { factor }, { token }));
const confirm = (codes: unknown, token = SESSION) => confirmRoute(post("/api/auth/mfa/recovery/mail/confirm", { codes }, { token }));
const recovery = () => db.tables.mfa_recovery.find((r) => r.user_id === U);
const codeMails = () => mails.filter((m) => m.subject === "Your Enki recovery code");
const codeFor = (address: string) => /for this address is (\d{6})/.exec(codeMails().filter((m) => m.to === address).at(-1)!.text)![1];
const removedMails = () => mails.filter((m) => m.subject === "A factor was removed from your Enki account");
const factorKinds = () => db.tables.mfa_factors.filter((f) => f.user_id === U).map((f) => f.kind);
const passkeys = () => db.tables.webauthn_credentials.filter((c) => c.user_id === U);

const login = (email = LOGIN) => db.tables.password_credentials.push({ user_id: U, email, email_verified_at: "2026-10-01T00:00:00Z" });
const google = (email = GOOGLE) => db.tables.auth_identities.push({ user_id: U, provider: "google", email });
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
const recoveryCode = (used_at: string | null = null) => db.tables.mfa_recovery_codes.push({ id: randomUUID(), user_id: U, code_hash: randomUUID(), used_at });
/** A password account with its login and Google: two addresses, in the order the codes go back. */
const twoAddresses = () => { login(); google(); return [GOOGLE, LOGIN]; };
const sentTo = async (factor = "totp") => {
  const res = await send(factor);
  expect(res.status).toBe(200);
  return ((await res.json()) as { to: string[] }).to;
};

let seed: ReturnType<typeof strangerRows>;
beforeEach(() => {
  U = randomUUID();
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  seed = strangerRows();
  Object.assign(db.tables, structuredClone(seed), {
    auth_sessions: [{ token: SESSION, wallet_address: U, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() }],
    consumed_stepup_tokens: [], bans: [], user_wallets: [], recovery_requests: [], recovery_guardians: [],
  });
  db.tables.users.push({ id: U, handle: "kev" });
  db.state.failing = null;
  db.state.failNext = null;
  db.state.holdNext = null;
  db.state.missing = null;
  mails.length = 0;
  mailFails.on = false;
  mailFails.only = null;
});
afterEach(() => {
  expect(mails.filter((m) => m.to.startsWith("stranger"))).toEqual([]);
  for (const table of ["users", "password_credentials", "auth_identities", "mfa_factors", "webauthn_credentials", "mfa_recovery", "mfa_recovery_codes"] as const) {
    expect(db.tables[table].filter((r) => r.user_id === STRANGER || r.id === STRANGER || r.id === "stranger-code"), table).toEqual(seed[table]);
  }
});

describe("sending the codes", () => {
  it("one code to each address, each its own and only as a keyed hash, for ten minutes, and nothing is removed yet", async () => {
    twoAddresses();
    totp();
    const before = Date.now();
    const res = await send("totp");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, to: ["go…@example.test", "ow…@example.test"] });
    expect(codeMails().map((m) => m.to)).toEqual([GOOGLE, LOGIN]);
    for (const m of codeMails()) {
      expect(m.text).toContain("It is valid for 10 minutes. We sent one code to each of your 2 email addresses: entered together in Settings, Recovery, Lost a factor, they remove your authenticator app from your account at once.");
      expect(m.text).toContain("Never give this code to anyone: Enki never asks for it.");
      expect(m.text).toContain(RESET_ADVICE);
    }
    const row = recovery()!;
    expect(row.factor).toBe("totp");
    expect((row.code_hashes as string[]).length).toBe(2);
    expect(JSON.stringify(row)).not.toContain(codeFor(GOOGLE));
    expect(JSON.stringify(row)).not.toContain(codeFor(LOGIN));
    expect(Date.parse(String(row.code_expires_at)) - before).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
    expect(Date.parse(String(row.code_expires_at)) - before).toBeLessThanOrEqual(10 * 60_000 + 1000);
    expect(factorKinds()).toEqual(["totp"]);
    expect(mails).toHaveLength(2);
  });

  // DEC-2026-11-07-30: only the ways this account has. Another account's unused code and two confirmed guardians stand first.
  it("its refusal says what it needs and names only the other ways this account has", async () => {
    login();
    totp();
    db.tables.recovery_guardians.push(...["s1", "s2"].map((v) => ({ id: randomUUID(), user_id: STRANGER, guardian_type: "email", value: `stranger-${v}@friends.test`, status: "confirmed" })));
    const say = async () => ((await (await send("totp")).json()) as { error: string }).error;
    expect(await say()).toBe(TOO_FEW);
    recoveryCode("2026-11-01T00:00:00Z");
    expect(await say()).toBe(TOO_FEW);
    recoveryCode();
    expect(await say()).toBe(`${TWO} Use a recovery code.`);
    for (const v of ["g1", "g2"]) db.tables.recovery_guardians.push({ id: randomUUID(), user_id: U, guardian_type: "email", value: `${v}@friends.test`, status: "confirmed" });
    expect(await say()).toBe(`${TWO} Use a recovery code or ask your guardians.`);
    db.tables.mfa_recovery_codes = db.tables.mfa_recovery_codes.filter((c) => c.user_id !== U);
    expect(await say()).toBe(`${TWO} No recovery code is left either, so only your guardians can remove a lost factor now.`);
    db.tables.recovery_guardians = db.tables.recovery_guardians.filter((g) => g.user_id !== U || g.value !== "g2@friends.test");
    db.tables.recovery_guardians.push({ id: randomUUID(), user_id: U, guardian_type: "authenticator", value: "Authenticator app", status: "confirmed" });
    expect(await say()).toBe(TOO_FEW);
    expect(mails).toEqual([]);
  });

  it("fewer than two addresses: not offered, nothing written and nothing mailed", async () => {
    login();
    totp();
    const res = await send("totp");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: TOO_FEW });
    expect(recovery()?.code_hashes ?? null).toBeNull();
    expect(mails).toEqual([]);
  });

  it("the same inbox twice, spelled otherwise, is one", async () => {
    login("Owner@Example.test");
    google("owner@example.test");
    totp();
    expect((await send("totp")).status).toBe(409);
    expect(mails).toEqual([]);
  });

  it("an address that opens no login counts as one, and so does none: a wallet account with an email factor alone is refused too", async () => {
    emailFactor("owner-factor@example.test");
    passkey();
    expect((await send("passkey")).status).toBe(409);
    db.tables.mfa_factors = db.tables.mfa_factors.filter((f) => f.user_id !== U);
    expect((await send("passkey")).status).toBe(409);
    expect(mails).toEqual([]);
  });

  it("an email factor named as lost: its own address gets no code and does not count", async () => {
    google("owner@gmail.test");
    usersEmail("owner-users@example.test");
    emailFactor("owner-factor@example.test");
    passkey();
    // Sorted by code unit, ignoring case: "-" comes before "@".
    expect(await sentTo("email")).toEqual(["ow…@example.test", "ow…@gmail.test"]);
    expect(codeMails().map((m) => m.to)).toEqual(["owner-users@example.test", "owner@gmail.test"]);
    mails.length = 0;
    recovery()!.code_sent_at = new Date(Date.now() - 61_000).toISOString();
    expect(await sentTo("passkey")).toEqual(["ow…@example.test", "ow…@example.test", "ow…@gmail.test"]);
    expect(codeMails().map((m) => m.to)).toEqual(["owner-factor@example.test", "owner-users@example.test", "owner@gmail.test"]);
  });

  it("with the email factor named, one address besides it is too few", async () => {
    google("owner@gmail.test");
    emailFactor("owner-factor@example.test");
    expect((await send("email")).status).toBe(409);
    expect(mails).toEqual([]);
  });

  it("refuses a factor that is not set up", async () => {
    twoAddresses();
    totp();
    expect((await send("passkey")).status).toBe(404);
    expect((await send("sms")).status).toBe(400);
    expect(mails).toEqual([]);
  });

  it("one set a minute, and a new set replaces the last: the earlier codes stop working", async () => {
    const to = twoAddresses();
    totp();
    await sentTo();
    const first = to.map(codeFor);
    const again = await send("totp");
    expect(again.status).toBe(429);
    expect(await again.json()).toEqual({ error: "Codes were just sent. Wait a minute before asking for new ones." });
    recovery()!.code_sent_at = new Date(Date.now() - 61_000).toISOString();
    await sentTo();
    expect((await confirm(first)).status).toBe(400);
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("five sets a day", async () => {
    twoAddresses();
    totp();
    await sentTo();
    Object.assign(recovery()!, { sends_count: 5, code_sent_at: new Date(Date.now() - 61_000).toISOString() });
    const res = await send("totp");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "No more codes today. Try again tomorrow." });
  });

  it("two at once send one set", async () => {
    twoAddresses();
    totp();
    const answers = await Promise.all([send("totp"), send("totp")]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 429]);
    expect(codeMails()).toHaveLength(2);
  });

  it("a set with a code that could not be mailed answers 502, thrown or refused", async () => {
    twoAddresses();
    totp();
    mailFails.only = LOGIN;
    expect((await send("totp")).status).toBe(502);
    mailFails.only = null;
    mailFails.on = true;
    recovery()!.code_sent_at = new Date(Date.now() - 61_000).toISOString();
    expect((await send("totp")).status).toBe(502);
  });

  it("needs a session", async () => {
    twoAddresses();
    totp();
    expect((await send("totp", "nobody")).status).toBe(401);
    expect(mails).toEqual([]);
  });
});

describe("entering every code", () => {
  it("in order: the factor goes at once, the unused recovery codes with it, and every address hears", async () => {
    const to = twoAddresses();
    totp();
    recoveryCode();
    recoveryCode("2026-11-01T00:00:00Z");
    await sentTo();
    recovery()!.failed_attempts = 2;
    const before = Date.now();
    const res = await confirm(to.map(codeFor));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(factorKinds()).toEqual([]);
    expect(db.tables.mfa_recovery_codes.filter((c) => c.user_id === U).map((c) => c.used_at)).toEqual(["2026-11-01T00:00:00Z"]);
    expect(recovery()).toMatchObject({ factor: null, code_hashes: null, code_expires_at: null, failed_attempts: 0 });
    expect(removedMails().map((m) => m.to)).toEqual([LOGIN, GOOGLE]);
    const { text } = removedMails()[0];
    expect(Date.parse(/account \((.+?)\)\./.exec(text)![1])).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(text).toMatch(/^A code sent to each of your email addresses removed your authenticator app from your Enki account \([^)]+\)\. /);
    expect(text).toContain("The recovery codes you had left stopped working too: the next factor you add comes with a new set. If that was you, there is nothing else to do.");
    expect(text).toContain(`If it was not, someone reads your email and is using your session: ${RESET_ADVICE}`);
  });

  it("with a factor left the mail names New codes, and a passkey goes with all the others", async () => {
    const to = twoAddresses();
    totp();
    passkey();
    passkey();
    await sentTo("passkey");
    expect((await confirm(to.map(codeFor))).status).toBe(200);
    expect(passkeys()).toEqual([]);
    expect(factorKinds()).toEqual(["totp"]);
    expect(removedMails()[0].text).toContain("The recovery codes you had left stopped working too: New codes in Settings, Recovery, makes a new set.");
  });

  // DEC-2026-11-07-36: its yes must not reach a passkey added later. Another account's running passkey ask stays.
  it("closes a running guardians' ask for the factor it removed, and only that one", async () => {
    const to = twoAddresses();
    totp();
    passkey();
    db.tables.recovery_requests.push(
      { id: "theirs", user_id: STRANGER, status: "pending", factor: "passkey", expires_at: FUTURE },
      { id: "mine", user_id: U, status: "pending", factor: "passkey", expires_at: FUTURE },
      { id: "my-reset", user_id: U, status: "pending", factor: null, owner_key_hash: "k", expires_at: FUTURE },
      { id: "my-old", user_id: U, status: "completed", factor: "passkey", expires_at: FUTURE },
    );
    await sentTo("passkey");
    expect((await confirm(to.map(codeFor))).status).toBe(200);
    expect(db.tables.recovery_requests.map((r) => [r.id, r.status])).toEqual([["theirs", "pending"], ["mine", "cancelled"], ["my-reset", "pending"], ["my-old", "completed"]]);
  });

  it("the removal mail reaches every address, the lost email factor's own included", async () => {
    google("owner@gmail.test");
    usersEmail("owner-users@example.test");
    emailFactor("owner-factor@example.test");
    passkey();
    await sentTo("email");
    expect((await confirm([codeFor("owner-users@example.test"), codeFor("owner@gmail.test")])).status).toBe(200);
    expect(factorKinds()).toEqual([]);
    expect(removedMails().map((m) => m.to)).toEqual(["owner@gmail.test", "owner-users@example.test", "owner-factor@example.test"]);
  });

  it("one wrong code, the codes swapped or one left out removes nothing, and each spends a try", async () => {
    const to = twoAddresses();
    totp();
    await sentTo();
    const right = to.map(codeFor);
    const wrong = String((Number(right[1]) + 1) % 1_000_000).padStart(6, "0");
    expect((await confirm([right[0], wrong])).status).toBe(400);
    expect((await confirm([right[1], right[0]])).status).toBe(right[0] === right[1] ? 200 : 400);
    expect((await confirm([right[0]])).status).toBe(400);
    expect(factorKinds()).toEqual(["totp"]);
    expect(recovery()!.failed_attempts).toBe(3);
    expect(removedMails()).toEqual([]);
  });

  it("dashes and spaces in a code do not matter", async () => {
    const to = twoAddresses();
    totp();
    await sentTo();
    const [a, b] = to.map(codeFor);
    expect((await confirm([`${a.slice(0, 3)} ${a.slice(3)}`, `${b.slice(0, 3)}-${b.slice(3)}`])).status).toBe(200);
  });

  it("codes past their ten minutes are wrong, and count", async () => {
    const to = twoAddresses();
    totp();
    await sentTo();
    recovery()!.code_expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await confirm(to.map(codeFor))).status).toBe(400);
    expect(recovery()!.failed_attempts).toBe(1);
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("five wrong lock it, on the one counter a recovery code uses too", async () => {
    twoAddresses();
    totp();
    await sentTo();
    for (let i = 0; i < 4; i++) expect((await confirm(["000000", "000000"])).status).toBe(400);
    expect((await confirm(["000000", "000000"])).status).toBe(429);
    const locked = await confirm(["000000", "000000"]);
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: "Too many wrong codes. Try again later." });
    expect((await redeem(post("/api/auth/mfa/recovery/redeem", { code: "AAAA-BBBB-CCCC-DDDD", factor: "totp" }))).status).toBe(429);
  });

  it("an address list that changed since the codes went out says so and spends no try; one that shrank to one is too few", async () => {
    const to = twoAddresses();
    totp();
    await sentTo();
    usersEmail("owner-users@example.test");
    const changed = await confirm(to.map(codeFor));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: "Your email addresses changed since the codes went out. Ask for new ones." });
    Object.assign(db.tables.users.find((u) => u.id === U)!, { email_ct: null });
    db.tables.auth_identities = db.tables.auth_identities.filter((i) => i.user_id !== U);
    const few = await confirm(to.map(codeFor));
    expect(few.status).toBe(409);
    expect(await few.json()).toEqual({ error: TOO_FEW });
    expect(recovery()!.failed_attempts).toBe(0);
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("an address swapped for another since the send: each code belongs to its address, so the set no longer fits", async () => {
    const to = twoAddresses();
    totp();
    await sentTo();
    const codes = to.map(codeFor);
    db.tables.auth_identities.find((i) => i.user_id === U)!.email = "another@example.test";
    expect((await confirm(codes)).status).toBe(400);
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("an address list that cannot be read removes nothing and spends no try", async () => {
    const to = twoAddresses();
    totp();
    await sentTo();
    db.state.failNext = { table: "auth_identities", op: "select", code: "XX000" };
    expect((await confirm(to.map(codeFor))).status).toBe(500);
    expect(recovery()!.failed_attempts).toBe(0);
    expect(factorKinds()).toEqual(["totp"]);
    expect((await confirm(to.map(codeFor))).status).toBe(200);
  });

  it("two at once with the right codes: one removes, and each address hears once", async () => {
    const to = twoAddresses();
    totp();
    await sentTo();
    const codes = to.map(codeFor);
    const answers = await Promise.all([confirm(codes), confirm(codes)]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(removedMails()).toHaveLength(2);
  });

  it("two past the attempt claim with the right codes: one removes, the other finds nothing waiting", async () => {
    const to = twoAddresses();
    totp();
    await sentTo();
    const codes = to.map(codeFor);
    let release!: () => void;
    // The first request's spend waits; the second claims its own try meanwhile and spends the set.
    db.state.holdNext = { table: "mfa_recovery", until: new Promise<void>((r) => { release = r; }), skip: 2 };
    const first = confirm(codes);
    while (db.state.holdNext) await new Promise((r) => setTimeout(r, 1));
    const second = await confirm(codes);
    release();
    const statuses = [(await first).status, second.status].sort();
    expect(statuses).toEqual([200, 404]);
    expect(removedMails()).toHaveLength(2);
  });

  it("a factor that cannot go brings the set back, and the same codes work again", async () => {
    const to = twoAddresses();
    totp();
    await sentTo();
    const hashes = recovery()!.code_hashes;
    db.state.failNext = { table: "mfa_factors", op: "delete", code: "XX000" };
    expect((await confirm(to.map(codeFor))).status).toBe(500);
    expect(factorKinds()).toEqual(["totp"]);
    expect(recovery()).toMatchObject({ factor: "totp", code_hashes: hashes });
    expect(removedMails()).toEqual([]);
    expect((await confirm(to.map(codeFor))).status).toBe(200);
    expect(factorKinds()).toEqual([]);
  });

  it("recovery codes that cannot be deleted remove nothing: the factor stays and the set comes back", async () => {
    const to = twoAddresses();
    totp();
    recoveryCode();
    await sentTo();
    db.state.failNext = { table: "mfa_recovery_codes", op: "delete", code: "XX000" };
    expect((await confirm(to.map(codeFor))).status).toBe(500);
    expect(factorKinds()).toEqual(["totp"]);
    expect(recovery()!.factor).toBe("totp");
  });

  it("with no set waiting, or its factor gone meanwhile, nothing waits and no try is spent", async () => {
    const to = twoAddresses();
    totp();
    const none = await confirm(["123456", "123456"]);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: "No codes are waiting. Ask for new ones." });
    await sentTo();
    db.tables.mfa_factors = db.tables.mfa_factors.filter((f) => f.user_id !== U);
    expect((await confirm(to.map(codeFor))).status).toBe(404);
    expect(recovery()!.failed_attempts).toBe(0);
  });

  it("a new factor of the named kind closes the set: the codes must not remove the new one", async () => {
    const to = twoAddresses();
    passkey();
    totp();
    await sentTo("passkey");
    const issued = NextResponse.json({});
    setChallengeCookie(issued, "pk_reg_challenge", "challenge", U);
    const added = await registerVerify(post("/api/auth/passkey/register/verify", { response: { id: "cred" } }, { cookie: `pk_reg_challenge=${issued.cookies.get("pk_reg_challenge")!.value}` }));
    expect(added.status).toBe(200);
    expect(recovery()).toMatchObject({ factor: null, code_hashes: null });
    expect((await confirm(to.map(codeFor))).status).toBe(404);
    expect(passkeys()).toHaveLength(2);
  });

  it("a new factor of another kind leaves the set: it named a factor that is still lost", async () => {
    const to = twoAddresses();
    passkey();
    totp();
    await sentTo("totp");
    const issued = NextResponse.json({});
    setChallengeCookie(issued, "pk_reg_challenge", "challenge", U);
    const added = await registerVerify(post("/api/auth/passkey/register/verify", { response: { id: "cred" } }, { cookie: `pk_reg_challenge=${issued.cookies.get("pk_reg_challenge")!.value}` }));
    expect(added.status).toBe(200);
    expect(recovery()!.factor).toBe("totp");
    expect((await confirm(to.map(codeFor))).status).toBe(200);
    expect(factorKinds()).toEqual([]);
    expect(passkeys()).toHaveLength(2);
  });

  it("asks for a list of codes, and a session", async () => {
    twoAddresses();
    totp();
    for (const body of [undefined, "123456", [], [1, 2], Array(11).fill("123456")]) expect((await confirm(body)).status).toBe(400);
    expect((await confirm(["123456", "123456"], "nobody")).status).toBe(401);
  });
});

describe("before SQL 74 ran", () => {
  it.each(["PGRST205", "42P01"])("both routes answer 503 %s and mail nobody", async (code) => {
    twoAddresses();
    totp();
    db.state.failing = { table: "mfa_recovery", code };
    for (const res of [await send("totp"), await confirm(["123456", "123456"])]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "This is not available yet" });
    }
    expect(mails).toEqual([]);
  });
});


describe("a banned account's door, and nothing left of the 5 day wait", () => {
  const passes = async (path: string) => {
    stubRequiredEnv();
    vi.stubEnv("TEAM_ACCESS_CODE", "team-code");
    const { proxy } = await import("../../proxy");
    const open = proxy(new NextRequest(`http://enki.test${path}`)).headers.get("x-middleware-next") === "1";
    vi.unstubAllEnvs();
    return open;
  };

  it("the recovery routes pass with no team cookie, the guardian's yes too, and the factor routes beside them do not", async () => {
    for (const path of ["/api/auth/mfa/recovery", "/api/auth/mfa/recovery/codes", "/api/auth/mfa/recovery/redeem", "/api/auth/mfa/recovery/mail", "/api/auth/mfa/recovery/mail/confirm", "/api/auth/mfa/recovery/guardians", "/api/recovery/approve", "/guardian"]) {
      expect(await passes(path), path).toBe(true);
    }
    expect(await passes("/api/auth/mfa/totp")).toBe(false);
    expect(await passes("/api/auth/mfa/recoveryx")).toBe(false);
    expect(await passes("/recovery-cancel")).toBe(false);
  });

  it("every one of them asks for a session", async () => {
    twoAddresses();
    totp();
    const nobody = { token: "nobody" };
    for (const res of [await send("totp", "nobody"), await confirm(["123456", "123456"], "nobody"),
      await redeem(post("/api/auth/mfa/recovery/redeem", { code: "x", factor: "totp" }, nobody)),
      await newSet(post("/api/auth/mfa/recovery/codes", {}, nobody)),
      await guardiansRoute.POST(post("/api/auth/mfa/recovery/guardians", { factor: "totp" }, nobody)),
      await status(new NextRequest("http://enki.test/api/auth/mfa/recovery", { headers: { "X-Session-Token": "nobody" } }))]) {
      expect(res.status).toBe(401);
    }
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("a banned session walks the mail path: its money sits behind the factor", async () => {
    db.tables.bans.push({ id: "b", user_id: U, reason: "x", expires_at: null, lifted_at: null, created_at: "2026-10-01T00:00:00Z" });
    const to = twoAddresses();
    totp();
    await sentTo();
    expect((await confirm(to.map(codeFor))).status).toBe(200);
    expect(factorKinds()).toEqual([]);
  });

  it("/banned shows the area with the embedded wallet whose key sits behind the factor", () => {
    const page = readSource(join(__dirname, "..", "..", "app", "banned", "page.tsx"));
    expect(page).toContain('<KeyExport ready={!!cdpAddress} />\n                  <RecoveryCodes />');
    expect(page).toContain('import RecoveryCodes from "@/components/settings/RecoveryCodes";');
  });

  it("no route, page, banner or public path of the wait is left", () => {
    const root = join(__dirname, "..", "..");
    for (const gone of ["app/api/auth/mfa/recovery/request/route.ts", "app/recovery-cancel/page.tsx"]) expect(fs.existsSync(join(root, gone)), gone).toBe(false);
    expect(readSource(join(root, "components", "BetaGate.tsx"))).not.toContain("/recovery-cancel");
    expect(readSource(join(root, "hooks", "useRecoveryStatus.ts"))).not.toMatch(/factorRecovery|readyAt|mfa\/recovery/);
    expect(readSource(join(root, "lib", "mfa-recovery.ts"))).not.toMatch(/ready_at|cancel_token|5 day|recoveryWaitUntil/);
  });
});
