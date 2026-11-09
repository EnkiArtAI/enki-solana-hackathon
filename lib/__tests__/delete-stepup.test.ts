import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * MFA-3: ending the account (POST /api/account/delete) and deleting a library
 * item (DELETE /api/library) ask for the second factor once the user has one,
 * like every other delete. Without a factor both work as before. The real
 * step-up check and real tokens run; the database is in memory.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
const factors = vi.hoisted(() => ({ list: [] as string[] }));

const query = (table: string) => {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  let remove = false;
  const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const run = () => {
    const hit = rows();
    if (patch) hit.forEach((r) => Object.assign(r, patch));
    if (remove) tables[table] = (tables[table] ?? []).filter((r) => !hit.includes(r));
    return { data: hit, error: null, count: hit.length };
  };
  const q = {
    select: () => q,
    update: (values: Row) => { patch = values; return q; },
    delete: () => { remove = true; return q; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    is: (c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return q; },
    in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
  };
  return q;
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: query }) }));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async (_s: unknown, t: string | null) => (t === "owner-tok" ? OWNER : null),
}));
vi.mock("@/lib/mfa", () => ({ enrolledFactors: async () => factors.list }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  checkRequestRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

// Before the imports: the account route's modules read the pepper as they load.
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64"); });
const OWNER = "0b5f2c1e-1111-4222-8333-444455556666";
const ITEM = "1a2b3c4d-1111-4222-8333-444455556666";
const ITEM2 = "5e6f7a8b-1111-4222-8333-444455556666";

import { POST as deleteAccount } from "../../app/api/account/delete/route";
import * as libraryRoute from "../../app/api/library/route";
import { DELETE as deleteLibrary } from "../../app/api/library/route";
import { mintStepUpToken } from "../webauthn";

const headers = (stepUp?: string): Record<string, string> => ({ "X-Session-Token": "owner-tok", ...(stepUp ? { "X-StepUp-Token": stepUp } : {}) });
const endAccount = (stepUp?: string, confirm = "kev") =>
  deleteAccount(new Request("http://enki.test/api/account/delete", { method: "POST", headers: headers(stepUp), body: JSON.stringify({ confirm }) }) as unknown as NextRequest);
const dropItem = (id: string, stepUp?: string) =>
  deleteLibrary(Object.assign(new Request(`http://enki.test/api/library?id=${id}`, { method: "DELETE", headers: headers(stepUp) }), { nextUrl: new URL(`http://enki.test/api/library?id=${id}`) }) as unknown as NextRequest);
const accountGone = () => tables.users[0].deleted_at != null;
const itemKept = (id: string) => tables.saved_workflows.some((r) => r.id === id);

beforeEach(() => {
  factors.list = [];
  tables = {
    users: [{ id: OWNER, handle: "kev", deleted_at: null }],
    recovery_guardians: [],
    user_wallets: [],
    auth_sessions: [{ wallet_address: OWNER, token: "owner-tok" }],
    deletion_requests: [],
    saved_workflows: [{ id: ITEM, user_id: OWNER }, { id: ITEM2, user_id: OWNER }],
  };
});

describe("ending the account", () => {
  it("works with the typed handle alone while the user has no factor", async () => {
    const res = await endAccount();
    expect(res.status).toBe(200);
    expect(accountGone()).toBe(true);
  });

  // DEC-434 (review wf_866ba07b-01a): a deleted account opens nothing more on this browser.
  it("takes the access cookies with it", async () => {
    const set = (await endAccount()).headers.getSetCookie();
    expect(set.some((c) => /^enki_team=;.*Max-Age=0/i.test(c))).toBe(true);
    expect(set.some((c) => /^enki_trial=;.*Max-Age=0/i.test(c))).toBe(true);
  });

  it("evicts sessions on both sides of the identity delete, as the reset does", () => {
    const route = readSource(join(__dirname, "..", "..", "app", "api", "account", "delete", "route.ts"));
    const evict = 'await supabase.from("auth_sessions").delete().in("wallet_address", keys);';
    const identities = route.indexOf('await supabase.from("auth_identities").delete().eq("user_id", userId);');
    expect(route.indexOf(evict)).toBeGreaterThan(-1);
    expect(identities).toBeGreaterThan(route.indexOf(evict));
    expect(route.indexOf(evict, identities)).toBeGreaterThan(identities);
  });

  it("takes the account's Google and X logins with it, and nobody else's", async () => {
    const other = { provider: "x", subject: "x2", user_id: "someone-else" };
    tables.auth_identities = [{ provider: "x", subject: "x1", user_id: OWNER }, { provider: "google", subject: "g1", user_id: OWNER }, other];
    expect((await endAccount()).status).toBe(200);
    expect(tables.auth_identities).toEqual([other]);
  });

  it("asks for the second factor once one is enrolled, and ends nothing without it", async () => {
    factors.list = ["passkey"];
    const res = await endAccount();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ stepUp: true, scope: "delete-account", factors: ["passkey"] });
    expect(accountGone()).toBe(false);
    expect(tables.auth_sessions).toHaveLength(1);
  });

  it("takes no other scope's token", async () => {
    factors.list = ["totp"];
    expect((await endAccount(await mintStepUpToken(OWNER, `delete-library:${ITEM}`))).status).toBe(401);
    expect(accountGone()).toBe(false);
  });

  it("ends the account with a delete-account token", async () => {
    factors.list = ["passkey"];
    const res = await endAccount(await mintStepUpToken(OWNER, "delete-account"));
    expect(res.status).toBe(200);
    expect(accountGone()).toBe(true);
  });

  it("answers a mistyped handle before asking for a factor", async () => {
    factors.list = ["passkey"];
    expect((await endAccount(undefined, "kevv")).status).toBe(400);
  });
});

describe("the callers run through the step-up dialog", () => {
  const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

  // The flow lives in Settings' account hooks (DEC-2026-11-08-41); the dialog stays in the view.
  const hook = () => src("components", "settings", "use-account.ts");

  it("Settings ends the account through it, and a cancel reports nothing", () => {
    const s = hook();
    expect(s).toContain('const res = await guarded("delete-account", (h) => fetch("/api/account/delete", {');
    expect(s).toContain('headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },');
    expect(s).toContain("if (res.status === 401 && data?.stepUp) return setDeleteBusy(false);");
  });

  it("the delete dialog tells an embedded wallet's owner about the funds, from what Settings already knows", () => {
    const s = src("components", "settings", "SettingsView.tsx");
    expect(s).toContain('import { cdpOwnWalletAccount, cdpRuntimeExpected } from "@/lib/cdp-bridge";');
    const dialog = s.slice(s.indexOf("Delete your account?"), s.indexOf("Type your username to confirm."));
    expect(dialog).toMatch(/\{cdpRuntimeExpected\(\) && !cdpOwnWalletAccount\(\) && \(\s*<p[^>]*>\s*Move your funds or export your key first: after deletion you can no longer reach this wallet\.\s*<\/p>\s*\)\}/);
  });

  it("the waiting dialog shows the sentence of a held deletion, and goes back when it is no longer held", () => {
    const s = src("components", "settings", "SettingsView.tsx");
    expect(hook()).toContain('else if (res.ok) setDeleteHeld(d.status === "held" ? d.message : null);');
    expect(s).toContain('deleteHeld ? "Deletion on hold" : "Waiting for your guardians"}');
    expect(s).toContain('{deleteHeld ?? "We emailed your guardians.');
  });

  it("the waiting dialog says so when the request ran out, stops asking, and a new request starts clean", () => {
    const s = src("components", "settings", "SettingsView.tsx");
    const h = hook();
    expect(h).toContain('export const DELETE_EXPIRED = "This request ran out after 7 days and nothing was deleted.');
    expect(h).toContain('else if (d.status === "expired") { clearInterval(t); setDeleteHeld(DELETE_EXPIRED); }');
    expect(s).toContain('{deleteHeld === DELETE_EXPIRED ? "Deletion request expired" : deleteHeld ?');
    expect(h).toMatch(/setDeleteHeld\(null\);\s+setDeleteReq\(\{ id: data\.requestId/);
  });

  it("the profile's library deletes through it", () => {
    expect(src("components", "profile", "ProfileView.tsx")).toContain(
      'const res = await guarded(`delete-library:${id}`, (h) =>\n      fetch(`/api/library?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { ...sessionAuthHeaders(), ...h } }),',
    );
  });
});

// No client saved through it (2026-10-28): the library reads and deletes, nothing more.
it("the library route answers GET and DELETE only", () => {
  expect(Object.keys(libraryRoute).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(["DELETE", "GET"]);
});

describe("deleting a library item", () => {
  it("deletes at once while the user has no factor", async () => {
    expect((await dropItem(ITEM)).status).toBe(200);
    expect(itemKept(ITEM)).toBe(false);
  });

  it("asks for the second factor once one is enrolled, and keeps the item without it", async () => {
    factors.list = ["email"];
    const res = await dropItem(ITEM);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ stepUp: true, scope: `delete-library:${ITEM}` });
    expect(itemKept(ITEM)).toBe(true);
  });

  it("deletes only the item the token names", async () => {
    factors.list = ["passkey"];
    expect((await dropItem(ITEM, await mintStepUpToken(OWNER, `delete-library:${ITEM2}`))).status).toBe(401);
    expect(itemKept(ITEM)).toBe(true);
    expect((await dropItem(ITEM, await mintStepUpToken(OWNER, `delete-library:${ITEM}`))).status).toBe(200);
    expect(itemKept(ITEM)).toBe(false);
    expect(itemKept(ITEM2)).toBe(true);
  });

  it("asks nothing once the owner switched deleting off in Settings, while ending the account still asks (Kev, 2026-10-17)", async () => {
    factors.list = ["passkey"];
    tables.users[0].stepup_actions = { delete: false };
    expect((await dropItem(ITEM)).status).toBe(200);
    expect(itemKept(ITEM)).toBe(false);
    expect((await endAccount()).status).toBe(401);
    expect(accountGone()).toBe(false);
  });
});
