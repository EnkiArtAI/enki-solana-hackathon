import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";

/**
 * SQL 63 on a real Postgres, through the helpers the route calls (Kev, 2026-10-30: "only humans are allowed to have 1
 * for free"). The daily cap over all accounts, one per hashed address, every place given back on a failure, and the
 * answer before the migration: today's limits, one warning, nothing refused.
 *
 * Blind spot: PGlite is one session, so parallel calls run one after the other here and the advisory lock is never
 * contended. The parallel test proves the count; the pin on the lock proves the lock is there.
 */
const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string; subject: string; text: string }) => { mail.sent.push(m); return { ok: true }; } }));

import { claimFreeRenderCaps, ipBucket, releaseFreeRenderCaps, tellFreeRendersFull } from "@/lib/generation/free-render-caps";

const ROOT = join(__dirname, "..", "..");
const MIGRATION = readFileSync(join(ROOT, "migrations", "2026-11-02-free-render-caps.sql"), "utf8");
const COPY = join(ROOT, "..", "sql-to-run", "63-free-render-caps.sql");
const PEPPER = "a-test-pepper";

const from = (ip: string | null, forwarded?: string) => ({ headers: { get: (name: string) =>
  name === "x-real-ip" ? ip : name === "x-forwarded-for" ? forwarded ?? null : null } }) as unknown as NextRequest;

describe("SQL 63", () => {
  let db: PGlite;
  let client: SupabaseClient;
  const count = async (table = "free_render_claims") =>
    (await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    `);
    await db.exec(MIGRATION);
    client = pglitePostgrest(db).client as unknown as SupabaseClient;
    process.env.AUTH_PEPPER = PEPPER;
  }, 60_000);
  afterAll(async () => { await db.close(); delete process.env.AUTH_PEPPER; });
  beforeEach(async () => {
    await db.exec("TRUNCATE public.free_render_claims, public.free_render_full_days");
    delete process.env.FREE_RENDERS_PER_DAY;
    mail.sent = [];
  });

  it("runs twice", async () => {
    await db.exec(MIGRATION);
    expect(await claimFreeRenderCaps(client, from("1.1.1.1"))).toMatchObject({ allowed: true, claimId: expect.any(String) });
  });

  // Kev's copy for the SQL editor, outside the repo: compared where it exists (his checkout), skipped elsewhere (CI).
  it.skipIf(!existsSync(COPY))("is in sql-to-run byte for byte", async () => {
    // Read past the in-memory mutation runner (it patches readFileSync only): this compares the files on disk.
    expect((await readFile(COPY)).equals(await readFile(join(ROOT, "migrations", "2026-11-02-free-render-caps.sql")))).toBe(true);
  });

  it("takes one claim at a time, by a transaction's lock, before it reads the day", () => {
    expect(MIGRATION).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\('free_render_claims', 0\)\);\n\s+v_day := \(clock_timestamp\(\) AT TIME ZONE 'UTC'\)::date;/);
  });

  it("gives one address one a day and another address its own, and stores the hash, never the address", async () => {
    const first = await claimFreeRenderCaps(client, from("1.1.1.1"));
    expect(first).toMatchObject({ allowed: true, claimId: expect.any(String) });
    expect(await claimFreeRenderCaps(client, from("1.1.1.1"))).toEqual({ allowed: false, reason: "ip", firstRefusal: false });
    expect(await claimFreeRenderCaps(client, from("2.2.2.2"))).toMatchObject({ allowed: true });
    const buckets = (await db.query<{ ip_bucket: string }>("select ip_bucket from public.free_render_claims")).rows.map((r) => r.ip_bucket);
    expect(buckets).toContain(createHmac("sha256", PEPPER).update("1.1.1.1").digest("hex"));
    expect(buckets.join()).not.toContain("1.1.1.1");
  });

  it("is not opened by a made-up forwarded address", async () => {
    expect(await claimFreeRenderCaps(client, from(null, "9.9.9.1, 7.7.7.7"))).toMatchObject({ allowed: true });
    expect(await claimFreeRenderCaps(client, from(null, "9.9.9.2, 7.7.7.7"))).toMatchObject({ allowed: false, reason: "ip" });
  });

  it("gives one IPv6 /64 one a day, however its host rotates and however an address is written", async () => {
    const bucket = (ip: string) => ipBucket(from(ip));
    const net = createHmac("sha256", PEPPER).update("2001:db8:1:2").digest("hex");
    for (const ip of ["2001:db8:1:2::a", "2001:db8:1:2:ffff:ffff:ffff:1", "2001:0DB8:0001:0002:0000:0000:0000:000A", "2001:db8:1:2::a%eth0"]) expect(bucket(ip)).toBe(net);
    expect(bucket("2001:db8:1:3::a")).not.toBe(net);
    expect(bucket("2001:db8::1")).toBe(createHmac("sha256", PEPPER).update("2001:db8:0:0").digest("hex"));
    expect(bucket("::1")).toBe(createHmac("sha256", PEPPER).update("0:0:0:0").digest("hex"));
    expect(bucket("::")).toBe(bucket("::1"));
    expect(await claimFreeRenderCaps(client, from("2001:db8:1:2::a"))).toMatchObject({ allowed: true });
    expect(await claimFreeRenderCaps(client, from("2001:db8:1:2::b"))).toEqual({ allowed: false, reason: "ip", firstRefusal: false });
    expect(await claimFreeRenderCaps(client, from("2001:db8:1:3::b"))).toMatchObject({ allowed: true });
  });

  it("reads a v4-mapped address as the IPv4 it is, and leaves what is no IPv6 as it came", async () => {
    const bucket = (ip: string) => ipBucket(from(ip));
    const v4 = createHmac("sha256", PEPPER).update("1.2.3.4").digest("hex");
    for (const ip of ["1.2.3.4", "::ffff:1.2.3.4", "::FFFF:102:304"]) expect(bucket(ip)).toBe(v4);
    expect(bucket("::ffff:0:102:304")).not.toBe(v4);
    expect(bucket("not an address")).toBe(createHmac("sha256", PEPPER).update("not an address").digest("hex"));
  });

  it("counts an unknown address under one shared bucket, a missing pepper too", async () => {
    expect(await claimFreeRenderCaps(client, from(null))).toMatchObject({ allowed: true });
    expect(await claimFreeRenderCaps(client, from(null))).toMatchObject({ allowed: false, reason: "ip" });
    await db.exec("TRUNCATE public.free_render_claims");
    delete process.env.AUTH_PEPPER;
    try {
      expect(ipBucket(from("1.1.1.1"))).toBe("unknown");
      expect(await claimFreeRenderCaps(client, from("1.1.1.1"))).toMatchObject({ allowed: true });
      expect(await claimFreeRenderCaps(client, from("2.2.2.2"))).toMatchObject({ allowed: false, reason: "ip" });
    } finally { process.env.AUTH_PEPPER = PEPPER; }
  });

  it("stops at the day's cap, in parallel too, and says so first only once", async () => {
    process.env.FREE_RENDERS_PER_DAY = "3";
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => claimFreeRenderCaps(client, from(`10.0.0.${i}`))));
    expect(all.filter((c) => c.allowed)).toHaveLength(3);
    expect(await count()).toBe(3);
    const refused = all.filter((c) => !c.allowed);
    expect(refused).toHaveLength(5);
    expect(refused.every((c) => !c.allowed && c.reason === "day")).toBe(true);
    expect(refused.filter((c) => !c.allowed && c.firstRefusal)).toHaveLength(1);
    expect(await count("free_render_full_days")).toBe(1);
  });

  it("a limit of 0 closes free renders: every try refused, no full day filed, no first refusal to mail about", async () => {
    process.env.FREE_RENDERS_PER_DAY = "0";
    for (const ip of ["1.1.1.1", "2.2.2.2"]) {
      expect(await claimFreeRenderCaps(client, from(ip))).toEqual({ allowed: false, reason: "day", firstRefusal: false });
    }
    expect(await count("free_render_full_days")).toBe(0);
    expect((await db.query<{ first_refusal: boolean | null }>("select first_refusal from public.claim_free_render('x', 0, 1)")).rows).toEqual([{ first_refusal: false }]);
    process.env.FREE_RENDERS_PER_DAY = "1";
    expect(await claimFreeRenderCaps(client, from("1.1.1.1"))).toMatchObject({ allowed: true });
    expect(await claimFreeRenderCaps(client, from("2.2.2.2"))).toEqual({ allowed: false, reason: "day", firstRefusal: true });
    expect(await count("free_render_full_days")).toBe(1);
  });

  it("defaults to 200 a day, and a broken FREE_RENDERS_PER_DAY does too", async () => {
    const seed = (n: number) => db.exec(`INSERT INTO public.free_render_claims (day, ip_bucket)
      SELECT (now() AT TIME ZONE 'UTC')::date, 'seed-' || g FROM generate_series(1, ${n}) g`);
    await seed(199);
    process.env.FREE_RENDERS_PER_DAY = "many";
    expect(await claimFreeRenderCaps(client, from("1.1.1.1"))).toMatchObject({ allowed: true });
    delete process.env.FREE_RENDERS_PER_DAY;
    expect(await claimFreeRenderCaps(client, from("2.2.2.2"))).toEqual({ allowed: false, reason: "day", firstRefusal: true });
  });

  it("FREE_RENDERS_PER_DAY=0 closes the day", async () => {
    process.env.FREE_RENDERS_PER_DAY = "0";
    expect(await claimFreeRenderCaps(client, from("1.1.1.1"))).toMatchObject({ allowed: false, reason: "day" });
    expect(await count()).toBe(0);
  });

  it("counts the day cap before the address, so a full day is said as one", async () => {
    process.env.FREE_RENDERS_PER_DAY = "1";
    expect(await claimFreeRenderCaps(client, from("1.1.1.1"))).toMatchObject({ allowed: true });
    expect(await claimFreeRenderCaps(client, from("1.1.1.1"))).toMatchObject({ allowed: false, reason: "day" });
  });

  it("gives a place back: the address and the day may try again", async () => {
    process.env.FREE_RENDERS_PER_DAY = "1";
    const first = await claimFreeRenderCaps(client, from("1.1.1.1"));
    if (!first.allowed) throw new Error("refused");
    await releaseFreeRenderCaps(client, first.claimId);
    expect(await count()).toBe(0);
    expect(await claimFreeRenderCaps(client, from("1.1.1.1"))).toMatchObject({ allowed: true });
  });

  it("counts only today and forgets earlier days' hashes; a new UTC day opens both caps", async () => {
    process.env.FREE_RENDERS_PER_DAY = "1";
    const bucket = ipBucket(from("1.1.1.1"));
    await db.query("INSERT INTO public.free_render_claims (day, ip_bucket) VALUES ((now() AT TIME ZONE 'UTC')::date - 1, $1)", [bucket]);
    expect(await claimFreeRenderCaps(client, from("1.1.1.1"))).toMatchObject({ allowed: true });
    const days = await db.query<{ today: boolean }>("select day = (now() AT TIME ZONE 'UTC')::date as today from public.free_render_claims");
    expect(days.rows).toEqual([{ today: true }]);
  });

  it("refuses a wrong call rather than reading it as free", async () => {
    await expect(db.query("select * from public.claim_free_render('', 1, 1)")).rejects.toThrow(/required/);
    await expect(db.query("select * from public.claim_free_render('x', null, 1)")).rejects.toThrow(/required/);
    await expect(db.query("select * from public.claim_free_render('x', 1, null)")).rejects.toThrow(/required/);
  });

  it("is the service role's only", async () => {
    const can = await db.query<Record<string, boolean>>(`SELECT
      has_function_privilege('anon', 'public.claim_free_render(text, int, int)', 'EXECUTE') AS anon_fn,
      has_function_privilege('authenticated', 'public.claim_free_render(text, int, int)', 'EXECUTE') AS auth_fn,
      has_function_privilege('service_role', 'public.claim_free_render(text, int, int)', 'EXECUTE') AS service_fn,
      has_table_privilege('anon', 'public.free_render_claims', 'SELECT') AS anon_read,
      has_table_privilege('authenticated', 'public.free_render_full_days', 'SELECT') AS auth_read,
      has_table_privilege('service_role', 'public.free_render_claims', 'DELETE') AS service_delete`);
    expect(can.rows[0]).toEqual({ anon_fn: false, auth_fn: false, service_fn: true, anon_read: false, auth_read: false, service_delete: true });
    const rls = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname in ('free_render_claims', 'free_render_full_days')");
    expect(rls.rows).toEqual([{ relrowsecurity: true }, { relrowsecurity: true }]);
  });

  // Said out loud in the file (changelog 45329): this schema gives the role no table by default, so what it can do here is
  // what the file grants. Each statement is what lib/generation/free-render-caps sends.
  it("grants the service role what the code does on both tables, and no more", async () => {
    await db.exec(`SET ROLE service_role`);
    const denied = (sql: string) => db.exec(sql).then(() => "ok", (e: { code?: string }) => e.code);
    try {
      const got = await db.query<{ claim_id: string }>(`select * from public.claim_free_render('grants', 1, 1)`);
      // The function writes the day's row as its owner: a second claim fills the day.
      const full = await db.query<{ refused: string; first_refusal: boolean }>(`select * from public.claim_free_render('grants2', 1, 1)`);
      expect(full.rows[0]).toMatchObject({ refused: "day", first_refusal: true });
      expect((await db.query(`delete from public.free_render_claims where id = '${got.rows[0].claim_id}'`)).affectedRows).toBe(1);
      for (const sql of [
        `insert into public.free_render_claims (day, ip_bucket) values (now()::date, 'x')`,
        `update public.free_render_claims set ip_bucket = 'x'`,
        `select day from public.free_render_full_days`,
        `insert into public.free_render_full_days (day) values ('2020-01-01')`,
        `delete from public.free_render_full_days`,
      ]) expect(await denied(sql)).toBe("42501");
    } finally {
      await db.exec(`RESET ROLE`);
    }
  });

  it("writes the day's mail to every OPS_ALERT_EMAILS address, and to nobody without one", async () => {
    process.env.OPS_ALERT_EMAILS = "a@enki.test, b@enki.test";
    process.env.FREE_RENDERS_PER_DAY = "7";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await tellFreeRendersFull();
      expect(mail.sent.map((m) => m.to)).toEqual(["a@enki.test", "b@enki.test"]);
      expect(mail.sent[0].subject).toBe("Enki: the daily cap on free renders was reached");
      expect(mail.sent[0].text).toMatch(/^The cap of 7 free renders a UTC day was reached at \d{4}-\d\d-\d\dT\d\d:\d\d/);
      expect(mail.sent[0].text).toContain("the places of renders that fail come back");
      expect(mail.sent[0].text).not.toContain("until midnight");
      mail.sent = [];
      delete process.env.OPS_ALERT_EMAILS;
      await tellFreeRendersFull();
      expect(mail.sent).toEqual([]);
    } finally { warn.mockRestore(); delete process.env.OPS_ALERT_EMAILS; }
  });
});

describe("before SQL 63", () => {
  it("lets the render through, warns once, and an outage or another error is still said as one", async () => {
    vi.resetModules();
    const { claimFreeRenderCaps: claim } = await import("@/lib/generation/free-render-caps");
    const answering = (error: { code?: string; message?: string } | null, data: unknown = null) =>
      ({ rpc: async () => ({ data, error }) }) as unknown as SupabaseClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const code of ["PGRST202", "42883", "PGRST202"]) {
        expect(await claim(answering({ code }), from("1.1.1.1"))).toEqual({ allowed: true, claimId: null });
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("SQL 63 has not run");
      await expect(claim(answering({ message: "TypeError: fetch failed" }), from("1.1.1.1"))).rejects.toThrow("database unreachable");
      await expect(claim(answering({ code: "42501", message: "denied" }), from("1.1.1.1"))).rejects.toThrow("free render caps failed");
      // A malformed reply grants nothing.
      for (const data of [null, [], [{}], [{ claim_id: null, refused: "other" }], [{ claim_id: 7 }], [{ claim_id: "a" }, { claim_id: "b" }]]) {
        await expect(claim(answering(null, data), from("1.1.1.1"))).rejects.toThrow("free render caps failed");
      }
    } finally { warn.mockRestore(); }
  });

  it("the helper on a database without the migration, through the real client double", async () => {
    vi.resetModules();
    const { claimFreeRenderCaps: claim } = await import("@/lib/generation/free-render-caps");
    const db = await PGlite.create();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const client = pglitePostgrest(db).client as unknown as SupabaseClient;
      expect(await claim(client, from("1.1.1.1"))).toEqual({ allowed: true, claimId: null });
      expect(await claim(client, from("1.1.1.1"))).toEqual({ allowed: true, claimId: null });
    } finally { warn.mockRestore(); await db.close(); }
  }, 60_000);
});
