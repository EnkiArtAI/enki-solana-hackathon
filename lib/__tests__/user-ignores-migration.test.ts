import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { MAX_IGNORED } from "@/lib/ignores";

/**
 * migrations/2026-10-29-user-ignores.sql in a real Postgres, on Supabase's roles and default privileges: one row per
 * (who, whom), nobody ignores themselves, a deleted account takes its rows with it, at most MAX_IGNORED per account,
 * and only the service role reaches the table.
 */
const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-29-user-ignores.sql"), "utf8");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C] = [1, 2, 3].map(id);

describe("the user_ignores migration", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create table public.users (id uuid primary key);
      insert into public.users values ('${A}'), ('${B}'), ('${C}');
    `);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("runs twice without harm, keeping the ignores there are", async () => {
    await db.query(`insert into public.user_ignores (user_id, ignored_id) values ($1, $2)`, [A, B]);
    await db.exec(SQL);
    expect((await db.query(`select user_id, ignored_id, created_at is not null as dated from public.user_ignores`)).rows).toEqual([{ user_id: A, ignored_id: B, dated: true }]);
  });

  it("holds one row per pair, refuses ignoring yourself and anyone who is not an account", async () => {
    await expect(db.query(`insert into public.user_ignores (user_id, ignored_id) values ($1, $2)`, [A, B])).rejects.toThrow(/user_ignores_pkey/);
    await expect(db.query(`insert into public.user_ignores (user_id, ignored_id) values ($1, $1)`, [C])).rejects.toThrow(/user_ignores_not_self/);
    await expect(db.query(`insert into public.user_ignores (user_id, ignored_id) values ($1, $2)`, [C, id(9)])).rejects.toThrow(/user_ignores_ignored_id_fkey/);
    await expect(db.query(`insert into public.user_ignores (user_id, ignored_id) values ($1, $2)`, [id(9), C])).rejects.toThrow(/user_ignores_user_id_fkey/);
  });

  it("forgets an account's ignores, both ways, when the account is deleted", async () => {
    await db.query(`insert into public.user_ignores (user_id, ignored_id) values ($1, $2), ($2, $3)`, [B, C, A]);
    await db.query(`delete from public.users where id = $1`, [C]);
    expect((await db.query(`select user_id, ignored_id from public.user_ignores`)).rows).toEqual([{ user_id: A, ignored_id: B }]);
  });

  it(`holds ${MAX_IGNORED} per account; someone already ignored and other people's ignores do not count`, async () => {
    const [D, E] = [50, 51].map(id);
    const many = Array.from({ length: MAX_IGNORED + 1 }, (_, i) => id(1000 + i));
    const ignore = (who: string, whom: string[]) =>
      db.query(`insert into public.user_ignores (user_id, ignored_id) select $1, unnest($2::uuid[])`, [who, whom]);
    const mine = async (who: string) => (await db.query<{ n: number }>(`select count(*)::int as n from public.user_ignores where user_id = $1`, [who])).rows[0].n;
    await db.exec(`insert into public.users values ${[D, E, ...many].map((u) => `('${u}')`).join(", ")}`);
    await ignore(D, many.slice(0, MAX_IGNORED - 1));
    await ignore(D, [many[MAX_IGNORED - 1]]);
    expect(await mine(D)).toBe(MAX_IGNORED);
    await expect(ignore(D, [many[MAX_IGNORED]])).rejects.toMatchObject({ code: "23514", message: "You can ignore up to 150 people" });
    // Ignoring someone again at the cap meets the primary key, which the route answers as a yes.
    await expect(ignore(D, [many[0]])).rejects.toThrow(/user_ignores_pkey/);
    await ignore(E, [many[0]]);
    await db.query(`delete from public.user_ignores where user_id = $1 and ignored_id = $2`, [D, many[0]]);
    await ignore(D, [many[MAX_IGNORED]]);
    expect([await mine(D), await mine(E)]).toEqual([MAX_IGNORED, 1]);
    // One ignore at a time per account: two at once wait for each other, then count (one connection cannot race here).
    expect(SQL).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\('user_ignores:' \|\| NEW\.user_id::text, 0\)\);\n\s+IF \(SELECT count\(\*\)/);
  });

  it("is the server's only", async () => {
    expect((await db.query(`select relrowsecurity as on from pg_class where relname = 'user_ignores'`)).rows).toEqual([{ on: true }]);
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["select", "insert", "delete"]) {
        expect((await db.query(`select has_table_privilege($1, 'public.user_ignores', $2) as can`, [role, priv])).rows, `${role} ${priv}`).toEqual([{ can: false }]);
      }
    }
    expect((await db.query(`select has_table_privilege('service_role', 'public.user_ignores', 'insert') as can`)).rows).toEqual([{ can: true }]);
    for (const [role, can] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      expect((await db.query(`select has_function_privilege($1, 'public.user_ignores_cap()', 'execute') as can`, [role])).rows, role).toEqual([{ can }]);
    }
    // The service role's insert runs through the cap.
    await db.exec(`set role service_role; insert into public.user_ignores (user_id, ignored_id) values ('${B}', '${id(1000)}'); reset role;`);
    expect((await db.query(`select count(*)::int as n from public.user_ignores where user_id = $1`, [B])).rows).toEqual([{ n: 1 }]);
  });

  it("rolls back to no table and no cap", async () => {
    await db.exec(ROLLBACK);
    expect((await db.query(`select to_regclass('public.user_ignores') as t, to_regprocedure('public.user_ignores_cap()') as f`)).rows).toEqual([{ t: null, f: null }]);
  });
});
