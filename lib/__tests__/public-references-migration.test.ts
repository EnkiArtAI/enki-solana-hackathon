import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/** migrations/2026-10-29-public-references.sql in a real Postgres: every image keeps its references to itself until its owner says otherwise. */
const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-29-public-references.sql"), "utf8");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");

describe("the public references migration", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`create table public.generated_images (id int primary key, visibility text not null default 'private');
      insert into public.generated_images values (1, 'public'), (2, 'private');`);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("runs twice without harm", async () => {
    await db.exec(SQL);
  });

  it("starts off for every image, old and new, and is never unknown", async () => {
    await db.query(`insert into public.generated_images (id) values (3)`);
    expect((await db.query(`select id, references_public from public.generated_images order by id`)).rows).toEqual([
      { id: 1, references_public: false }, { id: 2, references_public: false }, { id: 3, references_public: false },
    ]);
    await expect(db.query(`update public.generated_images set references_public = null where id = 1`)).rejects.toThrow(/null value/);
  });

  it("rolls back", async () => {
    await db.exec(ROLLBACK);
    expect((await db.query(`select count(*)::int as n from information_schema.columns where table_name = 'generated_images' and column_name = 'references_public'`)).rows).toEqual([{ n: 0 }]);
  });
});
