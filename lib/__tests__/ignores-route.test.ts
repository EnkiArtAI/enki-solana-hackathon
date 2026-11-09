import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";

/**
 * app/api/ignores/route.ts (Kev, 2026-10-29: "i also want an 'ignore' function ... no ban function ... the profile
 * settings where i see the list of people i ignored"). A signed-in viewer ignores someone else and un-ignores them;
 * GET is the list Settings shows. Before SQL 48 runs, every change says so in one sentence.
 */
const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null, reads: [] as string[] }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({
  from: (t: string) => { db.reads.push(t); return (db.current!.client as { from: (t: string) => unknown }).from(t); },
}) }));
const ME = "0b5f2c1e-1111-4222-8333-444455556666";
const HER = "9c1d2e3f-1111-4222-8333-444455556666";
const HIM = "8b8b8b8b-1111-4222-8333-444455556666";
const GONE = "7a7a7a7a-1111-4222-8333-444455556666";
const GHOST = "6c6c6c6c-1111-4222-8333-444455556666";
vi.mock("@/lib/session-user", async () => {
  const { DbUnreachableError } = await import("@/lib/db-error");
  return { resolveSessionUserId: async (_s: unknown, t: string | null) => {
    if (t === "down") throw new DbUnreachableError();
    return ({ me: ME, ME: ME.toUpperCase(), her: HER } as Record<string, string>)[t ?? ""] ?? null;
  } };
});

import { GET, POST } from "../../app/api/ignores/route";
import { MAX_IGNORED } from "@/lib/ignores";

const as = (token: string | null) => (token ? { "X-Session-Token": token } : {}) as Record<string, string>;
const list = async (token: string | null = "me") => {
  const res = await GET(new NextRequest("http://enki.test/api/ignores", { headers: as(token) }));
  return [res.status, await res.json()];
};
const post = async (body: unknown, token: string | null = "me") => {
  const req = new NextRequest("http://enki.test/api/ignores", { method: "POST", headers: { "Content-Type": "application/json", ...as(token) }, body: JSON.stringify(body) });
  const res = await POST(req);
  return [res.status, await res.json()];
};
const rows = () => db.current!.tables.user_ignores ?? [];

let clock = Date.now();
beforeEach(() => {
  // A fresh minute for each test: the rate limit is the one under test only where it says so.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime((clock += 120_000));
  db.current = fakePostgrest();
  db.reads = [];
  db.current.tables.users = [
    { id: ME, handle: "kev", display_name: "Kev", avatar_url: null, deleted_at: null },
    { id: HER, handle: "mira", display_name: "Mira K.", avatar_url: "https://img/m.webp", deleted_at: null },
    { id: HIM, handle: "otto", display_name: "", avatar_url: null, deleted_at: null },
    { id: GONE, handle: "gone", display_name: "Gone", avatar_url: null, deleted_at: "2026-10-01T00:00:00Z" },
  ];
  db.current.tables.user_ignores = [];
});
afterAll(() => vi.useRealTimers());

describe("ignoring someone", () => {
  it("ignores and lists them, newest first, with handle, name and avatar; a nameless one by handle", async () => {
    expect(await list()).toEqual([200, { people: [] }]);
    // Nobody ignored: no second read for their names.
    expect(db.reads).toEqual(["user_ignores"]);
    expect(await post({ user: HER, ignore: true })).toEqual([200, { ignored: true }]);
    expect(await post({ user: HIM.toUpperCase(), ignore: true })).toEqual([200, { ignored: true }]);
    expect(rows().map((r) => [r.user_id, r.ignored_id])).toEqual([[ME, HER], [ME, HIM]]);
    // The fake answers in insertion order; the route asks the database for newest first.
    expect(readSource(join(__dirname, "..", "..", "app", "api", "ignores", "route.ts")))
      .toMatch(/\.from\("user_ignores"\)\s*\.select\("ignored_id"\)\s*\.eq\("user_id", me\)\s*\.order\("created_at", \{ ascending: false \}\)/);
    db.current!.tables.user_ignores.reverse();
    expect(await list()).toEqual([200, { people: [
      { id: HIM, handle: "otto", displayName: "otto", avatarUrl: null },
      { id: HER, handle: "mira", displayName: "Mira K.", avatarUrl: "https://img/m.webp" },
    ] }]);
  });

  it("lists only my own, and leaves out a deleted account; one without a handle by name", async () => {
    db.current!.tables.users.push({ id: GHOST, handle: null, display_name: "Ivy", avatar_url: null, deleted_at: null });
    db.current!.tables.user_ignores = [{ user_id: HER, ignored_id: HIM }, { user_id: ME, ignored_id: GONE }, { user_id: ME, ignored_id: HER }, { user_id: ME, ignored_id: GHOST }];
    expect(await list()).toEqual([200, { people: [
      { id: HER, handle: "mira", displayName: "Mira K.", avatarUrl: "https://img/m.webp" },
      { id: GHOST, handle: "", displayName: "Ivy", avatarUrl: null },
    ] }]);
  });

  it("ignoring again is still a yes, and un-ignoring forgets only that one", async () => {
    await post({ user: HER, ignore: true });
    expect(await post({ user: HER, ignore: true })).toEqual([200, { ignored: true }]);
    await post({ user: HIM, ignore: true });
    db.current!.tables.user_ignores.push({ user_id: HER, ignored_id: HIM });
    expect(await post({ user: HIM, ignore: false })).toEqual([200, { ignored: false }]);
    expect(rows().map((r) => [r.user_id, r.ignored_id])).toEqual([[ME, HER], [HER, HIM]]);
  });

  it("stops where SQL 48's cap refuses the insert (23514), in one sentence, and counts nothing itself", async () => {
    // The cap's rules (150, someone already ignored, other people's ignores) are the trigger's: user-ignores-migration.
    db.current!.state.failNext = { table: "user_ignores", op: "insert", code: "23514" };
    expect(await post({ user: HIM, ignore: true })).toEqual([409, { error: "You can ignore up to 150 people. Un-ignore someone first." }]);
    expect(rows()).toEqual([]);
    expect(db.reads).toEqual(["users", "user_ignores"]);
    expect(MAX_IGNORED).toBe(150);
  });

  it("refuses yourself, a deleted or unknown account, a bad id, a guest and a body without a choice", async () => {
    expect(await post({ user: ME, ignore: true })).toEqual([400, { error: "That's you" }]);
    expect(await post({ user: ME, ignore: true }, "ME")).toEqual([400, { error: "That's you" }]);
    expect(await post({ user: GONE, ignore: true })).toEqual([404, { error: "Not found" }]);
    expect(await post({ user: GHOST, ignore: true })).toEqual([404, { error: "Not found" }]);
    expect(await post({ user: "nope", ignore: true })).toEqual([404, { error: "Not found" }]);
    expect(await post({ user: "nope", ignore: false })).toEqual([404, { error: "Not found" }]);
    expect(await post({ user: HER, ignore: true }, null)).toEqual([401, { error: "Not signed in" }]);
    expect(await post({ user: HER, ignore: "yes" })).toEqual([400, { error: "Bad request" }]);
    expect(await post({ user: HER })).toEqual([400, { error: "Bad request" }]);
    expect(rows()).toEqual([]);
  });

  it("a guest ignores nobody and costs no read", async () => {
    expect(await list(null)).toEqual([200, { people: [] }]);
    expect(db.reads).toEqual([]);
  });

  it("is rate limited per account: 30 a minute", async () => {
    for (let i = 0; i < 30; i++) expect((await post({ user: HER, ignore: i % 2 === 0 }))[0]).toBe(200);
    const [status, body] = await post({ user: HER, ignore: true });
    expect([status, body]).toEqual([429, { error: "Too many requests" }]);
    expect((await post({ user: ME, ignore: true }, "her"))[0]).toBe(200);
  });
});

describe("before SQL 48 runs, and when the database fails", () => {
  it("every change and the list say so in one sentence (503)", async () => {
    db.current!.state.failing = { table: "user_ignores", code: "PGRST205" };
    const notYet = { error: "Ignoring is not available yet." };
    expect(await post({ user: HER, ignore: true })).toEqual([503, notYet]);
    expect(await post({ user: HER, ignore: false })).toEqual([503, notYet]);
    expect(await list()).toEqual([503, notYet]);
    db.current!.state.failing = { table: "user_ignores", code: "42P01" };
    expect(await list()).toEqual([503, notYet]);
  });

  it("an unreachable database is the outage 503; any other failure is a 500 with its sentence", async () => {
    db.current!.state.failing = { table: "user_ignores", code: "ECONNREFUSED" };
    const [status, body] = await post({ user: HER, ignore: true });
    expect([status, body.code]).toEqual([503, "DB_UNAVAILABLE"]);
    expect((await list())[1].code).toBe("DB_UNAVAILABLE");
    db.current!.state.failing = { table: "user_ignores", code: "XX000" };
    expect(await post({ user: HER, ignore: true })).toEqual([500, { error: "Could not ignore" }]);
    expect(await post({ user: HER, ignore: false })).toEqual([500, { error: "Could not un-ignore" }]);
    expect(await list()).toEqual([500, { error: "Could not read the people you ignore" }]);
    db.current!.state.failing = null;
    db.current!.state.failNext = { table: "user_ignores", op: "insert", code: "XX000" };
    expect(await post({ user: HER, ignore: true })).toEqual([500, { error: "Could not ignore" }]);
    expect(rows()).toEqual([]);
    db.current!.state.failing = { table: "users", code: "XX000" };
    expect(await post({ user: HER, ignore: true })).toEqual([500, { error: "Could not ignore" }]);
    db.current!.tables.user_ignores = [{ user_id: ME, ignored_id: HER }];
    expect(await list()).toEqual([500, { error: "Could not read the people you ignore" }]);
  });

  it("a session that cannot be looked up is the outage 503, never a guest", async () => {
    for (const [status, body] of [await list("down"), await post({ user: HER, ignore: true }, "down")]) {
      expect([status, body.code]).toEqual([503, "DB_UNAVAILABLE"]);
    }
  });
});
