import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { handleKey, slugify } from "@/lib/communities/handle";
import {
  COMMUNITY_TEXT, HANDLE_MAX, HANDLE_MIN, LISTED_MIN_MEMBERS, LISTED_MIN_WORKS, MAX_ALIASES, MAX_COMMUNITIES_PER_WORK,
  MAX_NEW_COMMUNITIES, MAX_NEW_COMMUNITIES_PER_DAY, MAX_POSTS_PER_DAY, TRENDING_DAYS,
} from "@/lib/communities/types";

/**
 * migrations/2026-10-30-communities.sql (SQL 54; Kev, 2026-10-30: "propose me something, that cant be duplicated and
 * will work as a harbour AND gallery ..."; "max 18 communities pro werk"; the shape agreed with "ja lass mal probieren und
 * iterieren") in a real Postgres, on Supabase's roles and default privileges and the live columns it reads (VERIFIED
 * 2026-10-30): one handle per key, merged rows included; the caps of lib/communities/types.ts; a link and a post are their
 * item's owner's; a community's works read their prompts' renders in and leave private, deleted, uploaded, hidden-owner,
 * opted-out and hidden ones out; cards count, list and pick their cover by the agreed order; the Showroom's views; the
 * suggestion lookup; an admin's merge; only the service role reaches any of it; the read-back and rollback at its end work.
 */
const FILE = join(__dirname, "..", "..", "migrations", "2026-10-30-communities.sql");
const SQL = readFileSync(FILE, "utf8");
const lines = (from: string, to?: string) => SQL.slice(SQL.indexOf(from), to ? SQL.indexOf(to) : undefined)
  .split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5));
const READ_BACK = lines("-- Read back", "-- Rollback");
const ROLLBACK = lines("-- Rollback").join("\n");
const TABLES = ["communities", "community_aliases", "community_members", "showroom_posts", "community_links"];
const VIEWS = ["community_reach", "community_works", "community_cards", "showroom_entries", "community_posts"];
// Kev's copy for the SQL editor, outside the repo: compared where it exists (his checkout), skipped elsewhere (CI).
const COPY = join(__dirname, "..", "..", "..", "sql-to-run", "54-communities.sql");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, MOD, BANNED, GONE] = [1, 2, 3, 4, 5].map(id);

describe("the Communities migration", () => {
  let db: PGlite;
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params).then((r) => r.rows);
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
  const community = async (handle: string, by: string | null = null, name = `${handle} name`) =>
    (await one<{ id: string }>(`insert into public.communities (handle, core, name, created_by) values ($1, $1, $2, $3) returning id`, [handle, name, by])).id;
  const count = async (table: string, where = "true", params: unknown[] = []) => (await one<{ n: number }>(`select count(*)::int as n from public.${table} where ${where}`, params)).n;
  let n = 1000;
  const prompt = async (creator: string, extra: Record<string, unknown> = {}) => {
    const p = { id: id(++n), creator_id: creator, is_listed: true, listing_status: "active", deleted_at: null, is_adult: false, like_count: 0, published_at: new Date().toISOString(), showcase_images: [`https://cdn.test/p${n}.webp`], ...extra };
    await q(`insert into public.prompts (id, creator_id, is_listed, listing_status, deleted_at, is_adult, like_count, published_at, showcase_images) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [p.id, p.creator_id, p.is_listed, p.listing_status, p.deleted_at, p.is_adult, p.like_count, p.published_at, JSON.stringify(p.showcase_images)]);
    return p.id;
  };
  const render = async (owner: string, promptId: string, extra: Record<string, unknown> = {}) => {
    const r = { id: id(++n), visibility: "public", is_uploaded: false, deleted_at: null, is_adult: false, like_count: 0, published_at: new Date().toISOString(), mime_type: "image/png", ...extra };
    await q(`insert into public.generated_images (id, user_id, prompt_id, storage_url, preview_url, visibility, is_uploaded, deleted_at, is_adult, like_count, published_at, mime_type) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [r.id, owner, promptId, `https://cdn.test/${r.id}.png`, `https://cdn.test/${r.id}.webp`, r.visibility, r.is_uploaded, r.deleted_at, r.is_adult, r.like_count, r.published_at, r.mime_type]);
    return r.id;
  };
  const link = (c: string, kind: "prompt_id" | "image_id" | "post_id", item: string, by: string, state = "shown") =>
    q(`insert into public.community_links (community_id, ${kind}, user_id, state) values ($1, $2, $3, $4)`, [c, item, by, state]);
  const works = async (c: string) => (await q<{ image_id: string }>(`select image_id from public.community_works where community_id = $1 order by image_id`, [c])).map((r) => r.image_id);
  const card = (c: string) => one(`select members, works, works_7d, listed, cover_url from public.community_cards where id = $1`, [c]);
  // Whether a write's transaction holds the advisory lock of this key (pg_locks; rolled back after). That a second session
  // waits on it is Postgres's own advisory-lock rule: PGlite is one session, so that part is INFERRED, not run.
  const holdsLock = (write: string, params: unknown[], key: string) => db.transaction(async (tx) => {
    await tx.query(write, params);
    const { rows } = await tx.query<{ n: number }>(`select count(*)::int as n from pg_locks where locktype = 'advisory' and objsubid = 1
      and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`, [key]);
    await tx.rollback();
    return rows[0].n;
  });
  const users = async (k: number) => (await q<{ id: string }>(`insert into public.users (id) select gen_random_uuid() from generate_series(1, $1::int) returning id`, [k])).map((r) => r.id);

  beforeAll(async () => {
    db = await PGlite.create();
    // Supabase's roles and default grants, and the live tables SQL 54 reads, with the columns it needs (VERIFIED live
    // 2026-10-30, migration header).
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
      create table public.users (id uuid primary key, deleted_at timestamptz, account_status text default 'active');
      insert into public.users (id) values ('${A}'), ('${B}'), ('${MOD}'), ('${BANNED}'), ('${GONE}');
      update public.users set deleted_at = now() where id = '${GONE}';
      create table public.bans (id uuid primary key default gen_random_uuid(), user_id uuid, lifted_at timestamptz, expires_at timestamptz);
      insert into public.bans (user_id) values ('${BANNED}');
      create table public.prompts (id uuid primary key, creator_id uuid references public.users(id), is_listed boolean, listing_status text,
        deleted_at timestamptz, is_adult boolean default false, like_count int default 0, published_at timestamptz, showcase_images jsonb default '[]');
      create table public.generations (id uuid primary key default gen_random_uuid(), prompt_id uuid references public.prompts(id), deleted_at timestamptz);
      create table public.generated_images (id uuid primary key, user_id uuid references public.users(id), prompt_id uuid references public.prompts(id),
        mime_type text, storage_url text, preview_url text, thumbnail_url text, width int, height int, is_adult boolean default false,
        like_count int default 0, visibility text default 'private', is_uploaded boolean default false, deleted_at timestamptz,
        published_at timestamptz, created_at timestamptz not null default now());
    `);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("runs twice without harm, keeping the rows there are", async () => {
    const c = await community("kept", A);
    await db.exec(SQL);
    expect(await q(`select handle from public.communities where id = $1`, [c])).toEqual([{ handle: "kept" }]);
    await q(`delete from public.communities where id = $1`, [c]);
  });

  it("keys a handle exactly as lib/communities/handle.ts handleKey does", async () => {
    const samples = [
      "gundam", "gund4m", "gundam_wing", "rnrn", "vvv", "rn_vv", "b0ss", "2b", "l33t_57", "g6_8_9", "a1b3c4d5e7f0", "x",
      "apu_apustaja", "pepe_the_frog", "the_pepe_club", "w4gm1", "corn", "barn_vvall", "m0rn1ng", "0_1_3", "abc_123_xyz",
      slugify("__a__"), slugify("Gundam Wing!"), slugify("Pеpe"), "a".repeat(HANDLE_MAX), `${"r".repeat(15)}${"n".repeat(15)}`,
      `${"v".repeat(HANDLE_MAX)}`, "7777777", "s3v3n", "zz_top", "v2", "ii",
    ];
    expect(samples.length).toBeGreaterThanOrEqual(30);
    for (const s of samples) expect((await one<{ k: string }>(`select public.community_key($1) as k`, [s])).k, s).toBe(handleKey(s));
  });

  it("holds one community per key, merged rows included; a handle is 2-30 letters or digits with single underscores", async () => {
    const g = await community("gundam", A);
    expect(await one(`select handle_key from public.communities where id = $1`, [g])).toEqual({ handle_key: "gundam" });
    for (const look of ["gund4m", "gundarn", "gun_dam"]) await expect(community(look, B), look).rejects.toMatchObject({ code: "23505" });
    for (const bad of ["Gundam", "gundam_", "_gundam", "gun__dam", "gun-dam", "a", "a".repeat(HANDLE_MAX + 1), "gün"]) {
      await expect(community(bad, B), bad).rejects.toMatchObject({ code: "23514" });
    }
    await expect(community("a".repeat(HANDLE_MAX), B)).resolves.toBeTruthy();
    await expect(community("z".repeat(HANDLE_MIN), B)).resolves.toBeTruthy();
    // A merged row's handle stays taken.
    const fans = await community("gundam_fans", B);
    await q(`select public.merge_community($1, $2)`, [fans, g]);
    await expect(community("gundam_fan5", A)).rejects.toMatchObject({ code: "23505" });
    await q(`delete from public.communities where created_by = $1 or id = $2`, [B, g]);
  });

  it("holds every text field to lib/communities/types.ts's lengths", async () => {
    const make = (name: string, description: string | null = null) =>
      q(`insert into public.communities (handle, core, name, description) values ('lens', 'lens', $1, $2)`, [name, description]);
    for (const bad of [" x ", "x".repeat(COMMUNITY_TEXT.name + 1)]) await expect(make(bad), bad).rejects.toMatchObject({ code: "23514" });
    await expect(make("ok", "d".repeat(COMMUNITY_TEXT.description + 1))).rejects.toMatchObject({ code: "23514" });
    await make(` ${"n".repeat(COMMUNITY_TEXT.name)} `, "d".repeat(COMMUNITY_TEXT.description));
    const c = (await one<{ id: string }>(`select id from public.communities where handle = 'lens'`)).id;
    const alias = (a: string) => q(`insert into public.community_aliases (community_id, alias) values ($1, $2)`, [c, a]);
    for (const bad of ["a", "Big", "a_", "a".repeat(COMMUNITY_TEXT.alias + 1)]) await expect(alias(bad), bad).rejects.toMatchObject({ code: "23514" });
    await alias("a".repeat(COMMUNITY_TEXT.alias));
    // One search word per key and community.
    await alias("bitcoin");
    await expect(alias("bitc0in")).rejects.toMatchObject({ code: "23505" });
    expect(await one(`select alias_key from public.community_aliases where alias = 'bitcoin'`)).toEqual({ alias_key: "bitcoin" });
    const r = await render(A, await prompt(A));
    const post = (title: string, caption: string | null = null) =>
      q(`insert into public.showroom_posts (user_id, image_id, title, caption) values ($1, $2, $3, $4)`, [A, r, title, caption]);
    for (const bad of ["  ", "t".repeat(COMMUNITY_TEXT.title + 1)]) await expect(post(bad), bad.slice(0, 5)).rejects.toMatchObject({ code: "23514" });
    await expect(post("t", "c".repeat(COMMUNITY_TEXT.caption + 1))).rejects.toMatchObject({ code: "23514" });
    await post(` ${"t".repeat(COMMUNITY_TEXT.title)} `, "c".repeat(COMMUNITY_TEXT.caption));
    await q(`delete from public.communities where id = $1`, [c]);
    await q(`delete from public.showroom_posts`);
  });

  it("holds every cap of lib/communities/types.ts, by the count and window it names, and says which in its message", async () => {
    const caps = [...SQL.matchAll(/CREATE TRIGGER (\w+) BEFORE INSERT ON public\.(\w+) FOR EACH ROW EXECUTE FUNCTION public\.community_cap\('(\w+)', '(\d+)'(?:, '([^']+)')?\);/g)]
      .map(([, name, table, column, cap, window]) => [name, table, column, Number(cap), window ?? null]);
    expect(caps).toEqual([
      ["communities_cap_day", "communities", "created_by", MAX_NEW_COMMUNITIES_PER_DAY, "1 day"],
      ["communities_cap_all", "communities", "created_by", MAX_NEW_COMMUNITIES, null],
      ["community_aliases_cap", "community_aliases", "community_id", MAX_ALIASES, null],
      ["showroom_posts_cap_day", "showroom_posts", "user_id", MAX_POSTS_PER_DAY, "1 day"],
    ]);
    expect(SQL).toContain(`IF n >= ${MAX_COMMUNITIES_PER_WORK} THEN`);
    const full = (message: string) => ({ code: "23514", message });
    // New communities: 3 a day, then a day later 3 more, up to 30 in all; another account starts from none.
    const [C1] = await users(1);
    const make = (i: number) => community(`cap_${i}`, C1);
    let i = 0;
    for (; i < MAX_NEW_COMMUNITIES_PER_DAY; i++) await make(i);
    await expect(make(i)).rejects.toMatchObject(full("community cap communities created_by 1 day"));
    await q(`update public.communities set created_at = now() - interval '25 hours' where created_by = $1`, [C1]);
    await make(i++);
    await q(`insert into public.communities (handle, core, name, created_by, created_at) select 'old_' || k, 'old', 'Old', $1, now() - interval '2 days' from generate_series(1, $2::int) k`,
      [C1, MAX_NEW_COMMUNITIES - i]);
    expect(await count("communities", "created_by = $1", [C1])).toBe(MAX_NEW_COMMUNITIES);
    await expect(make(99)).rejects.toMatchObject(full("community cap communities created_by all"));
    await expect(community("someone_else", B)).resolves.toBeTruthy();
    // Without an owner (its account gone) nothing is counted.
    await expect(community("ownerless")).resolves.toBeTruthy();
    // Search words: 10 a community.
    const c = await community("words", B);
    await q(`insert into public.community_aliases (community_id, alias) select $1, 'w' || k from generate_series(1, $2::int) k`, [c, MAX_ALIASES]);
    await expect(q(`insert into public.community_aliases (community_id, alias) values ($1, 'more')`, [c])).rejects.toMatchObject(full("community cap community_aliases community_id all"));
    // Posts: 20 a day, then a day later more.
    const p = await prompt(B);
    const rs = await Promise.all(Array.from({ length: MAX_POSTS_PER_DAY + 1 }, () => render(B, p)));
    for (let k = 0; k < MAX_POSTS_PER_DAY; k++) await q(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 't')`, [B, rs[k]]);
    const post = () => q(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 't')`, [B, rs[MAX_POSTS_PER_DAY]]);
    await expect(post()).rejects.toMatchObject(full("community cap showroom_posts user_id 1 day"));
    await q(`update public.showroom_posts set created_at = now() - interval '25 hours' where user_id = $1`, [B]);
    await post();
    // One write at a time per owner: the owner's lock is held by the writing transaction, taken before it counts.
    expect(await holdsLock(`insert into public.communities (handle, core, name, created_by) values ('locked', 'locked', 'Locked', $1)`, [B], `communities:created_by:${B}`)).toBe(1);
    expect(await holdsLock(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 't')`, [B, await render(B, p)], `showroom_posts:user_id:${B}`)).toBe(1);
    expect(SQL).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\(TG_TABLE_NAME \|\| ':' \|\| TG_ARGV\[0\] \|\| ':' \|\| owner::text, 0\)\);\n\s+EXECUTE format\('SELECT count\(\*\)/);
    await q(`delete from public.communities`);
    await q(`delete from public.showroom_posts`);
  }, 60_000);

  it(`shows an item in up to ${MAX_COMMUNITIES_PER_WORK} communities through its own links; opted-out and hidden rows do not count`, async () => {
    const cs = (await q<{ id: string }>(`insert into public.communities (handle, core, name) select 'many_' || k, 'many', 'Many' from generate_series(1, $1::int) k returning id`,
      [MAX_COMMUNITIES_PER_WORK + 2])).map((r) => r.id);
    const p = await prompt(A);
    const r = await render(A, p);
    const post = (await one<{ id: string }>(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 't') returning id`, [A, r])).id;
    for (const [kind, item] of [["prompt_id", p], ["image_id", r], ["post_id", post]] as const) {
      for (let k = 0; k < MAX_COMMUNITIES_PER_WORK; k++) await link(cs[k], kind, item, A);
      await expect(link(cs[MAX_COMMUNITIES_PER_WORK], kind, item, A), kind).rejects.toMatchObject({ code: "23514", message: `community cap community_links ${kind}` });
    }
    // A hidden row and an opted-out one are no place it shows; a shown one taken out frees its place.
    await link(cs[MAX_COMMUNITIES_PER_WORK], "image_id", r, MOD, "hidden");
    await q(`update public.community_links set state = 'opted_out' where community_id = $1 and image_id = $2`, [cs[0], r]);
    await link(cs[MAX_COMMUNITIES_PER_WORK + 1], "image_id", r, A);
    // Setting one shown again is counted as a new one.
    await expect(q(`update public.community_links set state = 'shown' where community_id = $1 and image_id = $2`, [cs[0], r]))
      .rejects.toMatchObject({ code: "23514", message: "community cap community_links image_id" });
    // Counted one write at a time per item: a shown link's transaction holds the item's lock (a hidden one counts nothing).
    const fresh = await prompt(A);
    expect(await holdsLock(`insert into public.community_links (community_id, prompt_id, user_id) values ($1, $2, $3)`, [cs[0], fresh, A], `community_links:${fresh}`)).toBe(1);
    expect(await holdsLock(`insert into public.community_links (community_id, prompt_id, user_id, state) values ($1, $2, $3, 'hidden')`, [cs[0], fresh, MOD], `community_links:${fresh}`)).toBe(0);
    // A merge locks both rows before it reads them (two admins merging a into b and b into a at once): spelled only, the
    // same one-session limit (INFERRED).
    expect(SQL).toContain("PERFORM 1 FROM communities WHERE id IN (p_from, p_into) ORDER BY id FOR UPDATE;\n  IF (SELECT count(*) FROM communities WHERE id IN (p_from, p_into) AND merged_into IS NULL) <> 2 THEN");
    await q(`delete from public.communities`);
    await q(`delete from public.showroom_posts`);
  });

  it(`keeps a render in the first ${MAX_COMMUNITIES_PER_WORK} communities it reached, its prompt's and its post's included`, async () => {
    const cs = (await q<{ id: string }>(`insert into public.communities (handle, core, name) select 'reach_' || k, 'reach' || k, 'Reach' from generate_series(1, $1::int) k returning id`,
      [MAX_COMMUNITIES_PER_WORK + 4])).map((r) => r.id);
    const P = await prompt(B);
    const r = await render(A, P);
    const placed = async (img: string) => (await q<{ c: string }>(`select community_id as c from public.community_works where image_id = $1`, [img])).map((x) => x.c).sort();
    // Its own 18, a day ago; its prompt linked to 3 more later: still the first 18.
    for (let k = 0; k < MAX_COMMUNITIES_PER_WORK; k++) {
      await q(`insert into public.community_links (community_id, image_id, user_id, created_at) values ($1, $2, $3, now() - interval '1 day' + $4 * interval '1 second')`, [cs[k], r, A, k]);
    }
    // A second apart: PGlite's now() has whole milliseconds, so plain links can tie, and a tie goes to the lower random id.
    for (const [k, c] of cs.slice(MAX_COMMUNITIES_PER_WORK, MAX_COMMUNITIES_PER_WORK + 3).entries()) {
      await q(`insert into public.community_links (community_id, prompt_id, user_id, created_at) values ($1, $2, $3, now() - interval '1 hour' + $4 * interval '1 second')`, [c, P, B, k]);
    }
    expect(await placed(r)).toEqual(cs.slice(0, MAX_COMMUNITIES_PER_WORK).sort());
    // A post of it in one more: still 18.
    const post = (await one<{ id: string }>(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 't') returning id`, [A, r])).id;
    await link(cs[MAX_COMMUNITIES_PER_WORK + 3], "post_id", post, A);
    expect(await placed(r)).toHaveLength(MAX_COMMUNITIES_PER_WORK);
    // A moderator takes it out of its first: the first that waited (its prompt's earliest) comes in; every way stays read.
    await q(`update public.community_links set state = 'hidden' where community_id = $1 and image_id = $2`, [cs[0], r]);
    expect(await placed(r)).toEqual(cs.slice(1, MAX_COMMUNITIES_PER_WORK + 1).sort());
    expect(await q(`select via, count(*)::int as n from public.community_reach where image_id = $1 group by via order by via`, [r]))
      .toEqual([{ via: "link", n: MAX_COMMUNITIES_PER_WORK - 1 }, { via: "post", n: 1 }, { via: "prompt", n: 3 }]);
    // Another render of the prompt, with no links of its own, is in all 3 of its prompt's.
    const r2 = await render(A, P);
    expect(await placed(r2)).toEqual(cs.slice(MAX_COMMUNITIES_PER_WORK, MAX_COMMUNITIES_PER_WORK + 3).sort());
    expect((await card(cs[MAX_COMMUNITIES_PER_WORK + 1])).works).toBe(1);
    await q(`delete from public.communities`);
    await q(`delete from public.showroom_posts`);
  });

  it(`takes the ${MAX_COMMUNITIES_PER_WORK} lowest ids when every link has the same time`, async () => {
    const cs = (await q<{ id: string }>(`insert into public.communities (handle, core, name) select 'tie_' || k, 'tie' || k, 'Tie' from generate_series(1, $1::int) k returning id`,
      [MAX_COMMUNITIES_PER_WORK + 2])).map((r) => r.id).sort();
    const P = await prompt(B);
    const r = await render(A, P);
    // A render takes 18 links of its own, so the other two, and the lowest ids, come through its prompt.
    const tied = (c: string, col: string, item: string, by: string) => q(`insert into public.community_links (community_id, ${col}, user_id, created_at) values ($1, $2, $3, '2026-01-01T00:00:00Z')`, [c, item, by]);
    for (const c of cs.slice(0, 2)) await tied(c, "prompt_id", P, B);
    for (const c of cs.slice(2)) await tied(c, "image_id", r, A);
    expect((await q<{ c: string }>(`select community_id as c from public.community_works where image_id = $1 order by c`, [r])).map((x) => x.c))
      .toEqual(cs.slice(0, MAX_COMMUNITIES_PER_WORK));
    await q(`delete from public.communities`);
  });

  it("takes a link only from its item's owner (a moderator's hidden row aside), a post only of its poster's own render, never an upload", async () => {
    const c = await community("owners", A);
    const p = await prompt(A);
    const r = await render(A, p);
    const upload = await render(A, p, { is_uploaded: true });
    const post = (await one<{ id: string }>(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 't') returning id`, [A, r])).id;
    const notOwner = { code: "23514", message: "community link not owner" };
    await expect(link(c, "prompt_id", p, B)).rejects.toMatchObject(notOwner);
    await expect(link(c, "image_id", r, B)).rejects.toMatchObject(notOwner);
    await expect(link(c, "post_id", post, B)).rejects.toMatchObject(notOwner);
    await expect(link(c, "image_id", upload, A)).rejects.toMatchObject(notOwner);
    await expect(link(c, "image_id", r, B, "opted_out")).rejects.toMatchObject(notOwner);
    await link(c, "image_id", r, MOD, "hidden");
    // Setting someone else's row shown is refused as well (an update of state is checked like an insert).
    await expect(q(`update public.community_links set state = 'shown' where image_id = $1`, [r])).rejects.toMatchObject(notOwner);
    const ownRender = { code: "23514", message: "showroom post not own render" };
    await expect(q(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 't')`, [B, await render(A, p)])).rejects.toMatchObject(ownRender);
    await expect(q(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 't')`, [A, upload])).rejects.toMatchObject(ownRender);
    // Opting out is for renders; one item per row; one row per community and item.
    await expect(link(c, "prompt_id", p, A, "opted_out")).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("community_links_opt_out_renders") });
    await expect(link(c, "post_id", post, A, "opted_out")).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("community_links_opt_out_renders") });
    await expect(q(`insert into public.community_links (community_id, prompt_id, image_id, user_id) values ($1, $2, $3, $4)`, [c, p, r, A])).rejects.toMatchObject({ code: "23514" });
    await expect(q(`insert into public.community_links (community_id, user_id) values ($1, $2)`, [c, A])).rejects.toMatchObject({ code: "23514" });
    await link(c, "prompt_id", p, A);
    await expect(link(c, "prompt_id", p, A)).rejects.toMatchObject({ code: "23505" });
    await expect(link(c, "image_id", r, A)).rejects.toMatchObject({ code: "23505" });
    await q(`delete from public.communities where id = $1`, [c]);
    await q(`delete from public.showroom_posts`);
  });

  it("holds one post per render; an answer outlives the post it answers as a post of its own; a post never answers itself", async () => {
    const p = await prompt(A);
    const [r1, r2] = [await render(A, p), await render(B, p)];
    const first = (await one<{ id: string }>(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 'First') returning id`, [A, r1])).id;
    await expect(q(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 'Again')`, [A, r1])).rejects.toMatchObject({ code: "23505" });
    const answer = (await one<{ id: string }>(`insert into public.showroom_posts (user_id, image_id, title, parent_id) values ($1, $2, 'Mine', $3) returning id`, [B, r2, first])).id;
    await expect(q(`update public.showroom_posts set parent_id = id where id = $1`, [answer])).rejects.toMatchObject({ code: "23514" });
    await q(`delete from public.showroom_posts where id = $1`, [first]);
    expect(await q(`select parent_id from public.showroom_posts where id = $1`, [answer])).toEqual([{ parent_id: null }]);
    // A render deleted for good takes its post.
    await q(`delete from public.generated_images where id = $1`, [r2]);
    expect(await count("showroom_posts")).toBe(0);
  });

  it("reads a community's works: its listed prompts' public renders in, every other kind out, each render once, dated when it came in", async () => {
    const c = await community("works", A);
    const P = await prompt(A);
    const draft = await prompt(A, { is_listed: false, listing_status: "draft" });
    const ofBanned = await prompt(BANNED);
    const R1 = await render(A, P);
    const R3 = await render(B, P);
    const out = [
      await render(A, P, { visibility: "private" }),
      await render(B, P, { deleted_at: new Date().toISOString() }),
      await render(A, P, { is_uploaded: true }),
      await render(BANNED, P),
      await render(GONE, P),
      await render(A, draft),
      await render(B, ofBanned),
    ];
    for (const prompt of [P, draft]) await link(c, "prompt_id", prompt, A);
    await link(c, "prompt_id", ofBanned, BANNED);
    expect(await works(c)).toEqual([R1, R3].sort());
    // Linked directly: in, the draft's render too; a private one linked directly stays out.
    const R7 = await render(A, draft);
    await link(c, "image_id", R7, A);
    await link(c, "image_id", out[0], A);
    expect(await works(c)).toEqual([R1, R3, R7].sort());
    // Its owner opts a render out; a moderator hides one.
    await link(c, "image_id", R3, B, "opted_out");
    await q(`update public.community_links set state = 'hidden' where community_id = $1 and image_id = $2`, [c, R7]);
    expect(await works(c)).toEqual([R1]);
    // The prompt's link hidden takes every render it brought in.
    await q(`update public.community_links set state = 'hidden' where community_id = $1 and prompt_id = $2`, [c, P]);
    expect(await works(c)).toEqual([]);
    await q(`update public.community_links set state = 'shown' where community_id = $1 and prompt_id = $2`, [c, P]);
    // A render reached three ways (its prompt, a direct link, a post) is one work.
    await link(c, "image_id", R1, A);
    const post = (await one<{ id: string }>(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 't') returning id`, [A, R1])).id;
    await link(c, "post_id", post, A);
    expect(await count("community_works", "community_id = $1 and image_id = $2", [c, R1])).toBe(1);
    // added_at: the latest of its link and its going public, the earlier way when it came in two.
    const d = await community("dates", A);
    const old = await render(A, P, { published_at: new Date(Date.now() - 3 * 864e5).toISOString() });
    await link(d, "image_id", old, A);
    const fresh = await render(A, P);
    await q(`insert into public.community_links (community_id, image_id, user_id, created_at) values ($1, $2, $3, now() - interval '3 days')`, [d, fresh, A]);
    const at = async (img: string) => (await one<{ s: number }>(`select extract(epoch from now() - added_at)::int as s from public.community_works where community_id = $1 and image_id = $2`, [d, img])).s;
    expect(await at(old)).toBeLessThan(60);
    expect(await at(fresh)).toBeLessThan(60);
    await q(`insert into public.community_links (community_id, prompt_id, user_id, created_at) values ($1, $2, $3, now() - interval '2 days')`, [d, P, A]);
    expect(await at(R1)).toBeLessThan(60); // published now, linked 2 days ago: now
    expect(await at(old)).toBeGreaterThan(864e2); // linked now, but in through its prompt 2 days ago: then
    expect(await card(d)).toMatchObject({ works_7d: (await works(d)).length });
    await q(`delete from public.communities`);
    await q(`delete from public.showroom_posts`);
  });

  it(`counts a card's members and works (18+ works not), lists it at ${LISTED_MIN_MEMBERS} members or ${LISTED_MIN_WORKS} works, and counts the last ${TRENDING_DAYS} days apart`, async () => {
    const byMembers = await community("by_members", A);
    const members = await users(LISTED_MIN_MEMBERS);
    for (const u of members.slice(1)) await q(`insert into public.community_members (community_id, user_id) values ($1, $2)`, [byMembers, u]);
    expect(await card(byMembers)).toMatchObject({ members: LISTED_MIN_MEMBERS - 1, listed: false });
    await q(`insert into public.community_members (community_id, user_id) values ($1, $2)`, [byMembers, members[0]]);
    expect(await card(byMembers)).toMatchObject({ members: LISTED_MIN_MEMBERS, listed: true });
    await expect(q(`insert into public.community_members (community_id, user_id) values ($1, $2)`, [byMembers, members[0]])).rejects.toMatchObject({ code: "23505" });
    // A banned or deleted member is no member here (lib/hidden-owners.ts's rule); one whose ban ran out is.
    await q(`insert into public.community_members (community_id, user_id) values ($1, $2), ($1, $3)`, [byMembers, BANNED, GONE]);
    expect(await card(byMembers)).toMatchObject({ members: LISTED_MIN_MEMBERS });
    const [served] = await users(1);
    await q(`insert into public.bans (user_id, expires_at) values ($1, now() - interval '1 day')`, [served]);
    await q(`insert into public.community_members (community_id, user_id) values ($1, $2)`, [byMembers, served]);
    expect(await card(byMembers)).toMatchObject({ members: LISTED_MIN_MEMBERS + 1 });
    const byWorks = await community("by_works", A);
    const P = await prompt(A);
    for (let k = 0; k < LISTED_MIN_WORKS - 1; k++) await link(byWorks, "image_id", await render(A, P), A);
    await link(byWorks, "image_id", await render(A, P, { is_adult: true }), A);
    expect(await card(byWorks)).toMatchObject({ works: LISTED_MIN_WORKS - 1, works_7d: LISTED_MIN_WORKS - 1, listed: false });
    const last = await render(A, P, { published_at: new Date(Date.now() - (TRENDING_DAYS + 1) * 864e5).toISOString() });
    await q(`insert into public.community_links (community_id, image_id, user_id, created_at) values ($1, $2, $3, now() - interval '${TRENDING_DAYS + 1} days')`, [byWorks, last, A]);
    expect(await card(byWorks)).toMatchObject({ works: LISTED_MIN_WORKS, works_7d: LISTED_MIN_WORKS - 1, listed: true });
    // A merged community has no card.
    await q(`select public.merge_community($1, $2)`, [byWorks, byMembers]);
    expect(await card(byWorks)).toBeUndefined();
    await q(`delete from public.communities`);
  });

  it("covers a card with its listed prompt of the most generations, then more likes, then the newer; else its most-liked work, else its newest; never 18+", async () => {
    const c = await community("covers", A);
    const day = (k: number) => new Date(Date.now() - k * 864e5).toISOString();
    const gens = await prompt(A, { published_at: day(5) });
    const liked = await prompt(A, { like_count: 9, published_at: day(4) });
    const newer = await prompt(B, { published_at: day(1) });
    const adult = await prompt(A, { is_adult: true });
    const notWeb = await prompt(A, { showcase_images: ["data:image/png;base64,x"] });
    const unlisted = await prompt(A, { is_listed: false });
    const ofBanned = await prompt(BANNED);
    for (const [p, k] of [[gens, 2], [liked, 1], [newer, 1], [adult, 9], [notWeb, 9], [unlisted, 9], [ofBanned, 9]] as const) {
      await q(`insert into public.generations (prompt_id) select $1 from generate_series(1, $2::int)`, [p, k]);
      await link(c, "prompt_id", p, p === newer ? B : p === ofBanned ? BANNED : A);
    }
    const cover = async () => (await card(c)).cover_url;
    const show = (p: string) => one<{ u: string }>(`select showcase_images ->> 0 as u from public.prompts where id = $1`, [p]).then((r) => r.u);
    expect(await cover()).toBe(await show(gens));
    await q(`update public.generations set deleted_at = now() where prompt_id = $1`, [gens]);
    expect(await cover()).toBe(await show(liked));
    await q(`update public.prompts set like_count = 0 where id = $1`, [liked]);
    expect(await cover()).toBe(await show(newer));
    // Without a prompt to show: the most-liked work, else the newest; an 18+ one never.
    await q(`delete from public.community_links where community_id = $1`, [c]);
    const Q = await prompt(A, { is_listed: false });
    const older = await render(A, Q, { published_at: day(3) });
    const newest = await render(A, Q, { published_at: day(2) });
    const adultWork = await render(A, Q, { is_adult: true, like_count: 50 });
    for (const [r, k] of [[older, 3], [newest, 2], [adultWork, 1]] as const) {
      await q(`insert into public.community_links (community_id, image_id, user_id, created_at) values ($1, $2, $3, $4)`, [c, r, A, day(k)]);
    }
    expect(await cover()).toBe(`https://cdn.test/${newest}.webp`);
    await q(`update public.generated_images set like_count = 3 where id = $1`, [older]);
    expect(await cover()).toBe(`https://cdn.test/${older}.webp`);
    await q(`delete from public.community_links where community_id = $1`, [c]);
    expect(await cover()).toBeNull();
    await q(`delete from public.communities`);
  });

  it("shows a Showroom post while its render may be shown, in each community where its link is shown and its render not hidden", async () => {
    const c = await community("room", A);
    const d = await community("room_two", A);
    const P = await prompt(A);
    const mk = async (owner: string, extra: Record<string, unknown> = {}) => {
      const r = await render(owner, P);
      const post = (await one<{ id: string }>(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 't') returning id`, [owner, r])).id;
      if (Object.keys(extra).length) await q(`update public.generated_images set ${Object.keys(extra).map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [r, ...Object.values(extra)]);
      for (const x of [c, d]) await link(x, "post_id", post, owner);
      return { r, post };
    };
    const shown = await mk(A);
    const hiddenOne = await mk(B);
    const outs = [await mk(A, { visibility: "private" }), await mk(A, { deleted_at: new Date().toISOString() }), await mk(BANNED)];
    const posts = async (x: string) => (await q<{ id: string }>(`select id from public.community_posts where community_id = $1 order by id`, [x])).map((r) => r.id);
    expect(await posts(c)).toEqual([shown.post, hiddenOne.post].sort());
    expect(await count("showroom_entries")).toBe(2);
    expect(outs).toHaveLength(3);
    await q(`update public.community_links set state = 'hidden' where community_id = $1 and post_id = $2`, [c, hiddenOne.post]);
    await link(d, "image_id", shown.r, MOD, "hidden");
    expect([await posts(c), await posts(d)]).toEqual([[shown.post], [hiddenOne.post]]);
    // In the works too, while its link is shown.
    expect(await works(c)).toEqual([shown.r]);
    await q(`delete from public.communities`);
    await q(`delete from public.showroom_posts`);
  });

  it("suggests the live communities a text's keys name by handle, search word or a handle merged into them, the biggest first", async () => {
    const apu = await community("apu", A, "Apu");
    const pepe = await community("pepe", A, "Pepe");
    const frog = await community("frogs", A, "Frogs");
    const old = await community("pepe_coin", B, "Old pepe");
    await q(`insert into public.community_aliases (community_id, alias) values ($1, 'apustaja'), ($2, 'kek')`, [apu, frog]);
    await q(`insert into public.community_members (community_id, user_id) values ($1, $2), ($1, $3)`, [pepe, A, B]);
    await q(`select public.merge_community($1, $2)`, [old, pepe]);
    const suggest = async (keys: string[]) => (await q<{ handle: string; size: number }>(`select handle, size from public.community_suggest($1::text[])`, [keys]));
    expect(await suggest(["apustaja", "pepecoin", "kek", "nothing"])).toEqual([{ handle: "pepe", size: 2 }, { handle: "apu", size: 0 }, { handle: "frogs", size: 0 }]);
    expect(await suggest(["apu", "apu"])).toEqual([{ handle: "apu", size: 0 }]);
    expect(await suggest([])).toEqual([]);
    await q(`delete from public.communities`);
  });

  it("merges in one go: links and members the target lacks move, its own rows win, earlier merges point at the target, self and gone refused", async () => {
    const into = await community("merge_into", A);
    const from = await community("merge_from", B);
    const earlier = await community("merge_earlier", B);
    await q(`select public.merge_community($1, $2)`, [earlier, from]);
    const P = await prompt(A);
    const [r1, r2] = [await render(A, P), await render(B, P)];
    await link(from, "prompt_id", P, A);
    await link(from, "image_id", r1, A);
    await link(from, "image_id", r2, B);
    await link(into, "image_id", r2, MOD, "hidden");
    const [u1, u2] = await users(2);
    await q(`insert into public.community_members (community_id, user_id) values ($1, $2), ($1, $3), ($4, $2)`, [from, u1, u2, into]);
    expect(await one(`select public.merge_community($1, $2) as r`, [from, into])).toEqual({ r: { links: 2, members: 1 } });
    expect(await q(`select prompt_id, image_id, state from public.community_links where community_id = $1 order by state, image_id nulls first`, [into]))
      .toEqual([{ prompt_id: null, image_id: r2, state: "hidden" }, { prompt_id: P, image_id: null, state: "shown" }, { prompt_id: null, image_id: r1, state: "shown" }]);
    expect(await count("community_links", "community_id = $1", [from])).toBe(0);
    expect(await count("community_members", "community_id = $1", [into])).toBe(2);
    expect(await q(`select handle, merged_into = $2 as to_target, merged_at is not null as dated from public.communities where id in ($1, $3) order by handle`, [earlier, into, from]))
      .toEqual([{ handle: "merge_earlier", to_target: true, dated: true }, { handle: "merge_from", to_target: true, dated: true }]);
    await expect(q(`select public.merge_community($1, $2)`, [from, into])).rejects.toMatchObject({ code: "23514", message: "community merge gone" });
    await expect(q(`select public.merge_community($1, $1)`, [into])).rejects.toMatchObject({ code: "23514", message: "community merge same" });
    // Deleting the target takes its merged shells: their handles are free again.
    await q(`delete from public.communities where id = $1`, [into]);
    expect(await count("communities")).toBe(0);
  });

  it("moves a render's opt-out only with the prompt link it takes the render out of", async () => {
    const into = await community("optout_into", A);
    const from = await community("optout_from", A);
    // P is in both: her render R left the old one only, and stays in the target as she left it there.
    const P = await prompt(A);
    const r = await render(B, P);
    await link(from, "prompt_id", P, A);
    await link(into, "prompt_id", P, A);
    await link(from, "image_id", r, B, "opted_out");
    // Q is in the old one only: its link moves, and her render S stays out of it, opt-out and all.
    const Q = await prompt(A);
    const s = await render(B, Q);
    await link(from, "prompt_id", Q, A);
    await link(from, "image_id", s, B, "opted_out");
    expect(await works(into)).toEqual([r]);
    await q(`select public.merge_community($1, $2)`, [from, into]);
    expect(await works(into)).toEqual([r]);
    expect(await q(`select image_id, state from public.community_links where community_id = $1 and image_id is not null`, [into])).toEqual([{ image_id: s, state: "opted_out" }]);
    await q(`delete from public.communities`);
  });

  it("is the server's only: RLS on, nothing for anon or authenticated; the service role writes through the caps", async () => {
    for (const t of [...TABLES, ...VIEWS]) {
      if (TABLES.includes(t)) expect(await q(`select relrowsecurity as on from pg_class where relname = $1`, [t]), t).toEqual([{ on: true }]);
      for (const role of ["anon", "authenticated"]) {
        for (const priv of ["select", "insert", "update", "delete"]) {
          expect(await q(`select has_table_privilege($1, $2, $3) as can`, [role, `public.${t}`, priv]), `${role} ${priv} ${t}`).toEqual([{ can: false }]);
        }
      }
      expect(await q(`select has_table_privilege('service_role', $1, 'select') as can`, [`public.${t}`])).toEqual([{ can: true }]);
    }
    for (const fn of ["community_key(text)", "community_owner_hidden(uuid)", "community_cap()", "showroom_posts_own_render()", "community_links_guard()", "community_suggest(text[])", "merge_community(uuid,uuid)"]) {
      for (const [role, can] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
        expect(await q(`select has_function_privilege($1, $2, 'execute') as can`, [role, `public.${fn}`]), `${role} ${fn}`).toEqual([{ can }]);
      }
    }
    await db.exec(`set role service_role; insert into public.communities (handle, core, name, created_by) values ('by_server', 'byserver', 'By the server', '${B}'); reset role;`);
    expect(await count("communities", "handle = 'by_server'")).toBe(1);
  });

  it("reads back as its end says", async () => {
    expect(READ_BACK).toHaveLength(5);
    const [objects, triggers, rls, anon, key] = await Promise.all(READ_BACK.map((s) => q(s)));
    expect(Object.values(objects[0])).toEqual([...TABLES, ...VIEWS]);
    expect(triggers.map((r) => r.tgname)).toEqual([
      "communities_cap_all", "communities_cap_day", "community_aliases_cap", "community_links_guard", "showroom_posts_cap_day", "showroom_posts_own_render",
    ]);
    expect(rls).toEqual([...TABLES].sort().map((relname) => ({ relname, relrowsecurity: true })));
    expect(anon).toEqual([{ anon_reads: false }]);
    expect(key).toEqual([{ key: "gundamm" }]);
  });

  it("rolls back to no table, view or function, the renders, prompts and users left", async () => {
    await db.exec(ROLLBACK);
    expect([await count("generated_images"), await count("prompts"), await count("users")].every((k) => k > 0)).toBe(true);
    expect(await q(`select count(*)::int as n from pg_class where relname = any($1)`, [[...TABLES, ...VIEWS]])).toEqual([{ n: 0 }]);
    expect(await q(`select count(*)::int as n from pg_proc where proname like 'community%' or proname like 'showroom%' or proname = 'merge_community'`)).toEqual([{ n: 0 }]);
    // And runs again from there.
    await db.exec(SQL);
    expect(await count("communities")).toBe(0);
  });

  it.skipIf(!existsSync(COPY))("is copied to sql-to-run/54-communities.sql byte for byte", async () => {
    // Read past the in-memory mutation runner (it patches readFileSync only): this compares the files on disk.
    expect((await readFile(COPY)).equals(await readFile(FILE))).toBe(true);
  });
});
