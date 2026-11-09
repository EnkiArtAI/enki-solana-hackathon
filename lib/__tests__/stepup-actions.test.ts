import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { readSource } from "@/lib/__tests__/_read-source";
import { STEPUP_DEFAULTS, isStepUpAction, withDefaults } from "@/lib/stepup-actions";

/**
 * The Settings table of actions that ask for the second factor (Kev,
 * 2026-10-17: "ne tabelle mit toggles für bilder upload, prompt einstellen,
 * printen, löschen"). All on except render; switching one off is itself a
 * step-up, switching one on asks nothing; only chosen switches are stored.
 * The real step-up check and real tokens run; the database is in memory.
 */

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  users: [] as Record<string, unknown>[], readError: null as null | { code: string }, writeError: null as null | { code: string },
  // When the session was made: switching off without a factor needs a fresh one.
  sessionCreated: "", rpcCalls: 0,
}));
const factors = vi.hoisted(() => ({ list: [] as string[] }));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64"); });

const users = () => {
  let id: unknown;
  const q = {
    select: () => q,
    eq: (_c: string, v: unknown) => { id = v; return q; },
    maybeSingle: async () => (db.readError ? { data: null, error: db.readError } : { data: db.users.find((r) => r.id === id) ?? null, error: null }),
  };
  return q;
};
const sessions = () => {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: db.sessionCreated ? { created_at: db.sessionCreated } : null, error: null }) };
  return q;
};
/** merge_stepup_actions: stepup_actions || patch, in one step, as the SQL does. */
const rpc = async (fn: string, args: { p_user: string; p_patch: Row }) => {
  db.rpcCalls++;
  if (fn !== "merge_stepup_actions") return { data: null, error: { code: "PGRST202" } };
  if (db.writeError) return { data: null, error: db.writeError };
  const row = db.users.find((r) => r.id === args.p_user);
  if (!row) return { data: null, error: null };
  row.stepup_actions = { ...((row.stepup_actions as Row) ?? {}), ...args.p_patch };
  return { data: row.stepup_actions, error: null };
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: (t: string) => (t === "consumed_stepup_tokens" ? { insert: async () => ({ error: null }) } : t === "auth_sessions" ? sessions() : users()), rpc }) }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserWithBan: async (_s: unknown, t: string | null) => ({ userId: t === "tok" ? ME : null, ban: null }) }));
vi.mock("@/lib/mfa", () => ({ enrolledFactors: async () => factors.list, isPasswordAccount: async () => true, checkCode: async () => "none" }));

const ME = "0b5f2c1e-1111-4222-8333-444455556666";
import { GET, PATCH } from "../../app/api/auth/stepup/route";
import { mintStepUpToken, requireActionStepUp } from "../webauthn";

const req = (method: string, body?: unknown, stepUp?: string) =>
  new Request("http://enki.test/api/auth/stepup", {
    method, headers: { "X-Session-Token": "tok", "content-type": "application/json", ...(stepUp ? { "X-StepUp-Token": stepUp } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
const actionsOf = async (res: Response) => ((await res.json()) as { actions: Record<string, boolean> }).actions;

beforeEach(() => {
  factors.list = [];
  db.readError = null;
  db.writeError = null;
  db.users = [{ id: ME }];
  db.sessionCreated = new Date(Date.now() - 60 * 60_000).toISOString(); // an hour old
  db.rpcCalls = 0;
});

describe("the actions and their defaults", () => {
  it("asks for upload, publish and delete by default, not for render", () => {
    expect(STEPUP_DEFAULTS).toEqual({ upload: true, publish: true, render: false, delete: true });
    expect(withDefaults(undefined)).toEqual(STEPUP_DEFAULTS);
  });

  it("takes an account's own booleans over the defaults and ignores anything else", () => {
    expect(withDefaults({ render: true, delete: false, upload: "no", wallet: false })).toEqual({ upload: true, publish: true, render: true, delete: false });
    expect(withDefaults([true])).toEqual(STEPUP_DEFAULTS);
    expect(isStepUpAction("render")).toBe(true);
    expect(isStepUpAction("toString")).toBe(false);
    expect(isStepUpAction("wallet")).toBe(false);
  });
});

describe("reading the table", () => {
  it("answers the defaults, an account's choices, and the defaults when it cannot be read", async () => {
    expect(await actionsOf(await GET(req("GET")))).toEqual(STEPUP_DEFAULTS);
    db.users[0].stepup_actions = { render: true, upload: false };
    expect(await actionsOf(await GET(req("GET")))).toEqual({ upload: false, publish: true, render: true, delete: true });
    db.readError = { code: "42703" };
    expect(await actionsOf(await GET(req("GET")))).toEqual(STEPUP_DEFAULTS);
  });
});

describe("changing the table", () => {
  it("switching one off asks for the second factor, and only a stepup-settings token passes", async () => {
    factors.list = ["passkey"];
    const bare = await PATCH(req("PATCH", { actions: { delete: false } }));
    expect(bare.status).toBe(401);
    expect(await bare.json()).toMatchObject({ stepUp: true, scope: "stepup-settings" });
    expect(db.users[0].stepup_actions).toBeUndefined();
    expect((await PATCH(req("PATCH", { actions: { delete: false } }, await mintStepUpToken(ME, "delete-account")))).status).toBe(401);
    const ok = await PATCH(req("PATCH", { actions: { delete: false } }, await mintStepUpToken(ME, "stepup-settings", "passkey")));
    expect(ok.status).toBe(200);
    expect(await actionsOf(ok)).toEqual({ upload: true, publish: true, render: false, delete: false });
    // Only what was chosen is stored.
    expect(db.users[0].stepup_actions).toEqual({ delete: false });
  });

  it("switching one on asks nothing and keeps the earlier choices", async () => {
    factors.list = ["totp"];
    db.users[0].stepup_actions = { delete: false };
    const res = await PATCH(req("PATCH", { actions: { render: true } }));
    expect(res.status).toBe(200);
    expect(db.users[0].stepup_actions).toEqual({ delete: false, render: true });
  });

  it("asks when a change switches any one off, even beside one switched on", async () => {
    factors.list = ["passkey"];
    expect((await PATCH(req("PATCH", { actions: { render: true, upload: false } }))).status).toBe(401);
  });

  it("without a factor, switching off takes a login younger than ten minutes, so a stolen session cannot plant it (review 2026-10-17)", async () => {
    const stale = await PATCH(req("PATCH", { actions: { delete: false } }));
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ reauth: true });
    expect(db.users[0].stepup_actions).toBeUndefined();
    db.sessionCreated = new Date().toISOString();
    expect((await PATCH(req("PATCH", { actions: { delete: false } }))).status).toBe(200);
    expect(db.users[0].stepup_actions).toEqual({ delete: false });
  });

  it("merges in one database step, never by writing a whole value read earlier", async () => {
    db.users[0].stepup_actions = { delete: false };
    await Promise.all([PATCH(req("PATCH", { actions: { delete: true } })), PATCH(req("PATCH", { actions: { render: true } }))]);
    expect(db.users[0].stepup_actions).toEqual({ delete: true, render: true });
    expect(db.rpcCalls).toBe(2);
    const route = readSource(join(__dirname, "..", "..", "app", "api", "auth", "stepup", "route.ts"));
    expect(route).toContain('const { data, error } = await supabase.rpc("merge_stepup_actions", { p_user: userId, p_patch: Object.fromEntries(entries) });');
    expect(route).not.toMatch(/update\(\{ stepup_actions/);
  });

  it("refuses an unknown action, a non-boolean or nothing at all", async () => {
    for (const actions of [{ wallet: false }, { render: "on" }, {}, null, [true]]) {
      expect((await PATCH(req("PATCH", { actions }))).status).toBe(400);
    }
    expect(db.rpcCalls).toBe(0);
  });

  it("says so before the migration has run: no function, no column", async () => {
    for (const code of ["PGRST202", "42703"]) {
      db.writeError = { code };
      const res = await PATCH(req("PATCH", { actions: { render: true } }));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("This setting is not available yet");
    }
    db.writeError = { code: "XX000" };
    expect((await PATCH(req("PATCH", { actions: { render: true } }))).status).toBe(500);
  });
});

describe("the gate", () => {
  const gateReq = (stepUp?: string) => ({ headers: new Headers(stepUp ? { "X-StepUp-Token": stepUp } : {}) });

  it("asks only for an action the account has on, and only with that action's scope", async () => {
    factors.list = ["passkey"];
    expect((await requireActionStepUp(gateReq(), ME, "render", "render"))).toBeNull();
    expect((await requireActionStepUp(gateReq(), ME, "delete", "delete-account"))?.status).toBe(401);
    db.users[0].stepup_actions = { render: true, delete: false };
    expect((await requireActionStepUp(gateReq(), ME, "render", "render"))?.status).toBe(401);
    expect(await requireActionStepUp(gateReq(await mintStepUpToken(ME, "render")), ME, "render", "render")).toBeNull();
    expect(await requireActionStepUp(gateReq(), ME, "delete", "delete-account")).toBeNull();
  });
});

describe("the table in Settings", () => {
  const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

  it("sits in the 2FA section under the factors and changes a switch through the step-up dialog", () => {
    expect(src("components", "settings", "RecoveryPanel.tsx")).toContain("<CodeFactors onChange={recoveryChanged} onCodes={setFirstCodes} />\n        <RecoveryCodes onRemoved={loadPasskeys} />\n        <StepUpActionsTable />");
    const table = src("components", "settings", "StepUpActionsTable.tsx");
    expect(table).toContain('const res = await guarded("stepup-settings", (h) => fetch("/api/auth/stepup", {');
    expect(table).toContain("body: JSON.stringify({ actions: { [action]: on } }),");
    expect(table).toContain("if (res.status === 401 && body.stepUp) return;");
    // Without a factor, switching off needs a fresh login: the table offers it.
    expect(table).toContain("if (body.reauth) openLogin(BACK_TO_RECOVERY);");
    expect(table).toContain("const actions = data?.actions ?? STEPUP_DEFAULTS;");
  });
});
