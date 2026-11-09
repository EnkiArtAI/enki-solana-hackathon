import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { CREATOR_DEFAULTS, CREATOR_LIMITS } from "@/lib/hunter/creator-types";

/**
 * migrations/2026-10-30-creator-hunter.sql (SQL 56) in a real Postgres, over the shapes it meets live (probed
 * 2026-10-30): hunter_config in its FIRST draft's shape (daily_posts, accounts, account_ids, last_post_ids; no
 * posts_per_run, no dry_after), then 2026-10-14-prompt-hunter.sql as it ran (its CREATE TABLE IF NOT EXISTS skipped
 * the existing table), users.origin's CHECK as SQL 32 left it. The Creator Hunter (Kev, 2026-10-30: "creator
 * reinpacken, such kriterien einstellen, und go"; "account fürn creator angelegt werden").
 */
const ROOT = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, "migrations", f), "utf8").split("\r\n").join("\n");
const SQL = read("2026-10-30-creator-hunter.sql");
const HUNTER = read("2026-10-14-prompt-hunter.sql");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");

describe("the creator hunter migration (SQL 56)", () => {
  let db: PGlite;
  const fails = async (sql: string) => {
    try { await db.exec(sql); } catch (e) { return (e as { code?: string }).code ?? "error"; }
    return null;
  };
  const columns = async (table: string) =>
    (await db.query<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1`, [table])).rows.map((r) => r.c);

  beforeAll(async () => {
    db = await PGlite.create({ extensions: { citext } });
    await db.exec(`
      create extension citext;
      create table public.users (id uuid primary key default gen_random_uuid(), handle public.citext, origin text,
        display_name text, deleted_at timestamptz);
      alter table public.users add constraint users_origin_check check (origin in ('email', 'wallet', 'agent', 'google', 'x'));
      insert into public.users (handle, origin) values ('ann', 'wallet'), ('bob', null);
      create table public.hunt_submissions (id uuid primary key default gen_random_uuid(), hunter_user_id uuid);
      -- The first draft, as it lives (probe 2026-10-30).
      create table public.hunter_config (id smallint primary key default 1 check (id = 1), enabled boolean not null default false,
        mode text not null default 'queue', daily_posts integer not null default 400, min_likes integer not null default 20,
        per_author_daily integer not null default 3, accounts text[] not null default '{}', account_ids jsonb not null default '{}',
        last_post_ids jsonb not null default '{}', publisher_user_id uuid, updated_at timestamptz not null default now(), updated_by uuid);
      insert into public.hunter_config (id) values (1);
      create role anon; create role authenticated;
    `);
    await db.exec(HUNTER);
    // The legacy table kept its shape: the live 400 on posts_per_run.
    expect(await columns("hunter_config")).not.toContain("posts_per_run");
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("repairs hunter_config: posts_per_run and dry_after on the existing row, the first draft's columns kept", async () => {
    const row = (await db.query<Record<string, unknown>>(`select * from public.hunter_config`)).rows[0];
    expect(row).toMatchObject({ posts_per_run: 500, dry_after: 30, daily_posts: 400, per_author_daily: 3, mode: "queue" });
    expect(await fails(`update public.hunter_config set dry_after = 1001`)).toBe("23514");
    expect(await fails(`update public.hunter_config set posts_per_run = -1`)).toBe("23514");
  });

  it("takes an imported creator's account, keyed by X's numeric id, once, and no other origin with an X id", async () => {
    expect(await fails(`insert into public.users (origin, imported_x_id, handle) values ('imported', '1234567890123456789', 'hex')`)).toBeNull();
    // One account per X author.
    expect(await fails(`insert into public.users (origin, imported_x_id) values ('imported', '1234567890123456789')`)).toBe("23505");
    // Not an X id, or an X id on an account someone signs in to.
    expect(await fails(`insert into public.users (origin, imported_x_id) values ('imported', '12a')`)).toBe("23514");
    expect(await fails(`insert into public.users (origin, imported_x_id) values ('imported', '123456789012345678901')`)).toBe("23514");
    expect(await fails(`insert into public.users (origin, imported_x_id) values ('x', '42')`)).toBe("23514");
    expect(await fails(`insert into public.users (origin, imported_x_id) values (null, '43')`)).toBe("23514");
    // The origins from before still go in, a made-up one does not.
    for (const origin of ["email", "wallet", "agent", "google", "x", "imported"]) {
      expect(await fails(`insert into public.users (origin) values ('${origin}')`)).toBeNull();
    }
    expect(await fails(`insert into public.users (origin) values ('robot')`)).toBe("23514");
    const idx = (await db.query<{ d: string }>(`select indexdef as d from pg_indexes where indexname = 'users_imported_x_id_key'`)).rows[0]?.d;
    expect(idx).toContain("UNIQUE");
    expect(idx).toContain("WHERE (imported_x_id IS NOT NULL)");
  });

  it("gives every creator on the list the contract's defaults and holds SQL 56's limits", async () => {
    await db.exec(`insert into public.hunter_accounts (handle) values ('hex')`);
    const row = (await db.query<Record<string, unknown>>(`select words, media, min_likes, since_days, preferred_generator, posts_per_play,
      spend_cap_usd::float8 as spend_cap_usd, spent_usd::float8 as spent_usd, dry_after, playing_since, gap_top, gap_low from public.hunter_accounts where handle = 'hex'`)).rows[0];
    const d = CREATOR_DEFAULTS;
    expect(row).toEqual({
      words: d.words, media: d.media, min_likes: d.minLikes, since_days: d.sinceDays, preferred_generator: d.preferredGenerator,
      posts_per_play: d.postsPerPlay, spend_cap_usd: d.spendCapUsd, spent_usd: 0, dry_after: d.dryAfter, playing_since: null,
      gap_top: null, gap_low: null,
    });
    const L = CREATOR_LIMITS;
    const set = (sql: string) => fails(`update public.hunter_accounts set ${sql} where handle = 'hex'`);
    expect(await set(`words = array_fill('w'::text, array[${L.words}])`)).toBeNull();
    expect(await set(`words = array_fill('w'::text, array[${L.words + 1}])`)).toBe("23514");
    for (const m of ["images", "media", "any"]) expect(await set(`media = '${m}'`)).toBeNull();
    expect(await set(`media = 'video'`)).toBe("23514");
    expect(await set(`min_likes = ${L.minLikes.max}`)).toBeNull();
    expect(await set(`min_likes = ${L.minLikes.max + 1}`)).toBe("23514");
    expect(await set(`since_days = ${L.sinceDays.max}`)).toBeNull();
    expect(await set(`since_days = ${L.sinceDays.max + 1}`)).toBe("23514");
    expect(await set(`posts_per_play = ${L.postsPerPlay.min}`)).toBeNull();
    expect(await set(`posts_per_play = ${L.postsPerPlay.min - 1}`)).toBe("23514");
    expect(await set(`posts_per_play = ${L.postsPerPlay.max + 1}`)).toBe("23514");
    expect(await set(`spend_cap_usd = ${L.spendCapUsd.max}`)).toBeNull();
    expect(await set(`spend_cap_usd = ${L.spendCapUsd.max + 0.01}`)).toBe("23514");
    expect(await set(`spend_cap_usd = -0.01`)).toBe("23514");
    expect(await set(`spent_usd = -0.0001`)).toBe("23514");
    expect(await set(`dry_after = ${L.dryAfter.max + 1}`)).toBe("23514");
    expect(await set(`preferred_generator = ''`)).toBe("23514");
    expect(await set(`preferred_generator = 'Nano Banana Pro'`)).toBeNull();
    expect(await set(`playing_since = now()`)).toBeNull();
  });

  it("records a Play per creator: its handle, what it counted and what that cost", async () => {
    const run = (await db.query<Record<string, unknown>>(`insert into public.hunter_runs (handle) values ('hex') returning handle, usage, est_usd::float8 as est_usd`)).rows[0];
    expect(run).toEqual({ handle: "hex", usage: {}, est_usd: 0 });
    const idx = (await db.query<{ d: string }>(`select indexdef as d from pg_indexes where indexname = 'hunter_runs_handle_idx'`)).rows[0]?.d;
    expect(idx).toContain("(handle, started_at DESC) WHERE (handle IS NOT NULL)");
  });

  it("runs twice without harm", async () => {
    const before = await db.query(`select * from public.hunter_accounts order by handle`);
    await db.exec(SQL);
    expect((await db.query(`select * from public.hunter_accounts order by handle`)).rows).toEqual(before.rows);
  });

  it("rolls back once no imported account is left: the columns go, 'imported' is refused again, the repair stays", async () => {
    await db.exec(`delete from public.users where origin = 'imported'`);
    await db.exec(ROLLBACK);
    expect(await columns("users")).not.toContain("imported_x_id");
    for (const c of ["words", "media", "min_likes", "since_days", "preferred_generator", "posts_per_play", "spend_cap_usd", "spent_usd", "dry_after", "playing_since", "gap_top", "gap_low"]) {
      expect(await columns("hunter_accounts")).not.toContain(c);
    }
    for (const c of ["handle", "usage", "est_usd"]) expect(await columns("hunter_runs")).not.toContain(c);
    expect(await fails(`insert into public.users (origin) values ('imported')`)).toBe("23514");
    expect(await fails(`insert into public.users (origin) values ('x')`)).toBeNull();
    expect(await columns("hunter_config")).toEqual(expect.arrayContaining(["posts_per_run", "dry_after"]));
    // And forward again.
    await db.exec(SQL);
    expect(await columns("users")).toContain("imported_x_id");
  });
});
