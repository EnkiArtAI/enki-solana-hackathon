import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-29-dead-tables.sql in a real Postgres (Kev, 2026-10-29: "yes, drop all six if they are redundant"):
 * it refuses while a function still reads what it drops, a view still reading one stops it with nothing changed, it
 * drops the four tables, the function and prompts.views but keeps prompts.opens (search ranks by it) and the columns
 * that pointed at prompt_purchases, it runs twice, and the rollback brings the shapes and the feed counter back.
 */
const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-29-dead-tables.sql"), "utf8");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const P = "00000000-0000-4000-8000-000000000011";
const TABLES = ["prompt_purchases", "prompt_analytics_events", "platform_analytics", "prompt_reviews"];

describe("the dead tables migration", () => {
  let db: PGlite;
  const exists = async (t: string) => (await db.query<{ t: string | null }>(`select to_regclass('public.${t}')::text as t`)).rows[0].t !== null;
  const column = async (t: string, c: string) =>
    (await db.query<{ n: number }>(`select count(*)::int as n from information_schema.columns where table_name = $1 and column_name = $2`, [t, c])).rows[0].n === 1;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.prompts (id uuid primary key, views bigint not null default 0, opens bigint not null default 0);
      insert into public.prompts values ('${P}', 30, 7);
      create table public.view_days (kind text, day date, target_id uuid, n bigint, primary key (kind, day, target_id));
      insert into public.view_days values ('prompt_view', '1970-01-01', '${P}', 30), ('prompt_view', current_date, '${P}', 2), ('prompt_open', current_date, '${P}', 1);
      create table public.prompt_purchases (id uuid primary key default gen_random_uuid(), prompt_id uuid, status text);
      create table public.generations (id serial primary key, purchase_id uuid references public.prompt_purchases(id));
      create table public.payment_verifications (id serial primary key, purchase_id uuid references public.prompt_purchases(id));
      create table public.referral_commissions (id serial primary key, source_purchase_id uuid references public.prompt_purchases(id));
      create table public.content_access_logs (id serial primary key, purchase_id uuid references public.prompt_purchases(id));
      insert into public.generations (purchase_id) values (null);
      create table public.prompt_analytics_events (id uuid default gen_random_uuid(), event_type text, created_at timestamptz default now());
      create table public.platform_analytics (id uuid primary key default gen_random_uuid(), metric_type text);
      insert into public.platform_analytics (metric_type) values ('migration');
      create table public.prompt_reviews (id uuid primary key default gen_random_uuid(), rating smallint);
      create function public.insert_prompt_purchase(p_prompt_id uuid) returns uuid language sql as $$
        insert into public.prompt_purchases (prompt_id, status) values (p_prompt_id, 'completed') returning id $$;
      -- search ranks by the opens counter, which stays.
      create function public.search_like() returns setof uuid language sql as $$ select p.id from public.prompts p order by p.opens desc $$;
    `);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("refuses while a function still reads what it drops, and changes nothing", async () => {
    await db.exec(`create function public.old_reader() returns bigint language sql as $$ select count(*) from public.prompt_purchases $$;`);
    await expect(db.exec(SQL)).rejects.toThrow(/still read them: old_reader/);
    await db.exec("rollback");
    await db.exec(`drop function public.old_reader(); create function public.views_reader() returns bigint language sql as $$ select sum(p.views) from public.prompts p $$;`);
    await expect(db.exec(SQL)).rejects.toThrow(/still read them: views_reader/);
    await db.exec("rollback");
    await db.exec(`drop function public.views_reader();`);
    for (const t of TABLES) expect(await exists(t), t).toBe(true);
    expect(await column("prompts", "views")).toBe(true);
  });

  it("stops at a view still reading one, with nothing changed", async () => {
    await db.exec(`create view public.v_reviews as select rating from public.prompt_reviews;`);
    await expect(db.exec(SQL)).rejects.toThrow(/depend/);
    await db.exec("rollback");
    await db.exec(`drop view public.v_reviews;`);
    for (const t of TABLES) expect(await exists(t), t).toBe(true);
    expect((await db.query(`select count(*)::int as n from pg_constraint where confrelid = 'public.prompt_purchases'::regclass`)).rows).toEqual([{ n: 4 }]);
  });

  it("drops the four tables, the function and the feed counter; keeps opens and the columns that pointed at purchases", async () => {
    await db.exec(SQL);
    for (const t of TABLES) expect(await exists(t), t).toBe(false);
    expect((await db.query(`select to_regprocedure('public.insert_prompt_purchase(uuid)') as f`)).rows).toEqual([{ f: null }]);
    expect(await column("prompts", "views")).toBe(false);
    expect(await column("prompts", "opens")).toBe(true);
    for (const [t, c] of [["generations", "purchase_id"], ["payment_verifications", "purchase_id"], ["referral_commissions", "source_purchase_id"], ["content_access_logs", "purchase_id"]]) {
      expect(await column(t, c), `${t}.${c}`).toBe(true);
    }
    expect((await db.query(`select count(*)::int as n from public.generations`)).rows).toEqual([{ n: 1 }]);
    expect((await db.query(`select * from public.search_like()`)).rows).toHaveLength(1);
  });

  it("runs twice without harm", async () => {
    await db.exec(SQL);
    for (const t of TABLES) expect(await exists(t), t).toBe(false);
  });

  it("rolls back to the empty tables and the feed counter, from view_days", async () => {
    await db.exec(ROLLBACK);
    for (const t of TABLES) expect(await exists(t), t).toBe(true);
    expect((await db.query<{ views: number }>(`select views::int as views from public.prompts`)).rows).toEqual([{ views: 32 }]);
    for (const t of TABLES) expect((await db.query(`select relrowsecurity as on from pg_class where relname = $1`, [t])).rows, t).toEqual([{ on: true }]);
  });
});
