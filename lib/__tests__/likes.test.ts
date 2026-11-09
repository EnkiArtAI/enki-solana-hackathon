import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { readSource } from "@/lib/__tests__/_read-source";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Likes that scale (Kev, 2026-10-15): one row per like in reactions, the count
 * on the target (prompts / generated_images .like_count, kept by the SQL 29
 * trigger). lib/likes sets and reads them; the image route lets a viewer like
 * only an image they may see; the feed reads the counter; the gallery shows
 * the viewer's hearts.
 */

type Row = Record<string, unknown>;
interface Fake { client: SupabaseClient; tables: Record<string, Row[]>; failOn: Set<string>; raceOnInsert: boolean; reads: number }

/** A small in-memory Supabase: eq/in/maybeSingle/insert/delete, with the SQL 29 trigger and unique index emulated. */
function fakeDb(tables: Record<string, Row[]>): Fake {
  const fake: Fake = { client: null as unknown as SupabaseClient, tables, failOn: new Set(), raceOnInsert: false, reads: 0 };
  const bump = (r: Row, by: number) => {
    if (r.reaction_type !== "like") return;
    const t = r.target_type === "prompt" ? "prompts" : r.target_type === "generated_image" ? "generated_images" : null;
    const row = t ? (fake.tables[t] ?? []).find((x) => x.id === r.target_uuid) : undefined;
    if (row) row.like_count = Math.max(0, Number(row.like_count ?? 0) + by);
  };
  const key = (r: Row) => `${r.user_id}|${r.target_type}|${r.target_uuid}|${r.reaction_type}`;
  fake.client = {
    from(table: string) {
      fake.reads++;
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "delete" = "select";
      const rows = () => (fake.tables[table] ??= []);
      const fail = (what: string) => fake.failOn.has(`${table}:${what}`) ? { code: "XX000", message: "down" } : null;
      const run = () => {
        const err = fail(op);
        if (err) return { data: null, error: err };
        const hit = rows().filter((r) => filters.every((f) => f(r)));
        if (op === "delete") { fake.tables[table] = rows().filter((r) => !hit.includes(r)); hit.forEach((r) => bump(r, -1)); return { data: null, error: null }; }
        return { data: hit, error: null };
      };
      const q = {
        select: () => q,
        delete: () => { op = "delete"; return q; },
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
        in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
        insert: async (row: Row) => {
          const err = fail("insert");
          if (err) return { error: err };
          if (fake.raceOnInsert) { fake.raceOnInsert = false; rows().push({ ...row }); bump(row, 1); }
          if (rows().some((r) => key(r) === key(row))) return { error: { code: "23505", message: "duplicate key" } };
          rows().push({ ...row }); bump(row, 1);
          return { error: null };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return fake;
}

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const IMG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("lib/likes", async () => {
  const { likeCount, likedBy, likedAmong, setLike } = await import("@/lib/likes");
  let db: Fake;
  beforeEach(() => {
    db = fakeDb({ prompts: [{ id: PR, like_count: 0 }], generated_images: [{ id: IMG, like_count: 0 }], reactions: [] });
  });
  const img = { type: "generated_image", id: IMG } as const;

  it("sets, keeps, clears and toggles one like per user, and answers the counter", async () => {
    expect(await setLike(db.client, U1, img, true)).toEqual({ count: 1, mine: true });
    expect(await setLike(db.client, U1, img, true)).toEqual({ count: 1, mine: true });
    expect(db.tables.reactions).toHaveLength(1);
    expect(await setLike(db.client, U2, img, null)).toEqual({ count: 2, mine: true });
    expect(await setLike(db.client, U2, img, null)).toEqual({ count: 1, mine: false });
    expect(await setLike(db.client, U1, img, false)).toEqual({ count: 0, mine: false });
    expect(await setLike(db.client, U1, img, false)).toEqual({ count: 0, mine: false });
    expect(db.tables.reactions).toHaveLength(0);
  });

  it("reads a like that appeared meanwhile (the unique index refused the second) as liked", async () => {
    db.raceOnInsert = true;
    expect(await setLike(db.client, U1, img, true)).toEqual({ count: 1, mine: true });
    expect(db.tables.reactions).toHaveLength(1);
  });

  it("answers null when the store refuses, instead of a state it did not reach", async () => {
    db.failOn.add("reactions:insert");
    expect(await setLike(db.client, U1, img, true)).toBeNull();
    db.failOn.clear();
    await setLike(db.client, U1, img, true);
    db.failOn.add("reactions:delete");
    expect(await setLike(db.client, U1, img, false)).toBeNull();
    db.failOn.clear();
    db.failOn.add("reactions:select");
    expect(await setLike(db.client, U1, img, null)).toBeNull();
    expect(await likedBy(db.client, U1, img)).toBeNull();
    db.failOn.clear();
    db.failOn.add("generated_images:select");
    expect(await likeCount(db.client, img)).toBeNull();
  });

  it("reads the count from the target's column, never below zero, and the likes among many in one read", async () => {
    db.tables.generated_images[0].like_count = 7;
    expect(await likeCount(db.client, img)).toBe(7);
    db.tables.generated_images[0].like_count = -3;
    expect(await likeCount(db.client, img)).toBe(0);
    expect(await likeCount(db.client, { type: "prompt", id: PR })).toBe(0);
    await setLike(db.client, U1, img, true);
    await setLike(db.client, U1, { type: "prompt", id: PR }, true);
    expect([...await likedAmong(db.client, U1, "generated_image", [IMG, PR])]).toEqual([IMG]);
    expect([...await likedAmong(db.client, U2, "generated_image", [IMG])]).toEqual([]);
    expect([...await likedAmong(db.client, U1, "generated_image", [])]).toEqual([]);
  });
});

// ── the image route ──
const state = vi.hoisted(() => ({
  db: null as unknown as { client: unknown },
  viewer: { userId: null as string | null, showAdult: false },
  hidden: new Set<string>() as Set<string> | null,
}));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => state.db.client }));
vi.mock("@/lib/rate-limit", () => ({ checkRequestRateLimit: () => ({ allowed: true }), rateLimitKey: () => "k", rateLimitResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/lib/adult-content", async (original) => ({ ...(await original<typeof import("@/lib/adult-content")>()), viewer: async () => state.viewer }));
vi.mock("@/lib/hidden-owners", () => ({ hiddenOwners: async () => state.hidden }));

describe("the image like route", async () => {
  const route = await import("../../app/api/images/[id]/likes/route");
  const image = (over: Row = {}): Row => ({ id: IMG, user_id: U1, visibility: "private", is_uploaded: false, is_adult: false, deleted_at: null, like_count: 0, ...over });
  const setup = (img: Row | null, viewerId: string | null, showAdult = false) => {
    const fake = fakeDb({ generated_images: img ? [img] : [], reactions: [] });
    state.db = fake;
    state.viewer = { userId: viewerId, showAdult };
    state.hidden = new Set();
    return fake;
  };
  const call = async (method: "GET" | "POST", body?: unknown, id = IMG) => {
    const req = new NextRequest(`http://enki.test/api/images/${id}/likes`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const res = await route[method](req, { params: Promise.resolve({ id }) });
    return { status: res.status, body: await res.json() };
  };

  it("lets the owner like their own private image, sets it with a body and toggles without one", async () => {
    setup(image(), U1);
    expect(await call("POST", { liked: true })).toEqual({ status: 200, body: { count: 1, mine: true } });
    expect(await call("POST", { liked: true })).toEqual({ status: 200, body: { count: 1, mine: true } });
    expect(await call("POST")).toEqual({ status: 200, body: { count: 0, mine: false } });
    expect(await call("GET")).toEqual({ status: 200, body: { count: 0, mine: false } });
  });

  it("lets anyone signed in like a published image, and counts every user once", async () => {
    const fake = setup(image({ visibility: "public" }), U2);
    expect((await call("POST", { liked: true })).body).toEqual({ count: 1, mine: true });
    state.viewer = { userId: U1, showAdult: false };
    expect((await call("POST", { liked: true })).body).toEqual({ count: 2, mine: true });
    expect(fake.tables.reactions).toHaveLength(2);
  });

  it("answers 404 for an image the viewer may not see, so a like never confirms one exists", async () => {
    setup(image(), U2);
    expect((await call("POST", { liked: true })).status).toBe(404);
    expect((await call("GET")).status).toBe(404);
    setup(image({ visibility: "public", is_uploaded: true }), U2);
    expect((await call("POST", { liked: true })).status).toBe(404);
    setup(image({ visibility: "public", deleted_at: "2026-10-01T00:00:00Z" }), U2);
    expect((await call("POST", { liked: true })).status).toBe(404);
    setup(image({ deleted_at: "2026-10-01T00:00:00Z" }), U1);
    expect((await call("POST", { liked: true })).status).toBe(404);
    setup(null, U1);
    expect((await call("POST", { liked: true })).status).toBe(404);
    // A malformed id never reaches the store (Postgres would refuse it as an error, not a miss).
    const fake = setup(image(), U1);
    expect((await call("POST", { liked: true }, "not-a-uuid")).status).toBe(404);
    expect((await call("GET", undefined, "not-a-uuid")).status).toBe(404);
    expect(fake.reads).toBe(0);
  });

  it("hides 18+ from a viewer who did not opt in, but never from its owner", async () => {
    setup(image({ visibility: "public", is_adult: true }), U2);
    expect((await call("POST", { liked: true })).status).toBe(404);
    setup(image({ visibility: "public", is_adult: true }), U2, true);
    expect((await call("POST", { liked: true })).status).toBe(200);
    setup(image({ is_adult: true }), U1);
    expect((await call("POST", { liked: true })).status).toBe(200);
  });

  it("hides a banned or deleted account's published images, and says so when it cannot tell", async () => {
    setup(image({ visibility: "public" }), U2);
    state.hidden = new Set([U1]);
    expect((await call("POST", { liked: true })).status).toBe(404);
    state.hidden = null;
    expect((await call("POST", { liked: true })).status).toBe(503);
  });

  it("asks a signed-out viewer to sign in before liking, and lets them read the count", async () => {
    setup(image({ visibility: "public", like_count: 4 }), null);
    expect((await call("POST", { liked: true })).status).toBe(401);
    expect(await call("GET")).toEqual({ status: 200, body: { count: 4, mine: false } });
  });

  it("answers 503 when the store refuses, never a state it did not reach", async () => {
    const fake = setup(image(), U1);
    fake.failOn.add("reactions:insert");
    expect((await call("POST", { liked: true })).status).toBe(503);
    fake.failOn.clear();
    fake.failOn.add("generated_images:select");
    expect((await call("POST", { liked: true })).status).toBe(503);
  });
});

describe("where the counter and the hearts are read", () => {
  const ROOT = join(__dirname, "..", "..");
  const src = (...p: string[]) => readSource(join(ROOT, ...p));

  it("the feed reads each prompt's like_count and no longer counts reaction rows", () => {
    const feed = src("app", "api", "prompts", "route.ts");
    expect(feed).toContain("creator_id,showcase_images,like_count\"");
    expect(feed).toContain("likes: Math.max(0, Number(p.like_count ?? 0) || 0),");
    expect(feed).not.toContain('.from("reactions")');
  });

  it("the prompt like route runs on lib/likes: the counter, one row per user, a toggle", () => {
    const r = src("app", "api", "prompts", "[id]", "likes", "route.ts");
    expect(r).toContain('const state = await setLike(supabase, userId, { type: "prompt", id }, null);');
    expect(r).toContain("likeCount(supabase, target)");
    expect(r).not.toContain('.from("reactions")');
  });
});
