import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { fakePostgrest } from "./_fake-postgrest";
import { sha256 } from "../password-reset";
import { APP_NAME } from "@/shared/app-config";

/**
 * A deleted account stays deleted (DEC-2026-10-17-31). softDelete keeps the
 * password credential and the wallets, so each login has to ask: without it a
 * new session opened and BetaGate admitted the account. A ban is another thing:
 * a banned account keeps its session and its way to its funds. The real routes
 * run; the database is a fake and the KDF a stub.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
vi.mock("@/lib/password-auth", () => ({
  verifyOrDecoy: (password: string) => password === "right password",
  hashPassword: (password: string) => ({ hash: `hash:${password}`, salt: "salt" }),
}));
vi.mock("@/lib/ip-hash", () => ({ getClientIp: () => "203.0.113.9", hashIp: () => "iphash", isIpBanned: async () => false }));
const trialSpend = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/trial", async (orig) => ({
  ...(await orig<typeof import("@/lib/trial")>()),
  trialAdmission: async () => { trialSpend.calls += 1; return null; },
}));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  checkRequestRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
});

import { POST as login } from "../../app/api/auth/password/login/route";
import { POST as firstLogin } from "../../app/api/auth/password/first-login/route";
import { POST as resetCode } from "../../app/api/auth/password/reset-code/route";
import { POST as recoveryComplete } from "../../app/api/recovery/complete/route";
import { POST as walletLogin } from "../../app/api/auth/session/route";

const U = "11111111-1111-4111-8111-111111111111";
const EMAIL = "owner@example.test";
const CODE = "1234567";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const OWNER_KEY = "owner-key-owner-key";
const DELETED = "2026-11-01T00:00:00.000Z";
const kp = Keypair.generate();
const ADDRESS = kp.publicKey.toBase58();

const post = (path: string, body: unknown) => new NextRequest(`http://enki.test${path}`, { method: "POST", body: JSON.stringify(body) });
const passwordLogin = (password = "right password") => login(post("/api/auth/password/login", { identifier: EMAIL, password }));
const first = () => firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: "right password", newPassword: "my own password" }));
const reset = (code = CODE) => resetCode(post("/api/auth/password/reset-code", { email: EMAIL, code, password: "a new password" }));
const recover = (ownerKey = OWNER_KEY) => recoveryComplete(post("/api/recovery/complete", { requestId: REQUEST, ownerKey, password: "a new password" }));
const wallet = () => {
  const nonce = Math.random().toString(36).slice(2);
  db.tables.auth_nonces.push({ wallet_address: ADDRESS.toLowerCase(), nonce, consumed: false, expires_at: "2999-01-01T00:00:00.000Z" });
  const message = `${APP_NAME} sign in\n${ADDRESS}\nnonce ${nonce}`;
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32))).toString("base64");
  return walletLogin(post("/api/auth/session", { walletAddress: ADDRESS, walletType: "solana", signature, message, timestamp: Date.now(), nonce }));
};

const deleteAccount = () => { db.tables.users[0].deleted_at = DELETED; };
const banAccount = () => { db.tables.bans.push({ id: "b1", user_id: U, reason: "spam", expires_at: null, lifted_at: null, created_at: DELETED }); };

beforeEach(() => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  Object.assign(db.tables, {
    users: [{ id: U, role: "beta", deleted_at: null }],
    password_credentials: [{ user_id: U, email: EMAIL, pw_hash: "h", pw_salt: "s", must_change_password: false }],
    user_wallets: [{ user_id: U, address: ADDRESS, removed_at: null }],
    auth_sessions: [],
    auth_nonces: [],
    auth_identities: [],
    bans: [],
    access_allowlist: [],
    password_reset_tokens: [{ token: sha256(CODE), user_id: U, expires_at: "2999-01-01T00:00:00.000Z" }],
    recovery_requests: [{ id: REQUEST, user_id: U, status: "approved", owner_key_hash: sha256(OWNER_KEY), expires_at: "2999-01-01T00:00:00.000Z" }],
  });
  db.state.failing = null;
  db.state.failNext = null;
  trialSpend.calls = 0;
  vi.stubEnv("TEAM_ACCESS_CODE", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("a password login", () => {
  it("opens a session for a live account", async () => {
    const res = await passwordLogin();
    expect(res.status).toBe(200);
    expect(db.tables.auth_sessions).toHaveLength(1);
  });

  it("answers a deleted account exactly as a wrong password, and opens nothing", async () => {
    const wrong = await passwordLogin("wrong password");
    deleteAccount();
    const res = await passwordLogin();
    expect(res.status).toBe(wrong.status);
    expect(await res.json()).toEqual(await wrong.json());
    expect(db.tables.auth_sessions).toEqual([]);
  });

  it("does not tell a deleted invitee to set a password, nor spend a trial code on the way", async () => {
    deleteAccount();
    db.tables.password_credentials[0].must_change_password = true;
    expect((await passwordLogin()).status).toBe(401);
    vi.stubEnv("TEAM_ACCESS_CODE", "beta-code"); // off the list: the next step would be the trial
    expect((await passwordLogin()).status).toBe(401);
    expect(trialSpend.calls).toBe(0);
  });

  it("answers 503 when the account cannot be read, and opens nothing", async () => {
    db.state.failNext = { table: "users", op: "select", code: "XX000" };
    const res = await passwordLogin();
    expect(res.status).toBe(503);
    expect(db.tables.auth_sessions).toEqual([]);
  });

  it("still opens a session for a banned account: the ban keeps its door to the funds", async () => {
    banAccount();
    const res = await passwordLogin();
    expect(res.status).toBe(200);
    expect((await res.json()).banned).toBe(true);
    expect(db.tables.auth_sessions).toHaveLength(1);
  });
});

describe("an invited account's first login", () => {
  beforeEach(() => { db.tables.password_credentials[0].must_change_password = true; });

  it("opens a session for a live account", async () => {
    expect((await first()).status).toBe(200);
    expect(db.tables.auth_sessions).toHaveLength(1);
  });

  it("refuses a deleted one as a wrong password, and keeps the one-time password as it was", async () => {
    deleteAccount();
    const res = await first();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Wrong login or password");
    expect(db.tables.auth_sessions).toEqual([]);
    expect(db.tables.password_credentials[0]).toMatchObject({ pw_hash: "h", must_change_password: true });
  });

  it("answers 503 when the account cannot be read", async () => {
    db.state.failNext = { table: "users", op: "select", code: "XX000" };
    expect((await first()).status).toBe(503);
    expect(db.tables.password_credentials[0].pw_hash).toBe("h");
  });
});

describe("the emailed reset code", () => {
  it("logs a live account in", async () => {
    expect((await reset()).status).toBe(200);
    expect(db.tables.auth_sessions).toHaveLength(1);
  });

  it("answers a deleted account as a wrong code: no password set, no session", async () => {
    const wrong = await reset("7654321");
    deleteAccount();
    const res = await reset();
    expect(res.status).toBe(wrong.status);
    expect(await res.json()).toEqual(await wrong.json());
    expect(db.tables.auth_sessions).toEqual([]);
    expect(db.tables.password_credentials[0].pw_hash).toBe("h");
  });

  it("answers 503 when the account cannot be read", async () => {
    db.state.failNext = { table: "users", op: "select", code: "XX000" };
    expect((await reset()).status).toBe(503);
    expect(db.tables.password_credentials[0].pw_hash).toBe("h");
  });

  it("still logs a banned account in", async () => {
    banAccount();
    expect((await reset()).status).toBe(200);
    expect(db.tables.auth_sessions).toHaveLength(1);
  });
});

describe("a guardian recovery", () => {
  it("logs a live account in", async () => {
    expect((await recover()).status).toBe(200);
    expect(db.tables.auth_sessions).toHaveLength(1);
  });

  it("refuses a deleted account: no password set, no session", async () => {
    deleteAccount();
    const res = await recover();
    expect(res.status).toBe(400);
    expect(db.tables.auth_sessions).toEqual([]);
    expect(db.tables.password_credentials[0].pw_hash).toBe("h");
  });

  it("a deleted-check read that fails burns nothing: 503, and the retry logs in", async () => {
    db.state.failNext = { table: "users", op: "select", code: "XX000" };
    expect((await recover()).status).toBe(503);
    expect(db.tables.recovery_requests[0].status).toBe("approved");
    expect(db.tables.auth_sessions).toEqual([]);
    expect((await recover()).status).toBe(200);
    expect(db.tables.recovery_requests[0].status).toBe("completed");
    expect(db.tables.auth_sessions).toHaveLength(1);
  });

  it("a request that cannot be read burns nothing either", async () => {
    db.state.failNext = { table: "recovery_requests", op: "select", code: "XX000" };
    expect((await recover()).status).toBe(500);
    expect(db.tables.recovery_requests[0].status).toBe("approved");
    expect(db.tables.auth_sessions).toEqual([]);
  });

  it("a wrong owner key never reaches the account's read, and claims nothing", async () => {
    db.state.failNext = { table: "users", op: "select", code: "XX000" };
    expect((await recover("not-the-owner-key-at-all")).status).toBe(400);
    expect(db.tables.recovery_requests[0].status).toBe("approved");
  });
});

describe("a wallet login", () => {
  it("opens a session for a live account", async () => {
    expect((await wallet()).status).toBe(200);
    expect(db.tables.auth_sessions).toHaveLength(1);
  });

  it("gives a deleted account's wallet no session, and burns no nonce", async () => {
    deleteAccount();
    const res = await wallet();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This account was deleted." }); // no notWhitelisted: the picker shows this sentence
    expect(db.tables.auth_sessions).toEqual([]);
    expect(db.tables.auth_nonces[0].consumed).toBe(false);
    expect(db.tables.users).toHaveLength(1);
  });

  it("answers 503 when the account cannot be read, and opens nothing", async () => {
    db.state.failNext = { table: "users", op: "select", code: "XX000" };
    expect((await wallet()).status).toBe(503);
    expect(db.tables.auth_sessions).toEqual([]);
  });

  it("a wallet lookup that fails leaves no session and burns no nonce", async () => {
    db.state.failNext = { table: "user_wallets", op: "select", code: "XX000" };
    expect((await wallet()).status).toBe(503);
    expect(db.tables.auth_sessions).toEqual([]);
    expect(db.tables.auth_nonces[0].consumed).toBe(false);
  });

  it("off the list it says so with the flag the picker reads", async () => {
    vi.stubEnv("TEAM_ACCESS_CODE", "beta-code");
    const res = await wallet();
    expect(res.status).toBe(403);
    expect((await res.json()).notWhitelisted).toBe(true);
    expect(db.tables.auth_sessions).toEqual([]);
  });

  it("still opens a session for a banned account", async () => {
    banAccount();
    const res = await wallet();
    expect(res.status).toBe(200);
    expect((await res.json()).banned).toBe(true);
    expect(db.tables.auth_sessions).toHaveLength(1);
  });

  it("a wallet nobody holds still gets its account", async () => {
    db.tables.user_wallets = [];
    expect((await wallet()).status).toBe(200);
    expect(db.tables.users).toHaveLength(2);
    expect(db.tables.auth_sessions).toHaveLength(1);
  });
});
