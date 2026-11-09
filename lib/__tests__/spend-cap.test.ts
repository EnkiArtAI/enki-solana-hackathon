import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";

/**
 * SQL 72 on a real Postgres, through the helpers the routes call (key-theft measures, Kev 2026-11-04). vitest.setup.ts
 * stubs this module for every route test; here the real one runs.
 *
 * Blind spot: PGlite is one session, so calls "at once" run one after the other and the row's lock is never contended.
 * The racing tests prove the arithmetic under any order; that two real sessions cannot both pass rests on the pinned
 * statement (one UPDATE whose WHERE holds the cap) and Postgres's READ COMMITTED rule, which re-evaluates a WHERE on the
 * row the first writer left. No real Postgres ran it.
 */
const s = vi.hoisted(() => ({
  sent: [] as { to: string; subject: string; text: string }[], fail: false, refuses: "", later: [] as Promise<unknown>[],
}));
// As the real one: it answers ok: false and never throws.
vi.mock("@/lib/mailer", () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    if (s.fail || m.to === s.refuses) return { ok: false, error: "send failed" };
    s.sent.push(m);
    return { ok: true };
  },
}));
vi.mock("next/server", () => ({ after: (p: Promise<unknown>) => { s.later.push(p); } }));
vi.unmock("@/lib/generation/spend-cap");

import { JUDGE_CALL_MICRO, releaseSpend, reserveSpend, spendFits } from "@/lib/generation/spend-cap";

const ROOT = join(__dirname, "..", "..");
const MIGRATION = readFileSync(join(ROOT, "migrations", "2026-11-04-metered-spend.sql"), "utf8");
const COPY = join(ROOT, "..", "sql-to-run", "72-metered-spend.sql");
const USD = 1_000_000;

describe("SQL 72", () => {
  let db: PGlite;
  let client: SupabaseClient;
  const reserved = async () =>
    (await db.query<{ n: number }>("select coalesce(sum(reserved_micro), 0)::int as n from public.metered_spend_days")).rows[0].n;
  const reach = (micro: number, cap: number) => db.query<{ spend_day: string; allowed: boolean; first_refusal: boolean }>("select * from public.reserve_metered_spend($1, $2)", [micro, cap]);
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    `);
    await db.exec(MIGRATION);
    client = pglitePostgrest(db).client as unknown as SupabaseClient;
  }, 60_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.exec("TRUNCATE public.metered_spend_days");
    s.sent = []; s.fail = false; s.refuses = ""; s.later = [];
    vi.stubEnv("OPS_ALERT_EMAILS", "a@enki.test, b@enki.test");
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("runs twice", async () => {
    await db.exec(MIGRATION);
    expect(await reserveSpend(client, 5)).toMatchObject({ ok: true, micro: 5 });
  });

  // Kev's copy for the SQL editor, outside the repo: compared where it exists (his checkout), skipped elsewhere (CI).
  it.skipIf(!existsSync(COPY))("is in sql-to-run byte for byte", async () => {
    // Read past the in-memory mutation runner (it patches readFileSync only): this compares the files on disk.
    expect((await readFile(COPY)).equals(await readFile(join(ROOT, "migrations", "2026-11-04-metered-spend.sql")))).toBe(true);
  });

  it("reserves in one UPDATE whose WHERE holds the cap, the statement two sessions cannot both pass", () => {
    expect(MIGRATION).toMatch(/UPDATE public\.metered_spend_days SET reserved_micro = reserved_micro \+ p_micro\n\s+WHERE day = v_day AND reserved_micro \+ p_micro <= p_cap_micro;\n\s+IF FOUND THEN/);
  });

  it("closes the table and the functions: RLS on, execute for the service role alone, a fixed search_path", async () => {
    const one = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows[0];
    expect(await one("select relrowsecurity as on from pg_class where relname = 'metered_spend_days'")).toEqual({ on: true });
    for (const role of ["anon", "authenticated"]) {
      expect(await one(`select has_table_privilege('${role}', 'public.metered_spend_days', 'SELECT,INSERT,UPDATE,DELETE') as can`)).toEqual({ can: false });
      for (const fn of ["reserve_metered_spend(bigint, bigint)", "release_metered_spend(date, bigint)", "clear_first_refusal_metered_spend(date)"]) {
        expect(await one(`select has_function_privilege('${role}', 'public.${fn}', 'EXECUTE') as can`)).toEqual({ can: false });
      }
    }
    for (const fn of ["reserve_metered_spend(bigint, bigint)", "release_metered_spend(date, bigint)", "clear_first_refusal_metered_spend(date)"]) {
      expect(await one(`select has_function_privilege('service_role', 'public.${fn}', 'EXECUTE') as can`)).toEqual({ can: true });
      expect(await one(`select prosecdef as definer, proconfig as config from pg_proc where oid = 'public.${fn}'::regprocedure`))
        .toEqual({ definer: true, config: ["search_path=public, pg_temp"] });
    }
    expect(await one("select has_function_privilege('public', 'public.reserve_metered_spend(bigint, bigint)', 'EXECUTE') as can")).toEqual({ can: false });
  });

  it("works for the service role with no grant on the table, and refuses anon outright", async () => {
    await db.exec("SET ROLE service_role");
    try { expect((await reach(5, 10)).rows[0].allowed).toBe(true); } finally { await db.exec("RESET ROLE"); }
    await db.exec("SET ROLE anon");
    try { await expect(reach(5, 10)).rejects.toMatchObject({ code: "42501" }); } finally { await db.exec("RESET ROLE"); }
  });

  it("passes exactly at the cap, refuses the next, and a refusal adds nothing", async () => {
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "1");
    expect(await reserveSpend(client, USD - 1)).toMatchObject({ ok: true, day: expect.stringMatching(`^${today()}`), micro: USD - 1 });
    expect(await reserveSpend(client, 1)).toMatchObject({ ok: true });
    expect(await reserved()).toBe(USD);
    expect(await reserveSpend(client, 1)).toMatchObject({ ok: false, status: 503, error: expect.stringContaining("daily limit") });
    expect(await reserved()).toBe(USD);
  });

  it("says no to what does not fit, whatever already fits later", async () => {
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "1");
    expect(await reserveSpend(client, USD - 10)).toMatchObject({ ok: true });
    expect(await reserveSpend(client, 11)).toMatchObject({ ok: false });
    expect(await reserveSpend(client, 10)).toMatchObject({ ok: true });
  });

  it("two reservations racing for the last place: exactly one passes, in one session's order", async () => {
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "1");
    await reserveSpend(client, USD - 100);
    const both = await Promise.all([reserveSpend(client, 100), reserveSpend(client, 100)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await reserved()).toBe(USD);
    await Promise.all(s.later);
    expect(s.sent).toHaveLength(2); // Two recipients, one mail each: the second refusal's first_refusal is false.
  });

  it("twenty racing for ten places: ten pass and the day's total is the cap, never above", async () => {
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "0.001");
    const all = await Promise.all(Array.from({ length: 20 }, () => reserveSpend(client, 100)));
    expect(all.filter((r) => r.ok)).toHaveLength(10);
    expect(await reserved()).toBe(1000);
  });

  it("says first_refusal once a day, and mails each recipient once, naming no key", async () => {
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "0.0001");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-secret-value");
    await reserveSpend(client, 100);
    await reserveSpend(client, 100);
    await reserveSpend(client, 100);
    await Promise.all(s.later);
    expect(s.sent.map((m) => m.to)).toEqual(["a@enki.test", "b@enki.test"]);
    expect(s.sent[0].subject).toBe("Enki: the daily spend limit was reached");
    expect(s.sent[0].text).toContain("$0.0001");
    expect(s.sent[0].text).toContain("METERED_SPEND_USD_PER_DAY");
    expect(s.sent[0].text).toContain("public.metered_spend_days");
    expect(JSON.stringify(s.sent)).not.toContain("fixture-secret-value");
    expect((await db.query<{ set: boolean }>("select first_refused_at is not null as set from public.metered_spend_days")).rows).toEqual([{ set: true }]);
  });

  it("a mail that fails changes no answer, says so, and the next refusal tries again", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "0.0001");
    await reserveSpend(client, 100);
    s.fail = true;
    expect(await reserveSpend(client, 100)).toMatchObject({ ok: false });
    await Promise.all(s.later);
    expect(s.sent).toEqual([]);
    expect(logged).toHaveBeenCalledWith("[spend-cap] the mail was not sent");
    s.fail = false;
    expect(await reserveSpend(client, 100)).toMatchObject({ ok: false });
    await Promise.all(s.later);
    expect(s.sent.map((m) => m.to)).toEqual(["a@enki.test", "b@enki.test"]);
    expect(await reserveSpend(client, 100)).toMatchObject({ ok: false });
    await Promise.all(s.later);
    expect(s.sent).toHaveLength(2);
  });

  it("no recipient: says so once a day and keeps the mark, nothing can be retried", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OPS_ALERT_EMAILS", "");
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "0.0001");
    await reserveSpend(client, 100);
    await reserveSpend(client, 100);
    await reserveSpend(client, 100);
    await Promise.all(s.later);
    expect(logged.mock.calls.filter((c) => c[0] === "[spend-cap] the mail was not sent")).toHaveLength(1);
  });

  it("one recipient reached is a mail sent: the mark stays", async () => {
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "0.0001");
    s.refuses = "b@enki.test";
    await reserveSpend(client, 100);
    await reserveSpend(client, 100);
    await Promise.all(s.later);
    expect(s.sent).toHaveLength(1);
    // Asked only after the first mail finished: a clear still on its way must not hide behind the race.
    await reserveSpend(client, 100);
    await Promise.all(s.later);
    expect(s.sent).toHaveLength(1);
  });

  it("the mail says what is true when one large render did not fit and smaller ones still pass", async () => {
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "1");
    await reserveSpend(client, 900_000);
    expect(await reserveSpend(client, 200_000)).toMatchObject({ ok: false });
    expect(await reserveSpend(client, 50_000)).toMatchObject({ ok: true });
    await Promise.all(s.later);
    expect(s.sent[0].text).toContain("smaller ones can still pass");
    expect(s.sent[0].text).not.toMatch(/every new paid generation is refused/i);
  });

  it("the mark can only be cleared by the service role's function, for one day", async () => {
    await db.exec("INSERT INTO public.metered_spend_days (day, first_refused_at) VALUES ('2026-01-01', now()), ('2026-01-02', now())");
    await db.query("select public.clear_first_refusal_metered_spend($1)", ["2026-01-01"]);
    expect((await db.query<{ set: boolean }>("select first_refused_at is not null as set from public.metered_spend_days order by day")).rows).toEqual([{ set: false }, { set: true }]);
  });

  it("spendFits holds no place: a bill that fits leaves the day as it was, one that does not is the reservation's own refusal", async () => {
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "1");
    expect(await reserveSpend(client, 500_000)).toMatchObject({ ok: true });
    expect(await spendFits(client, 400_000)).toMatchObject({ ok: true, micro: 400_000 });
    expect(await reserved()).toBe(500_000);
    expect(await spendFits(client, 600_000)).toMatchObject({ ok: false, retry: false, error: expect.stringContaining("daily limit") });
    expect(await spendFits(null, 1)).toMatchObject({ ok: false, retry: true });
  });

  it("a cap of 0 closes on purpose: every call refused, no mark and no mail", async () => {
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "0");
    expect(await reserveSpend(client, 1)).toMatchObject({ ok: false, error: expect.stringContaining("daily limit") });
    expect(await reserveSpend(client, 1)).toMatchObject({ ok: false });
    expect(s.later).toEqual([]);
    expect((await db.query<{ set: boolean }>("select first_refused_at is not null as set from public.metered_spend_days")).rows).toEqual([{ set: false }]);
  });

  it("reads the cap from the env: the default is $100, what cannot be read is the default, never no limit", async () => {
    for (const set of ["", "abc", "-5", "Infinity", "NaN"]) {
      await db.exec("TRUNCATE public.metered_spend_days");
      vi.stubEnv("METERED_SPEND_USD_PER_DAY", set);
      expect(await reserveSpend(client, 100 * USD)).toMatchObject({ ok: true });
      expect(await reserveSpend(client, 1)).toMatchObject({ ok: false });
    }
    await db.exec("TRUNCATE public.metered_spend_days");
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "2.5");
    expect(await reserveSpend(client, 2.5 * USD)).toMatchObject({ ok: true });
    expect(await reserveSpend(client, 1)).toMatchObject({ ok: false });
  });

  it("a new day starts at 0, and yesterday's full row stays", async () => {
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "1");
    await db.query("insert into public.metered_spend_days (day, reserved_micro) values (($1::date - 1), $2)", [today(), USD]);
    expect(await reserveSpend(client, USD)).toMatchObject({ ok: true, day: expect.stringMatching(`^${today()}`) });
    expect((await db.query("select day from public.metered_spend_days")).rows).toHaveLength(2);
  });

  it("gives back on its own day, floors at 0, and leaves other days alone", async () => {
    vi.stubEnv("METERED_SPEND_USD_PER_DAY", "1");
    const held = await reserveSpend(client, 300);
    if (!held.ok) throw new Error("not reserved");
    await db.query("insert into public.metered_spend_days (day, reserved_micro) values (($1::date - 1), 500)", [today()]);
    await releaseSpend(client, held);
    const rows = async () => (await db.query<{ n: number }>("select reserved_micro::int as n from public.metered_spend_days order by day")).rows.map((r) => r.n);
    expect(await rows()).toEqual([500, 0]);
    await reserveSpend(client, 10);
    await releaseSpend(client, held);
    expect(await rows()).toEqual([500, 0]);
    await releaseSpend(client, { ...held, day: "2020-01-01" });
    expect(await rows()).toEqual([500, 0]);
  });

  it.each([[0], [-1], [NaN], [1.5]])("an amount of %s is refused, never a free pass", async (micro) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reserveSpend(client, micro)).toMatchObject({ ok: false, error: expect.stringContaining("could not check") });
    expect(await reserved()).toBe(0);
  });

  it("raises on a wrong call: 22023, not an answer", async () => {
    for (const args of [[0, 10], [-1, 10], [null, 10], [1, -1], [1, null]]) {
      await expect(db.query("select * from public.reserve_metered_spend($1, $2)", args)).rejects.toMatchObject({ code: "22023" });
    }
    for (const args of [[today(), 0], [today(), -1], [null, 1], [today(), null]]) {
      await expect(db.query("select public.release_metered_spend($1, $2)", args)).rejects.toMatchObject({ code: "22023" });
    }
  });
});

describe("a reading that fails refuses", () => {
  const replying = (reply: unknown) => ({ rpc: async () => reply }) as unknown as SupabaseClient;
  const UNREAD = { ok: false, status: 503, why: "Enki could not check its daily limit right now." };
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("no client", async () => {
    expect(await reserveSpend(null, 100)).toMatchObject(UNREAD);
  });
  it("a function that is missing, said once for all the calls that meet it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = replying({ data: null, error: { code: "PGRST202", message: "no function" } });
    // First in this file to meet it: the warning is one per server process.
    expect(await reserveSpend(db, 100)).toMatchObject(UNREAD);
    expect(await reserveSpend(db, 100)).toMatchObject(UNREAD);
    expect(log.mock.calls.filter((c) => String(c[0]).includes("SQL 72"))).toHaveLength(1);
  });
  it.each([
    ["a database error", { data: null, error: { code: "XX000", message: "boom" } }],
    ["no row", { data: [], error: null }],
    ["two rows", { data: [{ allowed: true, spend_day: "2026-11-04" }, { allowed: true, spend_day: "2026-11-04" }], error: null }],
    ["a scalar", { data: true, error: null }],
    ["allowed without a day", { data: [{ allowed: true }], error: null }],
    ["allowed as text", { data: [{ allowed: "true", spend_day: "2026-11-04" }], error: null }],
    ["nothing at all", null],
  ])("%s", async (_name, reply) => {
    expect(await reserveSpend(replying(reply), 100)).toMatchObject(UNREAD);
  });
  it("an unreachable database", async () => {
    const db = { rpc: async () => { throw new TypeError("fetch failed"); } } as unknown as SupabaseClient;
    expect(await reserveSpend(db, 100)).toMatchObject(UNREAD);
  });
  it("a failed give-back throws nothing and keeps the reservation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = { rpc: async () => { throw new TypeError("fetch failed"); } } as unknown as SupabaseClient;
    await expect(releaseSpend(down, { ok: true, day: "2026-11-04", micro: 1 })).resolves.toBeUndefined();
    await expect(releaseSpend(replying({ error: { code: "XX000" } }), { ok: true, day: "2026-11-04", micro: 1 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it("the words say nothing was generated and nothing was charged", async () => {
    expect((await reserveSpend(null, 1) as { error: string }).error).toBe("Enki could not check its daily limit right now. Nothing was generated and nothing was charged.");
  });
  it("one judge is priced by the code's own bound", () => {
    expect(JUDGE_CALL_MICRO).toBe(300);
  });
});
