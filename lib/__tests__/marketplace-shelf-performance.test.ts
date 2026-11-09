import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Kev, 2026-11-03: the profile's Released wall is endless, with its numbers on every card, sorted by performance or
 * date and filtered by category and generator (DEC-2026-11-03-05). The fake answers as PostgREST does: filters, order
 * and offset are applied, and a read returns at most `cap` rows, so a count cut at a page shows as a wrong number.
 */
type Row = Record<string, any>;
type Query = { table: string; columns: string; orders: [string, boolean][]; filters: [string, string, unknown][]; ranges: [number, number][] };
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  queries: [] as Query[],
  cap: 1000,
  fail: {} as Record<string, unknown>,
}));

vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from(table: string) {
      const q: Query = { table, columns: "", orders: [], filters: [], ranges: [] };
      db.queries.push(q);
      const keep: ((r: Row) => boolean)[] = [];
      let from = 0, to = Infinity, one = false;
      // "a.b" reads through an embedded row or rows: an inner embed keeps the row when any of them holds.
      const read = (r: Row, c: string): unknown[] => {
        const [head, tail] = c.split(".");
        return tail ? [r[head]].flat().map((e: Row) => e?.[tail]) : [r[head]];
      };
      const filter = (op: string, c: string, v: unknown, test: (x: any) => boolean) => {
        q.filters.push([op, c, v]);
        keep.push((r) => read(r, c).some(test));
        return chain;
      };
      const chain: Record<string, unknown> = {
        select: (columns: string) => { q.columns = columns; return chain; },
        eq: (c: string, v: unknown) => filter("eq", c, v, (x) => x === v),
        neq: (c: string, v: unknown) => filter("neq", c, v, (x) => x !== null && x !== undefined && x !== v),
        is: (c: string, v: unknown) => filter("is", c, v, (x) => (x ?? null) === v),
        in: (c: string, v: unknown[]) => filter("in", c, v, (x) => v.includes(x)),
        gt: (c: string, v: number) => filter("gt", c, v, (x) => x > v),
        gte: (c: string, v: number) => filter("gte", c, v, (x) => x >= v),
        lte: (c: string, v: number) => filter("lte", c, v, (x) => x <= v),
        overlaps: (c: string, v: unknown[]) => filter("overlaps", c, v, (x) => (x ?? []).some((t: unknown) => v.includes(t))),
        ilike: (c: string, v: string) => filter("ilike", c, v, (x) => String(x ?? "").toLowerCase().includes(v.replace(/%/g, "").toLowerCase())),
        order: (c: string, o?: { ascending?: boolean }) => { q.orders.push([c, o?.ascending !== false]); return chain; },
        range: (a: number, b: number) => { from = a; to = b; q.ranges.push([a, b]); return chain; },
        maybeSingle: () => { one = true; return chain; },
        single: () => { one = true; return chain; },
        then: (done: (v: unknown) => unknown, rejected?: (e: unknown) => unknown) => {
          const failure = db.fail[table];
          if (failure) return Promise.resolve({ data: null, error: failure }).then(done, rejected);
          const rows = [...(db.tables[table] ?? [])].filter((r) => keep.every((k) => k(r))).sort((a, b) => {
            for (const [c, asc] of q.orders) {
              if (a[c] === b[c]) continue;
              return (a[c] < b[c] ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
          // Only the columns asked for, so a read that forgot the numbers' columns shows.
          const page = rows.slice(from, Math.min(to + 1, from + db.cap))
            .map((r) => (table === "prompts" ? Object.fromEntries(q.columns.split(",").map((c) => [c, r[c]])) : r));
          return Promise.resolve({ data: one ? page[0] ?? null : page, error: null }).then(done, rejected);
        },
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/adult-content", () => ({
  viewer: async () => ({ userId: null }),
  hideAdult: (q: { eq(c: string, v: boolean): unknown }) => q.eq("is_adult", false),
}));
vi.mock("@/lib/hidden-owners", () => ({ hiddenOwners: async () => new Set() }));
// The read as it is before SQL 52; after it: marketplace-video.test.ts.
vi.mock("@/lib/marketplace/video-columns", () => ({ videoColumns: async () => false }));
vi.mock("@/lib/communities/server", () => ({ communityIdOf: async (_: unknown, handle: string) => (handle === "club" ? "c1" : null) }));
vi.mock("@/lib/marketplace/renditions", () => ({ renditionsByUrl: async () => new Map(), withRenditions: (i: unknown) => i }));

import { GET } from "../../app/api/marketplace/prompts/route";
import { PROMPT_CARD_SELECT } from "../marketplace/card";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const prompt = (id: string, created: number, patch: Row = {}): Row => ({
  id, title: `t-${id}`, creator_id: CREATOR, is_listed: true, listing_status: "active", deleted_at: null, is_adult: false,
  category: "Marketing", tags: [], ai_model: "flux", price_usd_cents: 0, like_count: 0, opens: 0, showcase_images: [],
  created_at: `2026-10-${String(created).padStart(2, "0")}T00:00:00.000+00:00`, community_links: [], ...patch,
});
const render = (promptId: string, user = OTHER, patch: Row = {}): Row => ({
  id: `g-${promptId}-${Math.random()}`, prompt_id: promptId, user_id: user, deleted_at: null, prompts: { creator_id: CREATOR }, ...patch,
});

// Each from its own address, so only the test of the limit meets the limit.
let ip = 0;
const from = (query: string, address: string) => GET(new NextRequest(`http://x/api/marketplace/prompts?${query}`, { headers: { "x-real-ip": address } }));
const get = async (query: string) => {
  const res = await from(query, `10.0.${ip >> 8}.${ip++ & 255}`);
  return { status: res.status, body: await res.json() };
};
const ids = async (query: string) => {
  const { status, body } = await get(query);
  expect(status).toBe(200);
  return (body.prompts as { id: string }[]).map((p) => p.id);
};
const shelf = `creator=${CREATOR}`;
const performance = `${shelf}&sortBy=performance&limit=50`;
const reads = (table: string) => db.queries.filter((q) => q.table === table);

beforeEach(() => {
  db.queries = [];
  db.cap = 1000;
  db.fail = {};
  db.tables = { users: [{ id: CREATOR, handle: "mira", display_name: "Mira", avatar_url: null }], prompt_variables: [], generations: [], prompts: [] };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sort by performance", () => {
  // One row per rule: the row above beats the next only by the column it names.
  const ladder = () => {
    db.tables.prompts = [
      prompt("oldest-id-z", 1),
      prompt("views", 2, { opens: 1 }),
      prompt("likes", 3, { like_count: 1 }),
      prompt("uses", 4),
      prompt("newer", 5),
      prompt("tie-b", 3),
      prompt("tie-a", 3),
    ];
    db.tables.generations = [render("uses")];
  };
  const order = ["uses", "likes", "views", "newer", "tie-a", "tie-b", "oldest-id-z"];

  it("orders by uses, likes, views, date, id", async () => {
    ladder();
    expect(await ids(performance)).toEqual(order);
  });

  it("each number outranks the ones after it", async () => {
    db.tables.prompts = [
      prompt("a-views", 9, { opens: 100, like_count: 0 }),
      prompt("b-likes", 8, { like_count: 100, opens: 0 }),
      prompt("c-uses", 7, { like_count: 0, opens: 0 }),
    ];
    db.tables.generations = [render("c-uses")];
    expect(await ids(performance)).toEqual(["c-uses", "b-likes", "a-views"]);
  });

  it("pages through the whole shelf's order, every id once", async () => {
    ladder();
    const seen: string[] = [];
    let cursor: string | undefined = "0";
    const stops: unknown[] = [];
    for (let page = 0; page < 5 && cursor !== undefined; page++) {
      const { body }: { body: { prompts: { id: string }[]; hasMore: boolean; nextCursor?: string } } = await get(`${shelf}&sortBy=performance&limit=3&cursor=${cursor}`);
      seen.push(...body.prompts.map((p) => p.id));
      stops.push([body.hasMore, body.nextCursor]);
      cursor = body.nextCursor;
    }
    expect(seen).toEqual(order);
    expect(stops).toEqual([[true, "3"], [true, "6"], [false, undefined]]);
  });

  it("the one prompt everyone used comes first whatever page it was read on", async () => {
    db.tables.prompts = Array.from({ length: 30 }, (_, i) => prompt(`p${String(i).padStart(2, "0")}`, 28 - i % 20));
    db.tables.generations = [render("p29")];
    expect((await ids(`${shelf}&sortBy=performance&limit=2`))[0]).toBe("p29");
  });

  it("counts renders by others only, of this creator's, not deleted", async () => {
    db.tables.prompts = [prompt("a", 1), prompt("b", 2)];
    db.tables.generations = [
      render("a", CREATOR),
      render("a", OTHER, { deleted_at: "2026-10-02T00:00:00Z" }),
      render("a", OTHER, { prompts: { creator_id: OTHER } }),
      render("a", null as unknown as string),
    ];
    const { body } = await get(`${performance}&stats=1`);
    expect(body.prompts.map((p: { stats: { uses: number } }) => p.stats.uses)).toEqual([0, 0]);
    expect(reads("generations")[0].columns).toBe("prompt_id, prompts!inner(creator_id)");
  });

  it("no count stops at PostgREST's 1000 rows, nor at a lower cap", async () => {
    db.tables.prompts = [
      ...Array.from({ length: 1200 }, (_, i) => prompt(`p${i}`, 1 + i % 28)),
      prompt("last-read", 1, { id: "zzz" }),
    ];
    db.tables.generations = Array.from({ length: 1500 }, () => render("zzz"));
    for (const cap of [1000, 300]) {
      db.cap = cap;
      const { body } = await get(`${shelf}&sortBy=performance&stats=1&limit=1`);
      expect(body.prompts[0]).toMatchObject({ id: "zzz", stats: { uses: 1500 } });
    }
  });

  it("a shelf read pages in a fixed order", async () => {
    ladder();
    await ids(performance);
    expect(reads("generations")[0].orders).toEqual([["id", true]]);
    expect(reads("prompts")[0].orders).toEqual([["created_at", false], ["id", true]]);
  });
});

describe("the filters reach the performance read", () => {
  const seeded = (patch: Row) => {
    db.tables.prompts = [prompt("yes", 2, patch), prompt("no", 1)];
    db.tables.generations = [render("no")];
  };
  it.each([
    ["models", "models=sdxl", { ai_model: "sdxl" }],
    ["category", "category=Portrait", { category: "Portrait" }],
    ["tags", "tags=cat", { tags: ["cat"] }],
    ["paid", "priceFilter=paid", { price_usd_cents: 5 }],
    ["min price", "minPrice=5", { price_usd_cents: 5 }],
    ["max price", "maxPrice=5", { price_usd_cents: 5 }],
    ["query", "query=needle", { title: "a needle here" }],
    ["community", "community=club", { community_links: [{ community_id: "c1", state: "shown" }] }],
  ] as const)("%s", async (_, query, patch) => {
    seeded(patch);
    if (query === "maxPrice=5") db.tables.prompts[1].price_usd_cents = 9;
    expect(await ids(`${performance}&${query}`)).toEqual(["yes"]);
  });

  it.each([
    ["a draft", { listing_status: "draft" }],
    ["an unlisted row", { is_listed: false }],
    ["a deleted row", { deleted_at: "2026-10-02T00:00:00Z" }],
    ["18+ for this viewer", { is_adult: true }],
    ["someone else's", { creator_id: OTHER }],
  ] as const)("leaves out %s", async (_, patch) => {
    db.tables.prompts = [prompt("gone", 1, patch), prompt("kept", 2)];
    expect(await ids(performance)).toEqual(["kept"]);
  });

  it("a community keeps the numbers' columns on its read", async () => {
    seeded({ community_links: [{ community_id: "c1", state: "shown" }], like_count: 4 });
    const { body } = await get(`${performance}&community=club&stats=1`);
    expect(body.prompts[0].stats).toEqual({ uses: 0, likes: 4, views: 0 });
    expect(reads("prompts")[0].columns).toContain("community_links!inner(community_id)");
  });
});

describe("without a creator it answers as newest", () => {
  it("reads one page by date and no renders", async () => {
    db.tables.prompts = [prompt("old", 1, { like_count: 9 }), prompt("new", 2)];
    db.tables.generations = [render("old")];
    const { body } = await get("sortBy=performance&stats=1&limit=5");
    expect(body.prompts.map((p: { id: string }) => p.id)).toEqual(["new", "old"]);
    expect(body.filters.applied.sortBy).toBe("newest");
    expect(reads("generations")).toEqual([]);
    expect(reads("prompts")).toHaveLength(1);
    expect(reads("prompts")[0].columns).toBe(PROMPT_CARD_SELECT);
    expect(body.prompts[0]).not.toHaveProperty("stats");
  });
});

describe("?stats=1 with ?creator=", () => {
  it("adds uses, likes and views to each card, a zero as 0, by date", async () => {
    db.tables.prompts = [prompt("older", 1, { like_count: 2, opens: 3 }), prompt("newer", 2)];
    db.tables.generations = [render("older"), render("older")];
    const { body } = await get(`${shelf}&sortBy=newest&stats=1`);
    expect(body.prompts.map((p: { id: string; stats: unknown }) => [p.id, p.stats])).toEqual([
      ["newer", { uses: 0, likes: 0, views: 0 }],
      ["older", { uses: 2, likes: 2, views: 3 }],
    ]);
  });

  it("a column without a value counts as 0", async () => {
    db.tables.prompts = [prompt("a", 1, { like_count: null, opens: null })];
    expect((await get(`${shelf}&stats=1`)).body.prompts[0].stats).toEqual({ uses: 0, likes: 0, views: 0 });
  });

  it("views are prompts.opens, not prompts.views", async () => {
    db.tables.prompts = [prompt("a", 1, { opens: 3, views: 8 })];
    expect((await get(`${shelf}&stats=1`)).body.prompts[0].stats.views).toBe(3);
  });

  it("without it the read is today's: no numbers, no renders, one prompts read", async () => {
    db.tables.prompts = [prompt("a", 1, { like_count: 2 })];
    db.tables.generations = [render("a")];
    const { body } = await get(`${shelf}&sortBy=newest`);
    expect(body.prompts[0]).not.toHaveProperty("stats");
    expect(reads("generations")).toEqual([]);
    expect(reads("prompts")).toHaveLength(1);
    expect(reads("prompts")[0].columns).toBe(PROMPT_CARD_SELECT);
    expect(reads("prompts")[0].ranges).toEqual([[0, 11]]);
  });

  it("performance alone sorts by the numbers and does not add them", async () => {
    db.tables.prompts = [prompt("a", 1, { like_count: 2 }), prompt("b", 2)];
    const { body } = await get(performance);
    expect(body.prompts.map((p: { id: string }) => p.id)).toEqual(["a", "b"]);
    expect(body.prompts[0]).not.toHaveProperty("stats");
    expect(body.prompts[0]).not.toHaveProperty("like_count");
  });
});

describe("a failed read never looks like a number or an empty wall", () => {
  const failure = { code: "XX000", message: "boom" };
  beforeEach(() => { db.tables.prompts = [prompt("a", 1, { like_count: 2 })]; });

  it("a failed count gives this page null stats, by date", async () => {
    db.fail.generations = failure;
    const { status, body } = await get(`${shelf}&sortBy=newest&stats=1`);
    expect(status).toBe(200);
    expect(body.prompts).toHaveLength(1);
    expect(body.prompts[0].stats).toBeNull();
  });

  it("a failed count refuses the performance sort", async () => {
    db.fail.generations = failure;
    const { status, body } = await get(performance);
    expect(status).toBe(500);
    expect(body.success).toBe(false);
  });

  it("a dead database says so on the performance sort", async () => {
    db.fail.generations = { message: "TypeError: fetch failed" };
    expect((await get(performance)).status).toBe(503);
  });

  it.each(["sortBy=performance", "sortBy=newest"])("a failed shelf read answers an error with %s", async (sort) => {
    db.fail.prompts = failure;
    expect((await get(`${shelf}&${sort}`)).status).toBe(500);
  });

  it("a failed page of the performance read is not a short shelf", async () => {
    db.fail.prompts = failure;
    expect((await get(performance)).status).toBe(500);
  });

  it("a handle that could not be looked up is not an unknown one", async () => {
    db.fail.users = failure;
    expect((await get("creator=mira&sortBy=newest")).status).toBe(500);
  });

  it("an unknown handle is an empty shelf", async () => {
    expect(await ids("creator=nobody&sortBy=performance")).toEqual([]);
  });

  it("the feed without a creator keeps its empty answer", async () => {
    db.fail.prompts = failure;
    const { status, body } = await get("sortBy=newest");
    expect(status).toBe(200);
    expect(body.prompts).toEqual([]);
  });
});

describe("?category= finds the label stored live", () => {
  beforeEach(() => {
    db.tables.prompts = [prompt("m", 1, { category: "Marketing" }), prompt("p", 2, { category: "Portrait" })];
  });
  it.each(["marketing", "Marketing", "MARKETING"])("%s", async (category) => {
    expect(await ids(`category=${category}`)).toEqual(["m"]);
    expect(reads("prompts")[0].filters).toContainEqual(["eq", "category", "Marketing"]);
  });
  it("a label outside the list reaches the database as sent", async () => {
    db.tables.prompts.push(prompt("o", 3, { category: "Photography" }));
    expect(await ids("category=Photography")).toEqual(["o"]);
  });
  it("a shelf's date sort filters the same way", async () => {
    expect(await ids(`${shelf}&sortBy=newest&category=portrait`)).toEqual(["p"]);
  });
});

describe("a shelf's date pages", () => {
  it("equal dates keep their order across pages, the feed's read is left as it is", async () => {
    db.tables.prompts = [prompt("b", 1), prompt("a", 1), prompt("c", 1)];
    expect(await ids(`${shelf}&sortBy=newest`)).toEqual(["a", "b", "c"]);
    expect(reads("prompts").at(-1)!.orders).toEqual([["created_at", false], ["id", true]]);
    db.queries = [];
    await ids("sortBy=newest");
    expect(reads("prompts")[0].orders).toEqual([["created_at", false]]);
  });
});

// Second review of DEC-2026-11-03-05: one request reads a whole shelf and all of a creator's renders, and nothing limited it.
describe("the whole-shelf reads are limited", () => {
  const limited = async (query: string, address: string) => {
    for (let i = 0; i < 60; i++) expect((await from(query, address)).status).toBe(200);
    db.queries = [];
    return from(query, address);
  };
  it.each([
    ["performance", `${performance}`, "172.16.0.1"],
    ["the date sort with its numbers", `${shelf}&sortBy=newest&stats=1`, "172.16.0.2"],
  ])("%s: the 61st of a minute answers 429 and reads nothing", async (_, query, address) => {
    db.tables.prompts = [prompt("a", 1)];
    const res = await limited(query, address);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^[0-9]+$/);
    expect((await res.json()).error).toBe("Too many requests");
    expect(db.queries).toEqual([]);
  });
  it("one address's limit is not another's", async () => {
    db.tables.prompts = [prompt("a", 1)];
    expect((await limited(performance, "172.16.0.3")).status).toBe(429);
    expect((await from(performance, "172.16.0.4")).status).toBe(200);
  });
  it.each([
    ["the feed", "sortBy=newest", "172.16.0.5"],
    ["the feed asking for performance", "sortBy=performance&stats=1", "172.16.0.6"],
    ["a shelf by date without numbers", `${shelf}&sortBy=newest`, "172.16.0.7"],
  ])("%s reads one page, and stays unlimited", async (_, query, address) => {
    for (let i = 0; i < 70; i++) expect((await from(query, address)).status).toBe(200);
  });
});
