import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { readSource } from "@/lib/__tests__/_read-source";
import { stubRequiredEnv } from "@/lib/__tests__/_required-env";
import { checkAgentPromptInputs } from "@/lib/generation/agent-prompt-inputs";

/**
 * GET /api/x402/prompts: the artist prompts an agent can buy renders of
 * (enki-render's enki_find_prompts). What these tests hold: a visitor's rules
 * (live, below 18+, no banned or deleted creator) whether the search found
 * the prompt or not; not a word of any prompt in the answer; every variable
 * under the key /api/x402/generate takes back; the four orders; the limits.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let failing: Record<string, { code: string; message: string }>;
let rpcCalls: { fn: string; args: Record<string, unknown> }[];

type Sort = { column: string; ascending: boolean; nullsFirst: boolean };
const compare = (sorts: Sort[]) => (a: Row, b: Row) => {
  for (const s of sorts) {
    const x = a[s.column] ?? null;
    const y = b[s.column] ?? null;
    if (x === y) continue;
    if (x === null) return s.nullsFirst ? -1 : 1;
    if (y === null) return s.nullsFirst ? 1 : -1;
    return (x < y ? -1 : 1) * (s.ascending ? 1 : -1);
  }
  return 0;
};

/** A supabase-js shaped fake: filters, orders (Postgres' null placement), limits and the selected columns, as PostgREST. */
class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: ((r: Row) => boolean)[] = [];
  private sorts: Sort[] = [];
  private cap = Infinity;
  private one = false;
  private columns: string[] | null = null;
  constructor(private table: string) {}
  select(columns = "*") { this.columns = columns === "*" ? null : columns.split(",").map((c) => c.trim()); return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  or() { return this; } // bans' expiry: every fixture ban is open ended
  order(c: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const ascending = o.ascending ?? true;
    this.sorts.push({ column: c, ascending, nullsFirst: o.nullsFirst ?? !ascending });
    return this;
  }
  limit(n: number) { this.cap = n; return this; }
  maybeSingle() { this.one = true; return this; }
  then<A, B = never>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    if (failing[this.table]) return Promise.resolve({ data: null, error: failing[this.table] }).then(ok, ko);
    const rows = (tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r))).sort(compare(this.sorts)).slice(0, this.cap)
      .map((r) => (this.columns ? Object.fromEntries(this.columns.map((c) => [c, r[c]])) : r));
    return Promise.resolve({ data: this.one ? rows[0] ?? null : rows, error: null }).then(ok, ko);
  }
}

const has = (v: unknown, q: string) => typeof v === "string" && v.toLowerCase().includes(q.toLowerCase());
const fake = {
  from: (t: string) => new Query(t),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    const q = String(args.q);
    // Deliberately unfiltered: the route must apply a visitor's rules to what the search finds.
    if (fn === "search_prompts") return { data: tables.prompts.filter((p) => has(p.title, q)).slice(0, Number(args.lim)).map((p) => ({ id: p.id, rank: 1 })), error: null };
    if (fn === "search_creators") return { data: tables.users.filter((u) => has(u.handle, q) || has(u.display_name, q)).slice(0, Number(args.lim)), error: null };
    return { data: null, error: { code: "PGRST202", message: `no ${fn}` } };
  },
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => fake }));

import { GET } from "../../app/api/x402/prompts/route";

let ip = 0;
const req = (query = "", from = `10.1.${Math.floor(++ip / 250)}.${ip % 250}`) =>
  new NextRequest(`http://enki.test/api/x402/prompts${query}`, { headers: { "x-real-ip": from } });
const call = async (query = "") => {
  const res = await GET(req(query));
  return { status: res.status, body: await res.json() };
};
type Listed = { promptId: string; variables: { name: string; options?: string[] }[] } & Row;
const list = async (query = "") => {
  const { status, body } = await call(query);
  expect(status).toBe(200);
  return body.prompts as Listed[];
};
const ids = async (query = "") => (await list(query)).map((p) => p.promptId);

const SECRET = { encrypted_content: "SECRET-CIPHER", encrypted_content_iv: "SECRET-IV", public_prompt_text: "SECRET-EXCERPT", description: "SECRET-DESCRIPTION" };
const LIVE = { is_listed: true, listing_status: "active", deleted_at: null, is_adult: false, ...SECRET };
// Every hidden prompt is new and much liked: it would lead every order if it got through.
const HOT = { published_at: "2026-10-16T12:00:00Z", created_at: "2026-10-16T12:00:00Z", like_count: 100, price_usd_cents: 100, prompt_type: "paid", creator_id: "u-mara", showcase_images: [] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  failing = {};
  rpcCalls = [];
  tables = {
    users: [
      { id: "u-mara", handle: "mara", display_name: "Mara Lin", account_status: "active", deleted_at: null },
      { id: "u-otto", handle: "otto", display_name: null, account_status: "active", deleted_at: null },
      { id: "u-banned", handle: "banned", display_name: "Banned", account_status: "active", deleted_at: null },
      { id: "u-gone", handle: "gone", display_name: "Gone", account_status: "active", deleted_at: "2026-10-01T00:00:00Z" },
    ],
    bans: [{ user_id: "u-banned", lifted_at: null, expires_at: null }],
    prompts: [
      { id: "p1", title: "Neon Portrait", ...LIVE, creator_id: "u-mara", prompt_type: "paid", is_free_showcase: false, price_usd_cents: 250, like_count: 10,
        published_at: "2026-10-01T12:00:00Z", created_at: "2026-09-30T12:00:00Z", showcase_images: ["https://img/p1.png", "https://img/p1b.png"],
        ai_model: "nano-banana-pro", ai_settings: { models: ["Nano Banana Pro", "GPT Image 2"] } },
      { id: "p2", title: "Neon Product Shot", ...LIVE, creator_id: "u-otto", prompt_type: "free", is_free_showcase: false, price_usd_cents: 300, like_count: 1,
        published_at: "2026-10-10T12:00:00Z", created_at: "2026-10-10T12:00:00Z", showcase_images: ["https://img/p2.png"], ai_model: "nano-banana-2", ai_settings: {} },
      { id: "p3", title: "Dragon over Kyoto", ...LIVE, creator_id: "u-mara", prompt_type: "paid", is_free_showcase: false, price_usd_cents: 50, like_count: 5,
        published_at: "2026-09-01T12:00:00Z", created_at: "2026-09-01T12:00:00Z", showcase_images: [], ai_model: null, ai_settings: null },
      { id: "unlisted", title: "Neon unlisted", ...LIVE, ...HOT, is_listed: false },
      { id: "draft", title: "Neon draft", ...LIVE, ...HOT, listing_status: "draft" },
      { id: "deleted", title: "Neon deleted", ...LIVE, ...HOT, deleted_at: "2026-10-16T13:00:00Z" },
      { id: "adult", title: "Neon adult", ...LIVE, ...HOT, is_adult: true },
      { id: "banned", title: "Neon banned", ...LIVE, ...HOT, creator_id: "u-banned" },
      { id: "gone", title: "Neon gone", ...LIVE, ...HOT, creator_id: "u-gone" },
      { id: "video", title: "Neon video", ...LIVE, ...HOT, media_type: "video", showcase_images: ["https://v/poster.webp"], ai_model: "Seedance 2.5" },
    ],
    prompt_variables: [
      { prompt_id: "p1", name: "subject", label: "Who", data_type: "text", options: null, is_required: true, position: 0, deleted_at: null, description: "SECRET-VAR", default_value: "SECRET-DEFAULT", min_value: null, max_value: null },
      { prompt_id: "p1", name: "mood", label: "Mood", data_type: "single_select", is_required: false, position: 1, deleted_at: null, min_value: null, max_value: null,
        options: [{ visibleName: "Calm", label: "Calm", promptValue: "calm and still" }, { visibleName: "Wild", label: "Wild", promptValue: "wild" }] },
      // A checkbox's label is the phrase it adds, shown to buyers on the prompt page.
      { prompt_id: "p1", name: "crown", label: "with a golden crown", description: "with a golden crown", data_type: "checkbox", options: null, is_required: false, position: 2, deleted_at: null, min_value: null, max_value: null },
      { prompt_id: "p1", name: "var_3", label: "名前", data_type: "text", options: null, is_required: false, position: 3, deleted_at: null, min_value: null, max_value: null },
      { prompt_id: "p1", name: "old", label: "Old", data_type: "text", options: null, is_required: false, position: 4, deleted_at: "2026-10-01T00:00:00Z", min_value: null, max_value: null },
      { prompt_id: "p2", name: "product", label: "Product", data_type: "text", options: null, is_required: true, position: 0, deleted_at: null, min_value: null, max_value: null },
    ],
    generations: [
      { prompt_id: "p1", amount_paid_cents: 120, payment_intent_id: null, deleted_at: null },
      { prompt_id: "p1", amount_paid_cents: null, payment_intent_id: null, deleted_at: null },
      ...Array.from({ length: 5 }, () => ({ prompt_id: "p2", amount_paid_cents: null, payment_intent_id: null, deleted_at: null })),
      { prompt_id: "p2", amount_paid_cents: 90, payment_intent_id: "i-0", deleted_at: "2026-10-12T00:00:00Z" },
      { prompt_id: "p3", amount_paid_cents: null, payment_intent_id: "i-1", deleted_at: null },
      { prompt_id: "p3", amount_paid_cents: null, payment_intent_id: "i-2", deleted_at: null },
      { prompt_id: "p3", amount_paid_cents: 60, payment_intent_id: null, deleted_at: null },
      ...Array.from({ length: 50 }, () => ({ prompt_id: "adult", amount_paid_cents: 100, payment_intent_id: null, deleted_at: null })),
    ],
    generated_images: [{ storage_url: "https://img/p1.png", preview_url: "https://img/p1-preview.webp", thumbnail_url: "https://img/p1-thumb.webp" }],
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("what an agent is shown", () => {
  it("only live prompts: no unlisted, draft or deleted one", async () => {
    for (const query of ["", "?q=neon"]) {
      const found = await ids(query);
      for (const hidden of ["unlisted", "draft", "deleted"]) expect(found).not.toContain(hidden);
    }
  });

  it("never 18+, also not from the search, which is asked for the safe view", async () => {
    expect(await ids()).not.toContain("adult");
    expect(await ids("?q=neon")).not.toContain("adult");
    expect(rpcCalls.find((c) => c.fn === "search_prompts")?.args).toEqual({ q: "neon", lim: 100, off: 0, show_adult: false, models: null });
  });

  it("never a banned or deleted creator's prompt", async () => {
    for (const query of ["", "?q=neon", "?creator=banned", "?creator=gone"]) {
      const found = await ids(query);
      expect(found).not.toContain("banned");
      expect(found).not.toContain("gone");
    }
  });

  it("everything else, with the search's matches", async () => {
    expect(await ids()).toEqual(["p1", "p2", "p3"]);
    expect(await ids("?q=neon")).toEqual(["p1", "p2"]);
    expect(await ids("?q=zebra")).toEqual([]);
  });

  it("not a word of any prompt, a free one's neither: only the declared fields", async () => {
    const PROMPT = ["promptId", "title", "creator", "priceUsdc", "likes", "renders", "paidRenders", "thumbnailUrl", "pageUrl", "models", "variables"];
    const VARIABLE = ["name", "label", "type", "options", "required"];
    for (const query of ["", "?q=neon", "?sort=best_selling", "?creator=mara"]) {
      const { body } = await call(query);
      expect(JSON.stringify(body)).not.toContain("SECRET");
      for (const p of body.prompts as Listed[]) {
        expect(PROMPT).toEqual(expect.arrayContaining(Object.keys(p)));
        for (const v of p.variables) expect(VARIABLE).toEqual(expect.arrayContaining(Object.keys(v)));
      }
    }
  });

  it("selects no text column at all", () => {
    const route = readSource(join(__dirname, "..", "..", "app", "api", "x402", "prompts", "route.ts"));
    expect(route).not.toMatch(/encrypted_|public_prompt_text|\bdescription\b|default_value|select\(\s*["']\*/);
  });

  it("the artist, the artist's price per image, the cover's thumb, the prompt's page and its generators", async () => {
    const [p1, p2, p3] = await list("?sort=newest").then((l) => ["p1", "p2", "p3"].map((id) => l.find((p) => p.promptId === id)!));
    expect(p1).toMatchObject({ title: "Neon Portrait", creator: { name: "Mara Lin", handle: "mara" }, priceUsdc: "2.50", likes: 10,
      thumbnailUrl: "https://img/p1-thumb.webp", pageUrl: "http://enki.test/generator/p1", models: ["nano-banana-pro", "gpt-image-2"] });
    // A free prompt's artist takes nothing, whatever price it was saved with (computeQuote).
    expect(p2).toMatchObject({ creator: { name: "otto", handle: "otto" }, priceUsdc: "0.00", thumbnailUrl: "https://img/p2.png", models: ["nano-banana-2"] });
    expect(p3).toMatchObject({ priceUsdc: "0.50", models: [] });
    expect(p3).not.toHaveProperty("thumbnailUrl");
  });

  it("renders and paid renders, deleted ones not counted", async () => {
    const byId = Object.fromEntries((await list()).map((p) => [p.promptId, [p.renders, p.paidRenders]]));
    expect(byId).toEqual({ p1: [2, 1], p2: [5, 0], p3: [3, 3] });
  });
});

describe("variables", () => {
  it("carry the stored name, never the label; a var_<position> or deleted one is left out", async () => {
    const p1 = (await list()).find((p) => p.promptId === "p1")!;
    expect(p1.variables).toEqual([
      { name: "subject", label: "Who", type: "text", required: true },
      { name: "mood", label: "Mood", type: "single_select", options: ["calm and still", "wild"], required: false },
      { name: "crown", label: "with a golden crown", type: "checkbox", options: ["true", "false"], required: false },
    ]);
  });

  it("go straight back into /api/x402/generate: every listed key and option is accepted", async () => {
    const p1 = (await list()).find((p) => p.promptId === "p1")!;
    const values = Object.fromEntries(p1.variables.map((v) => [v.name, v.options?.[0] ?? "a cat"]));
    const checked = await checkAgentPromptInputs(fake as unknown as SupabaseClient, "p1", values);
    expect(checked).toMatchObject({ ok: true });
    expect(checked.ok && [...checked.values.keys()]).toEqual(["subject", "mood", "crown"]);
  });
});

describe("orders", () => {
  it("newest: released last first", async () => {
    expect(await ids("?sort=newest")).toEqual(["p2", "p1", "p3"]);
  });

  it("top: most liked first", async () => {
    expect(await ids("?sort=top")).toEqual(["p1", "p3", "p2"]);
  });

  it("trending, the default: likes per age, so a new prompt's like outweighs an old one's five", async () => {
    expect(await ids("?sort=trending")).toEqual(["p1", "p2", "p3"]);
    expect(await ids()).toEqual(["p1", "p2", "p3"]);
  });

  it("best_selling: most paid renders first, an unpaid render not counted", async () => {
    expect(await ids("?sort=best_selling")).toEqual(["p3", "p1", "p2"]);
  });

  it("best_selling without readable renders orders as top and leaves the counts out", async () => {
    failing.generations = { code: "XX000", message: "boom" };
    const l = await list("?sort=best_selling");
    expect(l.map((p) => p.promptId)).toEqual(["p1", "p3", "p2"]);
    expect(l[0]).not.toHaveProperty("renders");
  });

  const filler = (n: number, extra: Row) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, title: `Filler ${i}`, ...LIVE, ...HOT, creator_id: "u-otto", ...extra }));

  it("top and best_selling pick their candidates by likes: an old favourite is not crowded out by 100 newer prompts", async () => {
    tables.prompts = [...filler(100, { like_count: 3 }), { id: "old", title: "Old favourite", ...LIVE, ...HOT, like_count: 50, published_at: "2025-01-01T00:00:00Z" }];
    expect((await ids("?sort=top"))[0]).toBe("old");
    expect((await ids("?sort=best_selling"))[0]).toBe("old");
  });

  it("newest and trending pick their candidates by release: a new prompt is not crowded out by 100 older, more liked ones", async () => {
    tables.prompts = [...filler(100, { like_count: 50, published_at: "2026-01-01T00:00:00Z" }), { id: "new", title: "New", ...LIVE, ...HOT, like_count: 1, published_at: "2026-10-17T11:00:00Z" }];
    expect((await ids("?sort=newest"))[0]).toBe("new");
    expect((await ids("?sort=trending"))[0]).toBe("new");
  });
});

describe("the artist filter", () => {
  it("takes a handle, a display name or @handle, in any case", async () => {
    for (const creator of ["mara", "Mara%20Lin", "%40MARA"]) expect(await ids(`?creator=${creator}`)).toEqual(["p1", "p3"]);
    expect(rpcCalls.filter((c) => c.fn === "search_creators").every((c) => c.args.show_adult === false)).toBe(true);
  });

  it("matches exactly: a prefix or an unknown name lists nothing", async () => {
    expect(await ids("?creator=mar")).toEqual([]);
    expect(await ids("?creator=nobody")).toEqual([]);
  });

  it("narrows the search too", async () => {
    expect(await ids("?q=neon&creator=otto")).toEqual(["p2"]);
  });
});

describe("the query", () => {
  it("limit: 1 to 20, 10 by default", async () => {
    tables.prompts.push(...Array.from({ length: 25 }, (_, i) => ({ id: `x${i}`, title: `Extra ${i}`, ...LIVE, ...HOT, creator_id: "u-otto" })));
    expect(await list()).toHaveLength(10);
    expect(await list("?limit=2")).toHaveLength(2);
    expect(await list("?limit=20")).toHaveLength(20);
    expect(await list("?limit=1")).toHaveLength(1);
  });

  it("answers 400 to a bad parameter", async () => {
    for (const query of ["?limit=0", "?limit=21", "?limit=abc", "?limit=2.5", "?sort=popular", "?sort=", `?q=${"a".repeat(201)}`, `?creator=${"a".repeat(101)}`]) {
      const { status, body } = await call(query);
      expect(status, query).toBe(400);
      expect(typeof body.error).toBe("string");
    }
    expect((await call(`?q=${"a".repeat(200)}&creator=${"a".repeat(100)}`)).status).toBe(200);
  });

  it("answers 500, never prompts without their variables, when the variables cannot be read", async () => {
    failing.prompt_variables = { code: "XX000", message: "boom" };
    expect((await call()).status).toBe(500);
  });

  it("answers 503 when the database cannot be reached", async () => {
    failing.prompts = { code: "", message: "TypeError: fetch failed" };
    expect((await call()).status).toBe(503);
  });

  it("limits each address to 60 searches a minute", async () => {
    for (let i = 0; i < 60; i++) expect((await GET(req("", "10.200.0.1"))).status).toBe(200);
    expect((await GET(req("", "10.200.0.1"))).status).toBe(429);
    expect((await GET(req("", "10.200.0.2"))).status).toBe(200);
  });

  it("offers no video prompt, found by words or not: /api/x402/generate makes images", async () => {
    expect(await ids()).not.toContain("video");
    expect(await ids("?q=neon")).not.toContain("video");
    expect(await ids("?sort=top")).not.toContain("video");
    expect(await ids("?creator=mara")).not.toContain("video");
  });

  it("is public: an agent holds no team cookie", async () => {
    stubRequiredEnv();
    vi.stubEnv("TEAM_ACCESS_CODE", "team-code");
    const { proxy } = await import("../../proxy");
    expect(proxy(new NextRequest("http://enki.test/api/x402/prompts?q=neon")).headers.get("x-middleware-next")).toBe("1");
  });
});
