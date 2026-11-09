import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * SQL 71 on a real Postgres (PGlite), the column absent first as it is live: it runs twice, keeps a style through the second
 * run, and its own Check and Rollback, read out of the file, do what they say. Blind spot: PGlite's stand-in users table holds
 * only what this file needs; the live table's triggers and policies are not here.
 */
const SQL = readFileSync(join(__dirname, "..", "..", "..", "migrations", "2026-11-04-share-style.sql"), "utf8").replace(/\r\n/g, "\n");
const after = (label: string) => new RegExp(`-- ${label}[^\\n]*\\n--\\s+([^\\n]+)`).exec(SQL)![1];
const ME = "00000000-0000-4000-8000-000000000001";

describe("SQL 71: users.share_style", () => {
  let db: PGlite;
  const column = async () => (await db.query<{ data_type: string; is_nullable: string }>(`select data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'share_style'`)).rows;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`create table public.users (id uuid primary key, handle text); insert into public.users (id, handle) values ('${ME}', 'mira');`);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("the column is absent, then present: jsonb, nullable, every row without a style", async () => {
    expect(await column()).toEqual([]);
    await db.exec(SQL);
    expect(await column()).toEqual([{ data_type: "jsonb", is_nullable: "YES" }]);
    expect((await db.query<{ s: unknown }>(`select share_style as s from public.users`)).rows).toEqual([{ s: null }]);
  });

  it("runs a second time and keeps what was saved", async () => {
    await db.query(`update public.users set share_style = $1 where id = $2`, [JSON.stringify({ image: { ratio: "4:5" } }), ME]);
    await db.exec(SQL);
    expect((await db.query<{ s: unknown }>(`select share_style as s from public.users`)).rows).toEqual([{ s: { image: { ratio: "4:5" } } }]);
  });

  it("its Check counts the users and the styles", async () => {
    expect(after("Check")).toBe("SELECT count(*), count(share_style) FROM public.users;");
    expect((await db.query<{ count: number }>(after("Check"))).rows[0]).toMatchObject({ count: 1 });
  });

  it("its Rollback takes the column away, the row stays, and it runs twice", async () => {
    await db.exec(after("Rollback"));
    expect(await column()).toEqual([]);
    await db.exec(after("Rollback"));
    expect((await db.query<{ handle: string }>(`select handle from public.users`)).rows).toEqual([{ handle: "mira" }]);
  });
});
