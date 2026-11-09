import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/analytics/enki (Kev, 2026-10-29: Enki-wide analytics "genauso wie hup.social/leaderboard"): the period
 * and the column asked for reach enki_stats, revenue leaves in cents, views exist for all time only, and a failure
 * is said, never shown as zeros. What counts is enki-stats-migration.test.ts's subject.
 */
const db = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
  answer: { data: null as unknown, error: null as unknown },
}));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => { db.calls.push({ name, args }); return db.answer; },
  }),
}));
vi.mock("@/lib/payments/solana", () => ({ solanaChainKey: () => "solana-devnet" }));
import { GET } from "../../app/api/analytics/enki/route";

const get = (qs = "") => GET(new NextRequest(`http://localhost/api/analytics/enki${qs}`));
const STATS = {
  totals: { users: [39, 2], posts: [2, 1], images: [55, 4], revenue: [3_855_000, 1_500_000], views: [120, 9], prompts: [6, 0], likes: [3, 0], comments: [1, 1] },
  board: [{ rank: 1, handle: "ann", prompts: 2, posts: 1, revenue: 3_600_000, views: 107, likes: 2, comments: 0, followers: 1 }],
};

describe("GET /api/analytics/enki", () => {
  beforeEach(() => { db.calls = []; db.answer = { data: STATS, error: null }; });

  it("asks for all time by revenue, and answers each figure with its last 24 hours, revenue in cents", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    // The deployment's chain picks the money (devnet test USDC here).
    expect(db.calls).toEqual([{ name: "enki_stats", args: { p_since: null, p_sort: "revenue", p_limit: 25, p_chain: "solana-devnet" } }]);
    const body = await res.json();
    expect(body.totals).toEqual({
      users: { value: 39, day: 2 }, posts: { value: 2, day: 1 }, images: { value: 55, day: 4 },
      revenue: { value: 386, day: 150 }, prompts: { value: 6, day: 0 }, likes: { value: 3, day: 0 },
      comments: { value: 1, day: 1 }, views: { value: 120, day: 9 },
    });
    expect(body.board).toEqual([{ rank: 1, handle: "ann", prompts: 2, posts: 1, revenueCents: 360, views: 107, likes: 2, comments: 0, followers: 1 }]);
    expect([body.sort, body.period]).toEqual(["revenue", "all"]);
  });

  it("narrows a week and a month to their days, views included", async () => {
    const before = Date.now();
    for (const [period, days] of [["week", 7], ["month", 30]] as const) {
      db.calls = [];
      const body = await (await get(`?period=${period}&sort=likes`)).json();
      const since = Date.parse(String(db.calls[0].args.p_since));
      expect(before - since).toBeGreaterThanOrEqual(days * 86_400_000 - 5_000);
      expect(before - since).toBeLessThanOrEqual(days * 86_400_000 + 5_000);
      expect([db.calls[0].args.p_sort, body.period]).toEqual(["likes", period]);
      expect(body.totals.views).toEqual({ value: 120, day: 9 });
      expect(body.board[0].views).toBe(107);
    }
  });

  it("ranks only by a column it knows", async () => {
    expect((await (await get("?period=year")).json()).period).toBe("all");
    for (const [qs, sort] of [["?sort=followers", "followers"], ["?sort=views", "views"], ["?sort=handle", "revenue"],
      ["?sort=comments", "comments"], ["?sort=images", "revenue"], ["?sort=views&period=year", "views"],
      ["?sort=views&period=week", "views"], ["?sort=likes&period=month", "likes"]] as const) {
      db.calls = [];
      const body = await (await get(qs)).json();
      expect([db.calls[0].args.p_sort, body.sort]).toEqual([sort, sort]);
    }
  });

  it("passes what was watched most through", async () => {
    db.answer = { data: { ...STATS,
      watched: { prompts: [{ id: "p1", title: "Lighthouse", handle: "ann", n: 9 }, { id: "p2", title: null, handle: null, n: 2 }],
        images: [{ id: "i1", thumb: "https://x/t.webp", handle: "ann", n: 7 }] } }, error: null };
    for (const qs of ["", "?period=week"]) {
      const body = await (await get(qs)).json();
      expect(body.watched).toEqual({
        prompts: [{ id: "p1", title: "Lighthouse", handle: "ann", views: 9 }, { id: "p2", title: "Untitled", handle: null, views: 2 }],
        images: [{ id: "i1", thumb: "https://x/t.webp", handle: "ann", views: 7 }],
      });
    }
  });

  it("counts a figure the database has no row for as 0, and keeps a creator without a handle without one", async () => {
    db.answer = { data: { totals: {}, board: [{ ...STATS.board[0], handle: null }] }, error: null };
    const body = await (await get()).json();
    expect(body.totals.users).toEqual({ value: 0, day: 0 });
    expect(body.totals.revenue).toEqual({ value: 0, day: 0 });
    expect(body.totals.views).toEqual({ value: 0, day: 0 });
    expect(body.watched).toEqual({ prompts: [], images: [] });
    expect(body.board[0].handle).toBeNull();
    expect(body.period).toBe("all");
  });

  it("says when the numbers cannot load: an unreachable database as an outage, anything else as a failure", async () => {
    db.answer = { data: null, error: { message: "TypeError: fetch failed" } };
    expect((await get()).status).toBe(503);
    db.answer = { data: null, error: { code: "PGRST202", message: "Could not find the function public.enki_stats" } };
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not load Enki's numbers" });
  });
});
