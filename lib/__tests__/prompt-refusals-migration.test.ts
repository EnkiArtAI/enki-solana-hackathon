import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-27-prompt-refusals.sql in a real Postgres, on Supabase's roles and default privileges: a refusal
 * names why and whose order it was, never more than a short detail, goes with its prompt, keeps its row when the buyer's
 * account goes, is decided once with who decided it, and only the service role reaches the table.
 */

const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-27-prompt-refusals.sql"), "utf8");
// The commented block at the end of the file, as it would be pasted.
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [PROMPT, OTHER, BUYER, ADMIN] = [1, 2, 3, 4].map(id);

describe("the prompt refusals migration", () => {
  let db: PGlite;
  const refuse = (fields: Record<string, unknown> = {}) => {
    const row = { prompt_id: PROMPT, cause: "moderation", detail: "violence", buyer_user_id: BUYER, ...fields };
    const cols = Object.keys(row);
    return db.query<{ id: string }>(
      `insert into public.prompt_refusals (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(row),
    );
  };

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create table public.users (id uuid primary key);
      create table public.prompts (id uuid primary key);
      insert into public.users values ('${BUYER}'), ('${ADMIN}');
      insert into public.prompts values ('${PROMPT}'), ('${OTHER}');
    `);
    await db.exec(SQL);
    await db.exec(SQL); // runs twice without harm
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("records why a render was refused, open until decided, and never more than a short detail", async () => {
    const { rows: [r] } = await refuse({ cause: "provider", detail: "OpenAI" });
    const { rows: [row] } = await db.query(`select cause, detail, paused, reviewed_at, decision from public.prompt_refusals where id = $1`, [r.id]);
    expect(row).toEqual({ cause: "provider", detail: "OpenAI", paused: false, reviewed_at: null, decision: null });
    await expect(refuse({ cause: "buyer" })).rejects.toThrow(/check constraint/);
    // A render that spelled out the hidden text (review wf_866ba07b-01a): the artist's lettering, or someone's extraction.
    await refuse({ cause: "render", detail: "hidden text" });
    await expect(refuse({ detail: "x".repeat(121) })).rejects.toThrow(/check constraint/);
    await refuse({ detail: "x".repeat(120) });
  });

  it("is decided once, with a decision and its time together", async () => {
    const { rows: [r] } = await refuse({ paused: true });
    await expect(db.query(`update public.prompt_refusals set reviewed_at = now() where id = $1`, [r.id])).rejects.toThrow(/check constraint/);
    await expect(db.query(`update public.prompt_refusals set decision = 'released' where id = $1`, [r.id])).rejects.toThrow(/check constraint/);
    await expect(db.query(`update public.prompt_refusals set decision = 'kept', reviewed_at = now() where id = $1`, [r.id])).rejects.toThrow(/check constraint/);
    for (const decision of ["released", "delisted"]) {
      await db.query(`update public.prompt_refusals set decision = $2, reviewed_at = now(), reviewed_by = $3 where id = $1`, [r.id, decision, ADMIN]);
    }
  });

  it("goes with its prompt, and keeps its row when the buyer's or the admin's account goes", async () => {
    const { rows: [a] } = await refuse({ prompt_id: OTHER, reviewed_by: ADMIN, reviewed_at: new Date(), decision: "released" });
    await db.query(`delete from public.users where id = $1`, [ADMIN]);
    expect((await db.query(`select buyer_user_id, reviewed_by from public.prompt_refusals where id = $1`, [a.id])).rows).toEqual([{ buyer_user_id: BUYER, reviewed_by: null }]);
    await db.query(`delete from public.users where id = $1`, [BUYER]);
    expect((await db.query(`select buyer_user_id from public.prompt_refusals where id = $1`, [a.id])).rows).toEqual([{ buyer_user_id: null }]);
    await db.query(`delete from public.prompts where id = $1`, [OTHER]);
    expect((await db.query(`select 1 from public.prompt_refusals where id = $1`, [a.id])).rows).toEqual([]);
    await db.query(`insert into public.users values ($1), ($2)`, [BUYER, ADMIN]);
  });

  it("keeps the open ones indexed by prompt, cause and newest first", async () => {
    expect((await db.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'prompt_refusals_open_idx'`)).rows[0]?.indexdef)
      .toMatch(/\(prompt_id, cause, created_at DESC\) WHERE \(reviewed_at IS NULL\)/);
  });

  it("lets only the service role read or write the table", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        for (const sql of ["select * from public.prompt_refusals", `insert into public.prompt_refusals (prompt_id, cause) values ('${PROMPT}', 'provider')`]) {
          await expect(db.query(sql), `${role}: ${sql}`).rejects.toThrow(/permission denied/);
        }
      } finally {
        await db.exec("reset role");
      }
    }
    await db.exec("set role service_role");
    try {
      expect(Number((await db.query<{ n: unknown }>(`select count(*) as n from public.prompt_refusals`)).rows[0].n)).toBeGreaterThan(0);
    } finally {
      await db.exec("reset role");
    }
    expect((await db.query(`select relrowsecurity from pg_class where relname = 'prompt_refusals'`)).rows).toEqual([{ relrowsecurity: true }]);
  });

  it("rolls back to nothing", async () => {
    await db.exec(ROLLBACK);
    expect((await db.query(`select to_regclass('public.prompt_refusals') as t`)).rows).toEqual([{ t: null }]);
  });
});
