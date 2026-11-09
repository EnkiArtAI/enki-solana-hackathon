import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-29-follows.sql in a real Postgres, on Supabase's roles and default privileges, over the table as it
 * stands live (made outside the repo, read back 2026-10-29): nobody follows themselves, the fan-out has its index, and
 * only the service role reaches the table.
 */
const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-29-follows.sql"), "utf8");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B] = [1, 2].map(id);

describe("the follows migration", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create table public.users (id uuid primary key);
      insert into public.users values ('${A}'), ('${B}');
      -- The live table, as the OpenAPI read showed it.
      create table public.follows (
        follower_id uuid not null references public.users(id), followee_id uuid not null references public.users(id),
        created_at timestamptz not null default now(), notify_on_new_prompt boolean not null default true,
        notify_on_new_post boolean not null default false, primary key (follower_id, followee_id));
      insert into public.follows (follower_id, followee_id) values ('${A}', '${B}');
    `);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("runs twice without harm", async () => {
    await db.exec(SQL);
  });

  it("keeps the follows there were, refuses following yourself, and indexes whose followers", async () => {
    expect((await db.query(`select count(*)::int as n from public.follows`)).rows).toEqual([{ n: 1 }]);
    await expect(db.query(`insert into public.follows (follower_id, followee_id) values ($1, $1)`, [A])).rejects.toThrow(/follows_not_self/);
    expect((await db.query(`select to_regclass('public.follows_followee_idx')::text as i`)).rows).toEqual([{ i: "follows_followee_idx" }]);
  });

  it("is the server's only", async () => {
    expect((await db.query(`select relrowsecurity as on from pg_class where relname = 'follows'`)).rows).toEqual([{ on: true }]);
    for (const role of ["anon", "authenticated"]) {
      expect((await db.query(`select has_table_privilege($1, 'public.follows', 'select') as can`, [role])).rows).toEqual([{ can: false }]);
    }
  });

  it("rolls back to the table as it was", async () => {
    await db.exec(ROLLBACK);
    expect((await db.query(`select to_regclass('public.follows_followee_idx') as i`)).rows).toEqual([{ i: null }]);
    await db.query(`insert into public.follows (follower_id, followee_id) values ($1, $1)`, [B]);
  });
});
