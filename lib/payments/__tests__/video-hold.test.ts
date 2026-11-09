import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import { ABANDONED_AFTER_MS, sweepAbandoned } from "@/lib/payments/authorization";
import { fakeClient, type Row } from "./_pg-fake";

/**
 * A video's held payment on PGlite, with the real SQL 69 and 70: the sweep leaves a held unit alone, voids it past its hold,
 * sweeps an image's unit as ever, and keeps working on a 42703 before SQL 70. Blind spot: PGlite's stand-in is not PostgREST;
 * its 42703 matches the live `generation_payment_intents?select=hold_until` read 400 42703. The constraints here are simulated:
 * the live ones cannot be read from outside, so SQL 69's first real run is its only real test.
 */
const MIG = join(__dirname, "..", "..", "..", "migrations");
const SQL69 = readFileSync(join(MIG, "2026-11-03-video-jobs.sql"), "utf8");
const SQL70 = readFileSync(join(MIG, "2026-11-03-intent-hold.sql"), "utf8");
const STUBS = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create table public.users (id uuid primary key);
  create table public.generation_payment_intents (id uuid primary key, buyer_wallet text, authorized_at timestamptz, consumed_at timestamptz, capture_started_at timestamptz,
    captured_at timestamptz, voided_at timestamptz, void_reason text, status text, updated_at timestamptz, nonce_account text);
  create table public.generations (id uuid primary key default gen_random_uuid(), provider text, constraint generations_provider_check check (provider in ('gemini', 'openai')));
`;
const IMAGES_CHECKED = `create table public.generated_images (id uuid primary key default gen_random_uuid(), storage_provider text not null, constraint gi_store check (storage_provider in ('vercel_blob', 'r2')));`;
const IMAGES_OPEN = `create table public.generated_images (id uuid primary key default gen_random_uuid(), storage_provider text not null);`;
/** The statements under a file's "-- Rollback" line, as it says to run them. */
const rollback = (sql: string) => sql.slice(sql.indexOf("-- Rollback")).split("\n").slice(1).filter((l) => /^--\s+(ALTER|DROP)/.test(l)).map((l) => l.replace(/^--\s+/, "")).join("\n");

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const STALE = ago(ABANDONED_AFTER_MS * 2);
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const asClient = (db: PGlite) => pglitePostgrest(db).client as unknown as SupabaseClient;

describe("the sweep and hold_until", () => {
  let db: PGlite;
  const add = (n: number, hold: string | null) => db.query(
    `insert into public.generation_payment_intents (id, buyer_wallet, authorized_at, consumed_at, status, nonce_account, hold_until) values ($1, 'b', $2, $2, 'generating', $3, $4)`,
    [ID(n), STALE, `N${n}`, hold],
  );
  const reason = async (n: number) => (await db.query<{ void_reason: string | null }>(`select void_reason from public.generation_payment_intents where id = $1`, [ID(n)])).rows[0].void_reason;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(STUBS + IMAGES_OPEN + SQL69 + SQL70);
    await add(1, ago(-60_000));
    await add(2, ago(1_000));
    await add(3, null);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("a held unit stays; one past its hold and an image's are voided, as Enki's", async () => {
    const flushed = await sweepAbandoned(asClient(db));
    expect(flushed.map((f) => f.intentId).sort()).toEqual([ID(2), ID(3)]);
    expect([await reason(1), await reason(2), await reason(3)]).toEqual([null, "provider_failed", "provider_failed"]);
  });
});

describe("the write asks again", () => {
  it("a hold set between the read and the write stands", async () => {
    const row: Row = { id: "u", authorized_at: STALE, consumed_at: STALE, capture_started_at: null, captured_at: null, voided_at: null, hold_until: null, nonce_account: "N", status: "generating" };
    const fake = fakeClient([row]);
    let calls = 0;
    const racing = {
      // The second call is the write: the row has been held since the read.
      from: (t: string) => { if (++calls === 2) row.hold_until = ago(-60_000); return fake.from(t); },
    } as unknown as SupabaseClient;
    expect(await sweepAbandoned(racing)).toEqual([]);
    expect(row.voided_at).toBeNull();
    expect(calls).toBe(2);
  });
});

describe("before SQL 70", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(STUBS);
    await db.query(`insert into public.generation_payment_intents (id, buyer_wallet, authorized_at, consumed_at, status, nonce_account) values ($1, 'b', $2, $2, 'generating', 'N')`, [ID(1), STALE]);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("the sweep is not switched off: the missing column is a 42703, and it reads as it always did", async () => {
    const client = asClient(db);
    const asked = await client.from("generation_payment_intents").select("hold_until");
    expect(asked.error?.code).toBe("42703");
    expect((await sweepAbandoned(client)).map((f) => f.intentId)).toEqual([ID(1)]);
  });
});

describe("SQL 69 and 70 themselves", () => {
  const grants = (db: PGlite, table: string) => db.query<{ g: string }>(
    `select grantee || ':' || privilege_type as g from information_schema.role_table_grants where table_name = '${table}' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') order by 1`,
  ).then((r) => r.rows.map((x) => x.g));
  const USER = "00000000-0000-4000-8000-0000000000aa";

  it("run twice; the table is the service role's alone, RLS on; a widened check takes 'video' and 'supabase' and still refuses others", async () => {
    const db = await PGlite.create();
    await db.exec(STUBS + IMAGES_CHECKED + `insert into public.generations (provider) values ('gemini');`);
    for (let i = 0; i < 2; i++) await db.exec(SQL69 + SQL70);
    expect(await grants(db, "video_jobs")).toEqual(["service_role:INSERT", "service_role:SELECT", "service_role:UPDATE"]);
    expect((await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'video_jobs'")).rows[0].relrowsecurity).toBe(true);
    expect((await db.query<{ c: string }>("select column_name || ':' || data_type as c from information_schema.columns where table_name = 'generation_payment_intents' and column_name in ('hold_until', 'video_settings') order by 1")).rows.map((r) => r.c))
      .toEqual(["hold_until:timestamp with time zone", "video_settings:jsonb"]);

    await db.exec(`insert into public.generations (provider) values ('video'), ('wavespeed');`);
    await expect(db.exec(`insert into public.generations (provider) values ('nobody');`)).rejects.toThrow(/generations_provider_check/);
    await db.exec(`insert into public.generated_images (storage_provider) values ('supabase'), ('vercel_blob'), ('r2');`);
    await expect(db.exec(`insert into public.generated_images (storage_provider) values ('nobody');`)).rejects.toThrow(/gi_store/);
    await db.close();
  }, 60_000);

  it("where no check names storage_provider it adds none", async () => {
    const db = await PGlite.create();
    await db.exec(STUBS + IMAGES_OPEN + SQL69);
    await db.exec(`insert into public.generated_images (storage_provider) values ('anything');`);
    expect((await db.query("select conname from pg_constraint where conrelid = 'public.generated_images'::regclass and contype = 'c'")).rows).toEqual([]);
    await db.close();
  }, 60_000);

  it("a job's status is one of six, its intent once, and a job needs its hash", async () => {
    const db = await PGlite.create();
    await db.exec(STUBS + IMAGES_OPEN + SQL69 + SQL70 + `insert into public.users (id) values ('${USER}'); insert into public.generation_payment_intents (id) values ('${ID(1)}'), ('${ID(2)}');`);
    const job = (intent: string, over = "") => `insert into public.video_jobs (user_id, intent_id, model_id, operator, provider_model, settings, end_user_hash${over ? ", status" : ""}) values ('${USER}', '${intent}', '${ID(3)}', 'o', 'm', '{}', 'h'${over ? `, '${over}'` : ""});`;
    await db.exec(job(ID(1)));
    expect((await db.query<{ status: string; consent: boolean; attempt_count: number }>("select status, consent, attempt_count from public.video_jobs")).rows).toEqual([{ status: "submitting", consent: false, attempt_count: 0 }]);
    await expect(db.exec(job(ID(1)))).rejects.toThrow(/intent_id/);
    await expect(db.exec(job(ID(2), "paused"))).rejects.toThrow(/status/);
    await expect(db.exec(`insert into public.video_jobs (user_id, intent_id, model_id, operator, provider_model, settings) values ('${USER}', '${ID(2)}', '${ID(3)}', 'o', 'm', '{}');`)).rejects.toThrow(/end_user_hash/);
    await db.close();
  }, 60_000);

  it("the rollbacks run as written", async () => {
    const db = await PGlite.create();
    await db.exec(STUBS + IMAGES_OPEN + SQL69 + SQL70);
    await db.exec(rollback(SQL70) + rollback(SQL69));
    const left = await db.query("select 1 from information_schema.tables where table_name = 'video_jobs'");
    const cols = await db.query("select 1 from information_schema.columns where table_name = 'generation_payment_intents' and column_name in ('hold_until', 'video_settings')");
    expect([left.rows.length, cols.rows.length]).toEqual([0, 0]);
    await expect(db.exec(`insert into public.generations (provider) values ('video');`)).rejects.toThrow(/generations_provider_check/);
    await db.close();
  }, 60_000);
});
