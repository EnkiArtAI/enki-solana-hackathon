import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * The admin log (Kev, 2026-10-17: "brauchen protokoll der admin aktionen"):
 * every admin or mod action that went through is one row in admin_actions,
 * written in one place for all actions; a refused one is not. Kept: who,
 * their role, what, on what, whitelisted settings and the outcome. Never a
 * reason, an email in clear, or a raw IP. Admins read it; mods do not.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null, actor: "admin-1" }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => db.actor }));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64"); });

import { GET, POST } from "../../app/api/admin/route";
import { recordAdminAction, targetOf } from "@/lib/admin/audit";

const IMAGE = "aaaaaaaa-0000-4000-8000-000000000002";
const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("http://enki.test/api/admin", { method: "POST", headers: { "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body) }));
const log = () => db.current!.tables.admin_actions ?? [];

beforeEach(() => {
  db.actor = "admin-1";
  db.current = fakePostgrest();
  db.current.tables.users = [{ id: "admin-1", role: "admin", handle: "kev" }, { id: "mod-1", role: "mod", handle: "modi" }, { id: "owner", role: "user" }];
  db.current.tables.generated_images = [{ id: IMAGE, user_id: "owner", visibility: "public" }];
  db.current.tables.reports = [
    { id: "rep-1", target_type: "generation", target_uuid: IMAGE, reason: "obscene", status: "pending" },
    { id: "rep-2", target_type: "prompt", target_uuid: "p1", reason: "spam", status: "pending" },
  ];
  db.current.tables.strikes = [];
  db.current.tables.admin_actions = [];
});

describe("writing the log", () => {
  it("records an action that went through: who, their role, what, on what, the outcome, the hashed IP", async () => {
    expect((await post({ resource: "reports", action: "hide", id: "rep-1", reason: "very private words" })).status).toBe(200);
    expect(log()).toHaveLength(1);
    const row = log()[0];
    expect(row).toMatchObject({ actor_id: "admin-1", actor_role: "admin", action: "reports.hide", target: "rep-1" });
    expect(row.detail).toEqual({ outcome: { httpStatus: 200 } });
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("very private words");
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
  });

  it("records a mod's action as a mod's", async () => {
    db.actor = "mod-1";
    expect((await post({ resource: "reports", action: "dismiss", id: "rep-2" })).status).toBe(200);
    expect(log()[0]).toMatchObject({ actor_id: "mod-1", actor_role: "mod", action: "reports.dismiss" });
  });

  it("records nothing for a refused or failed action, nor for someone who is not staff", async () => {
    expect((await post({ resource: "reports", action: "hide", id: "rep-2" })).status).toBe(400);
    expect((await post({ resource: "nothing", action: "at all" })).status).toBe(400);
    db.actor = "owner";
    expect((await post({ resource: "reports", action: "dismiss", id: "rep-2" })).status).toBe(403);
    expect(log()).toEqual([]);
  });
});

describe("what a row keeps", () => {
  it("names the target: ids, an id, a user, a public handle, and an email or address only as a keyed hash", () => {
    expect(targetOf({ ids: ["a", "b"] })).toBe("a,b");
    expect(targetOf({ id: "x", userId: "u" })).toBe("x");
    expect(targetOf({ userId: "u" })).toBe("u");
    expect(targetOf({ handle: "artist" })).toBe("artist");
    const email = targetOf({ email: "Someone@Example.com " });
    expect(email).toMatch(/^h:[0-9a-f]{32}$/);
    expect(email).toBe(targetOf({ email: "someone@example.com" }));
    expect(targetOf({ address: "7Yk3r9dQmPvZx1aBcDeFgHiJkLmNoPqRsTuVwXyZ1234" })).toMatch(/^h:[0-9a-f]{32}$/);
    expect(targetOf({})).toBeNull();
  });

  it("keeps whitelisted settings and outcomes, counts lists, and drops every free text", async () => {
    const rows: Record<string, unknown>[] = [];
    const supabase = { from: () => ({ insert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null }; } }) } as never;
    const answer = new Response(JSON.stringify({ ok: true, status: "denied", failed: [{ id: 1 }, { id: 2 }], error: "x", note: "free text" }), { status: 200 });
    await recordAdminAction(supabase, { headers: new Headers() }, { userId: "a", role: "admin" },
      { resource: "council", action: "vote", id: "p1", vote: "deny", reason: "secret why", violation: "words", email: "a@b.c", severity: 2, config: { mode: "queue", posts_per_run: 500 } },
      answer);
    expect(rows[0].detail).toEqual({ vote: "deny", severity: 2, config: { mode: "queue", posts_per_run: 500 }, outcome: { httpStatus: 200, status: "denied", failed: 2 } });
    expect(JSON.stringify(rows[0])).not.toMatch(/secret why|words|a@b\.c|free text/);
  });

  it("never throws: an action stands when its log row cannot be written, and says so", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = { from: () => ({ insert: async () => ({ error: { message: "relation admin_actions does not exist" } }) }) } as never;
    await expect(recordAdminAction(supabase, { headers: new Headers() }, { userId: "a", role: "admin" }, { resource: "r", action: "a" }, new Response("{}"))).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith("[admin-log] not recorded:", "relation admin_actions does not exist");
    // A client that throws (the database unreachable) is caught the same way.
    const throwing = { from: () => { throw new Error("fetch failed"); } } as never;
    await expect(recordAdminAction(throwing, { headers: new Headers() }, { userId: "a", role: "admin" }, { resource: "r", action: "a" }, new Response("{}"))).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith("[admin-log] not recorded:", "fetch failed");
    err.mockRestore();
  });
});

describe("reading the log", () => {
  it("admins get the newest rows with the actor's handle; mods get none", async () => {
    await post({ resource: "reports", action: "dismiss", id: "rep-2" });
    const admin = (await (await GET(new NextRequest("http://enki.test/api/admin"))).json()) as { adminLog: { ready: boolean; rows: { action: string; actor: string }[] } | null };
    expect(admin.adminLog?.ready).toBe(true);
    expect(admin.adminLog?.rows[0]).toMatchObject({ action: "reports.dismiss", actor: "kev" });
    db.actor = "mod-1";
    const mod = (await (await GET(new NextRequest("http://enki.test/api/admin"))).json()) as { adminLog: unknown };
    expect(mod.adminLog).toBeNull();
  });

  it("leaves a known link's row out of the tab: it is the hunter's log's line, not an action that went through", async () => {
    await post({ resource: "reports", action: "dismiss", id: "rep-2" });
    log().push({ id: "k1", actor_id: "admin-1", actor_role: "admin", action: "hunter.knownLink", target: "1", detail: {}, created_at: new Date().toISOString() });
    const admin = (await (await GET(new NextRequest("http://enki.test/api/admin"))).json()) as { adminLog: { rows: { action: string }[] } };
    expect(admin.adminLog.rows.map((r) => r.action)).toEqual(["reports.dismiss"]);
  });

  it("the panel shows the tab only when the API sends the log, and the table cannot be changed", () => {
    const page = readSource(join(__dirname, "..", "..", "app", "admin", "page.tsx"));
    expect(page).toContain('(t.id !== "adminlog" || d.adminLog)');
    expect(page).toContain('{tab === "adminlog" && d.adminLog && (');
    const sql = readSource(join(__dirname, "..", "..", "migrations", "2026-10-17-admin-actions.sql"));
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON admin_actions");
    expect(sql).toContain("BEFORE TRUNCATE ON admin_actions");
  });
});
