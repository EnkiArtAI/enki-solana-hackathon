import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { readSource } from "./_read-source";
import { usableHandle } from "@/lib/handle-rules";

/**
 * migrations/2026-10-29-auto-handles.sql (SQL 46) in a real Postgres, on Supabase's roles and default privileges, over
 * the users columns it reads (read back live 2026-10-29: handle citext, deleted_at): every account has a name (Kev,
 * 2026-10-29: "every newly logged in creator should have some random name on the platform"). The name is drawn from
 * the first-login picker's own words, never one an account has, and it stays Enki's until its owner picks or renames.
 */
const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(join(ROOT, "migrations", "2026-10-29-auto-handles.sql"), "utf8").split("\r\n").join("\n");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const PICKER = readSource(join(ROOT, "components", "enki-shell", "UsernameOnboard.tsx"));
const words = (name: string) => JSON.parse(PICKER.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`))![1]) as string[];
const [TONES, ARTISTS] = [words("TONES"), words("ARTISTS")];
const NAME = new RegExp(`^(${TONES.join("|")})_(${ARTISTS.join("|")})_([0-9]{4})$`);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// ann chose a name; bob, cat (wallet) and the agent have none; dan was deleted without one.
const [ANN, BOB, CAT, AGENT, DAN] = [1, 2, 3, 4, 5].map(id);

describe("the auto handles migration", () => {
  let db: PGlite;
  type U = { id: string; handle: string | null; handle_auto: boolean };
  const users = async () => (await db.query<U>(`select id, handle::text as handle, handle_auto from public.users order by id`)).rows;
  const user = async (who: string) => (await users()).find((u) => u.id === who)!;
  const draw = async () => (await db.query<{ h: string }>(`select public.random_handle() as h`)).rows[0].h;

  beforeAll(async () => {
    db = await PGlite.create({ extensions: { citext } });
    await db.exec(`
      create extension citext;
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
      create table public.users (id uuid primary key default gen_random_uuid(), handle public.citext, origin text,
        bio text, deleted_at timestamptz, created_at timestamptz not null default now());
      insert into public.users (id, handle, origin, deleted_at, created_at) values
        ('${ANN}', 'ann', null, null, now() - interval '9 days'), ('${BOB}', null, null, null, now() - interval '8 days'),
        ('${CAT}', null, 'wallet', null, now() - interval '7 days'), ('${AGENT}', null, 'agent', null, now() - interval '6 days'),
        ('${DAN}', null, null, now(), now() - interval '5 days');
    `);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("names every account without one that is not deleted, and leaves a chosen name and a deleted account alone", async () => {
    const after = await users();
    expect(after.find((u) => u.id === ANN)).toEqual({ id: ANN, handle: "ann", handle_auto: false });
    expect(after.find((u) => u.id === DAN)).toEqual({ id: DAN, handle: null, handle_auto: false });
    const named = after.filter((u) => [BOB, CAT, AGENT].includes(u.id));
    for (const u of named) {
      expect(u.handle).toMatch(NAME);
      expect(u.handle_auto).toBe(true);
    }
    expect(new Set(named.map((u) => u.handle)).size).toBe(3);
  });

  it("runs twice without harm: a second run draws nothing", async () => {
    const before = await users();
    await db.exec(SQL);
    expect(await users()).toEqual(before);
  });

  it("draws <tone>_<artist>_<4 digits> from the picker's own words, every one of them, always a usable name", async () => {
    expect(TONES).toHaveLength(10);
    expect(ARTISTS).toHaveLength(10);
    const names = await Promise.all(Array.from({ length: 400 }, draw));
    const parts = names.map((n) => NAME.exec(n));
    expect(parts.every(Boolean)).toBe(true);
    expect(names.every(usableHandle)).toBe(true);
    expect(new Set(parts.map((p) => p![1]))).toEqual(new Set(TONES));
    expect(new Set(parts.map((p) => p![2]))).toEqual(new Set(ARTISTS));
    // Every digit at the front and at the back: four digits from 0000 to 9999, none dropped.
    expect(new Set(parts.map((p) => p![3][0])).size).toBe(10);
    expect(new Set(parts.map((p) => p![3][3])).size).toBe(10);
  });

  it("draws again while an account has the name, whatever its case", async () => {
    await db.query(`select setseed(0.42)`);
    const first = await draw();
    await db.query(`insert into public.users (handle) values ($1)`, [first.toUpperCase()]);
    await db.query(`select setseed(0.42)`);
    const second = await draw();
    expect(second).toMatch(NAME);
    expect(second).not.toBe(first);
  });

  it("names a new account without one as the service role inserts it, and keeps a name given at the insert", async () => {
    await db.exec(`set role service_role`);
    try {
      const made = (await db.query<U>(`insert into public.users (origin) values ('email') returning id, handle::text as handle, handle_auto`)).rows[0];
      expect(made.handle).toMatch(NAME);
      expect(made.handle_auto).toBe(true);
      const given = (await db.query<U>(`insert into public.users (handle) values ('kev') returning id, handle::text as handle, handle_auto`)).rows[0];
      expect(given).toMatchObject({ handle: "kev", handle_auto: false });
    } finally {
      await db.exec(`reset role`);
    }
  });

  it("stays Enki's until the owner changes the name: then it is theirs", async () => {
    const auto = (await user(BOB)).handle!;
    await db.query(`update public.users set bio = 'hello' where id = $1`, [BOB]);
    expect(await user(BOB)).toEqual({ id: BOB, handle: auto, handle_auto: true });
    // The same name written again (a profile save that names it) is no change.
    await db.query(`update public.users set handle = $2 where id = $1`, [BOB, auto]);
    expect((await user(BOB)).handle_auto).toBe(true);
    await db.query(`update public.users set handle = 'bobby' where id = $1`, [BOB]);
    expect(await user(BOB)).toEqual({ id: BOB, handle: "bobby", handle_auto: false });
    // A change that sets handle_auto itself keeps what it set.
    await db.query(`update public.users set handle = 'bob_again', handle_auto = true where id = $1`, [BOB]);
    expect(await user(BOB)).toEqual({ id: BOB, handle: "bob_again", handle_auto: true });
  });

  it("each draw of the backfill sees the names drawn before it", async () => {
    // The backfill statement alone, over a VOLATILE draw like random_handle() that takes the first free name of two:
    // if a draw did not see the ones before it, both accounts would get the same name.
    const backfill = SQL.match(/^UPDATE public\.users SET handle = public\.random_handle\(\).*;$/m)![0];
    const a = (await db.query<{ id: string }>(`insert into public.users (handle) values ('tmp_a') returning id`)).rows[0].id;
    const b = (await db.query<{ id: string }>(`insert into public.users (handle) values ('tmp_b') returning id`)).rows[0].id;
    await db.exec(`
      alter table public.users disable trigger users_handle_auto;
      update public.users set handle = null where handle in ('tmp_a', 'tmp_b');
      alter function public.random_handle() rename to random_handle_real;
      create function public.random_handle() returns text language plpgsql volatile as $f$
        begin
          return (select x from (values ('first_free'), ('second_free')) v(x)
                  where not exists (select 1 from public.users where handle = x) limit 1);
        end $f$;
      ${backfill}
      drop function public.random_handle();
      alter function public.random_handle_real() rename to random_handle;
      alter table public.users enable trigger users_handle_auto;
    `);
    expect([(await user(a)).handle, (await user(b)).handle].sort()).toEqual(["first_free", "second_free"]);
    // That holds for VOLATILE only: a STABLE draw sees the table as the statement found it.
    expect((await db.query(`select provolatile as v from pg_proc where proname = 'random_handle'`)).rows).toEqual([{ v: "v" }]);
  });

  it("is the server's only", async () => {
    for (const [role, can] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      expect((await db.query(`select has_function_privilege($1, 'public.random_handle()', 'execute') as can`, [role])).rows)
        .toEqual([{ can }]);
    }
  });

  it("rolls back to the accounts as they were: Enki's names go, a chosen one stays", async () => {
    await db.exec(ROLLBACK);
    const left = (await db.query<{ id: string; handle: string | null }>(`select id, handle::text as handle from public.users order by id`)).rows;
    expect(left.find((u) => u.id === ANN)!.handle).toBe("ann");
    expect(left.find((u) => u.id === CAT)!.handle).toBeNull();
    expect(left.find((u) => u.id === AGENT)!.handle).toBeNull();
    expect((await db.query(`select count(*)::int as n from information_schema.columns where table_name = 'users' and column_name = 'handle_auto'`)).rows)
      .toEqual([{ n: 0 }]);
    expect((await db.query(`select to_regproc('public.random_handle') as f, to_regproc('public.users_handle_auto') as t`)).rows)
      .toEqual([{ f: null, t: null }]);
    const made = (await db.query<{ handle: string | null }>(`insert into public.users (origin) values ('wallet') returning handle::text as handle`)).rows[0];
    expect(made.handle).toBeNull();
  });
});
