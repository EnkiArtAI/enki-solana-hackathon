import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { fakePostgrest } from "./_fake-postgrest";
import type { ProviderIdentity } from "../auth/oauth";

/**
 * A login of a known Google or X identity keeps the address the identity was linked with (DEC-2026-11-05-57). A Google
 * account on a non-Gmail inbox can change its address and keep its subject: whoever recovered it through that inbox would
 * otherwise sign in once with a fresh address of his own, and the mail path (a code to every address, two or more:
 * lib/mfa-recovery.ts sendMailCodes) would count two addresses where the owner has one inbox. The real OAuth callback (the provider's answer stubbed), the real recovery
 * routes and the wallet JWT route run; the database is a fake, the mail is captured, the JWT signer is stubbed.
 */

const st = vi.hoisted(() => ({ identity: null as unknown as ProviderIdentity, background: [] as Promise<unknown>[] }));
const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string; subject: string; text: string }) => { mails.push(m); return { ok: true }; } }));
vi.mock("@/lib/wallet-jwt", () => ({ mintWalletJwt: async () => "wallet-jwt" }));
// A connect notice runs in after(), which needs a request scope: collected and awaited here.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (work: Promise<unknown>) => { st.background.push(work); } }));
vi.mock("@/lib/auth/oauth", async (importActual) => ({ ...(await importActual<typeof import("@/lib/auth/oauth")>()), completeAuth: vi.fn(async () => st.identity) }));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
  process.env.OAUTH_APP_URL = "https://enki.test";
  process.env.NEXT_PUBLIC_APP_URL = "https://enki.test";
  delete process.env.TEAM_ACCESS_CODE;
});

import { GET as callback } from "../../app/api/auth/oauth/[provider]/callback/route";
import { POST as mailRoute } from "../../app/api/auth/mfa/recovery/mail/route";
import { POST as walletJwt } from "../../app/api/auth/wallet/jwt/route";
import { signState, STATE_COOKIE } from "../auth/oauth";
import { encryptString } from "../crypto";

// The mail path's refusal for an account with no code left and no guardians (lib/mfa-recovery.ts tooFew, DEC-2026-11-07-30).
const TOO_FEW = "Emailing codes needs two email addresses or more, one code to each, not counting the address of an email code you lost. " +
  "No recovery code is left either, and fewer than two guardians can be asked, so a lost factor cannot be removed now.";

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const INBOX = "owner@proton.test"; // the owner's one inbox; his Google account is a non-Gmail one on it
const FRESH = "attacker-fresh@evil.test"; // the address the Google account was changed to
let U = "";

// Another account's rows stand first in every table a read could hit: a read or a write with no account filter lands on them.
const STRANGER = "99999999-9999-4999-8999-999999999999";
const strangerRows = () => {
  const e = encryptString("stranger@example.test");
  return {
    users: [{ id: STRANGER, handle: "stranger", origin: "google", deleted_at: null, email_ct: e.encrypted, email_iv: e.iv, email_tag: e.authTag, email_kid: e.kid ?? null, email_verified_at: "2026-10-01T00:00:00Z" }],
    password_credentials: [{ user_id: STRANGER, email: "stranger-login@example.test", email_verified_at: "2026-10-01T00:00:00Z", pw_hash: "x", pw_salt: "y", must_change_password: false }],
    auth_identities: [{ user_id: STRANGER, provider: "google", subject: "g-stranger", email: "stranger@example.test", email_verified: true }],
    webauthn_credentials: [{ id: randomUUID(), user_id: STRANGER, credential_id: "stranger", created_at: "2026-10-07T00:00:00Z" }],
  };
};

const post = (url: string, body: unknown, token: string) => new NextRequest(`http://enki.test${url}`, { method: "POST", headers: { "X-Session-Token": token }, body: JSON.stringify(body) });
const ask = (factor: string, token: string) => mailRoute(post("/api/auth/mfa/recovery/mail", { factor }, token));
const mine = () => db.tables.auth_identities.find((i) => i.user_id === U)!;
const minePasskeys = () => db.tables.webauthn_credentials.filter((c) => c.user_id === U);

/** A Google login through the real callback, the provider answering with this address. The new session's token. */
async function googleLogin(email: string): Promise<string> {
  st.identity = { provider: "google", subject: "g-owner", email, emailVerified: true, handle: null, displayName: "Kev", avatarUrl: null };
  const before = new Set(db.tables.auth_sessions.map((s) => s.token));
  const cookie = await signState({ provider: "google", intent: { kind: "login" }, next: "/", state: "s1", nonce: "n1", verifier: "v1" });
  const res = await callback(new NextRequest("https://enki.test/api/auth/oauth/google/callback?state=s1&code=c", {
    headers: { cookie: `${STATE_COOKIE}=${cookie}`, "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250)}` },
  }), { params: Promise.resolve({ provider: "google" }) });
  await Promise.all(st.background);
  const made = db.tables.auth_sessions.find((s) => !before.has(s.token) && s.wallet_address === U);
  if (!made) throw new Error(`no session from the callback: ${res.status} ${res.headers.get("location")}`);
  return String(made.token);
}

let seed: ReturnType<typeof strangerRows>;
beforeEach(() => {
  U = randomUUID();
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  seed = strangerRows();
  Object.assign(db.tables, structuredClone(seed), {
    auth_sessions: [], mfa_factors: [], mfa_recovery: [], mfa_recovery_codes: [], recovery_guardians: [], consumed_stepup_tokens: [],
    bans: [], ip_bans: [], user_wallets: [], access_allowlist: [], trial_codes: [], trial_redemptions: [],
  });
  db.tables.auth_identities.push({ user_id: U, provider: "google", subject: "g-owner", email: INBOX, email_verified: true, display_name: "old", last_login_at: null });
  db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: "owner", created_at: "2026-10-07T00:00:00Z" });
  mails.length = 0;
  st.background.length = 0;
  db.state.failing = null;
  db.state.failNext = null;
});
afterEach(() => {
  expect(mails.filter((m) => m.to.startsWith("stranger"))).toEqual([]);
  for (const table of ["users", "password_credentials", "auth_identities", "webauthn_credentials"] as const) {
    expect(db.tables[table].filter((r) => r.user_id === STRANGER || r.id === STRANGER), table).toEqual(seed[table]);
  }
});

/** The login that comes after the Google account's address changed: the identity keeps its address, one inbox stays one. */
async function freshAddressLogin() {
  const token = await googleLogin(FRESH);
  expect(mine()).toMatchObject({ email: INBOX, email_verified: true, display_name: "Kev" });
  expect(mine().last_login_at).toBeTruthy();
  const res = await ask("passkey", token);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: TOO_FEW });
  expect(mails.filter((m) => m.subject === "Your Enki recovery code")).toEqual([]);
  expect(db.tables.mfa_recovery.filter((r) => r.user_id === U).every((r) => !r.code_hashes)).toBe(true);
  expect(minePasskeys()).toHaveLength(1);
  expect((await walletJwt(post("/api/auth/wallet/jwt", {}, token))).status).toBe(403);
}

describe("a Google login whose account now says another address", () => {
  it("an account Google made on a non-Gmail inbox: the identity keeps that inbox, so it is still one inbox, too few", async () => {
    const e = encryptString(INBOX);
    db.tables.users.push({ id: U, handle: "kev", origin: "google", deleted_at: null, email_ct: e.encrypted, email_iv: e.iv, email_tag: e.authTag, email_kid: e.kid ?? null, email_verified_at: "2026-10-01T00:00:00Z" });
    await freshAddressLogin();
  });

  it("a password account whose Google sits on the login inbox: no reset, and still one inbox, too few", async () => {
    db.tables.users.push({ id: U, handle: "kev", origin: "email", deleted_at: null });
    db.tables.password_credentials.push({ user_id: U, email: INBOX, email_verified_at: "2026-10-01T00:00:00Z", pw_hash: "x", pw_salt: "y", must_change_password: false });
    db.tables.auth_sessions.push({ token: "owner-session", wallet_address: U, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() });
    await freshAddressLogin();
  });
});
