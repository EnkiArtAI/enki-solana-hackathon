import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-29-dm-requests.sql in a real Postgres over 2026-07-18-dm-messages.sql: conversations that existed
 * stay conversations for both, a new one is a request to whoever has not taken it in, a second run changes no request,
 * the overview says which, and the rollback leaves the 2026-07-18 overview working.
 */
const read = (f: string) => readFileSync(join(__dirname, "..", "..", "migrations", f), "utf8");
const SQL = read("2026-10-29-dm-requests.sql");
const DM = read("2026-07-18-dm-messages.sql");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ANN, BEN, CAT, OLD, NEW] = [1, 2, 3, 4, 5].map(id);

describe("the message requests migration", () => {
  let db: PGlite;
  const accepted = async (user: string) =>
    (await db.query<{ thread_id: string; accepted: boolean }>(`select thread_id, accepted from public.dm_overview($1) order by thread_id`, [user])).rows;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create table public.users (id uuid primary key, handle text, display_name text, avatar_url text, deleted_at timestamptz);
      insert into public.users (id, handle) values ('${ANN}', 'ann'), ('${BEN}', 'ben'), ('${CAT}', 'cat');
    `);
    await db.exec(DM);
    await db.exec(`
      insert into public.dm_threads (id, user_a, user_b) values ('${OLD}', '${ANN}', '${BEN}');
      insert into public.dm_messages (thread_id, sender_id, body) values ('${OLD}', '${ANN}', 'from before');
    `);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("keeps a conversation from before a conversation for both", async () => {
    expect(await accepted(ANN)).toEqual([{ thread_id: OLD, accepted: true }]);
    expect(await accepted(BEN)).toEqual([{ thread_id: OLD, accepted: true }]);
  });

  it("makes a new one a request to whoever has not taken it in, and a second run changes no request", async () => {
    await db.exec(`
      insert into public.dm_threads (id, user_a, user_b, a_accepted_at) values ('${NEW}', '${ANN}', '${CAT}', now());
      insert into public.dm_messages (thread_id, sender_id, body) values ('${NEW}', '${ANN}', 'hi cat');
    `);
    await db.exec(SQL);
    expect(await accepted(CAT)).toEqual([{ thread_id: NEW, accepted: false }]);
    expect(await accepted(ANN)).toEqual([{ thread_id: OLD, accepted: true }, { thread_id: NEW, accepted: true }]);
    const { rows: [unread] } = await db.query<{ unread: number }>(`select unread::int from public.dm_overview($1)`, [CAT]);
    expect(unread).toEqual({ unread: 1 });
  });

  it("is the server's only", async () => {
    for (const [role, can] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      expect((await db.query(`select has_function_privilege($1, 'public.dm_overview(uuid)', 'execute') as can`, [role])).rows).toEqual([{ can }]);
    }
  });

  it("rolls back to the 2026-07-18 overview", async () => {
    await db.exec(ROLLBACK);
    await db.exec(DM);
    const { rows } = await db.query(`select thread_id from public.dm_overview($1) order by thread_id`, [ANN]);
    expect(rows).toEqual([{ thread_id: OLD }, { thread_id: NEW }]);
    expect((await db.query(`select count(*)::int as n from information_schema.columns where table_name = 'dm_threads' and column_name like '%accepted_at'`)).rows).toEqual([{ n: 0 }]);
  });
});
