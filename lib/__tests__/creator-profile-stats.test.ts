import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Kev, 2026-11-02: following moves the count, and a profile counts its prompts. The profile's four numbers: every
 * listed prompt (the portfolio's 20 are not the count), renders of them by anyone else, those of the last 30 days, and
 * who follows them. A count that fails is null, so the profile shows a dash and never a wrong zero.
 */
type Query = { table: string; columns?: string; options?: { count?: string; head?: boolean }; filters: unknown[][] };
const db = vi.hoisted(() => ({ queries: [] as Query[], answer: (_: Query): unknown => ({}) }));

vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from(table: string) {
      const q: Query = { table, filters: [] };
      db.queries.push(q);
      const chain: Record<string, unknown> = {
        select: (columns: string, options?: Query["options"]) => { q.columns = columns; q.options = options; return chain; },
        then: (done: (v: unknown) => unknown) => Promise.resolve(db.answer(q)).then(done),
      };
      for (const op of ["eq", "neq", "is", "gte", "order", "limit", "maybeSingle"]) {
        chain[op] = (...args: unknown[]) => { q.filters.push([op, ...args]); return chain; };
      }
      return chain;
    },
  }),
}));
vi.mock("@/lib/adult-content", () => ({ hideAdult: (q: unknown) => q, viewer: async () => ({ userId: null }) }));
vi.mock("@/lib/hidden-owners", () => ({ hiddenOwners: async () => new Set() }));

import { GET } from "../../app/api/creators/[id]/profile/route";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const stats = async () => {
  const res = await GET(new NextRequest("http://x/api/creators/mira/profile"), { params: Promise.resolve({ id: "mira" }) });
  expect(res.status).toBe(200);
  return (await res.json()).stats;
};
const answers: Record<string, unknown> = {};
beforeEach(() => {
  db.queries = [];
  Object.assign(answers, {
    users: { data: { id: CREATOR, handle: "mira" }, error: null },
    prompts: { data: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, title: "t" })), error: null, count: 119 },
    user_wallets: { data: [], error: null },
    all: { count: 7, error: null },
    month: { count: 3, error: null },
    follows: { count: 2, error: null },
  });
  db.answer = (q) => (q.table === "generations" ? answers[q.filters.some((f) => f[0] === "gte") ? "month" : "all"] : answers[q.table]);
});

describe("a profile's numbers", () => {
  it("counts every listed prompt, past the portfolio's 20", async () => {
    expect(await stats()).toMatchObject({ totalPrompts: 119, activePrompts: 119 });
    expect(db.queries.find((q) => q.table === "prompts")?.options).toEqual({ count: "exact" });
  });

  it("says uses, this month and followers", async () => {
    expect(await stats()).toMatchObject({ uses: 7, usesMonth: 3, followers: 2 });
  });

  it("counts renders of their prompts by others, and followers of them", async () => {
    await stats();
    const gens = db.queries.filter((q) => q.table === "generations");
    expect(gens).toHaveLength(2);
    for (const g of gens) {
      expect(g.columns).toBe("id, prompts!inner(creator_id)");
      expect(g.options).toEqual({ count: "exact", head: true });
      expect(g.filters).toContainEqual(["eq", "prompts.creator_id", CREATOR]);
      expect(g.filters).toContainEqual(["neq", "user_id", CREATOR]);
      expect(g.filters).toContainEqual(["is", "deleted_at", null]);
    }
    expect(db.queries.find((q) => q.table === "follows")?.filters).toContainEqual(["eq", "followee_id", CREATOR]);
  });

  it("this month is the last 30 days", async () => {
    const before = Date.now();
    await stats();
    const since = db.queries.flatMap((q) => q.filters).find((f) => f[0] === "gte") as string[];
    expect(since[1]).toBe("created_at");
    expect(before - Date.parse(since[2])).toBeGreaterThanOrEqual(30 * 864e5 - 1000);
    expect(before - Date.parse(since[2])).toBeLessThanOrEqual(30 * 864e5 + 1000);
  });

  it("a count that fails is null, never a zero", async () => {
    Object.assign(answers, { all: { count: null, error: { message: "no" } }, month: { count: null, error: { message: "no" } }, follows: { count: null, error: { message: "no" } } });
    expect(await stats()).toMatchObject({ uses: null, usesMonth: null, followers: null, totalPrompts: 119 });
  });

  it("no followers yet is a zero", async () => {
    answers.follows = { count: 0, error: null };
    expect((await stats()).followers).toBe(0);
  });
});
