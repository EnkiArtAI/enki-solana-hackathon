import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { randomBytes } from "node:crypto";
import { fakeDb } from "./_fake-supabase";
import { ERROR_SENTENCES, errorSentence } from "@/lib/auth/oauth-shared";
import {
  beginAuth,
  completeAuth,
  emailLookupHash,
  MissingTableError,
  OAuthError,
  readState,
  redirectUri,
  resolveIdentity,
  sanitizeNext,
  signState,
  verifyGoogleIdToken,
  X_USERINFO,
  type ProviderIdentity,
  type StateClaims,
} from "@/lib/auth/oauth";

const UUID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

beforeAll(() => {
  process.env.AUTH_PEPPER = randomBytes(32).toString("base64");
  process.env.X_OAUTH_CLIENT_ID = "x-client";
  process.env.X_OAUTH_CLIENT_SECRET = "x-secret";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://enki.test";
});
beforeEach(() => { delete process.env.TEAM_ACCESS_CODE; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const claims = (over: Partial<StateClaims> = {}): StateClaims => ({
  provider: "x", intent: { kind: "login" }, next: "/home", state: "s1", nonce: "n1", verifier: "v1", ...over,
});

describe("the return address", () => {
  it("is OAUTH_APP_URL when set, else NEXT_PUBLIC_APP_URL, without a trailing slash", () => {
    expect(redirectUri("google")).toBe("https://enki.test/api/auth/oauth/google/callback");
    process.env.OAUTH_APP_URL = "http://localhost:3008/";
    try {
      expect(redirectUri("x")).toBe("http://localhost:3008/api/auth/oauth/x/callback");
    } finally {
      delete process.env.OAUTH_APP_URL;
    }
  });
});

describe("errorSentence", () => {
  it("names a known refusal and reads anything else from a URL as a provider error, never an object", () => {
    expect(errorSentence("already_linked")).toBe(ERROR_SENTENCES.already_linked);
    for (const odd of ["__proto__", "constructor", "toString", "nope", ""]) expect(errorSentence(odd)).toBe(ERROR_SENTENCES.provider_error);
  });
});

describe("sanitizeNext", () => {
  it("keeps a relative path and rejects everything that could leave the site", () => {
    expect(sanitizeNext("/profile?tab=wallet")).toBe("/profile?tab=wallet");
    expect(sanitizeNext("https://evil.example/x")).toBe("/home");
    expect(sanitizeNext("//evil.example")).toBe("/home");
    expect(sanitizeNext("/\\evil.example")).toBe("/home");
    expect(sanitizeNext("javascript:alert(1)")).toBe("/home");
    expect(sanitizeNext("/a b")).toBe("/home");
    expect(sanitizeNext(undefined)).toBe("/home");
    expect(sanitizeNext("")).toBe("/home");
  });
});

describe("state cookie", () => {
  it("round trips and binds to the provider", async () => {
    const cookie = await signState(claims());
    await expect(readState(cookie, "x")).resolves.toMatchObject({ state: "s1", nonce: "n1", verifier: "v1", intent: { kind: "login" } });
    await expect(readState(cookie, "google")).resolves.toBeNull();
  });

  it("refuses a tampered cookie", async () => {
    const cookie = await signState(claims());
    const [h, p, sig] = cookie.split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    await expect(readState(`${h}.${p}.${flipped}`, "x")).resolves.toBeNull();
    // payload swapped for another provider's state, signature kept
    const other = (await signState(claims({ state: "other" }))).split(".")[1];
    await expect(readState(`${h}.${other}.${sig}`, "x")).resolves.toBeNull();
    await expect(readState(undefined, "x")).resolves.toBeNull();
  });

  it("refuses an expired cookie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T10:00:00Z"));
    const cookie = await signState(claims());
    vi.setSystemTime(new Date("2026-09-24T10:06:00Z"));
    await expect(readState(cookie, "x")).resolves.toBeNull();
  });

  it("carries a link only with the hash of the session that started it", async () => {
    const bound = await signState(claims({ intent: { kind: "link", userId: UUID, session: "abc" } }));
    await expect(readState(bound, "x")).resolves.toMatchObject({ intent: { kind: "link", userId: UUID, session: "abc" } });
    const unbound = await signState(claims({ intent: { kind: "link", userId: UUID } as never }));
    await expect(readState(unbound, "x")).resolves.toBeNull();
  });

  it("sanitises the return path it carries", async () => {
    const cookie = await signState(claims({ next: "//evil.example" }));
    await expect(readState(cookie, "x")).resolves.toMatchObject({ next: "/home" });
  });
});

describe("google id_token", () => {
  const nonce = "nonce-1";
  async function idToken(payload: Record<string, unknown>, over: { iss?: string; aud?: string; exp?: string | null } = {}) {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = await exportJWK(publicKey);
    const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] });
    const signing = new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(over.iss ?? "https://accounts.google.com")
      .setAudience(over.aud ?? "google-client")
      .setSubject("g-123")
      .setIssuedAt();
    if (over.exp !== null) signing.setExpirationTime(over.exp ?? "5m");
    return { token: await signing.sign(privateKey), keys };
  }

  it("refuses a token with no expiry or a passed one, and takes one that is still good", async () => {
    const none = await idToken({ nonce }, { exp: null });
    await expect(verifyGoogleIdToken(none.token, { clientId: "google-client", nonce }, none.keys)).rejects.toMatchObject({ code: "provider_error", message: expect.stringContaining('"exp"') });
    const late = await idToken({ nonce }, { exp: "1 minute ago" });
    await expect(verifyGoogleIdToken(late.token, { clientId: "google-client", nonce }, late.keys)).rejects.toMatchObject({ code: "provider_error" });
    const good = await idToken({ nonce });
    await expect(verifyGoogleIdToken(good.token, { clientId: "google-client", nonce }, good.keys)).resolves.toMatchObject({ subject: "g-123" });
  });

  it("refuses a nonce that is not the one in our cookie", async () => {
    const { token, keys } = await idToken({ nonce, email: "a@b.c", email_verified: true });
    await expect(verifyGoogleIdToken(token, { clientId: "google-client", nonce: "other" }, keys)).rejects.toMatchObject({ code: "state_mismatch" });
  });

  it("refuses a wrong audience or issuer", async () => {
    const aud = await idToken({ nonce }, { aud: "someone-else" });
    await expect(verifyGoogleIdToken(aud.token, { clientId: "google-client", nonce }, aud.keys)).rejects.toMatchObject({ code: "provider_error" });
    const iss = await idToken({ nonce }, { iss: "https://accounts.example" });
    await expect(verifyGoogleIdToken(iss.token, { clientId: "google-client", nonce }, iss.keys)).rejects.toMatchObject({ code: "provider_error" });
  });

  it("only trusts email_verified when Google says true", async () => {
    const ok = await idToken({ nonce, email: "A@B.c", email_verified: true, name: "A", picture: "p" });
    await expect(verifyGoogleIdToken(ok.token, { clientId: "google-client", nonce }, ok.keys)).resolves.toMatchObject({
      provider: "google", subject: "g-123", email: "a@b.c", emailVerified: true, displayName: "A", avatarUrl: "p",
    });
    const no = await idToken({ nonce, email: "a@b.c", email_verified: "true" });
    await expect(verifyGoogleIdToken(no.token, { clientId: "google-client", nonce }, no.keys)).resolves.toMatchObject({ emailVerified: false });
  });
});

describe("x", () => {
  it("asks for the free scopes without users.email, no refresh token, and PKCE S256", async () => {
    const { url, cookie } = await beginAuth("x", { kind: "login" }, "/profile");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://x.com/i/oauth2/authorize");
    const scopes = u.searchParams.get("scope")!.split(" ");
    expect(scopes.sort()).toEqual(["tweet.read", "users.read"]);
    expect(scopes).not.toContain("offline.access");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://enki.test/api/auth/oauth/x/callback");
    const st = await readState(cookie, "x");
    expect(st?.state).toBe(u.searchParams.get("state"));
    expect(st?.next).toBe("/profile");
  });

  it("never adds expansions or extra user.fields to users/me, and uses Basic auth on the token call", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://api.x.com/2/oauth2/token")) return Response.json({ access_token: "at" });
      if (url.startsWith("https://api.x.com/2/users/me")) return Response.json({ data: { id: "42", name: "Kev", username: "KiriKev", profile_image_url: "img" } });
      throw new Error(`unexpected ${url}`);
    });
    const id = await completeAuth(claims(), "code-1");
    expect(id).toEqual({ provider: "x", subject: "42", email: null, emailVerified: false, handle: "kirikev", displayName: "Kev", avatarUrl: "img" });
    const me = new URL(calls[1].url);
    expect(me.origin + me.pathname).toBe("https://api.x.com/2/users/me");
    expect([...me.searchParams.keys()]).toEqual(["user.fields"]);
    expect(me.searchParams.get("user.fields")).toBe("profile_image_url");
    expect(X_USERINFO).not.toMatch(/expansions/);
    const tokenHeaders = calls[0].init?.headers as Record<string, string>;
    expect(tokenHeaders.Authorization).toBe(`Basic ${Buffer.from("x-client:x-secret").toString("base64")}`);
    expect(String(calls[0].init?.body)).toContain("code_verifier=v1");
  });
});

describe("resolveIdentity", () => {
  const google = (over: Partial<ProviderIdentity> = {}): ProviderIdentity => ({
    provider: "google", subject: "g1", email: "kev@example.com", emailVerified: true, handle: null, displayName: "Kev", avatarUrl: null, ...over,
  });
  const x = (over: Partial<ProviderIdentity> = {}): ProviderIdentity => ({
    provider: "x", subject: "x1", email: null, emailVerified: false, handle: "kirikev", displayName: "Kev", avatarUrl: null, ...over,
  });

  it("(a) a known identity resolves to its user without touching users", async () => {
    const db = fakeDb({ auth_identities: [{ provider: "google", subject: "g1", user_id: UUID }] });
    await expect(resolveIdentity(db.client, google(), { kind: "login" })).resolves.toEqual({ userId: UUID, banned: false, allowlisted: true, inserted: false });
    expect(db.ops).not.toContain("users.insert");
    expect(db.tables.auth_identities[0].last_login_at).toBeTruthy();
  });

  it("(b) never joins a password account by email, confirmed or not, and makes no second account under it", async () => {
    for (const cred of [
      { user_id: OTHER, email: "kev@example.com" }, // typed at register, never confirmed
      { user_id: UUID, email: "kev@example.com", email_verified_at: "2026-10-01T00:00:00.000Z", must_change_password: false },
      { user_id: UUID, email: "kev@example.com", email_verified_at: null, must_change_password: true }, // an invitee before the first login
    ]) {
      const db = fakeDb({ password_credentials: [cred] });
      await expect(resolveIdentity(db.client, google({ email: "Kev@Example.com" }), { kind: "login" })).rejects.toMatchObject({ code: "email_in_use" });
      expect(db.ops).not.toContain("users.insert");
      expect(db.tables.auth_identities ?? []).toEqual([]);
    }
  });

  it("(b) never joins an account a Google login made either, from Google or X, and keeps the other Google account out", async () => {
    const googleMade = { id: UUID, email_lookup_hash: emailLookupHash("kev@example.com"), email_verified_at: "2026-09-24T00:00:00.000Z" };
    for (const who of [google({ subject: "g-recycled" }), x({ email: "kev@example.com", emailVerified: true })]) {
      const db = fakeDb({ users: [googleMade] });
      await expect(resolveIdentity(db.client, who, { kind: "login" })).rejects.toMatchObject({ code: "email_in_use" });
      expect(db.ops).not.toContain("users.insert");
      expect(db.tables.auth_identities ?? []).toEqual([]);
    }

    // an address the provider does not vouch for is no proof of anything: a fresh account, no email stored
    const unverified = fakeDb({ users: [googleMade] });
    const r = await resolveIdentity(unverified.client, google({ emailVerified: false }), { kind: "login" });
    expect(r.userId).not.toBe(UUID);
    expect(unverified.tables.users.find((u) => u.id === r.userId)).not.toHaveProperty("email_lookup_hash");
  });

  it("an address only a deleted account holds says the account was deleted, never to sign in with it", async () => {
    const deletedPassword = fakeDb({ users: [{ id: UUID, deleted_at: "2026-10-10T00:00:00.000Z" }], password_credentials: [{ user_id: UUID, email: "kev@example.com" }] });
    await expect(resolveIdentity(deletedPassword.client, google(), { kind: "login" })).rejects.toMatchObject({ code: "account_deleted" });
    const deletedGoogle = fakeDb({ users: [{ id: UUID, email_lookup_hash: emailLookupHash("kev@example.com"), deleted_at: "2026-10-10T00:00:00.000Z" }] });
    await expect(resolveIdentity(deletedGoogle.client, google({ subject: "g-new" }), { kind: "login" })).rejects.toMatchObject({ code: "account_deleted" });
    expect(deletedGoogle.ops).not.toContain("users.insert");
    // a live holder beside a deleted one: the live one decides
    const both = fakeDb({ users: [{ id: UUID, deleted_at: "2026-10-10T00:00:00.000Z" }, { id: OTHER, deleted_at: null }], password_credentials: [{ user_id: UUID, email: "kev@example.com" }, { user_id: OTHER, email: "kev@example.com" }] });
    await expect(resolveIdentity(both.client, google(), { kind: "login" })).rejects.toMatchObject({ code: "email_in_use" });
  });

  it("a deleted account stays deleted: its provider login is refused", async () => {
    const db = fakeDb({ auth_identities: [{ provider: "x", subject: "x1", user_id: UUID }], users: [{ id: UUID, deleted_at: "2026-10-10T00:00:00.000Z" }] });
    await expect(resolveIdentity(db.client, x(), { kind: "login" })).rejects.toMatchObject({ code: "account_deleted" });
  });

  it("(c) creates a user for a stranger, email columns only for a Google address", async () => {
    const db = fakeDb();
    const r = await resolveIdentity(db.client, x(), { kind: "login" });
    expect(db.tables.users).toEqual([expect.objectContaining({ id: r.userId, account_status: "active", display_name: "Kev", origin: "x" })]);
    expect(db.tables.users[0]).not.toHaveProperty("email_lookup_hash");
    expect(db.tables.auth_identities).toEqual([expect.objectContaining({ user_id: r.userId, handle: "kirikev" })]);

    // an X account's confirmed email stays on its identity: a later Google login with it never lands here
    const xMail = fakeDb();
    const viaX = await resolveIdentity(xMail.client, x({ email: "kev@example.com", emailVerified: true }), { kind: "login" });
    expect(xMail.tables.users[0]).not.toHaveProperty("email_lookup_hash");
    expect(xMail.tables.auth_identities[0]).toMatchObject({ email: "kev@example.com" });
    expect((await resolveIdentity(xMail.client, google(), { kind: "login" })).userId).not.toBe(viaX.userId);

    const withMail = fakeDb();
    await resolveIdentity(withMail.client, google(), { kind: "login" });
    expect(withMail.tables.users[0]).toMatchObject({ email_lookup_hash: expect.stringMatching(/^[0-9a-f]{64}$/), email_verified_at: expect.any(String) });
  });

  it("rolls the users row back when the identity insert fails", async () => {
    const db = fakeDb({}, { "auth_identities.insert": { message: "boom", code: "XX000" } });
    await expect(resolveIdentity(db.client, x(), { kind: "login" })).rejects.toMatchObject({ message: "boom" });
    expect(db.tables.users).toEqual([]);
  });

  // Trial codes (Kev, 2026-10-26): a tester signs in with an own account; the callback spends the code (lib/trial).
  it("whitelist stage: off the list, a trial pass or the account's running trial lets the login on, nothing else", async () => {
    process.env.TEAM_ACCESS_CODE = "code";
    const fresh = fakeDb({ access_allowlist: [] });
    await expect(resolveIdentity(fresh.client, google(), { kind: "login" }, true)).resolves.toMatchObject({ allowlisted: false, inserted: true });
    expect(fresh.tables.users).toHaveLength(1);
    const running = fakeDb({ access_allowlist: [], auth_identities: [{ provider: "google", subject: "g1", user_id: UUID }], "rpc.active_trial": [{ redemption_id: "r1" }] });
    await expect(resolveIdentity(running.client, google(), { kind: "login" })).resolves.toMatchObject({ userId: UUID, allowlisted: false });
    const ended = fakeDb({ access_allowlist: [], auth_identities: [{ provider: "google", subject: "g1", user_id: UUID }] });
    await expect(resolveIdentity(ended.client, google(), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
    const nobody = fakeDb({ access_allowlist: [] });
    await expect(resolveIdentity(nobody.client, google(), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
    expect(nobody.ops).not.toContain("users.insert");
  });

  it("whitelist stage: a Google email must be listed, an X account may be listed by its numeric id instead", async () => {
    process.env.TEAM_ACCESS_CODE = "code";
    const noMail = fakeDb({ access_allowlist: [{ kind: "email", value: "someone@else.com" }] });
    await expect(resolveIdentity(noMail.client, google(), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
    expect(noMail.ops).not.toContain("users.insert");

    const listedMail = fakeDb({ access_allowlist: [{ kind: "email", value: "kev@example.com" }] });
    await expect(resolveIdentity(listedMail.client, google(), { kind: "login" })).resolves.toMatchObject({ allowlisted: true });

    // a listed address the provider has NOT verified opens nothing
    const unverifiedListed = fakeDb({ access_allowlist: [{ kind: "email", value: "kev@example.com" }] });
    await expect(resolveIdentity(unverifiedListed.client, google({ emailVerified: false }), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
    expect(unverifiedListed.ops).not.toContain("users.insert");

    const otherId = fakeDb({ access_allowlist: [{ kind: "x", value: "x2" }] });
    await expect(resolveIdentity(otherId.client, x(), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });

    const listedId = fakeDb({ access_allowlist: [{ kind: "x", value: "x1" }] });
    await expect(resolveIdentity(listedId.client, x(), { kind: "login" })).resolves.toMatchObject({ allowlisted: true });

    // a listed handle opens nothing: whoever registers a released handle is not the person listed
    const byHandle = fakeDb({ access_allowlist: [{ kind: "x", value: "kirikev" }] });
    await expect(resolveIdentity(byHandle.client, x({ subject: "x9" }), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });

    // a Google subject would never match the x kind
    const googleId = fakeDb({ access_allowlist: [{ kind: "x", value: "g1" }] });
    await expect(resolveIdentity(googleId.client, google({ email: null, emailVerified: false }), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
  });

  it("whitelist stage: an identity connected from settings logs in by its account's listing", async () => {
    process.env.TEAM_ACCESS_CODE = "code";
    const linkedX = { provider: "x", subject: "x1", user_id: UUID, email: null, email_verified: false, handle: "kirikev" };
    const listed = [{ kind: "email", value: "kev@example.com" }];

    // the account's password email is listed, the X account is not
    const viaPassword = fakeDb({ access_allowlist: listed, auth_identities: [linkedX], password_credentials: [{ user_id: UUID, email: "kev@example.com" }] });
    await expect(resolveIdentity(viaPassword.client, x(), { kind: "login" })).resolves.toMatchObject({ userId: UUID, allowlisted: true });

    // or another provider identity of the account carries a listed, verified email
    const google1 = { provider: "google", subject: "g1", user_id: UUID, email: "kev@example.com", email_verified: true, handle: null };
    const viaGoogle = fakeDb({ access_allowlist: listed, auth_identities: [linkedX, google1] });
    await expect(resolveIdentity(viaGoogle.client, x(), { kind: "login" })).resolves.toMatchObject({ userId: UUID, allowlisted: true });

    // or the account signs in with a listed wallet (a Phantom account that connected Google), while that wallet is its own
    const walletAccount = fakeDb({ access_allowlist: [{ kind: "wallet", value: "So1Listed" }], auth_identities: [linkedX], user_wallets: [{ user_id: UUID, address: "So1Listed", removed_at: null }] });
    await expect(resolveIdentity(walletAccount.client, x(), { kind: "login" })).resolves.toMatchObject({ userId: UUID, allowlisted: true });
    const walletGone = fakeDb({ access_allowlist: [{ kind: "wallet", value: "So1Listed" }], auth_identities: [linkedX], user_wallets: [{ user_id: UUID, address: "So1Listed", removed_at: "2026-10-01T00:00:00Z" }] });
    await expect(resolveIdentity(walletGone.client, x(), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });

    // or the account's connected X account is listed by its numeric id, and the login is by Google
    const googleOfAccount = { ...google1, email: "unlisted@example.com" };
    const viaListedX = fakeDb({ access_allowlist: [{ kind: "x", value: "x1" }], auth_identities: [linkedX, googleOfAccount] });
    await expect(resolveIdentity(viaListedX.client, google({ email: "unlisted@example.com" }), { kind: "login" })).resolves.toMatchObject({ userId: UUID, allowlisted: true });

    // an unverified identity email does not count, nor does an account with nothing listed
    const unverified = fakeDb({ access_allowlist: listed, auth_identities: [linkedX, { ...google1, email_verified: false }] });
    await expect(resolveIdentity(unverified.client, x(), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
    const nothing = fakeDb({ access_allowlist: [{ kind: "email", value: "someone@else.com" }], auth_identities: [linkedX], password_credentials: [{ user_id: UUID, email: "kev@example.com" }] });
    await expect(resolveIdentity(nothing.client, x(), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
  });

  it("a banned user still resolves, flagged, and stays allowlisted so the gate opens /banned", async () => {
    const db = fakeDb({
      auth_identities: [{ provider: "x", subject: "x1", user_id: UUID }],
      bans: [{ id: "b1", user_id: UUID, reason: "spam", lifted_at: null, expires_at: null }],
    });
    await expect(resolveIdentity(db.client, x(), { kind: "login" })).resolves.toEqual({ userId: UUID, banned: true, allowlisted: true, inserted: false });
  });

  it("(d) link attaches to the session user and refuses an identity owned by someone else", async () => {
    const db = fakeDb();
    await expect(resolveIdentity(db.client, x(), { kind: "link", userId: UUID, session: "s" })).resolves.toMatchObject({ userId: UUID, allowlisted: false });
    expect(db.tables.auth_identities).toEqual([expect.objectContaining({ user_id: UUID, subject: "x1" })]);
    expect(db.ops).not.toContain("users.insert");

    await expect(resolveIdentity(db.client, x(), { kind: "link", userId: OTHER, session: "s" })).rejects.toMatchObject({ code: "already_linked" });
    expect(db.tables.auth_identities).toHaveLength(1);

    const slotTaken = fakeDb({}, { "auth_identities.insert": { message: "duplicate key", code: "23505" } });
    await expect(resolveIdentity(slotTaken.client, x(), { kind: "link", userId: UUID, session: "s" })).rejects.toBeInstanceOf(OAuthError);
  });

  it("names the missing table instead of a cryptic failure", async () => {
    const db = fakeDb({}, { auth_identities: { message: "Could not find the table 'public.auth_identities' in the schema cache", code: "PGRST205" } });
    await expect(resolveIdentity(db.client, x(), { kind: "login" })).rejects.toBeInstanceOf(MissingTableError);
  });
});
