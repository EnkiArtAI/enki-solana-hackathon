import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * One passkey tap is one token for one action. A signed cookie alone stopped no
 * replay: whoever saw an assertion for delete-work could send it again with the
 * same cookie for wallet-change or withdraw, for five minutes, and a synced
 * passkey keeps counter 0, so the counter check is skipped. The real verifier
 * runs here, against a software P-256 authenticator at counter 0.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
const startAuthentication = vi.hoisted(() => vi.fn(async () => ({ id: "asserted" })));
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication, startRegistration: vi.fn() }));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.WEBAUTHN_ORIGIN = "https://enki.test";
});

import { POST as options } from "../../app/api/auth/passkey/stepup/options/route";
import { POST as verify } from "../../app/api/auth/passkey/stepup/verify/route";
import { passkeyStepUpToken } from "../../hooks/usePasskey";

const U = "11111111-1111-4111-8111-111111111111";
const SOL = "So11111111111111111111111111111111111111112";
const HARMLESS = "delete-work:9a2b3c4d-1111-4222-8333-444455556666";
const CHANGE = `wallet-change:${SOL}`;
const CRED = "c29mdHdhcmUta2V5";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
const coseKey = Buffer.concat([
  Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, "base64url"),
  Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, "base64url"),
]);
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

/** What an authenticator at counter 0 answers for this challenge. */
function assertion(challenge: string) {
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: "https://enki.test" }));
  const authData = Buffer.concat([sha256("enki.test"), Buffer.from([0x05, 0, 0, 0, 0])]);
  const signature = createSign("SHA256").update(Buffer.concat([authData, sha256(clientData)])).sign(privateKey);
  return {
    id: CRED, rawId: CRED, type: "public-key", clientExtensionResults: {},
    response: { clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") },
  };
}

const call = (route: "options" | "verify", body: unknown, cookie?: string) => {
  const req = new NextRequest(`https://enki.test/api/auth/passkey/stepup/${route}`, {
    method: "POST",
    headers: { "X-Session-Token": "sess", ...(cookie ? { cookie: `pk_auth_challenge=${cookie}` } : {}) },
    body: JSON.stringify(body),
  });
  return route === "options" ? options(req) : verify(req);
};
async function begun(scope: string) {
  const res = await call("options", { scope });
  expect(res.status).toBe(200);
  const { challenge } = (await res.json()) as { challenge: string };
  return { challenge, cookie: res.cookies.get("pk_auth_challenge")!.value };
}

beforeEach(() => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  Object.assign(db.tables, {
    auth_sessions: [{ token: "sess", wallet_address: U, wallet_type: "password", expires_at: new Date(Date.now() + 3_600_000).toISOString() }],
    webauthn_credentials: [{ id: "pk1", user_id: U, credential_id: CRED, public_key: coseKey.toString("base64url"), counter: 0, transports: null }],
    consumed_stepup_tokens: [],
    bans: [],
    user_wallets: [],
  });
  db.state.failing = null;
  db.state.failNext = null;
});

describe("a passkey step-up", () => {
  it("gives one token, named passkey, for the scope the challenge was issued for", async () => {
    const { challenge, cookie } = await begun(HARMLESS);
    const res = await call("verify", { response: assertion(challenge), scope: HARMLESS }, cookie);
    expect(res.status).toBe(200);
    expect(decodeJwt(((await res.json()) as { token: string }).token)).toMatchObject({ sub: U, scope: HARMLESS, factor: "passkey" });
    expect(db.tables.consumed_stepup_tokens).toHaveLength(1);
    expect(db.tables.consumed_stepup_tokens[0]).toMatchObject({ user_id: U, scope: HARMLESS });
    expect(db.tables.consumed_stepup_tokens[0].jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("cannot be replayed for the same scope: the challenge is spent, the counter never would have stopped it", async () => {
    const { challenge, cookie } = await begun(HARMLESS);
    const response = assertion(challenge);
    expect((await call("verify", { response, scope: HARMLESS }, cookie)).status).toBe(200);
    const again = await call("verify", { response, scope: HARMLESS }, cookie);
    expect(again.status).toBe(400);
    expect((await again.json()).token).toBeUndefined();
    expect(again.cookies.get("pk_auth_challenge")?.value).toBe("");
  });

  it("cannot be replayed for another scope: the cookie is signed for the first", async () => {
    const { challenge, cookie } = await begun(HARMLESS);
    const response = assertion(challenge);
    expect((await call("verify", { response, scope: HARMLESS }, cookie)).status).toBe(200);
    for (const scope of [CHANGE, "export", `withdraw:${SOL}`]) {
      const res = await call("verify", { response, scope }, cookie);
      expect(res.status).toBe(400);
      expect((await res.json()).token).toBeUndefined();
    }
  });

  it("refuses another scope before the first use too, and that burns nothing", async () => {
    const { challenge, cookie } = await begun(HARMLESS);
    const response = assertion(challenge);
    expect((await call("verify", { response, scope: CHANGE }, cookie)).status).toBe(400);
    expect(db.tables.consumed_stepup_tokens).toEqual([]);
    expect((await call("verify", { response, scope: HARMLESS }, cookie)).status).toBe(200);
  });

  it("a wrong assertion spends nothing: the owner's own tap still works", async () => {
    const { challenge, cookie } = await begun(HARMLESS);
    const forged = assertion("c29tZS1vdGhlci1jaGFsbGVuZ2U");
    expect((await call("verify", { response: forged, scope: HARMLESS }, cookie)).status).toBe(400);
    expect(db.tables.consumed_stepup_tokens).toEqual([]);
    expect((await call("verify", { response: assertion(challenge), scope: HARMLESS }, cookie)).status).toBe(200);
  });

  it("answers 503 with no token when the store fails, and stamps no unlock", async () => {
    const { challenge, cookie } = await begun("wallet");
    db.state.failNext = { table: "consumed_stepup_tokens", op: "insert", code: "XX000" };
    const res = await call("verify", { response: assertion(challenge), scope: "wallet" }, cookie);
    expect(res.status).toBe(503);
    expect((await res.json()).token).toBeUndefined();
    expect(db.tables.auth_sessions[0].stepup_at).toBeUndefined();
  });

  it("a replayed wallet unlock stamps no second unlock", async () => {
    const { challenge, cookie } = await begun("wallet");
    const response = assertion(challenge);
    expect((await call("verify", { response, scope: "wallet" }, cookie)).status).toBe(200);
    db.tables.auth_sessions[0].stepup_at = null;
    expect((await call("verify", { response, scope: "wallet" }, cookie)).status).toBe(400);
    expect(db.tables.auth_sessions[0].stepup_at).toBeNull();
  });

  it("two different taps are two challenges, both good", async () => {
    for (let i = 0; i < 2; i++) {
      const { challenge, cookie } = await begun(CHANGE);
      expect((await call("verify", { response: assertion(challenge), scope: CHANGE }, cookie)).status).toBe(200);
    }
    expect(db.tables.consumed_stepup_tokens).toHaveLength(2);
  });

  it("issues no challenge for an unknown scope, or none", async () => {
    expect((await call("options", { scope: "everything" })).status).toBe(400);
    expect((await call("options", {})).status).toBe(400);
  });

  it("the client asks for the challenge with the scope it will verify", async () => {
    const seen: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
      seen.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(url.endsWith("options") ? { challenge: "x" } : { token: "t" }), { status: 200 });
    }));
    await expect(passkeyStepUpToken(CHANGE)).resolves.toBe("t");
    vi.unstubAllGlobals();
    expect(seen[0]).toEqual({ url: "/api/auth/passkey/stepup/options", body: { scope: CHANGE } });
    expect(seen[1].body).toMatchObject({ scope: CHANGE });
  });
});
