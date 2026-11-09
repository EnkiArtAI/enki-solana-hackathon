import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-29-view-days.sql in a real Postgres, over enki-stats and artist-earnings: prompt and image opens
 * land on their UTC day, both counters counted before the table sit on "before", the feed's counter stops counting
 * (SQL 50 drops it) while opens keep theirs for search, enki_stats takes the deployment's chain, an image open counts only for a public
 * render that is not the viewer's own, the Enki view counts and ranks views per period and lists what was watched
 * most without anything hidden, and the rollback leaves the counters as they were.
 */
const M = (f: string) => readFileSync(join(__dirname, "..", "..", "migrations", f), "utf8");
const STATS = M("2026-10-29-enki-stats.sql"), EARN = M("2026-10-29-artist-earnings.sql"), SQL = M("2026-10-29-view-days.sql");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C, D] = [1, 2, 3, 4].map(id);
const [pA1, pA2, pA3, pD1, pC1] = [11, 12, 13, 14, 15].map(id);
const [iA1, iA2, iA3, iA4, iD1, iC1] = [21, 22, 23, 24, 25, 26].map(id);
const GHOST = id(99);

type Stats = { totals: Record<string, [number, number]>; board: Record<string, unknown>[]; watched: { prompts: Record<string, unknown>[]; images: Record<string, unknown>[] } };

describe("the view days migration", () => {
  let db: PGlite;
  const stats = async (args = "null") => (await db.query<{ s: Stats }>(`select public.enki_stats(${args}) as s`)).rows[0].s;
  const days = async () => (await db.query<{ kind: string; day: string; target_id: string; n: number }>(
    `select kind, day::text as day, target_id, n::int as n from public.view_days order by kind, day, target_id`)).rows;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
      create table public.users (id uuid primary key, handle text, created_at timestamptz not null default now(),
        deleted_at timestamptz, account_status text, hide_from_leaderboard boolean not null default false);
      create table public.bans (id serial, user_id uuid, lifted_at timestamptz, expires_at timestamptz);
      create table public.prompts (id uuid primary key, creator_id uuid, is_listed boolean, listing_status text,
        deleted_at timestamptz, published_at timestamptz, views bigint not null default 0, opens bigint not null default 0,
        title text, is_adult boolean not null default false);
      create table public.generated_images (id uuid primary key, user_id uuid, visibility text, is_uploaded boolean,
        deleted_at timestamptz, created_at timestamptz not null default now(), is_adult boolean not null default false,
        thumbnail_url text, preview_url text, storage_url text);
      create table public.generations (id serial, payment_intent_id uuid, chain_key text, user_id uuid, transaction_hash text,
        prompt_id uuid, created_at timestamptz not null default now(), deleted_at timestamptz);
      create table public.user_wallets (user_id uuid, address text);
      create table public.reactions (target_type text, target_uuid uuid, user_id uuid, reaction_type text, created_at timestamptz);
      create table public.prompt_comments (prompt_id text, user_id uuid, created_at timestamptz);
      create table public.follows (follower_id uuid, followee_id uuid, created_at timestamptz);
      create table public.licence_credits (source text, role text, mint text, micro bigint, prompt_id uuid, user_id uuid, created_at timestamptz);
      create table public.generation_payment_intents (id uuid primary key, prompt_id text, status text,
        captured_at timestamptz, fulfilled_at timestamptz, artist_amount_micro bigint, buyer_wallet text);
      create table public.generation_escrow_recovery (intent_id uuid, mint text, state text, delivered_units smallint,
        original_artist_unit_micro bigint, confirmed_at timestamptz);

      -- ann makes things, bob looks at them, cat is deleted, dee hid from the board.
      insert into public.users (id, handle, deleted_at, account_status, hide_from_leaderboard) values
        ('${A}', 'ann', null, 'active', false), ('${B}', 'bob', null, 'active', false),
        ('${C}', 'cat', now(), 'active', false), ('${D}', 'dee', null, 'active', true);
      insert into public.prompts (id, creator_id, is_listed, listing_status, published_at, views, opens, title, is_adult) values
        ('${pA1}', '${A}', true, 'active', now(), 30, 7, 'Lighthouse', false), ('${pA2}', '${A}', false, 'draft', null, 4, 2, 'draft', false),
        ('${pA3}', '${A}', true, 'active', now(), 0, 0, 'Night', true), ('${pD1}', '${D}', true, 'active', now(), 0, 0, 'Dee', false),
        ('${pC1}', '${C}', true, 'active', now(), 0, 0, 'Cat', false);
      -- ann earned twice: mainnet and devnet test money.
      insert into public.licence_credits values ('x402:m', 'artist', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1500000, '${pA1}', '${A}', now()),
        ('x402:d', 'artist', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 9000000, '${pA1}', '${A}', now());
      insert into public.generated_images (id, user_id, visibility, is_uploaded, is_adult, thumbnail_url, storage_url) values
        ('${iA1}', '${A}', 'public', false, false, 'https://x/a1-thumb.webp', 'https://x/a1.png'), ('${iA2}', '${A}', 'private', false, false, null, 'https://x/a2.png'),
        ('${iA3}', '${A}', 'public', false, true, null, 'https://x/a3.png'), ('${iA4}', '${A}', 'public', true, false, null, 'https://x/a4.png'),
        ('${iD1}', '${D}', 'public', false, false, null, 'https://x/d1.png'), ('${iC1}', '${C}', 'public', false, false, null, 'https://x/c1.png');
    `);
    await db.exec(STATS);
    await db.exec(EARN);
    await db.exec(SQL);
    // What happens after: cards seen twice, prompts opened, images opened by bob, by ann (her own), by nobody signed in.
    await db.exec(`
      select public.increment_prompt_views_batch(array['${pA1}', '${pA2}', 'bogus']);
      select public.increment_prompt_views_batch(array['${pA1}', '${pA2}']);
      select public.increment_prompt_opens('${pA1}'); select public.increment_prompt_opens('${pA1}');
      select public.increment_prompt_opens('${pA3}'); select public.increment_prompt_opens('${pD1}'); select public.increment_prompt_opens('${pC1}');
      insert into public.view_days values ('image_open', (now() at time zone 'utc')::date - 10, '${iA1}', 5);
    `);
  }, 90_000);
  afterAll(async () => { await db.close(); });

  it("counts an image opened large once per call, only a public render that is not the viewer's own", async () => {
    const n = async (args: string) => (await db.query<{ n: number }>(`select public.count_image_opens(${args}) as n`)).rows[0].n;
    expect(await n(`array['${iA1}', '${iA2}', '${iA3}', '${iA4}', '${iD1}', '${iC1}', '${GHOST}']::uuid[], '${B}'`)).toBe(4);
    expect(await n(`array['${iA1}']::uuid[], '${A}'`)).toBe(0);
    expect(await n(`array['${iA1}']::uuid[]`)).toBe(1);
    const today = (await db.query<{ d: string }>(`select ((now() at time zone 'utc')::date)::text as d`)).rows[0].d;
    expect((await days()).filter((r) => r.day === today).map((r) => [r.kind, r.target_id, r.n])).toEqual([
      ["image_open", iA1, 2], ["image_open", iA3, 1], ["image_open", iD1, 1], ["image_open", iC1, 1],
      ["prompt_open", pA1, 2], ["prompt_open", pA3, 1], ["prompt_open", pD1, 1], ["prompt_open", pC1, 1],
      ["prompt_view", pA1, 2], ["prompt_view", pA2, 2],
    ]);
    // The feed's counter stops (its days are in view_days); the opens counter goes on, search ranks by it.
    expect((await db.query<{ views: number; opens: number }>(`select views::int as views, opens::int as opens from public.prompts where id = '${pA1}'`)).rows).toEqual([{ views: 30, opens: 9 }]);
  });

  it("keeps both counters as they stood under 'before', once", async () => {
    const before = (await days()).filter((r) => r.day === "1970-01-01").map((r) => [r.kind, r.target_id, r.n]);
    expect(before).toEqual([["prompt_open", pA1, 7], ["prompt_open", pA2, 2], ["prompt_view", pA1, 30], ["prompt_view", pA2, 4]]);
    await db.exec(SQL);
    expect((await days()).filter((r) => r.day === "1970-01-01").map((r) => [r.kind, r.target_id, r.n])).toEqual(before);
    expect((await days()).filter((r) => r.day === "1970-01-01" && r.target_id === pA3)).toEqual([]);
  });

  it("counts views per owner, all time with 'before' and today, and ranks by them", async () => {
    const all = await stats();
    expect(all.totals.views).toEqual([22, 8]);
    expect(all.board.map((r) => [r.handle, r.views])).toEqual([["ann", 20]]);
    const week = await stats("now() - interval '7 days', 'views'");
    expect(week.totals.views).toEqual([8, 8]);
    expect(week.board.map((r) => [r.handle, r.views])).toEqual([["ann", 6]]);
  });

  // Live 2026-10-31 23:24 UTC, the suite on a Europe/Berlin machine: today's views counted 0. A view day became midnight
  // of the session's time zone, not UTC's, so ahead of UTC it fell before today and out of the last 24 hours. A session
  // 14 hours ahead and a period from UTC's midnight show it at any hour.
  it("puts a view day at UTC's midnight whatever the session's time zone", async () => {
    await db.exec(`set time zone 'Etc/GMT-14'`);
    try {
      const today = await stats(`(now() at time zone 'utc')::date::timestamp at time zone 'utc', 'views'`);
      expect(today.totals.views).toEqual([8, 8]);
    } finally {
      await db.exec(`set time zone 'UTC'`);
    }
  });

  it("lists what was watched most: listed prompts and public images only, never 18+ or anyone hidden", async () => {
    const all = await stats();
    expect(all.watched.prompts).toEqual([{ id: pA1, title: "Lighthouse", handle: "ann", n: 9 }]);
    expect(all.watched.images).toEqual([{ id: iA1, thumb: "https://x/a1-thumb.webp", handle: "ann", n: 7 }]);
    const week = await stats("now() - interval '7 days'");
    expect(week.watched.prompts.map((w) => w.n)).toEqual([2]);
    expect(week.watched.images.map((w) => w.n)).toEqual([2]);
  });

  it("counts revenue in the money of the chain asked for, and replaces the 3-argument enki_stats", async () => {
    expect((await stats()).totals.revenue).toEqual([1500000, 1500000]);
    expect((await stats("null, 'revenue', 25, 'solana-devnet'")).totals.revenue).toEqual([9000000, 9000000]);
    expect((await db.query(`select to_regprocedure('public.enki_stats(timestamptz, text, integer)') as f`)).rows).toEqual([{ f: null }]);
  });

  it("is the server's only", async () => {
    for (const fn of ["increment_prompt_views_batch(text[])", "increment_prompt_opens(text)", "count_image_opens(uuid[], uuid)", "enki_stats(timestamptz, text, integer, text)"]) {
      for (const [role, can] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
        expect((await db.query(`select has_function_privilege($1, 'public.${fn}', 'execute') as can`, [role])).rows, `${role} ${fn}`).toEqual([{ can }]);
      }
    }
    expect((await db.query(`select relrowsecurity as on from pg_class where relname = 'view_days'`)).rows).toEqual([{ on: true }]);
    expect((await db.query(`select has_table_privilege('anon', 'public.view_days', 'select') as can`)).rows).toEqual([{ can: false }]);
  });

  it("rolls back to the counters alone, the feed views counted since back on prompts.views", async () => {
    await db.exec(ROLLBACK);
    await db.exec(STATS);
    expect((await db.query(`select to_regclass('public.view_days') as t`)).rows).toEqual([{ t: null }]);
    await db.exec(`select public.increment_prompt_opens('${pA1}')`);
    expect((await db.query<{ opens: number }>(`select opens::int as opens from public.prompts where id = '${pA1}'`)).rows).toEqual([{ opens: 10 }]);
    expect((await db.query<{ views: number }>(`select views::int as views from public.prompts where id = '${pA1}'`)).rows).toEqual([{ views: 32 }]);
    await db.exec(`select public.increment_prompt_views_batch(array['${pA1}'])`);
    expect((await db.query<{ views: number }>(`select views::int as views from public.prompts where id = '${pA1}'`)).rows).toEqual([{ views: 33 }]);
    expect((await stats()).totals.views).toBeUndefined();
  });
});
