import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";

/**
 * Disconnecting Google or X removes a way in and an address from the recovery mails (DEC-2026-11-05-40 point 1). With a factor
 * it takes every factor, as removing a factor does; every address hears, the one leaving included. The real route, the real
 * session lookup and the real step-up check run; the database is a fake and the mail is captured.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string; subject: string; text: string }) => { mails.push(m); return { ok: true }; } }));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { DELETE as disconnect } from "../../app/api/auth/identities/[provider]/route";
import { isStepUpScope, mintStepUpToken } from "../webauthn";
import { RESET_ADVICE } from "../mfa";
import { encryptString } from "../crypto";

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const LOGIN = "owner@example.test";
const GOOGLE = "owner@gmail.test";
let U = "";

// Another account's rows stand first in every table a read could hit: a read or a write with no account filter lands on them.
const STRANGER = "99999999-9999-4999-8999-999999999999";
const strangerRows = () => {
  const e = encryptString("stranger-users@example.test");
  return {
    users: [{ id: STRANGER, handle: "stranger", email_ct: e.encrypted, email_iv: e.iv, email_tag: e.authTag, email_kid: e.kid ?? null, email_verified_at: "2026-10-01T00:00:00Z" }],
    password_credentials: [{ user_id: STRANGER, email: "stranger-login@example.test", email_verified_at: "2026-10-01T00:00:00Z" }],
    auth_identities: [
      { user_id: STRANGER, provider: "google", subject: "sg", email: "stranger-google@example.test" },
      { user_id: STRANGER, provider: "x", subject: "sx", email: null },
    ],
    mfa_factors: [{ id: randomUUID(), user_id: STRANGER, kind: "totp", secret_ct: "x", confirmed_at: "2026-10-07T00:00:00Z" }],
    webauthn_credentials: [{ id: randomUUID(), user_id: STRANGER, credential_id: "stranger", created_at: "2026-10-07T00:00:00Z" }],
    // Its unused code and two confirmed guardians: a count of the other ways with no account filter would name them.
    mfa_recovery_codes: [{ id: "stranger-code", user_id: STRANGER, code_hash: "stranger-hash", used_at: null }],
    recovery_guardians: ["s1", "s2"].map((v) => ({ id: `stranger-${v}`, user_id: STRANGER, guardian_type: "email", value: `stranger-${v}@friends.test`, status: "confirmed" })),
  };
};

const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
const del = (provider: string, stepUpTokens: string[] = []) => disconnect(new NextRequest(`http://enki.test/api/auth/identities/${provider}`, {
  method: "DELETE",
  headers: { "X-Session-Token": "s", ...(stepUpTokens.length ? { "X-StepUp-Token": stepUpTokens.join(",") } : {}) },
}), ctx(provider));
const mine = () => db.tables.auth_identities.filter((i) => i.user_id === U).map((i) => i.provider);
const told = () => mails.map((m) => m.to);

let seed: ReturnType<typeof strangerRows>;
beforeEach(() => {
  U = randomUUID();
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  seed = strangerRows();
  Object.assign(db.tables, structuredClone(seed), {
    auth_sessions: [{ token: "s", wallet_address: U, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() }],
    consumed_stepup_tokens: [], user_wallets: [], bans: [],
  });
  db.tables.users.push({ id: U, handle: "kev", origin: "email" });
  db.tables.password_credentials.push({ user_id: U, email: LOGIN, email_verified_at: "2026-10-01T00:00:00Z" });
  db.tables.auth_identities.push({ user_id: U, provider: "google", subject: "g1", email: GOOGLE }, { user_id: U, provider: "x", subject: "x1", email: null });
  db.state.failing = null;
  db.state.failNext = null;
  db.state.holdNext = null;
  db.state.missing = null;
  mails.length = 0;
});
afterEach(() => {
  expect(mails.filter((m) => m.to.startsWith("stranger"))).toEqual([]);
  for (const table of ["users", "password_credentials", "auth_identities", "mfa_factors", "webauthn_credentials"] as const) {
    expect(db.tables[table].filter((r) => r.user_id === STRANGER || r.id === STRANGER), table).toEqual(seed[table]);
  }
});

const totp = () => db.tables.mfa_factors.push({ id: randomUUID(), user_id: U, kind: "totp", secret_ct: "x", confirmed_at: "2026-10-07T00:00:00Z" });
const passkey = () => db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: randomUUID(), created_at: "2026-10-07T00:00:00Z" });

describe("with a factor", () => {
  // Both providers: a scope fixed to one, or one provider's token taken for the other, must go red (review of 8e586c14).
  const each = it.each([
    { provider: "google", other: "x", name: "Google" },
    { provider: "x", other: "google", name: "X" },
  ]);

  each("$name: asks every factor and removes nothing until all of them confirmed", async ({ provider }) => {
    totp();
    passkey();
    const none = await del(provider);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ stepUp: true, all: true, scope: `disconnect:${provider}`, missing: ["passkey", "totp"] });
    const one = await del(provider, [await mintStepUpToken(U, `disconnect:${provider}`, "totp")]);
    expect(one.status).toBe(401);
    expect(await one.json()).toMatchObject({ missing: ["passkey"] });
    expect(mine()).toEqual(["google", "x"]);
    expect(mails).toEqual([]);
    expect(db.tables.consumed_stepup_tokens).toEqual([]);
  });

  each("$name: every factor: it goes, and every address hears, the Google one included", async ({ provider, other, name }) => {
    totp();
    passkey();
    const res = await del(provider, [await mintStepUpToken(U, `disconnect:${provider}`, "totp"), await mintStepUpToken(U, `disconnect:${provider}`, "passkey")]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: provider });
    expect(mine()).toEqual([other]);
    expect(told()).toEqual([LOGIN, GOOGLE]);
    expect(mails[0].subject).toBe(`${name} was disconnected from your Enki account`);
    expect(mails[0].text).toContain("It can no longer be used to sign in to it.");
    expect(mails[0].text).toContain(RESET_ADVICE);
    expect(db.tables.consumed_stepup_tokens).toHaveLength(2);
  });

  each("$name: a token for another provider or another action does not count", async ({ provider, other }) => {
    totp();
    expect((await del(provider, [await mintStepUpToken(U, `disconnect:${other}`, "totp")])).status).toBe(401);
    expect((await del(provider, [await mintStepUpToken(U, "remove-factor:totp", "totp")])).status).toBe(401);
    expect((await del(provider, [await mintStepUpToken(U, "add-factor", "totp")])).status).toBe(401);
    expect(mine()).toEqual(["google", "x"]);
    expect(isStepUpScope("disconnect:facebook")).toBe(false);
  });

  it("the last way in is refused before any factor is asked or spent", async () => {
    totp();
    db.tables.password_credentials = db.tables.password_credentials.filter((c) => c.user_id !== U);
    db.tables.auth_identities = db.tables.auth_identities.filter((i) => !(i.user_id === U && i.provider === "x"));
    const res = await del("google", [await mintStepUpToken(U, "disconnect:google", "totp")]);
    expect(res.status).toBe(409);
    expect(db.tables.consumed_stepup_tokens).toEqual([]);
    expect(mails).toEqual([]);
  });
});

// The address that goes may leave fewer than the two the mail path needs (lib/mfa-recovery.ts tooFew): with a factor, the mail says so,
// and names only the other ways the account has (DEC-2026-11-07-30).
const PLAIN = "It can no longer be used to sign in to it. If that was you, there is nothing to do.\n\n";
const FEWER = "It can no longer be used to sign in to it. This account now has fewer than two email addresses, so until it has a second, ";
const LAST_DOOR = `${FEWER}a lost factor cannot be removed: no recovery code is left and fewer than two guardians can be asked. If that was you, there is nothing to do.\n\n`;
const allTokens = async (provider: string) => [await mintStepUpToken(U, `disconnect:${provider}`, "totp")];

describe("what the mail says of the mail path", () => {
  it("with a factor, taking the second address: with no code and no guardians, a lost factor cannot be removed, at every address", async () => {
    totp();
    expect((await del("google", await allTokens("google"))).status).toBe(200);
    expect(told()).toEqual([LOGIN, GOOGLE]);
    expect(mails.map((m) => m.text.includes(LAST_DOOR))).toEqual([true, true]);
  });

  const guardians = () => ["g1", "g2"].forEach((v) => db.tables.recovery_guardians.push({ id: randomUUID(), user_id: U, guardian_type: "email", value: `${v}@friends.test`, status: "confirmed" }));
  const code = () => db.tables.mfa_recovery_codes.push({ id: randomUUID(), user_id: U, code_hash: randomUUID(), used_at: null });
  it.each([
    { has: "a code left and two guardians", seed: () => { code(); guardians(); }, says: "a recovery code or your guardians" },
    { has: "a code left", seed: code, says: "a recovery code" },
    { has: "two guardians", seed: guardians, says: "your guardians" },
  ])("with $has, it names those: a lost factor can be removed only with $says", async ({ seed: give, says }) => {
    totp();
    give();
    expect((await del("google", await allTokens("google"))).status).toBe(200);
    expect(mails.map((m) => m.text.includes(`${FEWER}a lost factor can be removed only with ${says}. If that was you`))).toEqual([true, true]);
  });

  it("before SQL 74 ran there is no way to name: nothing of it", async () => {
    totp();
    db.state.missing = "mfa_recovery_codes";
    expect((await del("google", await allTokens("google"))).status).toBe(200);
    expect(mails.map((m) => m.text.includes(PLAIN))).toEqual([true, true]);
  });

  it("one address left that opens no login, an email factor's, is fewer than two as well", async () => {
    db.tables.password_credentials = db.tables.password_credentials.filter((c) => c.user_id !== U);
    const e = encryptString("owner-factor@example.test", U);
    db.tables.mfa_factors.push({ id: randomUUID(), user_id: U, kind: "email", secret_ct: e.encrypted, secret_iv: e.iv, secret_tag: e.authTag, secret_kid: e.kid ?? "", confirmed_at: "2026-10-07T00:00:00Z" });
    expect((await del("google", [await mintStepUpToken(U, "disconnect:google", "email")])).status).toBe(200);
    expect(told()).toEqual([GOOGLE, "owner-factor@example.test"]);
    expect(mails.map((m) => m.text.includes(LAST_DOOR))).toEqual([true, true]);
  });

  it("with a factor, leaving two addresses: nothing of it", async () => {
    totp();
    expect((await del("x", await allTokens("x"))).status).toBe(200);
    expect(mails.map((m) => m.text.includes(PLAIN))).toEqual([true, true]);
  });

  it("without a factor there is none to lose: nothing of it", async () => {
    expect((await del("google")).status).toBe(200);
    expect(mails.map((m) => m.text.includes(PLAIN))).toEqual([true, true]);
  });

  it("a read after the delete that fails drops that sentence only: Google is gone and every address hears", async () => {
    totp();
    db.state.failNext = { table: "webauthn_credentials", op: "select", code: "XX000", skip: 1 }; // the step-up's factor count, then this one
    expect((await del("google", await allTokens("google"))).status).toBe(200);
    expect(db.state.failNext).toBeNull();
    expect(mine()).toEqual(["x"]);
    expect(mails.map((m) => m.text.includes(PLAIN))).toEqual([true, true]);
  });
});

describe("without a factor", () => {
  it("goes as before, and every address hears", async () => {
    const res = await del("x");
    expect(res.status).toBe(200);
    expect(mine()).toEqual(["google"]);
    expect(told()).toEqual([LOGIN, GOOGLE]);
    expect(mails[0].subject).toBe("X was disconnected from your Enki account");
  });

  it("an address list that cannot be read removes nothing", async () => {
    db.state.failNext = { table: "mfa_factors", op: "select", code: "XX000", skip: 1 }; // the factor count, then the address list's email factor
    await expect(del("google")).rejects.toMatchObject({ code: "XX000" });
    expect(mine()).toEqual(["google", "x"]);
    expect(mails).toEqual([]);
  });

  it("one that is put back, as the last way in after a race, tells nobody", async () => {
    db.tables.password_credentials = db.tables.password_credentials.filter((c) => c.user_id !== U);
    const answers = await Promise.all([del("google"), del("x")]);
    const gone = ["google", "x"].filter((_, i) => answers[i].status === 200);
    expect(answers.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(mine().length).toBeGreaterThanOrEqual(1);
    expect(mails.map((m) => m.subject)).toEqual(gone.map((p) => `${p === "google" ? "Google" : "X"} was disconnected from your Enki account`));
    expect(gone.length).toBeLessThan(2);
  });
});

describe("Settings", () => {
  it("disconnects through the step-up path factor removal uses, and the dialog says every factor confirms it", () => {
    const view = readSource(join(__dirname, "..", "..", "components", "settings", "use-account.ts"));
    const body = /const disconnectAccount = async \(provider: string\) => \{([\s\S]*?)\n  \};/.exec(view)![1];
    expect(body).toContain("const res = await guarded(`disconnect:${provider}`, (h) =>\n      fetch(`/api/auth/identities/${provider}`, { method: \"DELETE\", headers: { ...sessionAuthHeaders(), ...h } }),");
    expect(body).toContain("if (res.status === 401 && body.stepUp) return;");
    const dialog = readSource(join(__dirname, "..", "..", "components", "StepUpProvider.tsx"));
    expect(dialog).toContain("/^(add-factor|remove-factor:|guardians|stepup-settings|recovery-codes|disconnect:)/.test(pending?.scope");
  });
});
