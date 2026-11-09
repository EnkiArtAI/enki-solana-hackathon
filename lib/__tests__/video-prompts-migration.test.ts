import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pglitePostgrest } from "./_pglite-postgrest";
import { VIDEO_SQL, videoColumns, videosNeedSql } from "../marketplace/video-columns";

/**
 * SQL 52 in a real Postgres, over the prompts and generated_images columns it touches (VERIFIED live 2026-11-03), and
 * lib/marketplace/video-columns.ts on that database, before and after it runs. Blind spot: PGlite is not Supabase's
 * Postgres, and its stand-in client answers 42703 as PostgREST does (`select=media_type: 400 42703`, read live).
 */
const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(...p), "utf8").split("\r\n").join("\n");
const SQL = read(ROOT, "migrations", "2026-11-03-video-prompts.sql");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
// A minute past whatever video-columns.ts kept, so each read below is a new one.
let now = 1_800_000_000_000;
const fresh = () => { now += 61_000; vi.spyOn(Date, "now").mockReturnValue(now); };

describe("SQL 52", () => {
  let db: PGlite;
  const columns = async () => (await db.query<{ c: string }>(`
    select table_name || '.' || column_name as c from information_schema.columns
     where table_schema = 'public' and column_name in ('media_type', 'showcase_video', 'video', 'duration_ms') order by 1`)).rows.map((r) => r.c);

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create table public.prompts (id uuid primary key default gen_random_uuid(), title text, is_listed boolean, created_at timestamptz default now());
      create table public.generated_images (id uuid primary key default gen_random_uuid());
      insert into public.prompts (title, is_listed) values ('old', true);`);
  });
  afterEach(() => vi.restoreAllMocks());

  it("before it runs the read says no, and the answer names the file", async () => {
    fresh();
    expect(await videoColumns(pglitePostgrest(db).client as never)).toBe(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = videosNeedSql({ query: "cats", creators: [] });
    expect(await res.json()).toEqual({ query: "cats", creators: [], prompts: [], hasMore: false, run: "52-video-prompts.sql" });
    expect(error).toHaveBeenCalledWith("[videos] prompts.media_type is missing: run sql-to-run/52-video-prompts.sql");
  });

  it("adds the four columns, twice without harm: an old row reads image, and a third medium is refused", async () => {
    await db.exec(SQL);
    await db.exec(SQL);
    expect(await columns()).toEqual(["generated_images.duration_ms", "generated_images.video", "prompts.media_type", "prompts.showcase_video"]);
    expect((await db.query<{ media_type: string }>(`select media_type from public.prompts`)).rows).toEqual([{ media_type: "image" }]);
    await db.exec(`insert into public.prompts (title, media_type) values ('v', 'video')`);
    await expect(db.exec(`insert into public.prompts (title, media_type) values ('x', 'audio')`)).rejects.toMatchObject({ code: "23514" });
    await expect(db.exec(`insert into public.prompts (title, media_type) values ('x', null)`)).rejects.toMatchObject({ code: "23502" });
    expect((await db.query(`select 1 from pg_indexes where indexname = 'prompts_media_listed_idx' and indexdef like '%(media_type, created_at DESC)%WHERE is_listed%'`)).rows).toHaveLength(1);
  });

  it("after it runs the read says yes, and keeps its answer for a minute", async () => {
    fresh();
    const real = pglitePostgrest(db).client;
    const from = vi.fn((table: string) => real.from(table));
    const client = { from };
    expect(await videoColumns(client as never)).toBe(true);
    expect(from).toHaveBeenCalledTimes(1);
    expect(await videoColumns(client as never)).toBe(true);
    expect(from).toHaveBeenCalledTimes(1);
    fresh();
    expect(await videoColumns(client as never)).toBe(true);
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("an outage says no and is not kept: the next read asks again", async () => {
    fresh();
    const down = { from: vi.fn(() => ({ select: () => ({ limit: async () => ({ data: null, error: { code: "", message: "fetch failed" } }) }) })) };
    expect(await videoColumns(down as never)).toBe(false);
    expect(await videoColumns(down as never)).toBe(false);
    expect(down.from).toHaveBeenCalledTimes(2);
    const thrown = { from: () => { throw new Error("down"); } };
    expect(await videoColumns(thrown as never)).toBe(false);
  });

  it("its Rollback takes all four away, and the read says no again", async () => {
    await db.exec(ROLLBACK);
    expect(await columns()).toEqual([]);
    fresh();
    expect(await videoColumns(pglitePostgrest(db).client as never)).toBe(false);
    expect((await db.query(`select 1 from pg_indexes where indexname = 'prompts_media_listed_idx'`)).rows).toHaveLength(0);
  });

  it("ends with a Check, and the file the answer names is this one, byte for byte", () => {
    expect(SQL).toContain("-- Check:");
    expect(VIDEO_SQL).toBe("52-video-prompts.sql");
    const copy = join(ROOT, "..", "sql-to-run", VIDEO_SQL);
    if (existsSync(copy)) expect(read(copy)).toBe(SQL);
  });
});
