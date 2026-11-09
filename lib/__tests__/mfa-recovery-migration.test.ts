import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * SQL 74 in a real Postgres (PGlite), on Supabase's roles and default privileges: it runs twice, a code is unique and goes with
 * its user, a request names a real factor, the browser key sees nothing, and its own Check and Rollback do what they say. Blind
 * spot: the stand-in users table holds only an id, and PGlite is one session, so no lock contention is measured here.
 */
const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-11-05-mfa-recovery.sql"), "utf8").replace(/\r\n/g, "\n");
const after = (label: string) => new RegExp(`-- ${label}[^\\n]*\\n--\\s+([^\\n]+)`).exec(SQL)![1];
const U = "11111111-1111-4111-8111-111111111111";

describe("SQL 74: mfa_recovery_codes and mfa_recovery", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated;
      create table public.users (id uuid primary key);
      insert into public.users (id) values ('${U}');
      -- recovery_requests as the live table has it (OpenAPI, 2026-11-07): the old design's six NOT NULL columns with no default.
      create table public.recovery_requests (
        id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id),
        contact_email_ct text not null, contact_email_iv text not null, contact_email_tag text not null, contact_email_kid text not null,
        contact_email_lookup_hash text not null, layer text not null, status text not null default 'submitted',
        owner_key_hash text, expires_at timestamptz, created_at timestamptz not null default now()
      );
    `);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("runs a second time without harm", async () => {
    await db.exec(SQL);
  });

  it("keeps a code hash unique", async () => {
    await db.exec(`insert into public.mfa_recovery_codes (user_id, code_hash) values ('${U}', 'h1')`);
    await expect(db.exec(`insert into public.mfa_recovery_codes (user_id, code_hash) values ('${U}', 'h1')`)).rejects.toThrow(/unique|duplicate/i);
  });

  it("keeps one request row per account, naming a real factor or none", async () => {
    await db.exec(`insert into public.mfa_recovery (user_id) values ('${U}')`);
    await expect(db.exec(`insert into public.mfa_recovery (user_id) values ('${U}')`)).rejects.toThrow(/unique|duplicate/i);
    await expect(db.exec(`update public.mfa_recovery set factor = 'sms'`)).rejects.toThrow(/check/i);
    for (const factor of ["passkey", "totp", "email"]) await db.exec(`update public.mfa_recovery set factor = '${factor}'`);
    await db.exec(`update public.mfa_recovery set factor = null`);
  });

  it("starts every counter at zero", async () => {
    expect((await db.query(`select failed_attempts, lockouts, sends_count, locked_until from public.mfa_recovery`)).rows[0])
      .toEqual({ failed_attempts: 0, lockouts: 0, sends_count: 0, locked_until: null });
    // The 5 day wait this file first held is gone (DEC-2026-11-07-13).
    expect((await db.query(`select column_name from information_schema.columns where table_name = 'mfa_recovery' and column_name in ('code_hash', 'ready_at', 'cancel_token_hash')`)).rows).toEqual([]);
  });

  it("keeps one hash per address of a mailed set, in order, and none to begin with", async () => {
    expect((await db.query(`select code_hashes from public.mfa_recovery`)).rows[0]).toEqual({ code_hashes: null });
    await db.exec(`update public.mfa_recovery set code_hashes = array['h-b', 'h-a']`);
    expect((await db.query(`select code_hashes from public.mfa_recovery`)).rows[0]).toEqual({ code_hashes: ["h-b", "h-a"] });
    await db.exec(`update public.mfa_recovery set code_hashes = null`);
  });

  it("lets a guardian request in without the old design's six columns, naming a real factor or none", async () => {
    await db.exec(`insert into public.recovery_requests (user_id, status, expires_at, factor) values ('${U}', 'pending', now(), 'totp')`);
    await db.exec(`insert into public.recovery_requests (user_id, status, owner_key_hash, expires_at) values ('${U}', 'pending', 'k', now())`);
    await expect(db.exec(`insert into public.recovery_requests (user_id, status, factor) values ('${U}', 'pending', 'sms')`)).rejects.toThrow(/check/i);
    expect((await db.query(`select factor from public.recovery_requests order by factor nulls last`)).rows).toEqual([{ factor: "totp" }, { factor: null }]);
    // One running ask per account; a closed one, or a password reset, stands beside it.
    await expect(db.exec(`insert into public.recovery_requests (user_id, status, factor) values ('${U}', 'pending', 'email')`)).rejects.toThrow(/unique|duplicate/i);
    await db.exec(`insert into public.recovery_requests (user_id, status, factor) values ('${U}', 'cancelled', 'email')`);
    await db.exec(`insert into public.recovery_requests (user_id, status) values ('${U}', 'pending')`);
    await db.exec(`delete from public.recovery_requests`);
  });

  it("hides both tables from anon and authenticated, and lets the service role work", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      for (const table of ["mfa_recovery", "mfa_recovery_codes"]) await expect(db.query(`select * from public.${table}`), `${role} ${table}`).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
    await db.exec(`set role service_role`);
    for (const table of ["mfa_recovery", "mfa_recovery_codes"]) await db.query(`select * from public.${table}`);
    await db.exec(`update public.mfa_recovery set failed_attempts = 0`);
    await db.exec("reset role");
  });

  it("turns row level security on", async () => {
    const rows = (await db.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname in ('mfa_recovery', 'mfa_recovery_codes') order by relname`)).rows;
    expect(rows).toEqual([{ relname: "mfa_recovery", relrowsecurity: true }, { relname: "mfa_recovery_codes", relrowsecurity: true }]);
    expect((await db.query(`select 1 from pg_policies where tablename in ('mfa_recovery', 'mfa_recovery_codes')`)).rows).toEqual([]);
  });

  it("its Check counts both tables", async () => {
    expect((await db.query<{ codes: number; rows: number }>(after("Check"))).rows[0]).toEqual({ codes: 1, rows: 1 });
  });

  it("goes with the user", async () => {
    await db.exec(`delete from public.users where id = '${U}'`);
    expect((await db.query<{ codes: number; rows: number }>(after("Check"))).rows[0]).toEqual({ codes: 0, rows: 0 });
  });

  it("its Rollback takes both tables away and runs twice", async () => {
    await db.exec(after("Rollback"));
    await db.exec(after("Rollback"));
    expect((await db.query(`select 1 from information_schema.tables where table_name in ('mfa_recovery', 'mfa_recovery_codes')`)).rows).toEqual([]);
    expect((await db.query(`select 1 from information_schema.columns where table_name = 'recovery_requests' and column_name = 'factor'`)).rows).toEqual([]);
  });
});
