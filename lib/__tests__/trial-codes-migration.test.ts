import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-26-trial-codes.sql in a real Postgres, on Supabase's
 * roles and default privileges, after the live roles migration, on a
 * generations table whose rail CHECK carries another name (the live one was
 * generated): a code is spent once per account and only while it may be, a
 * trial ends at its minutes or its code's expiry, renders spend the budget
 * and no further, a release gives a claim back once, and only the service
 * role reaches any of it. The clock is moved by setting ends_at in the past.
 */

const DIR = join(__dirname, "..", "..", "migrations");
const SQL = readFileSync(join(DIR, "2026-10-26-trial-codes.sql"), "utf8");
const ROLES = readFileSync(join(DIR, "2026-07-12-user-roles.sql"), "utf8");
// The commented block at the end of the file, as it would be pasted.
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const user = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = user(1);
const FUNCTIONS = ["active_trial", "claim_trial_spend", "redeem_trial_code", "release_trial_spend"];
const TABLES = ["trial_codes", "trial_redemptions", "trial_spend"];

type Code = { max_uses?: number | null; access_minutes?: number; expires_in?: string | null; budget_micro?: number; revoked?: boolean };
type Trial = { redemption_id: string; code_id?: string; ends_at: Date; budget_micro: unknown; spent_micro: unknown };

describe("the trial codes migration", () => {
  let db: PGlite;
  let n = 0;
  const code = async (c: Code = {}) =>
    (await db.query<{ id: string }>(
      `insert into public.trial_codes (code_hash, max_uses, access_minutes, expires_at, budget_micro, created_by, revoked_at)
       values ($1, $2, $3, now() + $4::interval, $5, $6, case when $7::boolean then now() end) returning id`,
      [`hash-${++n}`, c.max_uses ?? null, c.access_minutes ?? 60, c.expires_in ?? null, c.budget_micro ?? 1_000_000, OWNER, c.revoked ?? false],
    )).rows[0].id;
  const redeem = async (codeId: string, userId: string) =>
    (await db.query<Trial>(`select * from public.redeem_trial_code($1, $2)`, [codeId, userId])).rows;
  const active = async (userId: string) => (await db.query<Trial>(`select * from public.active_trial($1)`, [userId])).rows;
  const claim = async (userId: string, amount: number | string) =>
    (await db.query<{ id: string | null }>(`select public.claim_trial_spend($1, $2) as id`, [userId, amount])).rows[0].id;
  const release = async (spendId: string) =>
    (await db.query<{ ok: boolean }>(`select public.release_trial_spend($1) as ok`, [spendId])).rows[0].ok;
  const spent = async (userId: string) =>
    Number((await db.query<{ s: unknown }>(`select sum(spent_micro) as s from public.trial_redemptions where user_id = $1`, [userId])).rows[0].s);
  const uses = async (codeId: string) => (await db.query<{ uses: number }>(`select uses from public.trial_codes where id = $1`, [codeId])).rows[0].uses;
  const redemptions = async (userId: string) => (await db.query(`select 1 from public.trial_redemptions where user_id = $1`, [userId])).rows.length;
  // The trial's time is up.
  const end = (userId: string) => db.query(`update public.trial_redemptions set ends_at = now() - interval '1 second' where user_id = $1`, [userId]);

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
      create table public.users (id uuid primary key);
      insert into public.users (id) select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid from generate_series(1, 20) i;
      -- The rail CHECK named otherwise on purpose: the migration must find it by what it checks.
      create table public.generations (
        id uuid primary key default gen_random_uuid(),
        provider text constraint generations_provider_check check (provider in ('gemini', 'openai')),
        rail text constraint generations_rail_legacy check (rail in ('web', 'free', 'x402', 'mcp'))
      );
    `);
    await db.exec(ROLES);
    await db.exec(SQL);
    await db.exec(SQL); // runs twice without harm
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("adds the trial role, not staff, which an account can take", async () => {
    expect((await db.query(`select key, label, is_staff from public.roles where key = 'trial'`)).rows)
      .toEqual([{ key: "trial", label: "Trial tester", is_staff: false }]);
    await db.query(`update public.users set role = 'trial' where id = $1`, [user(20)]);
  });

  it("keeps a code inside its bounds", async () => {
    for (const bad of [{ access_minutes: 4 }, { access_minutes: 43201 }, { budget_micro: -1 }, { budget_micro: 1_000_000_001 }, { max_uses: 0 }]) {
      await expect(code(bad), JSON.stringify(bad)).rejects.toThrow(/check constraint/);
    }
    for (const edge of [{ access_minutes: 5 }, { access_minutes: 43200 }, { budget_micro: 0 }, { budget_micro: 1_000_000_000 }, { max_uses: 1 }]) await code(edge);
    const id = await code();
    await expect(db.query(`update public.trial_codes set note = repeat('x', 121) where id = $1`, [id])).rejects.toThrow(/check constraint/);
    await db.query(`update public.trial_codes set note = repeat('x', 120) where id = $1`, [id]);
    await expect(db.query(`update public.trial_codes set uses = -1 where id = $1`, [id])).rejects.toThrow(/check constraint/);
    await expect(db.query(`insert into public.trial_codes (code_hash, access_minutes, budget_micro, created_by)
      select code_hash, 60, 0, $1 from public.trial_codes where id = $2`, [OWNER, id])).rejects.toThrow(/unique|duplicate/i);
  });

  it("redeems a code of two uses for two accounts, refuses a third, and hands the first its trial back", async () => {
    const id = await code({ max_uses: 2, budget_micro: 2_500_000 });
    const [a] = await redeem(id, user(2));
    const [b] = await redeem(id, user(3));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.redemption_id).not.toBe(b.redemption_id);
    expect([Number(a.budget_micro), Number(a.spent_micro)]).toEqual([2_500_000, 0]);
    expect(await uses(id)).toBe(2);
    expect(await redeem(id, user(4))).toEqual([]);
    expect(await uses(id)).toBe(2);
    expect(await redemptions(user(4))).toBe(0);
    // The code is full; the account that holds a running trial from it still gets that one.
    expect((await redeem(id, user(2))).map((t) => t.redemption_id)).toEqual([a.redemption_id]);
  });

  it("hands an account its running trial back without spending a use, and nothing once its time is up", async () => {
    const id = await code();
    const [first] = await redeem(id, user(5));
    const [again] = await redeem(id, user(5));
    expect(again?.redemption_id).toBe(first.redemption_id);
    expect(new Date(again.ends_at).getTime()).toBe(new Date(first.ends_at).getTime());
    expect(await uses(id)).toBe(1);
    await end(user(5));
    expect(await redeem(id, user(5))).toEqual([]);
    expect(await uses(id)).toBe(1);
    expect(await active(user(5))).toEqual([]);
  });

  it("refuses a revoked code and a code past its date", async () => {
    for (const id of [await code({ revoked: true }), await code({ expires_in: "-1 minute" })]) {
      expect(await redeem(id, user(6))).toEqual([]);
      expect(await uses(id)).toBe(0);
    }
    expect(await redemptions(user(6))).toBe(0);
  });

  it("ends a trial at its minutes, or at its code's expiry when that comes first", async () => {
    const capped = await code({ access_minutes: 60, expires_in: "10 minutes" });
    const plain = await code({ access_minutes: 30 });
    const later = await code({ access_minutes: 30, expires_in: "1 day" });
    for (const id of [capped, plain, later]) expect(await redeem(id, user(7))).toHaveLength(1);
    const rows = (await db.query<{ code_id: string; minutes: number; at_expiry: boolean | null }>(
      `select r.code_id, extract(epoch from r.ends_at - r.started_at)::float8 / 60 as minutes, r.ends_at = c.expires_at as at_expiry
         from public.trial_redemptions r join public.trial_codes c on c.id = r.code_id where r.user_id = $1`, [user(7)])).rows;
    const by = Object.fromEntries(rows.map((r) => [r.code_id, r]));
    expect(by[capped].at_expiry).toBe(true);
    expect(by[capped].minutes).toBeLessThanOrEqual(10);
    expect(by[plain]).toMatchObject({ minutes: 30, at_expiry: null });
    expect(by[later]).toMatchObject({ minutes: 30, at_expiry: false });
  });

  it("measures a trial from when it is redeemed, not from when its transaction began", async () => {
    // The 50 ms sleep stands in for waiting on another redeemer's lock.
    const id = await code({ access_minutes: 30 });
    const row = await db.transaction(async (tx) => {
      await tx.query(`select pg_sleep(0.05)`);
      expect((await tx.query(`select * from public.redeem_trial_code($1, $2)`, [id, user(14)])).rows).toHaveLength(1);
      return (await tx.query<{ minutes: number; late: boolean }>(
        `select extract(epoch from ends_at - started_at)::float8 / 60 as minutes, started_at >= now() + interval '40 milliseconds' as late
           from public.trial_redemptions where user_id = $1`, [user(14)])).rows[0];
    });
    expect(row).toEqual({ minutes: 30, late: true });
  });

  it("spends the budget to the last micro-USDC and no further, and nothing outside a running trial", async () => {
    const id = await code({ budget_micro: 100 });
    await redeem(id, user(8));
    const a = await claim(user(8), 60);
    expect(a).toBeTruthy();
    expect(await claim(user(8), 41)).toBeNull();
    expect(await claim(user(8), 40)).toBeTruthy();
    expect(await spent(user(8))).toBe(100);
    expect(Number((await active(user(8)))[0].spent_micro)).toBe(100);
    for (const refused of [1, 0, -5, "9223372036854775807"]) expect(await claim(user(8), refused), String(refused)).toBeNull();
    expect((await db.query(`select 1 from public.trial_spend s join public.trial_redemptions r on r.id = s.redemption_id where r.user_id = $1`, [user(8)])).rows).toHaveLength(2);
    // Room in the budget again, but the trial's time is up.
    expect(await release(a!)).toBe(true);
    await end(user(8));
    expect(await claim(user(8), 1)).toBeNull();
    expect(await spent(user(8))).toBe(40);
    expect(await claim(user(9), 1)).toBeNull(); // never had a trial
  });

  it("gives a claim back to its trial once", async () => {
    const id = await code({ budget_micro: 100 });
    await redeem(id, user(10));
    const a = (await claim(user(10), 30))!;
    expect(await claim(user(10), 20)).toBeTruthy();
    expect(await spent(user(10))).toBe(50);
    expect(await release(a)).toBe(true);
    expect(await spent(user(10))).toBe(20);
    expect((await db.query<{ released_at: Date | null }>(`select released_at from public.trial_spend where id = $1`, [a])).rows[0].released_at).not.toBeNull();
    expect(await release(a)).toBe(false);
    expect(await spent(user(10))).toBe(20);
    expect(await release(user(99))).toBe(false); // no such claim
    expect(await claim(user(10), 80)).toBeTruthy(); // the released 30 is spendable again
    // Never below zero, even when the books were set by hand.
    await redeem(id, user(13));
    const b = (await claim(user(13), 5))!;
    await db.query(`update public.trial_redemptions set spent_micro = 0 where user_id = $1`, [user(13)]);
    expect(await release(b)).toBe(true);
    expect(await spent(user(13))).toBe(0);
  });

  it("widens the rail check to trial, still refuses anything else, and leaves the other checks", async () => {
    for (const rail of ["web", "free", "x402", "mcp", "trial"]) await db.query(`insert into public.generations (rail) values ($1)`, [rail]);
    await expect(db.query(`insert into public.generations (rail) values ('other')`)).rejects.toThrow(/generations_rail_check/);
    await db.exec(SQL); // and again, with a trial render recorded
    const checks = (await db.query<{ conname: string }>(
      `select conname from pg_constraint where conrelid = 'public.generations'::regclass and contype = 'c' order by conname`)).rows.map((r) => r.conname);
    expect(checks).toEqual(["generations_provider_check", "generations_rail_check"]);
  });

  it("finds the account's trial that ends last, never one whose code is revoked", async () => {
    const long = await code({ access_minutes: 120 });
    const short = await code({ access_minutes: 30 });
    await redeem(short, user(11));
    await redeem(long, user(11));
    const rows = await active(user(11));
    expect(rows.map((t) => t.code_id)).toEqual([long]);
    expect([Number(rows[0].budget_micro), Number(rows[0].spent_micro)]).toEqual([1_000_000, 0]);
    await db.query(`update public.trial_codes set revoked_at = now() where id = $1`, [long]);
    expect((await active(user(11))).map((t) => t.code_id)).toEqual([short]);
    expect(await redeem(long, user(11))).toEqual([]);
    await db.query(`update public.trial_codes set revoked_at = now() where id = $1`, [short]);
    expect(await active(user(11))).toEqual([]);
    expect(await claim(user(11), 1)).toBeNull();
  });

  it("lets only the service role call the functions and read the tables", async () => {
    const calls = [
      `select * from public.active_trial('${user(19)}')`,
      `select * from public.redeem_trial_code('${user(19)}', '${user(19)}')`,
      `select public.claim_trial_spend('${user(19)}', 1)`,
      `select public.release_trial_spend('${user(19)}')`,
    ];
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        for (const sql of [...calls, ...TABLES.map((t) => `select * from public.${t}`)]) {
          await expect(db.query(sql), `${role}: ${sql}`).rejects.toThrow(/permission denied/);
        }
      } finally {
        await db.exec("reset role");
      }
    }
    await db.exec("set role service_role");
    try {
      for (const sql of calls) await db.query(sql);
      for (const t of TABLES) expect(Number((await db.query<{ n: unknown }>(`select count(*) as n from public.${t}`)).rows[0].n), t).toBeGreaterThan(0);
    } finally {
      await db.exec("reset role");
    }
    expect((await db.query(`select proname, prosecdef, proconfig from pg_proc where proname = any($1) order by proname`, [FUNCTIONS])).rows)
      .toEqual(FUNCTIONS.map((proname) => ({ proname, prosecdef: true, proconfig: ["search_path=public, pg_temp"] })));
    expect((await db.query(`select relname, relrowsecurity from pg_class where relname = any($1) and relkind = 'r' order by relname`, [TABLES])).rows)
      .toEqual(TABLES.map((relname) => ({ relname, relrowsecurity: true })));
  });

  it("keeps one redemption per account and code, indexed newest first, and goes with its account", async () => {
    const id = await code();
    const [r] = await redeem(id, user(12));
    await expect(db.query(`insert into public.trial_redemptions (code_id, user_id, ends_at) values ($1, $2, now() + interval '1 hour')`, [id, user(12)]))
      .rejects.toThrow(/unique|duplicate/i);
    expect((await db.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'trial_redemptions_user_ends_idx'`)).rows[0]?.indexdef)
      .toMatch(/\(user_id, ends_at DESC\)/);
    expect(await claim(user(12), 10)).toBeTruthy();
    await db.query(`delete from public.users where id = $1`, [user(12)]);
    expect((await db.query(`select 1 from public.trial_redemptions where id = $1`, [r.redemption_id])).rows).toEqual([]);
    expect((await db.query(`select 1 from public.trial_spend where redemption_id = $1`, [r.redemption_id])).rows).toEqual([]);
  });

  it("is undone by the rollback at its end, once no render says trial", async () => {
    expect(ROLLBACK).toMatch(/DROP TABLE/);
    await db.exec(`delete from public.generations where rail = 'trial'`);
    await db.exec(ROLLBACK);
    expect((await db.query(`select 1 from pg_class where relname = any($1)`, [TABLES])).rows).toEqual([]);
    expect((await db.query(`select 1 from pg_proc where proname = any($1)`, [FUNCTIONS])).rows).toEqual([]);
    expect((await db.query(`select 1 from public.roles where key = 'trial'`)).rows).toEqual([]);
    expect((await db.query(`select role from public.users where id = $1`, [user(20)])).rows).toEqual([{ role: "user" }]);
    await expect(db.query(`insert into public.generations (rail) values ('trial')`)).rejects.toThrow(/generations_rail_check/);
    await db.query(`insert into public.generations (rail) values ('mcp')`);
  });
});
