import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { REFERENCE_BUCKET } from "@/lib/reference-library";
import {
  MAX_CHARACTERS, MAX_CONTENT_IMAGES, MAX_CONTENTS, MAX_MASTER_PROMPTS, MAX_PALETTE, MAX_PROJECT_ASSETS, MAX_PROJECTS,
  MAX_STUDIO_ASSETS, MAX_STYLES, STUDIO_BUCKET, STUDIO_TEXT,
} from "@/lib/studio/types";

/**
 * migrations/2026-10-30-studio.sql (SQL 53; Kev, 2026-10-30: "a collection of projects containing different content
 * pieces that all access the same reference images, characters, styles and master prompts") in a real Postgres, on
 * Supabase's roles and default privileges: every child row is its project's owner's (composite keys), a character has
 * exactly one picture and only its own project's asset, names are unique per account and per project, the caps of
 * lib/studio/types.ts hold, a project's delete takes everything in it and never a render, only the service role reaches
 * it, the pictures' bucket is SQL 51's private one, and the read-back and rollback at its end work.
 */
const FILE = join(__dirname, "..", "..", "migrations", "2026-10-30-studio.sql");
const SQL = readFileSync(FILE, "utf8");
const lines = (from: string, to?: string) => SQL.slice(SQL.indexOf(from), to ? SQL.indexOf(to) : undefined)
  .split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5));
const READ_BACK = lines("-- Read back", "-- Rollback");
const ROLLBACK = lines("-- Rollback").join("\n");
const TABLES = ["studio_projects", "studio_assets", "studio_characters", "studio_styles", "studio_master_prompts", "studio_contents", "studio_content_images"];
// Kev's copy for the SQL editor, outside the repo: compared where it exists (his checkout), skipped elsewhere (CI).
const COPY = join(__dirname, "..", "..", "..", "sql-to-run", "53-studio.sql");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C] = [1, 2, 3].map(id);
const SHEET = id(900);
const [RENDER, RENDER2, HERS] = [800, 801, 802].map(id);

describe("the Studio migration", () => {
  let db: PGlite;
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params).then((r) => r.rows);
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
  const project = async (who: string, name: string) => (await one<{ id: string }>(`insert into public.studio_projects (user_id, name) values ($1, $2) returning id`, [who, name])).id;
  const asset = async (p: string, who: string, hash: string) =>
    (await one<{ id: string }>(`insert into public.studio_assets (project_id, user_id, path, content_hash) values ($1, $2, 'p', $3) returning id`, [p, who, hash])).id;
  const content = async (p: string, who: string, name: string) =>
    (await one<{ id: string }>(`insert into public.studio_contents (project_id, user_id, name) values ($1, $2, $3) returning id`, [p, who, name])).id;
  const count = async (table: string, where = "true", params: unknown[] = []) => (await one<{ n: number }>(`select count(*)::int as n from public.${table} where ${where}`, params)).n;

  beforeAll(async () => {
    db = await PGlite.create();
    // Supabase's roles and default grants (everything to anon and authenticated unless a migration revokes it), and the
    // live tables SQL 53 points at, with the columns it needs (VERIFIED live 2026-10-30).
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
      create table public.users (id uuid primary key);
      insert into public.users values ('${A}'), ('${B}'), ('${C}');
      create table public.prompts (id uuid primary key);
      insert into public.prompts values ('${SHEET}');
      create table public.generated_images (id uuid primary key, user_id uuid references public.users(id), is_uploaded boolean default false, deleted_at timestamptz);
      insert into public.generated_images (id, user_id) values ('${RENDER}', '${A}'), ('${RENDER2}', '${A}'), ('${HERS}', '${B}');
      create schema storage;
      create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
    `);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("runs twice without harm, keeping the rows there are", async () => {
    const p = await project(C, "Kept");
    await db.exec(SQL);
    expect(await q(`select name from public.studio_projects where id = $1`, [p])).toEqual([{ name: "Kept" }]);
    await q(`delete from public.studio_projects where id = $1`, [p]);
  });

  it("keeps the pictures in SQL 51's private bucket with SQL 51's settings, made where none is, private again if made public", async () => {
    expect(STUDIO_BUCKET).toBe(REFERENCE_BUCKET);
    const bucket = `select id, name, public, file_size_limit::int as limit, allowed_mime_types from storage.buckets`;
    const PRIVATE = { id: REFERENCE_BUCKET, name: REFERENCE_BUCKET, public: false, limit: 4194304, allowed_mime_types: ["image/png", "image/jpeg", "image/webp"] };
    expect(await q(bucket)).toEqual([PRIVATE]);
    await q(`update storage.buckets set public = true, file_size_limit = null`);
    await db.exec(SQL);
    expect(await q(bucket)).toEqual([PRIVATE]);
    // Word for word SQL 51's INSERT, so whichever runs second changes nothing.
    const SQL51 = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-29-reference-uploads.sql"), "utf8");
    const insert = (s: string) => s.slice(s.indexOf("INSERT INTO storage.buckets"), s.indexOf("excluded.allowed_mime_types;") + 28);
    expect(insert(SQL)).toBe(insert(SQL51));
  });

  it("holds one project name per account (case and spaces ignored), any name for another account; a name is never blank, the fields have their lengths", async () => {
    await project(A, "Moonlight");
    await expect(project(A, " moonlight ")).rejects.toMatchObject({ code: "23505" });
    await expect(project(B, "Moonlight")).resolves.toBeTruthy();
    await expect(project(A, "   ")).rejects.toMatchObject({ code: "23514" });
    await expect(project(A, "x".repeat(STUDIO_TEXT.name + 1))).rejects.toMatchObject({ code: "23514" });
    await expect(project(A, ` ${"x".repeat(STUDIO_TEXT.name)} `)).resolves.toBeTruthy();
    await expect(q(`insert into public.studio_projects (user_id, name, description) values ($1, 'd', $2)`, [A, "x".repeat(STUDIO_TEXT.description + 1)])).rejects.toMatchObject({ code: "23514" });
    await expect(q(`insert into public.studio_projects (user_id, name, link) values ($1, 'l', $2)`, [A, `https://${"x".repeat(STUDIO_TEXT.link - 7)}`])).rejects.toMatchObject({ code: "23514" });
    await q(`delete from public.studio_projects where name <> 'Moonlight'`);
  });

  it("takes a link only when it is http(s), and none at all", async () => {
    for (const bad of ["javascript:alert(1)", "ftp://enki.art", "enki.art", "HTTPS://enki.art"]) {
      await expect(q(`insert into public.studio_projects (user_id, name, link) values ($1, 'x', $2)`, [A, bad]), bad).rejects.toMatchObject({ code: "23514" });
    }
    await q(`insert into public.studio_projects (user_id, name, link) values ($1, 'a', 'https://enki.art'), ($1, 'b', 'http://enki.art'), ($1, 'c', null)`, [A]);
    await q(`delete from public.studio_projects where name in ('a', 'b', 'c')`);
  });

  it("holds a content piece's link and description as a project's, and every name to 1-60 characters", async () => {
    const P = (await one<{ id: string }>(`select id from public.studio_projects where user_id = $1`, [A])).id;
    const piece = (name: string, description: string | null, link: string | null) =>
      q(`insert into public.studio_contents (project_id, user_id, name, description, link) values ($1, $2, $3, $4, $5)`, [P, A, name, description, link]);
    for (const bad of ["javascript:alert(1)", "ftp://enki.art", "enki.art", "HTTPS://enki.art", `https://${"x".repeat(STUDIO_TEXT.link - 7)}`]) {
      await expect(piece("x", null, bad), bad.slice(0, 20)).rejects.toMatchObject({ code: "23514" });
    }
    await expect(piece("x", "x".repeat(STUDIO_TEXT.description + 1), null)).rejects.toMatchObject({ code: "23514" });
    await piece("x", "x".repeat(STUDIO_TEXT.description), `https://${"x".repeat(STUDIO_TEXT.link - 8)}`);
    const named = {
      studio_styles: (name: string) => q(`insert into public.studio_styles (project_id, user_id, name) values ($1, $2, $3)`, [P, A, name]),
      studio_master_prompts: (name: string) => q(`insert into public.studio_master_prompts (project_id, user_id, name, prompt) values ($1, $2, $3, 'p')`, [P, A, name]),
      studio_contents: (name: string) => piece(name, null, null),
    };
    for (const [table, insert] of Object.entries(named)) {
      for (const bad of ["   ", "x".repeat(STUDIO_TEXT.name + 1)]) await expect(insert(bad), `${table} ${bad.length}`).rejects.toMatchObject({ code: "23514" });
      await insert(` ${"y".repeat(STUDIO_TEXT.name)} `);
    }
    for (const table of Object.keys(named)) await q(`delete from public.${table} where project_id = $1`, [P]);
  });

  it("refuses a child row whose owner is not its project's (composite key), and a character on another project's asset", async () => {
    const P = (await one<{ id: string }>(`select id from public.studio_projects where user_id = $1`, [A])).id;
    await expect(q(`insert into public.studio_assets (project_id, user_id, path, content_hash) values ($1, $2, 'p', 'h')`, [P, B])).rejects.toMatchObject({ code: "23503" });
    await expect(q(`insert into public.studio_styles (project_id, user_id, name) values ($1, $2, 's')`, [P, B])).rejects.toMatchObject({ code: "23503" });
    await expect(q(`insert into public.studio_master_prompts (project_id, user_id, name, prompt) values ($1, $2, 'm', 'p')`, [P, B])).rejects.toMatchObject({ code: "23503" });
    await expect(content(P, B, "x")).rejects.toMatchObject({ code: "23503" });
    await expect(q(`insert into public.studio_characters (project_id, user_id, name, image_id) values ($1, $2, 'x', $3)`, [P, B, HERS])).rejects.toMatchObject({ code: "23503" });
    const other = await project(A, "Other");
    const a = await asset(P, A, "shared");
    await expect(q(`insert into public.studio_characters (project_id, user_id, name, asset_id) values ($1, $2, 'X', $3)`, [other, A, a])).rejects.toMatchObject({ code: "23503" });
    // The same picture is a second project's to add as well, once per project.
    await asset(other, A, "shared");
    await expect(asset(P, A, "shared")).rejects.toMatchObject({ code: "23505" });
    await q(`delete from public.studio_projects where id = $1`, [other]);
    await q(`delete from public.studio_assets where content_hash = 'shared'`);
  });

  it("gives a character exactly one picture; an asset a character uses is not deleted alone (23503); the sheet's key is named for the route", async () => {
    const P = (await one<{ id: string }>(`select id from public.studio_projects where user_id = $1 and name = 'Moonlight'`, [A])).id;
    const a = await asset(P, A, "h1");
    const character = `insert into public.studio_characters (project_id, user_id, name, image_id, asset_id, sheet_prompt_id) values ($1, $2, $3, $4, $5, $6)`;
    await expect(q(character, [P, A, "Mira", null, null, null])).rejects.toMatchObject({ code: "23514" });
    await expect(q(character, [P, A, "Mira", RENDER, a, null])).rejects.toMatchObject({ code: "23514" });
    await expect(q(character, [P, A, " ", null, a, null])).rejects.toMatchObject({ code: "23514" });
    await q(character, [P, A, "Mira", null, a, null]);
    await q(character, [P, A, "Rex", RENDER, null, SHEET]);
    await expect(q(`delete from public.studio_assets where id = $1`, [a])).rejects.toMatchObject({ code: "23503" });
    // app/api/studio answers a sheet gone from Enki by this key's name in the message (SHEET_GONE).
    await expect(q(character, [P, A, "Ghost", RENDER2, null, id(999)])).rejects.toMatchObject({ code: "23503", message: expect.stringContaining("sheet_prompt_id") });
    // A sheet deleted from Enki leaves the character, with no sheet.
    await q(`delete from public.prompts where id = $1`, [SHEET]);
    expect(await q(`select name, sheet_prompt_id from public.studio_characters where name = 'Rex'`)).toEqual([{ name: "Rex", sheet_prompt_id: null }]);
  });

  it(`takes a palette of up to ${MAX_PALETTE} lower-case #rrggbb colours, and none`, async () => {
    const P = (await one<{ id: string }>(`select id from public.studio_projects where user_id = $1 and name = 'Moonlight'`, [A])).id;
    const style = (name: string, palette: string[] | null) => q(`insert into public.studio_styles (project_id, user_id, name, palette) values ($1, $2, $3, coalesce($4::text[], '{}'))`, [P, A, name, palette]);
    await style("Bold", ["#7d1d33", "#cba24a"]);
    await style("Plain", null);
    await style("Full", Array(MAX_PALETTE).fill("#000000"));
    for (const bad of [["#7D1D33"], ["red"], ["#7d1d3"], ["#7d1d33 "], Array(MAX_PALETTE + 1).fill("#000000")]) {
      await expect(style("Bad", bad), JSON.stringify(bad)).rejects.toMatchObject({ code: "23514" });
    }
    await expect(q(`insert into public.studio_styles (project_id, user_id, name, words) values ($1, $2, 'w', $3)`, [P, A, "x".repeat(STUDIO_TEXT.words + 1)])).rejects.toMatchObject({ code: "23514" });
    expect(await q(`select words, palette from public.studio_styles where name = 'Plain'`)).toEqual([{ words: "", palette: [] }]);
    await expect(q(`insert into public.studio_master_prompts (project_id, user_id, name, prompt) values ($1, $2, 'm', '  ')`, [P, A])).rejects.toMatchObject({ code: "23514" });
    await expect(q(`insert into public.studio_master_prompts (project_id, user_id, name, prompt) values ($1, $2, 'm', $3)`, [P, A, "x".repeat(STUDIO_TEXT.prompt + 1)])).rejects.toMatchObject({ code: "23514" });
  });

  it("holds one content name per project; a style or master prompt deleted leaves its pieces with none; a filing is its piece's owner's", async () => {
    const P = (await one<{ id: string }>(`select id from public.studio_projects where user_id = $1 and name = 'Moonlight'`, [A])).id;
    const S = (await one<{ id: string }>(`select id from public.studio_styles where name = 'Bold'`)).id;
    const M = (await one<{ id: string }>(`insert into public.studio_master_prompts (project_id, user_id, name, prompt) values ($1, $2, 'Brand', 'moody') returning id`, [P, A])).id;
    const piece = (await one<{ id: string }>(`insert into public.studio_contents (project_id, user_id, name, style_id, master_prompt_id) values ($1, $2, 'Launch', $3, $4) returning id`, [P, A, S, M])).id;
    await expect(content(P, A, " LAUNCH")).rejects.toMatchObject({ code: "23505" });
    const other = await project(A, "Second");
    await content(other, A, "Launch");
    await q(`delete from public.studio_styles where id = $1`, [S]);
    await q(`delete from public.studio_master_prompts where id = $1`, [M]);
    expect(await q(`select style_id, master_prompt_id from public.studio_contents where id = $1`, [piece])).toEqual([{ style_id: null, master_prompt_id: null }]);
    await q(`insert into public.studio_content_images (content_id, user_id, image_id) values ($1, $2, $3)`, [piece, A, RENDER]);
    await expect(q(`insert into public.studio_content_images (content_id, user_id, image_id) values ($1, $2, $3)`, [piece, A, RENDER])).rejects.toMatchObject({ code: "23505" });
    await expect(q(`insert into public.studio_content_images (content_id, user_id, image_id) values ($1, $2, $3)`, [piece, B, HERS])).rejects.toMatchObject({ code: "23503" });
    expect(await q(`select added_at is not null as dated from public.studio_content_images`)).toEqual([{ dated: true }]);
    await q(`delete from public.studio_projects where id = $1`, [other]);
  });

  it("a render deleted from the gallery for good takes its filings and its character; deleting a piece never deletes a render", async () => {
    const piece = (await one<{ id: string }>(`select id from public.studio_contents where name = 'Launch'`)).id;
    await q(`insert into public.studio_content_images (content_id, user_id, image_id) values ($1, $2, $3)`, [piece, A, RENDER2]);
    await q(`delete from public.generated_images where id = $1`, [RENDER]);
    expect(await count("studio_content_images")).toBe(1);
    expect(await count("studio_characters", "name = 'Rex'")).toBe(0);
    await q(`delete from public.studio_contents where id = $1`, [piece]);
    expect([await count("studio_content_images"), await count("generated_images", "id = $1", [RENDER2])]).toEqual([0, 1]);
  });

  it("a project's delete takes its assets (the characters made of them too), styles, master prompts, contents and filings", async () => {
    const P = (await one<{ id: string }>(`select id from public.studio_projects where user_id = $1 and name = 'Moonlight'`, [A])).id;
    const piece = await content(P, A, "Again");
    await q(`insert into public.studio_content_images (content_id, user_id, image_id) values ($1, $2, $3)`, [piece, A, RENDER2]);
    expect(await count("studio_characters", "asset_id is not null")).toBe(1);
    await q(`delete from public.studio_projects where id = $1`, [P]);
    for (const t of TABLES) expect(await count(t, "user_id = $1", [A]), t).toBe(0);
    expect(await count("generated_images", "id = $1", [RENDER2])).toBe(1);
  });

  it("a deleted account takes its projects and everything in them", async () => {
    const P = await project(C, "Gone");
    await asset(P, C, "c1");
    await content(P, C, "c");
    await q(`delete from public.users where id = $1`, [C]);
    for (const t of TABLES) expect(await count(t, "user_id = $1", [C]), t).toBe(0);
  });

  it("holds every cap of lib/studio/types.ts, by the count it names, and says which one in its message", async () => {
    // The trigger arguments are the contract's numbers.
    const caps = [...SQL.matchAll(/CREATE TRIGGER (\w+) BEFORE INSERT ON public\.(\w+) FOR EACH ROW EXECUTE FUNCTION public\.studio_cap\('(\w+)', '(\d+)'\);/g)]
      .map(([, , table, column, n]) => [table, column, Number(n)]);
    expect(caps).toEqual([
      ["studio_projects", "user_id", MAX_PROJECTS],
      ["studio_assets", "project_id", MAX_PROJECT_ASSETS],
      ["studio_assets", "user_id", MAX_STUDIO_ASSETS],
      ["studio_characters", "project_id", MAX_CHARACTERS],
      ["studio_styles", "project_id", MAX_STYLES],
      ["studio_master_prompts", "project_id", MAX_MASTER_PROMPTS],
      ["studio_contents", "project_id", MAX_CONTENTS],
      ["studio_content_images", "content_id", MAX_CONTENT_IMAGES],
    ]);
    const full = (table: string, column: string) => ({ code: "23514", message: `studio cap ${table} ${column}` });
    // Projects: per account; another account is not counted.
    await q(`insert into public.studio_projects (user_id, name) select $1, 'p' || n from generate_series(1, $2::int) n`, [A, MAX_PROJECTS]);
    await expect(project(A, "one more")).rejects.toMatchObject(full("studio_projects", "user_id"));
    expect(await count("studio_projects", "user_id = $1", [A])).toBe(MAX_PROJECTS);
    const [P1, P2, P3] = (await q<{ id: string }>(`select id from public.studio_projects where user_id = $1 order by name limit 3`, [A])).map((r) => r.id);
    // Assets: per project, then per account across its projects.
    const assets = (p: string, n: number, tag: string) =>
      q(`insert into public.studio_assets (project_id, user_id, path, content_hash) select $1, $2, 'p', $3 || n from generate_series(1, $4::int) n`, [p, A, tag, n]);
    await assets(P1, MAX_PROJECT_ASSETS, "a");
    await expect(asset(P1, A, "a-more")).rejects.toMatchObject(full("studio_assets", "project_id"));
    await assets(P2, MAX_PROJECT_ASSETS, "b");
    await assets(P3, MAX_STUDIO_ASSETS - 2 * MAX_PROJECT_ASSETS, "c");
    await expect(asset(P3, A, "c-more")).rejects.toMatchObject(full("studio_assets", "user_id"));
    // The rest: per project, and filings per piece.
    const renders = await q<{ id: string }>(`insert into public.generated_images (id, user_id) select gen_random_uuid(), $1 from generate_series(1, $2::int) returning id`, [A, MAX_CONTENT_IMAGES + 1]);
    const fill: [string, string, number, string][] = [
      ["studio_characters", "project_id", MAX_CHARACTERS, `insert into public.studio_characters (project_id, user_id, name, image_id) values ($1, $2, 'c', $3)`],
      ["studio_styles", "project_id", MAX_STYLES, `insert into public.studio_styles (project_id, user_id, name) values ($1, $2, 's')`],
      ["studio_master_prompts", "project_id", MAX_MASTER_PROMPTS, `insert into public.studio_master_prompts (project_id, user_id, name, prompt) values ($1, $2, 'm', 'p')`],
    ];
    for (const [table, column, cap, insert] of fill) {
      const params = (i: number) => (table === "studio_characters" ? [P1, A, renders[i].id] : [P1, A]);
      for (let i = 0; i < cap; i++) await q(insert, params(i));
      await expect(q(insert, params(cap)), table).rejects.toMatchObject(full(table, column));
      expect(await count(table, "project_id = $1", [P1])).toBe(cap);
    }
    await q(`insert into public.studio_contents (project_id, user_id, name) select $1, $2, 'piece ' || n from generate_series(1, $3::int) n`, [P1, A, MAX_CONTENTS]);
    await expect(content(P1, A, "one more")).rejects.toMatchObject(full("studio_contents", "project_id"));
    const piece = (await one<{ id: string }>(`select id from public.studio_contents where project_id = $1 limit 1`, [P1])).id;
    for (let i = 0; i < MAX_CONTENT_IMAGES; i++) await q(`insert into public.studio_content_images (content_id, user_id, image_id) values ($1, $2, $3)`, [piece, A, renders[i].id]);
    await expect(q(`insert into public.studio_content_images (content_id, user_id, image_id) values ($1, $2, $3)`, [piece, A, renders[MAX_CONTENT_IMAGES].id]))
      .rejects.toMatchObject(full("studio_content_images", "content_id"));
    // Another account starts from none.
    await expect(project(B, "Second of hers")).resolves.toBeTruthy();
    // One write at a time per counted value: two at once wait for each other, then count (one connection cannot race here).
    expect(SQL).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\(TG_TABLE_NAME \|\| ':' \|\| TG_ARGV\[0\] \|\| ':' \|\| owner::text, 0\)\);\n\s+EXECUTE format\('SELECT count\(\*\)/);
  }, 60_000);

  it("is the server's only: RLS on, nothing for anon or authenticated, the cap no one else's to run; the service role writes through the caps", async () => {
    for (const t of TABLES) {
      expect(await q(`select relrowsecurity as on from pg_class where relname = $1`, [t]), t).toEqual([{ on: true }]);
      for (const role of ["anon", "authenticated"]) {
        for (const priv of ["select", "insert", "update", "delete"]) {
          expect(await q(`select has_table_privilege($1, $2, $3) as can`, [role, `public.${t}`, priv]), `${role} ${priv} ${t}`).toEqual([{ can: false }]);
        }
      }
      expect(await q(`select has_table_privilege('service_role', $1, 'insert') as can`, [`public.${t}`])).toEqual([{ can: true }]);
    }
    for (const [role, can] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      expect(await q(`select has_function_privilege($1, 'public.studio_cap()', 'execute') as can`, [role]), role).toEqual([{ can }]);
    }
    await db.exec(`set role service_role; insert into public.studio_projects (user_id, name) values ('${B}', 'By the server'); reset role;`);
    expect(await count("studio_projects", "user_id = $1", [B])).toBe(3);
  });

  it("reads back as its end says: seven tables, eight caps, RLS on everywhere, anon reads nothing, the bucket private", async () => {
    expect(READ_BACK).toHaveLength(5);
    const [tables, triggers, rls, anon, bucket] = await Promise.all(READ_BACK.map((s) => q(s)));
    expect(Object.values(tables[0])).toEqual(TABLES);
    expect(triggers.map((r) => r.tgname)).toEqual([
      "studio_assets_cap_account", "studio_assets_cap_project", "studio_characters_cap", "studio_content_images_cap",
      "studio_contents_cap", "studio_master_prompts_cap", "studio_projects_cap", "studio_styles_cap",
    ]);
    expect(rls).toEqual([...TABLES].sort().map((relname) => ({ relname, relrowsecurity: true })));
    expect(anon).toEqual([{ anon_reads: false }]);
    expect(bucket).toEqual([{ id: REFERENCE_BUCKET, public: false, file_size_limit: 4194304, allowed_mime_types: ["image/png", "image/jpeg", "image/webp"] }]);
  });

  it("rolls back to no table and no function, the bucket and the renders left", async () => {
    await db.exec(ROLLBACK);
    expect(await count("generated_images")).toBeGreaterThan(0);
    expect(await q(`select count(*)::int as n from pg_class where relname like 'studio_%' and relkind = 'r'`)).toEqual([{ n: 0 }]);
    expect(await q(`select to_regprocedure('public.studio_cap()') as f`)).toEqual([{ f: null }]);
    expect(await q(`select count(*)::int as n from storage.buckets`)).toEqual([{ n: 1 }]);
  });

  it.skipIf(!existsSync(COPY))("is copied to sql-to-run/53-studio.sql byte for byte", async () => {
    // Read past the in-memory mutation runner (it patches readFileSync only): this compares the files on disk.
    expect((await readFile(COPY)).equals(await readFile(FILE))).toBe(true);
  });
});
