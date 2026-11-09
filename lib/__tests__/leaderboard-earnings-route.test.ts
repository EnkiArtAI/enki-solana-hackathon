import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The Hall of Fame's earnings tab (Kev, 2026-10-29, "go 1"): the ranking, its trend and "N prompts" all come from
 * artist_earnings in the deployment's chain's money, never from prompt_purchases; the generations tab asks as before.
 */
const db = vi.hoisted(() => ({
  rpc: [] as { name: string; args: Record<string, unknown> }[],
  ranking: [] as Record<string, unknown>[],
  earned: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.rpc.push({ name, args });
      return { data: name.startsWith("leaderboard_") && !name.includes("series") ? db.ranking : name === "artist_earnings" ? db.earned : [], error: null };
    },
    from: () => {
      const q: Record<string, unknown> = {};
      for (const op of ["select", "eq", "is", "in", "order", "limit", "gte"]) q[op] = () => q;
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return q;
    },
  }),
}));
vi.mock("@/lib/hidden-owners", () => ({ hiddenOwners: async () => new Set<string>() }));
vi.mock("@/lib/payments/solana", () => ({ solanaChainKey: () => "solana-devnet" }));
import { GET } from "../../app/api/leaderboard/route";

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/leaderboard${qs}`));

describe("the Hall of Fame's earnings", () => {
  beforeEach(() => {
    db.rpc = [];
    db.ranking = [
      { creator_id: "c1", handle: "ann", total_cents: 360, best_prompt_id: "p1", best_prompt_title: "Lighthouse" },
      { creator_id: "c2", handle: "bob", total_cents: 100, best_prompt_id: null, best_prompt_title: null },
    ];
    db.earned = [{ creator_id: "c1", prompt_id: "p1" }, { creator_id: "c1", prompt_id: "p2" }, { creator_id: "c1", prompt_id: "p1" }, { creator_id: "c2", prompt_id: null }];
  });

  it("ranks, draws the trend and counts the prompts that earned, all from artist_earnings on the deployment's chain", async () => {
    const res = await get("?metric=earnings&period=week");
    expect(res.status).toBe(200);
    const [rank, series, earn] = db.rpc;
    expect(rank.name).toBe("leaderboard_earnings");
    expect(rank.args).toMatchObject({ p_limit: 20, p_chain: "solana-devnet" });
    expect(Date.now() - Date.parse(String(rank.args.p_since))).toBeGreaterThan(6.9 * 86_400_000);
    expect([series.name, series.args.p_creators, series.args.p_chain]).toEqual(["leaderboard_earn_series", ["c1", "c2"], "solana-devnet"]);
    expect([earn.name, earn.args.p_creators, earn.args.p_chain, earn.args.p_since]).toEqual(["artist_earnings", ["c1", "c2"], "solana-devnet", rank.args.p_since]);
    const rows = (await res.json()).rows;
    expect(rows.map((r: { handle: string; value: number; unit: string; sub: number }) => [r.handle, r.value, r.unit, r.sub])).toEqual([["ann", 3.6, "usd", 2], ["bob", 1, "usd", 0]]);
  });

  it("asks all time with no start", async () => {
    await get("?metric=earnings&period=all");
    expect(db.rpc[0].args).toEqual({ p_since: null, p_limit: 20, p_chain: "solana-devnet" });
    expect(db.rpc[2].args.p_since).toBeNull();
  });

  it("leaves the generations tab as it was: no chain, no earnings read", async () => {
    await get("?metric=generations&period=month");
    expect(db.rpc.map((c) => c.name)).toEqual(["leaderboard_generations", "leaderboard_gen_series"]);
    expect(db.rpc[0].args).toEqual({ p_since: expect.any(String), p_limit: 20 });
    expect(db.rpc[1].args).toEqual({ p_creators: ["c1", "c2"], p_since: expect.any(String) });
  });
});
