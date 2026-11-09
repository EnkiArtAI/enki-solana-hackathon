import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pglitePostgrest } from "./_pglite-postgrest";

/**
 * Explore's Community pick (Kev, 2026-10-30: "i want at one point to filter for a community and then see all images and
 * videos with it created"; agreed: a Community pick in Explore's filter area filters the feed to that community's
 * prompts): ?community=<handle> on GET /api/marketplace/prompts (an inner embed of SQL 54's community_links) and on
 * GET /api/search (each ranked page kept to the community's prompts), against SQL 54 in PGlite. A look-alike or merged
 * handle finds the live community; an unknown one, or SQL 54 not run yet, finds nothing, never the whole feed; without the
 * parameter both read as before.
 */
const pgs = vi.hoisted(() => ({ client: null as unknown }));
const who = vi.hoisted(() => ({ ME: "00000000-0000-4000-8000-000000000001", HER: "00000000-0000-4000-8000-000000000002" }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => pgs.client }));
vi.mock("@/lib/session-user", async (original) => ({
  ...(await original<typeof import("@/lib/session-user")>()),
  resolveSessionUserId: async (_s: unknown, t: string | null) => (t === "me" ? who.ME : null),
}));
// The cards' creators and variables are lib/marketplace/card.ts's own business: the listings as read.
vi.mock("@/lib/marketplace/card", async (original) => ({
  ...(await original<typeof import("@/lib/marketplace/card")>()),
  enrichPromptCards: async (_s: unknown, prompts: unknown[]) => prompts,
}));
const { ME, HER } = who;

import { GET as feed } from "../../app/api/marketplace/prompts/route";
import { GET as search } from "../../app/api/search/route";

const SQL54 = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-30-communities.sql"), "utf8");
const STUBS = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create table public.users (id uuid primary key, handle text, role text default 'user', deleted_at timestamptz, account_status text default 'active', adult_confirmed_at timestamptz);
  insert into public.users (id, handle) values ('${ME}', 'me'), ('${HER}', 'her');
  create table public.bans (id uuid primary key default gen_random_uuid(), user_id uuid, lifted_at timestamptz, expires_at timestamptz);
  create table public.prompts (id uuid primary key default gen_random_uuid(), creator_id uuid references public.users(id), title text,
    description text, public_prompt_text text, price_usd_cents int default 0, category text, tags text[], ai_model text,
    created_at timestamptz default now(), showcase_images jsonb default '[]', aspect_ratio text, resolution text,
    is_free_showcase boolean default false, prompt_type text default 'free', is_listed boolean default true, listing_status text default 'active',
    deleted_at timestamptz, is_adult boolean default false, like_count int default 0, published_at timestamptz default now());
  create table public.generations (id uuid primary key default gen_random_uuid(), prompt_id uuid references public.prompts(id), deleted_at timestamptz);
  create table public.generated_images (id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id),
    prompt_id uuid references public.prompts(id), mime_type text, storage_url text, preview_url text, thumbnail_url text, width int, height int,
    is_adult boolean default false, like_count int default 0, visibility text default 'public', is_uploaded boolean default false,
    deleted_at timestamptz, published_at timestamptz, created_at timestamptz not null default now());
  create table public.user_ignores (user_id uuid, ignored_id uuid, primary key (user_id, ignored_id));
  -- SQL 31's ranking, as far as the route reads it: listed prompts whose title holds q, newest first.
  create function public.search_prompts(q text, lim int, off int, show_adult boolean, models text[]) returns table (id uuid, rank real)
    language sql stable as $$ select p.id, 1::real from public.prompts p where p.is_listed and p.deleted_at is null and p.title ilike '%' || q || '%'
      and (show_adult or not p.is_adult) order by p.created_at desc, p.id limit lim offset off $$;
`;

let pg: PGlite;
let bare: PGlite;
let live: ReturnType<typeof pglitePostgrest>;
const sql = <R = Record<string, unknown>>(text: string, params: unknown[] = []) => pg.query<R>(text, params).then((r) => r.rows);
let address = 0;
const headers = (token: string | null) => ({ "x-real-ip": `10.4.${++address >> 8}.${address & 255}`, ...(token ? { "X-Session-Token": token } : {}) });
const feedOf = async (query = "", token: string | null = "me") => {
  const res = await feed(new NextRequest(`http://enki.test/api/marketplace/prompts?limit=12${query}`, { headers: headers(token) }));
  const body = await res.json();
  return [res.status, res.status === 200 ? (body.prompts as { title: string }[]).map((p) => p.title).sort() : body] as const;
};
const searchOf = async (query = "", token: string | null = "me") => {
  const res = await search(new NextRequest(`http://enki.test/api/search?q=p&type=prompts&limit=2${query}`, { headers: headers(token) }));
  const body = await res.json();
  return [res.status, res.status === 200 ? { titles: (body.prompts as { title: string }[]).map((p) => p.title), hasMore: body.hasMore } : body] as const;
};
// pN is N minutes old: search ranks newest first.
const prompt = async (title: string, creator = ME) =>
  (await sql<{ id: string }>(`insert into public.prompts (title, creator_id, created_at) values ($1, $2, now() - $3::int * interval '1 minute') returning id`, [title, creator, Number(title.replace(/\D/g, "") || 0)]))[0].id;
const community = async (handle: string) => (await sql<{ id: string }>(`insert into public.communities (handle, core, name) values ($1, $1, $1) returning id`, [handle]))[0].id;
const link = (c: string, p: string, by = ME, state = "shown") => sql(`insert into public.community_links (community_id, prompt_id, user_id, state) values ($1, $2, $3, $4)`, [c, p, by, state]);

beforeAll(async () => {
  [pg, bare] = await Promise.all([PGlite.create(), PGlite.create()]);
  await Promise.all([pg.exec(STUBS), bare.exec(STUBS)]);
  await pg.exec(SQL54);
  live = pglitePostgrest(pg);
}, 60_000);
afterAll(async () => { await Promise.all([pg.close(), bare.close()]); });
beforeEach(async () => {
  pgs.client = live.client;
  await sql(`truncate public.community_links, public.communities, public.prompts, public.user_ignores cascade`);
});

describe("the feed's Community pick", () => {
  it("narrows the feed to a community's shown prompts; a look-alike or merged handle finds it; the feed's other rules stay", async () => {
    const [p1, p2, p3, p4] = [await prompt("p1"), await prompt("p2", HER), await prompt("p3"), await prompt("p4", HER)];
    const gundam = await community("gundam");
    const pepe = await community("pepe");
    await link(gundam, p1);
    await link(gundam, p2, HER);
    await link(pepe, p2, HER);
    await link(gundam, p3, ME, "hidden");
    expect(await feedOf("&community=gundam")).toEqual([200, ["p1", "p2"]]);
    expect(await feedOf("&community=GUND4M")).toEqual([200, ["p1", "p2"]]);
    expect(await feedOf("&community=pepe")).toEqual([200, ["p2"]]);
    const old = await community("old_gundam");
    await sql(`select public.merge_community($1, $2)`, [old, gundam]);
    expect(await feedOf("&community=old_gundam")).toEqual([200, ["p1", "p2"]]);
    // 18+ and whom the viewer ignores stay out, as without the pick.
    await sql(`update public.prompts set is_adult = true where id = $1`, [p1]);
    await sql(`insert into public.user_ignores (user_id, ignored_id) values ($1, $2)`, [ME, HER]);
    expect(await feedOf("&community=gundam")).toEqual([200, []]);
    expect(await feedOf("&community=gundam", null)).toEqual([200, ["p2"]]);
    expect(p4).toBeTruthy();
  });

  it("finds nothing for an unknown handle, and before SQL 54 runs; without the pick it reads every listed prompt as before", async () => {
    // p1 is in a community, just not in one of that name.
    await link(await community("gundam"), await prompt("p1"));
    await prompt("p2", HER);
    expect(await feedOf("&community=nobody")).toEqual([200, []]);
    expect(await feedOf("&community=!!!")).toEqual([200, []]);
    expect(await feedOf("")).toEqual([200, ["p1", "p2"]]);
    // The query without the pick names no community table at all.
    live.state.statements.length = 0;
    await feedOf("");
    expect(live.state.statements.filter((s) => s.includes("FROM public.\"prompts\"")).every((s) => !s.includes("community"))).toBe(true);
    pgs.client = pglitePostgrest(bare).client;
    await bare.query(`insert into public.prompts (title, creator_id) values ('b1', $1)`, [ME]);
    expect(await feedOf("&community=gundam")).toEqual([200, []]);
    expect(await feedOf("")).toEqual([200, ["b1"]]);
  });
});

describe("search's Community pick", () => {
  it("keeps each ranked page to the community's prompts, the cursor moving on; an unknown handle finds nothing", async () => {
    const ids: string[] = [];
    for (const t of ["p1", "p2", "p3", "p4"]) ids.push(await prompt(t));
    const gundam = await community("gundam");
    await link(gundam, ids[0]);
    await link(gundam, ids[2]);
    await link(gundam, ids[3], ME, "hidden");
    // Ranked newest first two a page: p1 p2 | p3 p4.
    expect(await searchOf("")).toEqual([200, { titles: ["p1", "p2"], hasMore: true }]);
    expect(await searchOf("&community=gundam")).toEqual([200, { titles: ["p1"], hasMore: true }]);
    expect(await searchOf("&community=gundam&cursor=2")).toEqual([200, { titles: ["p3"], hasMore: false }]);
    expect(await searchOf("&community=gund4m")).toEqual([200, { titles: ["p1"], hasMore: true }]);
    expect(await searchOf("&community=nobody")).toEqual([200, { titles: [], hasMore: false }]);
    pgs.client = pglitePostgrest(bare).client;
    await bare.query(`insert into public.prompts (title, creator_id) values ('p9', $1)`, [ME]);
    expect(await searchOf("&community=gundam")).toEqual([200, { titles: [], hasMore: false }]);
    expect(await searchOf("")).toEqual([200, { titles: ["p9"], hasMore: false }]);
  });
});
