import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * SQL 57 on a real Postgres (Kev, 2026-10-31: "mach bitte einfach 2 bilder gratis pro account for ever. danach ist
 * auffüllen angesagt."): two free images per account in its whole life, after the claims table (2026-10-06) and the
 * daily rule it replaces (2026-10-12).
 */
const sql = (f: string) => readFileSync(join(__dirname, "..", "..", "migrations", f), "utf8");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("two free images per account, ever (SQL 57)", () => {
  let db: PGlite;
  const claim = async (user: string, limit = 2) => (await db.query<{ id: string | null }>("SELECT public.claim_free_generation($1, $2) AS id", [user, limit])).rows[0].id;
  const quota = async (user: string) => (await db.query<{ remaining: number }>("SELECT * FROM public.free_generation_quota($1)", [user])).rows[0];

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.users (id uuid PRIMARY KEY);
      CREATE TABLE public.generations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.users(id),
        provider text, created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO public.users VALUES ('${A}'), ('${B}');
    `);
    for (const f of ["2026-10-06-free-generation-claims.sql", "2026-10-12-free-daily-quota.sql", "2026-10-31-free-lifetime-quota.sql"]) await db.exec(sql(f));
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("grants two, then none, whatever the day; a claim made under the daily rule counts", async () => {
    // One claimed yesterday under the daily rule.
    await db.query("INSERT INTO public.free_generation_claims (user_id, created_at) VALUES ($1, now() - interval '1 day')", [A]);
    expect(await quota(A)).toEqual({ used: 1, limit: 2, remaining: 1, exhausted: false, resets_at: null });
    expect(await claim(A)).toEqual(expect.any(String));
    expect(await claim(A)).toBeNull();
    await db.query("UPDATE public.free_generation_claims SET created_at = created_at - interval '30 days' WHERE user_id = $1", [A]);
    expect(await claim(A)).toBeNull();
    expect(await quota(A)).toEqual({ used: 2, limit: 2, remaining: 0, exhausted: true, resets_at: null });
  });

  it("gives a failed render's claim back, and a caller still passing 1 gets one in all", async () => {
    expect(await claim(B, 1)).toEqual(expect.any(String));
    expect(await claim(B, 1)).toBeNull();
    const id = await claim(B);
    expect(id).toEqual(expect.any(String));
    await db.query("DELETE FROM public.free_generation_claims WHERE id = $1", [id]);
    expect((await quota(B)).remaining).toBe(1);
    expect(await claim(B, 99)).toEqual(expect.any(String));
    expect(await claim(B, 99)).toBeNull();
  });

  it("is the service role's only", async () => {
    const can = await db.query<{ anon: boolean; service: boolean }>(`SELECT
      has_function_privilege('anon', 'public.claim_free_generation(uuid, int)', 'EXECUTE') AS anon,
      has_function_privilege('service_role', 'public.claim_free_generation(uuid, int)', 'EXECUTE') AS service`);
    expect(can.rows[0]).toEqual({ anon: false, service: true });
  });
});
