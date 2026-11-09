import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/analytics/me (Kev, 2026-10-29, "go 1"): the Mine tab's earnings are what the artist earned per paid
 * render (artist_earnings, in the deployment's chain's money), never the dead prompt_purchases table; "Created" counts
 * the images this person rendered, private ones included; before SQL 45 ran the page stands with nothing earned.
 * Ratings come from prompt_comments and conversion per open (prompts.opens): it never reads a table SQL 50 drops.
 */
const db = vi.hoisted(() => ({
  rpc: [] as { name: string; args: Record<string, unknown> }[],
  earn: { data: [] as unknown[], error: null as { code?: string; message?: string } | null },
  rows: {} as Record<string, unknown[]>,
  filters: {} as Record<string, unknown[][]>,
  failing: new Set<string>(),
}));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => { db.rpc.push({ name, args }); return db.earn; },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      const log = (op: string) => (...a: unknown[]) => { (db.filters[table] ??= []).push([op, ...a]); return q; };
      for (const op of ["select", "eq", "is", "in", "order", "limit"]) q[op] = log(op);
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve(
        db.failing.has(table) ? { data: null, error: { message: "relation does not exist" } } : { data: db.rows[table] ?? [], error: null },
      ).then(ok);
      return q;
    },
  }),
}));
const session = vi.hoisted(() => ({ user: "u1" as string | null }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => session.user }));
vi.mock("@/lib/payments/solana", () => ({ solanaChainKey: () => "solana-devnet" }));
import { GET } from "../../app/api/analytics/me/route";

const H = 3_600_000, D = 24 * H;
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const get = (qs = "") => GET(new NextRequest(`http://localhost/api/analytics/me${qs}`, { headers: { "X-Session-Token": "t" } }));

describe("GET /api/analytics/me", () => {
  beforeEach(() => {
    db.rpc = []; db.filters = {}; db.failing = new Set(["prompt_analytics_events", "prompt_reviews", "prompt_purchases", "platform_analytics"]); session.user = "u1";
    db.earn = { data: [
      { prompt_id: "p1", micro: "1500000", earned_at: at(H) },
      { prompt_id: "p1", micro: 800000, earned_at: at(5 * D) },
      { prompt_id: null, micro: 250000, earned_at: at(40 * D) },
    ], error: null };
    db.rows = {
      prompts: [{ id: "p1", title: "Lighthouse", prompt_type: "paid", is_free_showcase: false, price_usd_cents: 1000, listing_status: "active", created_at: at(10 * D), showcase_images: ["https://x/1.webp"], opens: 4 }],
      generated_images: [{ created_at: at(H) }, { created_at: at(3 * D) }, { created_at: at(40 * D) }],
      prompt_comments: [
        { prompt_id: "p1", rating: 4, created_at: at(2 * H) }, { prompt_id: "p1", rating: null, created_at: at(3 * H) },
        { prompt_id: "p1", rating: 2, created_at: at(4 * D) },
      ],
    };
  });

  it("asks artist_earnings for this person, on the deployment's chain, and sums it in cents", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(db.rpc).toEqual([{ name: "artist_earnings", args: { p_since: null, p_creators: ["u1"], p_chain: "solana-devnet" } }]);
    const body = await res.json();
    expect(body.summary).toMatchObject({ totalCents: 255, salesCount: 3, week: { cents: 230 }, month: { cents: 230 }, year: { cents: 255 } });
    expect(body.stats.all).toMatchObject({ earningsCents: 255, unlocks: 3 });
    expect(body.stats.week).toMatchObject({ earningsCents: 230, unlocks: 2 });
    expect(body.prompts).toEqual([expect.objectContaining({ id: "p1", earningsCents: 230, sales: 2 })]);
    expect(body.recentSales.map((s: { promptTitle: string; amountCents: number }) => [s.promptTitle, s.amountCents])).toEqual([["Lighthouse", 150], ["Lighthouse", 80], ["Untitled", 25]]);
    expect(body.topPrompts).toEqual([expect.objectContaining({ id: "p1", revenueCents: 230, image: "https://x/1.webp" })]);
    expect(body.activity.filter((a: { type: string }) => a.type === "sale").map((a: { amountCents: number }) => a.amountCents)).toEqual([150, 80, 25]);
  });

  it("counts the images this person rendered, private ones too, never uploads or deleted ones", async () => {
    const body = await (await get()).json();
    expect(body.stats.all.created).toBe(3);
    expect(body.stats.week).toMatchObject({ created: 2, createdTrend: null });
    expect(body.stats.month).toMatchObject({ created: 2 });
    expect(db.filters.generated_images).toEqual([["select", "created_at"], ["eq", "user_id", "u1"], ["eq", "is_uploaded", false], ["is", "deleted_at", null], ["limit", 20000]]);
  });

  it("stands before SQL 45 ran, with nothing earned; any other failure is said", async () => {
    db.earn = { data: null as unknown as unknown[], error: { code: "PGRST202", message: "Could not find the function" } };
    const body = await (await get()).json();
    expect(body.summary).toMatchObject({ totalCents: 0, salesCount: 0 });
    expect(body.stats.all.created).toBe(3);
    db.earn = { data: null as unknown as unknown[], error: { code: "42501", message: "permission denied" } };
    expect((await get()).status).toBe(500);
  });

  it("rates and converts from what is still there: prompt_comments and the opens counter", async () => {
    const body = await (await get()).json();
    expect(body.prompts[0]).toMatchObject({ rating: 3, comments: 3, opens: 4 });
    expect(body.prompts[0].views).toBeUndefined();
    expect(body.activity.filter((a: { type: string }) => a.type === "rating").map((a: { rating: number }) => a.rating)).toEqual([4, 2]);
    expect(body.conversionPct).toBe(75);
    expect(body.topPrompts[0].conversionPct).toBe(50);
    for (const t of ["prompt_reviews", "prompt_analytics_events", "prompt_purchases", "platform_analytics"]) expect(db.filters[t], t).toBeUndefined();
    expect(db.filters.prompts[0]).toEqual(["select", "id, title, prompt_type, is_free_showcase, price_usd_cents, listing_status, created_at, showcase_images, opens"]);
    expect(db.filters.prompt_comments[0]).toEqual(["select", "prompt_id, rating, created_at"]);
  });

  it("shows no conversion before anyone opened a prompt", async () => {
    db.rows.prompts = [{ ...(db.rows.prompts[0] as object), opens: 0 }];
    const body = await (await get()).json();
    expect([body.conversionPct, body.topPrompts[0].conversionPct]).toEqual([null, null]);
  });

  it("needs a session", async () => {
    session.user = null;
    expect((await get()).status).toBe(401);
    expect(db.rpc).toEqual([]);
  });
});
