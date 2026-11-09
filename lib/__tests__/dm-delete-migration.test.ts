import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-29-dm-delete-follow.sql in a real Postgres, on Supabase's roles and default privileges, over
 * 2026-07-18-dm-messages.sql, the follows table and SQL 42 (Kev, 2026-10-29: "just add a delete button, no decline
 * button"; "following someone accepts their messages request automatically"): a deleted request leaves my view only and
 * comes back with what is written after, the unread count starts at the later of my read and my delete, following the
 * one who wrote takes it in, a request with nothing to see takes no place in the overview's 200, and the rollback
 * leaves SQL 42's overview working.
 */
const read = (f: string) => readFileSync(join(__dirname, "..", "..", "migrations", f), "utf8");
const SQL = read("2026-10-29-dm-delete-follow.sql");
const REQUESTS = read("2026-10-29-dm-requests.sql");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// user_a < user_b by id: ann-ben (T1), cat-dan (T2), ben-dan (T3), ann-cat (T4).
const [ANN, BEN, CAT, DAN, T1, T2, T3, T4] = [1, 2, 3, 4, 11, 12, 13, 14].map(id);

describe("the delete-and-follow migration", () => {
  let db: PGlite;
  const view = async (user: string, thread: string) =>
    (await db.query<{ last_body: string | null; unread: number; accepted: boolean }>(
      `select last_body, unread::int, accepted from public.dm_overview($1) where thread_id = $2`, [user, thread])).rows[0];
  const follow = (who: string, whom: string) => db.query(`insert into public.follows (follower_id, followee_id) values ($1, $2)`, [who, whom]);

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create table public.users (id uuid primary key, handle text, display_name text, avatar_url text, deleted_at timestamptz);
      insert into public.users (id, handle) values ('${ANN}', 'ann'), ('${BEN}', 'ben'), ('${CAT}', 'cat'), ('${DAN}', 'dan');
    `);
    await db.exec(read("2026-07-18-dm-messages.sql"));
    await db.exec(read("2026-10-29-follows.sql"));
    await db.exec(REQUESTS);
    await db.exec(SQL);
    // Ann wrote twice to Ben, Cat once to Dan; Ben opened one with Dan and wrote nothing. Nobody else took theirs in.
    await db.exec(`
      insert into public.dm_threads (id, user_a, user_b, a_accepted_at) values
        ('${T1}', '${ANN}', '${BEN}', '2026-10-29 10:00:00+00'), ('${T2}', '${CAT}', '${DAN}', '2026-10-29 10:00:00+00');
      insert into public.dm_threads (id, user_a, user_b) values ('${T3}', '${BEN}', '${DAN}');
      insert into public.dm_messages (thread_id, sender_id, body, created_at) values
        ('${T1}', '${ANN}', 'first', '2026-10-29 10:00:00+00'), ('${T1}', '${ANN}', 'second', '2026-10-29 10:01:00.123456+00'),
        ('${T2}', '${CAT}', 'hi dan', '2026-10-29 10:00:00+00');
    `);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("runs twice without harm", async () => {
    await db.exec(SQL);
  });

  it("a deleted request leaves my view, up to the newest message I was shown, and the sender keeps all of it", async () => {
    expect(await view(BEN, T1)).toEqual({ last_body: "second", unread: 2, accepted: false });
    await db.exec(`update public.dm_threads set b_cleared_at = '2026-10-29 10:01:00.123456+00' where id = '${T1}'`);
    expect(await view(BEN, T1)).toBeUndefined();
    expect(await view(ANN, T1)).toEqual({ last_body: "second", unread: 0, accepted: true });
  });

  it("a message after it brings it back as a request with only the new", async () => {
    await db.exec(`insert into public.dm_messages (thread_id, sender_id, body, created_at) values ('${T1}', '${ANN}', 'third', '2026-10-29 10:02:00+00')`);
    expect(await view(BEN, T1)).toEqual({ last_body: "third", unread: 1, accepted: false });
  });

  it("counts unread after the later of my read and my delete", async () => {
    await db.exec(`update public.dm_threads set b_last_read_at = '2026-10-29 10:00:00+00' where id = '${T1}'`);
    expect((await view(BEN, T1)).unread).toBe(1);
    await db.exec(`update public.dm_threads set b_last_read_at = '2026-10-29 10:02:00+00' where id = '${T1}'`);
    expect((await view(BEN, T1)).unread).toBe(0);
  });

  it("following the one who wrote takes it in, no other follow does, and unfollowing makes it a request again", async () => {
    expect((await view(DAN, T2)).accepted).toBe(false);
    // Cat follows me, Ben follows Cat, I follow Ann.
    await follow(CAT, DAN);
    await follow(BEN, CAT);
    await follow(DAN, ANN);
    expect((await view(DAN, T2)).accepted).toBe(false);
    await follow(DAN, CAT);
    expect(await view(DAN, T2)).toEqual({ last_body: "hi dan", unread: 1, accepted: true });
    await db.exec(`delete from public.follows where follower_id = '${DAN}' and followee_id = '${CAT}'`);
    expect((await view(DAN, T2)).accepted).toBe(false);
  });

  it("following brings back neither a conversation nobody wrote in nor one I deleted", async () => {
    await follow(DAN, BEN);
    expect(await view(DAN, T3)).toBeUndefined();
    await follow(DAN, CAT);
    await db.exec(`update public.dm_threads set b_cleared_at = '2026-10-29 10:00:00+00' where id = '${T2}'`);
    expect(await view(DAN, T2)).toBeUndefined();
  });

  it("leaves out a request with nothing to see before its 200, and keeps one I took in that nobody wrote in", async () => {
    // 200 more people wrote to Ann at 10:30 and she deleted each; her conversation with Ben is from 10:02.
    await db.exec(`
      insert into public.users (id, handle)
        select ('00000000-0000-4000-8001-' || lpad(g::text, 12, '0'))::uuid, 'p' || g from generate_series(1, 200) g;
      insert into public.dm_threads (user_a, user_b, a_cleared_at, created_at)
        select '${ANN}', id, '2026-10-29 10:30:00+00', '2026-10-29 10:30:00+00' from public.users where handle like 'p%';
      insert into public.dm_messages (thread_id, sender_id, body, created_at)
        select id, user_b, 'more', '2026-10-29 10:30:00+00' from public.dm_threads where a_cleared_at is not null;
    `);
    expect(await view(ANN, T1)).toEqual({ last_body: "third", unread: 0, accepted: true });
    await db.exec(`insert into public.dm_threads (id, user_a, user_b, a_accepted_at) values ('${T4}', '${ANN}', '${CAT}', '2026-10-29 10:00:00+00')`);
    expect([await view(ANN, T4), await view(CAT, T4)]).toEqual([{ last_body: null, unread: 0, accepted: true }, undefined]);
  });

  it("is the server's only, also where it makes the overview new", async () => {
    await db.exec(`drop function public.dm_overview(uuid)`);
    await db.exec(SQL);
    for (const [role, can] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      expect((await db.query(`select has_function_privilege($1, 'public.dm_overview(uuid)', 'execute') as can`, [role])).rows).toEqual([{ can }]);
    }
    for (const role of ["anon", "authenticated"]) {
      expect((await db.query(`select has_column_privilege($1, 'public.dm_threads', 'b_cleared_at', 'select') as can`, [role])).rows).toEqual([{ can: false }]);
    }
  });

  it("rolls back to SQL 42's overview: everything shows again and following takes nothing in", async () => {
    await db.exec(REQUESTS);
    await db.exec(ROLLBACK);
    expect((await db.query(`select count(*)::int as n from information_schema.columns where table_name = 'dm_threads' and column_name like '%cleared_at'`)).rows).toEqual([{ n: 0 }]);
    expect(await view(DAN, T2)).toEqual({ last_body: "hi dan", unread: 1, accepted: false });
    expect(await view(BEN, T1)).toEqual({ last_body: "third", unread: 0, accepted: false });
  });
});
