import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pglitePostgrest } from "./_pglite-postgrest";
import { toFeedCard } from "@/lib/ui/feed/card";

/**
 * ?media=images|videos on GET /api/marketplace/prompts and GET /api/search (Kev, 2026-11-03: "roll dann videos bei explore
 * aus"), the real routes and the real cards on PGlite, on the live prompts columns before and after SQL 52: before it All
 * and Images read as they always did and Videos says which file to run; after it each world holds its medium and All both.
 * Blind spot: PGlite's stand-in is not PostgREST (no schema cache); its 42703 on a missing column is what the live table
 * answers (`prompts.media_type read 400 42703`, read 2026-11-03).
 */
const pgs = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => pgs.client }));

import { GET as feed } from "../../app/api/marketplace/prompts/route";
import { GET as search } from "../../app/api/search/route";

const SQL52 = readFileSync(join(__dirname, "..", "..", "migrations", "2026-11-03-video-prompts.sql"), "utf8");
const ME = "00000000-0000-4000-8000-000000000001";
const STUBS = `
  create table public.users (id uuid primary key, handle text, display_name text, avatar_url text, role text default 'user', deleted_at timestamptz, account_status text default 'active', adult_confirmed_at timestamptz);
  insert into public.users (id, handle, display_name) values ('${ME}', 'mira', 'Mira');
  create table public.bans (id uuid primary key default gen_random_uuid(), user_id uuid, lifted_at timestamptz, expires_at timestamptz);
  create table public.prompts (id uuid primary key default gen_random_uuid(), creator_id uuid references public.users(id), title text,
    description text, public_prompt_text text, price_usd_cents int default 0, category text, tags text[], ai_model text,
    created_at timestamptz default now(), showcase_images jsonb default '[]', aspect_ratio text, resolution text,
    is_free_showcase boolean default false, prompt_type text default 'free', is_listed boolean default true, listing_status text default 'active',
    deleted_at timestamptz, is_adult boolean default false, like_count int default 0, opens bigint default 0);
  create table public.prompt_variables (prompt_id uuid, name text, label text, description text, data_type text, default_value text, is_required boolean, position int, deleted_at timestamptz);
  create table public.generations (id uuid primary key default gen_random_uuid(), prompt_id uuid, user_id uuid, deleted_at timestamptz);
  create table public.generated_images (id uuid primary key default gen_random_uuid(), storage_url text, preview_url text, thumbnail_url text, view_url text, tiny_url text, deleted_at timestamptz);
  create table public.user_ignores (user_id uuid, ignored_id uuid, primary key (user_id, ignored_id));
  create function public.search_prompts(q text, lim int, off int, show_adult boolean, models text[]) returns table (id uuid, rank real)
    language sql stable as $$ select p.id, 1::real from public.prompts p where p.is_listed and p.deleted_at is null and p.title ilike '%' || q || '%'
      order by p.created_at desc, p.id limit lim offset off $$;
  create function public.search_creators(q text, lim int, show_adult boolean) returns setof public.users language sql stable as $$ select * from public.users where handle ilike '%' || q || '%' limit lim $$;
`;
const IMAGES = `insert into public.prompts (title, creator_id, showcase_images, aspect_ratio, created_at) values
  ('p image one', '${ME}', '["https://a/1.png"]', '1:1', now() - interval '1 minute'), ('p image two', '${ME}', '["https://a/2.png"]', '1:1', now() - interval '3 minutes');`;
const FILES = { preview: "https://v/preview.mp4", v720: "https://v/v720.mp4", v1080: null, poster: "https://v/poster.webp", width: 480, height: 854, durationMs: 6000 };
const VIDEO = `insert into public.prompts (title, creator_id, media_type, showcase_images, showcase_video, aspect_ratio, created_at) values
  ('p video', '${ME}', 'video', '["https://v/poster.webp"]', '${JSON.stringify(FILES)}', 'auto', now() - interval '2 minutes');`;

let before: PGlite, after: PGlite;
let [beforeClient, afterClient]: unknown[] = [];
// A minute past whatever lib/marketplace/video-columns.ts kept: each test's database is read anew.
let now = 1_800_000_000_000;
let address = 0;
const headers = () => ({ "x-real-ip": `10.9.${++address >> 8}.${address & 255}` });
type Body = { prompts: { title: string; isVideo?: boolean; video?: unknown }[]; hasMore: boolean; run?: string; total?: number; creators?: unknown[]; query?: string };
const feedOf = async (query = "") => (await feed(new NextRequest(`http://enki.test/api/marketplace/prompts?limit=12${query}`, { headers: headers() }))).json() as Promise<Body>;
const searchOf = async (query = "") => (await search(new NextRequest(`http://enki.test/api/search?q=p&type=prompts&limit=10${query}`, { headers: headers() }))).json() as Promise<Body>;
const titles = (b: Body) => b.prompts.map((p) => p.title);

beforeAll(async () => {
  [before, after] = await Promise.all([PGlite.create(), PGlite.create()]);
  await Promise.all([before.exec(STUBS + IMAGES), after.exec(STUBS + IMAGES)]);
  await after.exec(SQL52 + VIDEO);
  [beforeClient, afterClient] = [pglitePostgrest(before).client, pglitePostgrest(after).client];
}, 60_000);
afterAll(async () => { await Promise.all([before.close(), after.close()]); });
beforeEach(() => { now += 61_000; vi.spyOn(Date, "now").mockReturnValue(now); });
afterEach(() => vi.restoreAllMocks());

describe("before SQL 52", () => {
  beforeEach(() => { pgs.client = beforeClient; });

  it("All and Images are the feed as it was", async () => {
    for (const query of ["", "&media=images", "&media=nope"]) {
      const body = await feedOf(query);
      expect(titles(body)).toEqual(["p image one", "p image two"]);
      expect(body.prompts[0]).toMatchObject({ isVideo: false, video: null });
      expect(body.run).toBeUndefined();
    }
    expect(titles(await searchOf())).toEqual(["p image one", "p image two"]);
    expect(titles(await searchOf("&media=images"))).toEqual(["p image one", "p image two"]);
  });

  it("Videos answers empty and names the file to run, on the feed and in search", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await feedOf("&media=videos")).toEqual({ total: 0, prompts: [], hasMore: false, run: "52-video-prompts.sql" });
    expect(await searchOf("&media=videos")).toEqual({ query: "p", creators: [], prompts: [], hasMore: false, run: "52-video-prompts.sql" });
    expect(said).toHaveBeenCalledWith("[videos] prompts.media_type is missing: run sql-to-run/52-video-prompts.sql");
    expect(said).toHaveBeenCalledTimes(2);
  });
});

describe("after SQL 52", () => {
  beforeEach(() => { pgs.client = afterClient; });

  it("All mixes both in the feed's order, each world holds its medium, an unknown one reads as All", async () => {
    expect(titles(await feedOf())).toEqual(["p image one", "p video", "p image two"]);
    expect(titles(await feedOf("&media=nope"))).toEqual(["p image one", "p video", "p image two"]);
    expect(titles(await feedOf("&media=images"))).toEqual(["p image one", "p image two"]);
    expect(titles(await feedOf("&media=videos"))).toEqual(["p video"]);
  });

  it("search keeps its rank order and narrows to the world after it", async () => {
    expect(titles(await searchOf())).toEqual(["p image one", "p video", "p image two"]);
    expect(titles(await searchOf("&media=images"))).toEqual(["p image one", "p image two"]);
    expect(titles(await searchOf("&media=videos"))).toEqual(["p video"]);
  });

  it("a card says what it is and carries the files, and the feed's card reads them", async () => {
    for (const body of [await feedOf(), await searchOf()]) {
      const [image, video] = body.prompts;
      expect(image).toMatchObject({ title: "p image one", isVideo: false, video: null });
      expect(video).toMatchObject({ title: "p video", isVideo: true, video: FILES });
      const card = toFeedCard(video)!;
      expect(card.video).toEqual(FILES);
      // The poster is the picture every old surface shows; 480 x 854 is the box, though the prompt says "auto".
      expect(card.images[0].url).toBe("https://v/poster.webp");
      expect(card.ratio).toBeCloseTo(480 / 854);
      expect(toFeedCard(image)!.video).toBeNull();
    }
  });

  it("a creator's shelf is served too, with its numbers and both media", async () => {
    const body = await feedOf(`&creator=${ME}&stats=1`);
    expect(titles(body)).toEqual(["p image one", "p video", "p image two"]);
    expect(body.prompts[1]).toMatchObject({ isVideo: true, video: FILES });
  });
});
