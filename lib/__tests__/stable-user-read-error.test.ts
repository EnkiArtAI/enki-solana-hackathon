import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * resolveStableUserId used to drop a read error, so an outage read as "no user".
 * Passkeys key on what it answers: every caller has to stop on a failed read,
 * never carry on as if the wallet had no account. The real routes run; the
 * database is a fake.
 */

const WALLET = "7Yk3r9dQmPvZx1aBcDeFgHiJkLmNoPqRsTuVwXyZ1234";
const USER = "0b5f2c1e-1111-4222-8333-444455556666";
const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
vi.mock("@/lib/auth", () => ({
  requireAuth: async () => ({ walletAddress: WALLET, userId: WALLET }),
  authRefusal: () => new Response(null, { status: 401 }),
}));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserWithBan: async () => ({ userId: USER, ban: null, wallet: WALLET }) }));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { POST as registerOptions } from "../../app/api/auth/passkey/register/options/route";
import { POST as registerVerify } from "../../app/api/auth/passkey/register/verify/route";
import { POST as stepUpOptions } from "../../app/api/auth/passkey/stepup/options/route";
import { POST as stepUpVerify } from "../../app/api/auth/passkey/stepup/verify/route";
import { resolveStableUserId } from "../webauthn";

const post = (path: string, body: unknown) => new NextRequest(`http://enki.test${path}`, { method: "POST", headers: { "X-Session-Token": "sess" }, body: JSON.stringify(body) });

beforeEach(() => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  Object.assign(db.tables, { user_wallets: [{ user_id: USER, address: WALLET, removed_at: null }], webauthn_credentials: [], mfa_factors: [], password_credentials: [] });
  db.state.failing = null;
});

describe("resolveStableUserId", () => {
  it("answers a uuid as it is, without reading", async () => {
    db.state.failing = { table: "user_wallets", code: "XX000" };
    expect(await resolveStableUserId(db.client, USER)).toBe(USER);
  });

  it("answers the wallet's account, and null when no row answers", async () => {
    expect(await resolveStableUserId(db.client, WALLET)).toBe(USER);
    db.tables.user_wallets = [];
    expect(await resolveStableUserId(db.client, WALLET)).toBeNull();
  });

  it("throws on a failed read", async () => {
    db.state.failing = { table: "user_wallets", code: "XX000" };
    await expect(resolveStableUserId(db.client, WALLET)).rejects.toMatchObject({ code: "XX000" });
  });
});

describe("every passkey route stops on a failed read", () => {
  const routes: [string, () => Promise<Response>][] = [
    ["register options", () => registerOptions(post("/api/auth/passkey/register/options", {}))],
    ["register verify", () => registerVerify(post("/api/auth/passkey/register/verify", { response: { id: "cred" } }))],
    ["step-up options", () => stepUpOptions(post("/api/auth/passkey/stepup/options", { scope: "wallet" }))],
    ["step-up verify", () => stepUpVerify(post("/api/auth/passkey/stepup/verify", { scope: "wallet", response: { id: "cred" } }))],
  ];

  for (const [name, call] of routes) {
    it(`${name}: stops, with nothing issued; with no row it says no user`, async () => {
      db.state.failing = { table: "user_wallets", code: "XX000" };
      await expect(call()).rejects.toMatchObject({ code: "XX000" });
      expect(db.tables.webauthn_credentials).toEqual([]);
      db.state.failing = null;
      db.tables.user_wallets = [];
      expect((await call()).status).toBe(404);
    });
  }
});
