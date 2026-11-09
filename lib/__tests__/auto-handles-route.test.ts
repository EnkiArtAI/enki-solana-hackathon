import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * app/api/users/handle/route.ts with SQL 46 (Kev, 2026-10-29: every account has a name). The own read says whether
 * Enki picked the name (handleAuto), false while users.handle_auto does not exist yet, and every other field reads as
 * before then. PUT replaces a name Enki picked once, refuses a chosen one (409), and sets a first one as before.
 */
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  users: [] as Row[],
  // users.handle_auto not there yet (SQL 46 not run): naming it fails the request, as PostgREST does (42703).
  missing: false,
  // Runs once after the next own read: another save landing between the PUT's read and its write.
  afterRead: null as null | (() => void),
}));
const ME = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: (table: string) => {
      let cols = "";
      let values: Row | null = null;
      const filters: [op: "eq" | "is", col: string, val: unknown][] = [];
      const run = () => {
        if (table !== "users") return { data: null, error: null, count: 0 };
        if (db.missing && (cols.includes("handle_auto") || filters.some(([, c]) => c === "handle_auto"))) {
          return { data: null, error: { code: "42703", message: "column users.handle_auto does not exist" } };
        }
        const hit = db.users.filter((r) => filters.every(([op, c, v]) => (op === "eq" ? r[c] === v : (r[c] ?? null) === v)));
        if (values) { hit.forEach((r) => Object.assign(r, values)); return { data: null, error: null }; }
        // Only the selected columns come back, as from PostgREST.
        const pick = (r: Row) => Object.fromEntries(cols.split(",").map((c) => c.trim()).map((c) => [c, r[c] ?? null]));
        return { data: hit[0] ? pick(hit[0]) : null, error: null };
      };
      const q = {
        select: (c: string) => { cols = c; return q; },
        update: (v: Row) => { values = v; return q; },
        eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return q; },
        is: (c: string, v: unknown) => { filters.push(["is", c, v]); return q; },
        maybeSingle: async () => {
          const out = run();
          const then = db.afterRead;
          db.afterRead = null;
          then?.();
          return out;
        },
        then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async (_s: unknown, t: string | null) => (t === "tok" ? ME : null),
  resolveSessionUserWithBan: async (_s: unknown, t: string | null) => ({ userId: t === "tok" ? ME : null, ban: null, wallet: null }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRequestRateLimit: () => ({ allowed: true }),
  rateLimitKey: () => "test",
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));

import { GET, PUT } from "../../app/api/users/handle/route";

const OTHER = "22222222-2222-4222-8222-222222222222";

const me = () => db.users[0];
const own = async () => {
  const res = await GET(new NextRequest("http://enki.test/api/users/handle", { headers: { "X-Session-Token": "tok" } }));
  return res.json();
};
const check = async (name: string, token: string | null = "tok") => {
  const res = await GET(new NextRequest(`http://enki.test/api/users/handle?name=${name}`, { headers: token ? { "X-Session-Token": token } : {} }));
  return res.json();
};
const pick = async (handle: string) => {
  const res = await PUT(new NextRequest("http://enki.test/api/users/handle", {
    method: "PUT", headers: { "X-Session-Token": "tok", "Content-Type": "application/json" }, body: JSON.stringify({ handle }),
  }));
  return [res.status, await res.json()];
};

beforeEach(() => {
  db.missing = false;
  db.afterRead = null;
  db.users = [{
    id: ME, handle: "velvet_muse_0427", handle_auto: true, role: "beta", bio: "hello", avatar_url: null,
    cover_image_url: null, hide_from_leaderboard: true, adult_confirmed_at: "2026-10-03T10:00:00Z",
  }];
});

describe("the own read", () => {
  it("says the name is Enki's, with everything else", async () => {
    expect(await own()).toMatchObject({
      handle: "velvet_muse_0427", handleAuto: true, role: "beta", bio: "hello", hideFromLeaderboard: true, adultConfirmed: true,
    });
  });

  it("a chosen name is not Enki's", async () => {
    me().handle_auto = false;
    expect((await own()).handleAuto).toBe(false);
  });

  it("before SQL 46: not Enki's, and every other field reads as before", async () => {
    db.missing = true;
    expect(await own()).toMatchObject({
      handle: "velvet_muse_0427", handleAuto: false, role: "beta", bio: "hello", hideFromLeaderboard: true, adultConfirmed: true,
    });
  });
});

describe("picking a name", () => {
  it("replaces the one Enki picked", async () => {
    expect(await pick("kev_art")).toEqual([200, { handle: "kev_art" }]);
    expect(me().handle).toBe("kev_art");
  });

  it("refuses to replace a chosen one", async () => {
    me().handle_auto = false;
    expect(await pick("kev_art")).toEqual([409, { error: "You already have a username" }]);
    expect(me().handle).toBe("velvet_muse_0427");
  });

  it("sets a first one, after SQL 46 and before it, and refuses a set one before it", async () => {
    Object.assign(me(), { handle: null, handle_auto: false });
    expect(await pick("kev_art")).toEqual([200, { handle: "kev_art" }]);
    expect(me().handle).toBe("kev_art");
    db.missing = true;
    me().handle = null;
    expect(await pick("kev_two")).toEqual([200, { handle: "kev_two" }]);
    expect(me().handle).toBe("kev_two");
    expect((await pick("kev_three"))[0]).toBe(409);
    expect(me().handle).toBe("kev_two");
  });

  it("lets the owner keep the name Enki picked: free to them, taken to anyone else, chosen once saved", async () => {
    db.users.push({ id: OTHER, handle: "quiet_raven_1234", handle_auto: false });
    expect(await check("velvet_muse_0427")).toEqual({ valid: true, available: true });
    expect(await check("velvet_muse_0427", null)).toEqual({ valid: true, available: false });
    expect(await check("quiet_raven_1234")).toEqual({ valid: true, available: false });
    expect(await check("nobody_has_it")).toEqual({ valid: true, available: true });
    expect(await pick("velvet_muse_0427")).toEqual([200, { handle: "velvet_muse_0427" }]);
    expect(me()).toMatchObject({ handle: "velvet_muse_0427", handle_auto: false });
    expect((await pick("kev_art"))[0]).toBe(409);
  });

  it("leaves a name another save set between the read and the write", async () => {
    db.afterRead = () => Object.assign(me(), { handle: "chosen_meanwhile", handle_auto: false });
    await pick("kev_art");
    expect(me().handle).toBe("chosen_meanwhile");
    Object.assign(me(), { handle: null, handle_auto: false });
    db.afterRead = () => { me().handle = "first_meanwhile"; };
    await pick("kev_art");
    expect(me().handle).toBe("first_meanwhile");
  });
});
