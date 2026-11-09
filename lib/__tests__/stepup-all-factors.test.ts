import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { decodeJwt, SignJWT } from "jose";
import { hkdfSync } from "node:crypto";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * requireAllFactors, the gate a wallet change sits behind (Kev, 2026-11-05: a
 * wallet changes only with all MFAs). One token per enrolled factor, each for
 * this user and this exact scope; nothing is claimed until all are there, and
 * then every jti is, so one approval never changes a wallet twice.
 */

const db = fakePostgrest();
const supabase = db.client;
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => supabase }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserWithBan: async () => ({ userId: U, ban: null, wallet: U }) }));
vi.mock("@simplewebauthn/server", async (orig) => ({
  ...(await orig<typeof import("@simplewebauthn/server")>()),
  verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 1 } }),
}));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { isStepUpScope, mintStepUpToken, requireAllFactors, requireStepUp, setChallengeCookie } from "../webauthn";
import { beginTotp, checkCode } from "../mfa";
import { totpCode } from "../totp";
import { POST as codeStepUp } from "../../app/api/auth/stepup/route";
import { POST as passkeyStepUp } from "../../app/api/auth/passkey/stepup/verify/route";

const U = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SOL = "So11111111111111111111111111111111111111112";
const SCOPE = `wallet-change:${SOL}`;
const req = (...tokens: string[]) => new NextRequest("http://enki.test/x", { headers: tokens.length ? { "X-StepUp-Token": tokens.join(",") } : {} });
const claimed = () => db.tables.consumed_stepup_tokens.map((r) => r.jti);
const jti = (token: string) => decodeJwt(token).jti;

/** Both a passkey and an authenticator app enrolled, unless a test narrows it. */
const twoFactors = () => {
  db.tables.webauthn_credentials = [{ id: "pk1", user_id: U, credential_id: "c1", public_key: "AAAA", counter: 0 }];
  db.tables.mfa_factors = [{ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" }];
};

beforeEach(() => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  db.tables.webauthn_credentials = [];
  db.tables.mfa_factors = [];
  db.tables.consumed_stepup_tokens = [];
  db.tables.password_credentials = [];
  db.state.failing = null;
  db.state.failNext = null;
});

describe("requireAllFactors", () => {
  it("refuses one factor of two, names the missing one, and claims nothing", async () => {
    twoFactors();
    const res = await requireAllFactors(req(await mintStepUpToken(U, SCOPE, "passkey")), U, SCOPE);
    expect(res!.status).toBe(401);
    expect(await res!.json()).toMatchObject({ stepUp: true, all: true, scope: SCOPE, factors: ["passkey", "totp"], missing: ["totp"] });
    expect(claimed()).toEqual([]);
  });

  it("asks for all of them when no token came at all", async () => {
    twoFactors();
    const res = await requireAllFactors(req(), U, SCOPE);
    expect(await res!.json()).toMatchObject({ missing: ["passkey", "totp"] });
  });

  it("passes with every factor and claims each jti", async () => {
    twoFactors();
    const a = await mintStepUpToken(U, SCOPE, "passkey");
    const b = await mintStepUpToken(U, SCOPE, "totp");
    expect(await requireAllFactors(req(a, b), U, SCOPE)).toBeNull();
    expect(claimed().sort()).toEqual([jti(a), jti(b)].sort());
  });

  it("refuses the same tokens a second time, for every token in the set", async () => {
    twoFactors();
    const a = await mintStepUpToken(U, SCOPE, "passkey");
    const b = await mintStepUpToken(U, SCOPE, "totp");
    expect(await requireAllFactors(req(a, b), U, SCOPE)).toBeNull();
    const replay = await requireAllFactors(req(a, b), U, SCOPE);
    expect(replay!.status).toBe(401);
    expect(await replay!.json()).toMatchObject({ all: true, missing: ["passkey", "totp"] });
    const fresh = await mintStepUpToken(U, SCOPE, "totp");
    expect((await requireAllFactors(req(a, fresh), U, SCOPE))!.status).toBe(401);
  });

  it("claims none of the set when one of them is a replay", async () => {
    twoFactors();
    const used = await mintStepUpToken(U, SCOPE, "passkey");
    db.tables.consumed_stepup_tokens.push({ jti: jti(used), user_id: U, scope: SCOPE });
    const fresh = await mintStepUpToken(U, SCOPE, "totp");
    expect((await requireAllFactors(req(used, fresh), U, SCOPE))!.status).toBe(401);
    expect(claimed()).toEqual([jti(used)]);
  });

  it("counts the same factor twice as one", async () => {
    twoFactors();
    const res = await requireAllFactors(req(await mintStepUpToken(U, SCOPE, "totp"), await mintStepUpToken(U, SCOPE, "totp")), U, SCOPE);
    expect(await res!.json()).toMatchObject({ missing: ["passkey"] });
  });

  it("refuses a token for another scope, another target or another user", async () => {
    db.tables.mfa_factors = [{ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" }];
    for (const token of [
      await mintStepUpToken(U, "wallet", "totp"),
      await mintStepUpToken(U, `wallet-change:${"1".repeat(32)}`, "totp"),
      await mintStepUpToken(OTHER, SCOPE, "totp"),
    ]) {
      expect((await requireAllFactors(req(token), U, SCOPE))!.status).toBe(401);
    }
    expect(claimed()).toEqual([]);
  });

  it("refuses a token with no factor claim, as older tokens and server-made ones have", async () => {
    db.tables.mfa_factors = [{ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" }];
    expect((await requireAllFactors(req(await mintStepUpToken(U, SCOPE)), U, SCOPE))!.status).toBe(401);
  });

  it("refuses a token with no jti, which could not be claimed, and one signed with another key", async () => {
    db.tables.mfa_factors = [{ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" }];
    const signed = (key: Uint8Array, jti?: string) => {
      const token = new SignJWT({ scope: SCOPE, factor: "totp" }).setProtectedHeader({ alg: "HS256" }).setSubject(U).setExpirationTime("300s");
      return (jti ? token.setJti(jti) : token).sign(key);
    };
    const key = new Uint8Array(hkdfSync("sha256", Buffer.from(process.env.AUTH_PEPPER!, "base64"), new Uint8Array(0), Buffer.from("enki-stepup-v1"), 32));
    expect((await requireAllFactors(req(await signed(key)), U, SCOPE))!.status).toBe(401);
    expect((await requireAllFactors(req(await signed(new Uint8Array(32).fill(1), "forged")), U, SCOPE))!.status).toBe(401);
    expect(await requireAllFactors(req(await signed(key, "genuine")), U, SCOPE)).toBeNull();
  });

  it("refuses a token for a factor that is not enrolled any more", async () => {
    db.tables.mfa_factors = [{ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" }];
    const stale = await mintStepUpToken(U, SCOPE, "passkey");
    expect((await requireAllFactors(req(stale), U, SCOPE))!.status).toBe(401);
    // Nor does it get claimed beside the factor that does count.
    const live = await mintStepUpToken(U, SCOPE, "totp");
    expect(await requireAllFactors(req(stale, live), U, SCOPE)).toBeNull();
    expect(claimed()).toEqual([jti(live)]);
  });

  it("does not count an email code on a password account, where it is no factor", async () => {
    db.tables.password_credentials = [{ user_id: U, email: "a@example.test" }];
    db.tables.mfa_factors = [
      { user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" },
      { user_id: U, kind: "email", confirmed_at: "2026-10-07T00:00:00Z" },
    ];
    const res = await requireAllFactors(req(await mintStepUpToken(U, SCOPE, "email")), U, SCOPE);
    expect(await res!.json()).toMatchObject({ factors: ["totp"], missing: ["totp"] });
    expect(await requireAllFactors(req(await mintStepUpToken(U, SCOPE, "totp")), U, SCOPE)).toBeNull();
  });

  it("without a factor: proceeds, unless mandatory, which answers 403 { enroll }", async () => {
    expect(await requireAllFactors(req(), U, SCOPE)).toBeNull();
    const res = await requireAllFactors(req(), U, SCOPE, { mandatory: true });
    expect(res!.status).toBe(403);
    expect(await res!.json()).toMatchObject({ enroll: true, error: "Set up a second factor first" });
  });

  it("refuses when the token store fails, and when the factors cannot be read", async () => {
    db.tables.mfa_factors = [{ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" }];
    const token = await mintStepUpToken(U, SCOPE, "totp");
    db.state.failNext = { table: "consumed_stepup_tokens", op: "insert", code: "XX000" };
    expect((await requireAllFactors(req(token), U, SCOPE))!.status).toBe(503);
    db.state.failing = { table: "mfa_factors", code: "XX000" };
    expect((await requireAllFactors(req(token), U, SCOPE, { mandatory: true }))!.status).toBe(503);
  });
});

describe("the wallet-change scope", () => {
  it("names a Solana address and nothing else", () => {
    expect(isStepUpScope(SCOPE)).toBe(true);
    expect(isStepUpScope("wallet-change:")).toBe(false);
    expect(isStepUpScope("wallet-change:not-an-address")).toBe(false);
  });

  it("is single use through requireStepUp too", async () => {
    db.tables.mfa_factors = [{ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" }];
    const token = await mintStepUpToken(U, SCOPE, "totp");
    expect(await requireStepUp(req(token), U, SCOPE)).toBeNull();
    expect((await requireStepUp(req(token), U, SCOPE))!.status).toBe(401);
  });
});

describe("both routes that mint a token say which factor passed", () => {
  it("the code route", async () => {
    const t = await beginTotp(supabase, U, "me");
    if (typeof t === "string") throw new Error(t);
    expect(await checkCode(supabase, U, "totp", totpCode(t.secret), { confirm: true })).toBe("ok");
    const res = await codeStepUp(new NextRequest("http://enki.test/api/auth/stepup", {
      method: "POST",
      headers: { "X-Session-Token": "sess" },
      body: JSON.stringify({ scope: SCOPE, factor: "totp", code: totpCode(t.secret, Math.floor(Date.now() / 30000) + 1) }),
    }));
    expect(res.status).toBe(200);
    expect(decodeJwt((await res.json()).token).factor).toBe("totp");
  });

  it("the passkey route", async () => {
    db.tables.webauthn_credentials = [{ id: "pk1", user_id: U, credential_id: "cred1", public_key: "AAAA", counter: 0, transports: null }];
    const issued = NextResponse.json({});
    setChallengeCookie(issued, "pk_auth_challenge", "challenge", U, SCOPE);
    const res = await passkeyStepUp(new NextRequest("http://enki.test/api/auth/passkey/stepup/verify", {
      method: "POST",
      headers: { "X-Session-Token": "sess", cookie: `pk_auth_challenge=${issued.cookies.get("pk_auth_challenge")!.value}` },
      body: JSON.stringify({ response: { id: "cred1" }, scope: SCOPE }),
    }));
    expect(res.status).toBe(200);
    expect(decodeJwt((await res.json()).token).factor).toBe("passkey");
  });
});
