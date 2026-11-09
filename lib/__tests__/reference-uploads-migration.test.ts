import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { MAX_REFERENCES, REFERENCE_BUCKET } from "@/lib/reference-library";

/**
 * migrations/2026-10-29-reference-uploads.sql (SQL 51) in a real Postgres, on Supabase's roles and default privileges:
 * one row per (account, picture), an id and a time of its own, a deleted account takes its rows with it, at most
 * MAX_REFERENCES kept per account (neither a deleted one nor the picture being saved again counts), only the service
 * role reaches it, and the pictures' bucket is private (DEC-525).
 */
const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-29-reference-uploads.sql"), "utf8");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C] = [1, 2, 3].map(id);
const hash = (n: number) => n.toString(16).padStart(64, "0");
// What the route sends (app/api/references POST): an upsert on (user_id, content_hash) that moves the time and clears
// a deletion.
const SAVE = `insert into public.reference_uploads (user_id, path, thumb_path, content_hash, created_at, deleted_at) values ($1, $2, $3, $4, $5, null)
  on conflict (user_id, content_hash) do update set path = excluded.path, thumb_path = excluded.thumb_path, created_at = excluded.created_at, deleted_at = excluded.deleted_at`;

describe("the reference_uploads migration", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await PGlite.create();
    // storage.buckets as Supabase has it (the columns VERIFIED live 2026-10-29), with the bucket made public by hand.
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create table public.users (id uuid primary key);
      insert into public.users values ('${A}'), ('${B}'), ('${C}');
      create schema storage;
      create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
      insert into storage.buckets (id, name, public) values ('${REFERENCE_BUCKET}', '${REFERENCE_BUCKET}', true);
    `);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("keeps the pictures in a private bucket of their own, PNG, JPEG and WebP up to 4 MB, private again if made public", async () => {
    expect(REFERENCE_BUCKET).toBe("reference-uploads");
    expect((await db.query(`select id, name, public, file_size_limit::int as limit, allowed_mime_types from storage.buckets`)).rows).toEqual([
      { id: REFERENCE_BUCKET, name: REFERENCE_BUCKET, public: false, limit: 4194304, allowed_mime_types: ["image/png", "image/jpeg", "image/webp"] }]);
    // Made where none is.
    await db.exec(`delete from storage.buckets`);
    await db.exec(SQL);
    expect((await db.query(`select id, public from storage.buckets`)).rows).toEqual([{ id: REFERENCE_BUCKET, public: false }]);
  });

  it("runs twice without harm, keeping the saved references there are; each gets an id and a time, and is not deleted", async () => {
    await db.query(`insert into public.reference_uploads (user_id, path, content_hash) values ($1, 'p1', $2)`, [A, hash(1)]);
    await db.exec(SQL);
    expect((await db.query(`select user_id, path, thumb_path, content_hash, deleted_at, id is not null as has_id, created_at is not null as dated from public.reference_uploads`)).rows)
      .toEqual([{ user_id: A, path: "p1", thumb_path: null, content_hash: hash(1), deleted_at: null, has_id: true, dated: true }]);
  });

  it("holds one row per picture and account, needs an owner, a path and a hash, and refuses anyone who is not an account", async () => {
    await expect(db.query(`insert into public.reference_uploads (user_id, path, content_hash) values ($1, 'again', $2)`, [A, hash(1)])).rejects.toThrow(/reference_uploads_one_per_picture/);
    // The same picture is someone else's to save too.
    await db.query(`insert into public.reference_uploads (user_id, path, content_hash) values ($1, 'b1', $2)`, [B, hash(1)]);
    await expect(db.query(`insert into public.reference_uploads (user_id, path, content_hash) values ($1, null, $2)`, [A, hash(2)])).rejects.toThrow(/null value in column "path"/);
    await expect(db.query(`insert into public.reference_uploads (user_id, path, content_hash) values ($1, 'x', null)`, [A])).rejects.toThrow(/null value in column "content_hash"/);
    await expect(db.query(`insert into public.reference_uploads (user_id, path, content_hash) values (null, 'x', $1)`, [hash(2)])).rejects.toThrow(/null value in column "user_id"/);
    await expect(db.query(`insert into public.reference_uploads (user_id, path, content_hash) values ($1, 'x', $2)`, [id(9), hash(2)])).rejects.toThrow(/reference_uploads_user_id_fkey/);
  });

  it("saving the same picture again is the same row, at the newer time, no longer deleted", async () => {
    const [before] = (await db.query<{ id: string }>(`select id from public.reference_uploads where user_id = $1`, [A])).rows;
    await db.query(`update public.reference_uploads set deleted_at = now() where user_id = $1`, [A]);
    await db.query(SAVE, [A, "p1", "t1", hash(1), "2030-01-01T00:00:00Z"]);
    expect((await db.query(`select id, thumb_path, deleted_at, created_at = '2030-01-01T00:00:00Z'::timestamptz as moved from public.reference_uploads where user_id = $1`, [A])).rows)
      .toEqual([{ id: before.id, thumb_path: "t1", deleted_at: null, moved: true }]);
  });

  it("forgets an account's saved references when the account is deleted", async () => {
    await db.query(`insert into public.reference_uploads (user_id, path, content_hash) values ($1, 'c1', $2)`, [C, hash(3)]);
    await db.query(`delete from public.users where id = $1`, [C]);
    expect((await db.query(`select user_id from public.reference_uploads order by user_id`)).rows).toEqual([{ user_id: A }, { user_id: B }]);
  });

  it(`holds ${MAX_REFERENCES} kept per account; a deleted one, the picture saved again and other accounts' do not count`, async () => {
    const [D, E] = [50, 51].map(id);
    await db.exec(`insert into public.users values ('${D}'), ('${E}')`);
    const save = (who: string, n: number) => db.query(SAVE, [who, `p${n}`, null, hash(n), new Date().toISOString()]);
    const kept = async (who: string) => (await db.query<{ n: number }>(`select count(*)::int as n from public.reference_uploads where user_id = $1 and deleted_at is null`, [who])).rows[0].n;
    await db.query(`insert into public.reference_uploads (user_id, path, content_hash) select $1, 'p' || n, lpad(to_hex(n), 64, '0') from generate_series(1, $2::int - 1) n`, [D, MAX_REFERENCES]);
    // Deleted ones beside them.
    await db.query(`insert into public.reference_uploads (user_id, path, content_hash, deleted_at) select $1, 'q' || n, lpad(to_hex(n), 64, '0'), now() from generate_series(9001, 9003) n`, [D]);
    await save(D, MAX_REFERENCES);
    expect(await kept(D)).toBe(MAX_REFERENCES);
    await expect(save(D, MAX_REFERENCES + 1)).rejects.toMatchObject({ code: "23514", message: "You can keep up to 50 references" });
    // Nor does a deleted one come back past the cap.
    await expect(save(D, 9001)).rejects.toMatchObject({ code: "23514" });
    // At the cap, a picture already kept moves to the top: a yes.
    await save(D, 7);
    await save(E, MAX_REFERENCES + 1);
    await db.query(`update public.reference_uploads set deleted_at = now() where user_id = $1 and content_hash = $2`, [D, hash(7)]);
    await save(D, MAX_REFERENCES + 1);
    expect([await kept(D), await kept(E)]).toEqual([MAX_REFERENCES, 1]);
    // One save at a time per account: two at once wait for each other, then count (one connection cannot race here).
    expect(SQL).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\('reference_uploads:' \|\| NEW\.user_id::text, 0\)\);\n\s+IF \(SELECT count\(\*\)/);
  });

  it("is the server's only", async () => {
    expect((await db.query(`select relrowsecurity as on from pg_class where relname = 'reference_uploads'`)).rows).toEqual([{ on: true }]);
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["select", "insert", "update", "delete"]) {
        expect((await db.query(`select has_table_privilege($1, 'public.reference_uploads', $2) as can`, [role, priv])).rows, `${role} ${priv}`).toEqual([{ can: false }]);
      }
    }
    expect((await db.query(`select has_table_privilege('service_role', 'public.reference_uploads', 'insert') as can`)).rows).toEqual([{ can: true }]);
    for (const [role, can] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      expect((await db.query(`select has_function_privilege($1, 'public.reference_uploads_cap()', 'execute') as can`, [role])).rows, role).toEqual([{ can }]);
    }
    // The service role's save runs through the cap.
    await db.exec(`set role service_role; insert into public.reference_uploads (user_id, path, content_hash) values ('${B}', 'b2', '${hash(2)}'); reset role;`);
    expect((await db.query(`select count(*)::int as n from public.reference_uploads where user_id = $1`, [B])).rows).toEqual([{ n: 2 }]);
  });

  it("rolls back to no table and no cap, the bucket left", async () => {
    await db.exec(ROLLBACK);
    expect((await db.query(`select to_regclass('public.reference_uploads') as t, to_regprocedure('public.reference_uploads_cap()') as f`)).rows).toEqual([{ t: null, f: null }]);
    expect((await db.query(`select count(*)::int as n from storage.buckets`)).rows).toEqual([{ n: 1 }]);
  });
});
