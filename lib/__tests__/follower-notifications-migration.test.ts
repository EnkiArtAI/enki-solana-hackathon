import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-29-follower-notifications.sql in a real Postgres, over notifications as 2026-07-13 left it and the
 * live follows table: a new post reaches each follower whose bell is on for its kind, once per post and day, never a
 * deleted account; the new kinds pass the checks, nothing else does; only the service role calls it.
 */
const read = (f: string) => readFileSync(join(__dirname, "..", "..", "migrations", f), "utf8");
const SQL = read("2026-10-29-follower-notifications.sql");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [MAKER, BELL, QUIET, PROMPTS_ONLY, GONE, POST, ELSEWHERE] = [1, 2, 3, 4, 5, 6, 8].map(id);

describe("the follower notifications migration", () => {
  let db: PGlite;
  const fanOut = async (kind: string, target = POST) =>
    (await db.query<{ n: number }>(`select public.notify_followers($1, $2, 'Mira released a new prompt', 'Dune', $3, $4, '{"thumb":"https://blob.test/t.webp"}') as n`,
      [MAKER, kind, kind === "new_prompt" ? "prompt" : "image", target])).rows[0].n;
  const inbox = async () => (await db.query<{ user_id: string; kind: string }>(`select user_id, kind from public.notifications order by user_id, kind`)).rows;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create table public.users (id uuid primary key, deleted_at timestamptz);
      insert into public.users values ('${MAKER}', null), ('${BELL}', null), ('${QUIET}', null), ('${PROMPTS_ONLY}', null), ('${GONE}', now()), ('${ELSEWHERE}', null);
      -- notifications as it stood before 2026-07-13 (that file adapts it), follows as it stands live.
      create table public.notifications (
        id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id), kind text, target_type text,
        target_uuid uuid, actor_user_id uuid references public.users(id), title text, body text, metadata jsonb not null,
        read_at timestamptz, seen_at timestamptz, sent_email boolean not null default false, sent_push boolean not null default false,
        created_at timestamptz not null default now());
      create table public.follows (
        follower_id uuid not null references public.users(id), followee_id uuid not null references public.users(id),
        created_at timestamptz not null default now(), notify_on_new_prompt boolean not null default true,
        notify_on_new_post boolean not null default false, primary key (follower_id, followee_id));
      insert into public.follows values
        ('${BELL}', '${MAKER}', now(), true, true), ('${QUIET}', '${MAKER}', now(), false, false),
        ('${PROMPTS_ONLY}', '${MAKER}', now(), true, false), ('${GONE}', '${MAKER}', now(), true, true),
        -- A fan of someone else, bell on.
        ('${ELSEWHERE}', '${QUIET}', now(), true, true);
    `);
    await db.exec(read("2026-07-13-notifications.sql"));
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("runs twice without harm", async () => {
    await db.exec(SQL);
  });

  it("tells each follower whose bell is on for that kind, never a deleted account, once per post and day", async () => {
    expect(await fanOut("new_prompt")).toBe(2);
    expect(await fanOut("new_image")).toBe(1);
    expect(await inbox()).toEqual([
      { user_id: BELL, kind: "new_image" }, { user_id: BELL, kind: "new_prompt" }, { user_id: PROMPTS_ONLY, kind: "new_prompt" },
    ]);
    expect(await fanOut("new_prompt")).toBe(0);
    expect(await fanOut("comment", id(7))).toBe(0);
    const { rows: [row] } = await db.query(`select title, body, target_type, actor_user_id, metadata from public.notifications where user_id = $1 and kind = 'new_prompt'`, [BELL]);
    expect(row).toEqual({ title: "Mira released a new prompt", body: "Dune", target_type: "prompt", actor_user_id: MAKER, metadata: { thumb: "https://blob.test/t.webp" } });
  });

  it("lets the two new kinds and the image target through the checks, and nothing else", async () => {
    const put = (kind: string, target: string | null) =>
      db.query(`insert into public.notifications (user_id, kind, target_type, title, metadata) values ($1, $2, $3, 't', '{}')`, [QUIET, kind, target]);
    await put("new_image", "image");
    await put("guardian_confirmed", "guardian");
    await expect(put("new_follower", null)).rejects.toThrow(/notifications_kind_check/);
    await expect(put("comment", "profile")).rejects.toThrow(/notifications_target_type_check/);
  });

  it("is the server's only", async () => {
    const fn = "public.notify_followers(uuid, text, text, text, text, uuid, jsonb)";
    for (const [role, can] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      expect((await db.query(`select has_function_privilege($1, $2, 'execute') as can`, [role, fn])).rows).toEqual([{ can }]);
    }
  });

  it("rolls back: no function, no new-post rows, the old checks", async () => {
    await db.exec(ROLLBACK);
    expect((await db.query(`select to_regprocedure('public.notify_followers(uuid, text, text, text, text, uuid, jsonb)') as f`)).rows).toEqual([{ f: null }]);
    expect((await db.query(`select count(*)::int as n from public.notifications where kind like 'new_%'`)).rows).toEqual([{ n: 0 }]);
    await expect(db.query(`insert into public.notifications (user_id, kind, title, metadata) values ($1, 'new_prompt', 't', '{}')`, [QUIET])).rejects.toThrow(/notifications_kind_check/);
  });
});
