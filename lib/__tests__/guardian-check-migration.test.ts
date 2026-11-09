import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * SQL 75 in a real Postgres (PGlite): the yearly guardian check's four columns on recovery_guardians. It runs twice, an existing
 * guardian keeps every value and starts with no check, its own Check reads what it says, and its Rollback removes the four.
 * Blind spot: the stand-in table holds only the columns the code reads.
 */
const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-11-07-guardian-check.sql"), "utf8").replace(/\r\n/g, "\n");
const after = (label: string) => new RegExp(`-- ${label}[^\\n]*\\n--\\s+([^\\n]+)`).exec(SQL)![1];
const G = "22222222-2222-4222-8222-222222222222";

describe("SQL 75: the yearly guardian check", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create table public.recovery_guardians (
        id uuid primary key, user_id uuid not null, guardian_type text not null, value text, status text not null default 'pending',
        confirmed_at timestamptz, created_at timestamptz not null default now()
      );
      insert into public.recovery_guardians (id, user_id, guardian_type, value, status, confirmed_at)
        values ('${G}', '${G}', 'email', 'g@friends.test', 'confirmed', '2025-10-01T00:00:00Z');
    `);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("runs a second time without harm", async () => {
    await db.exec(SQL);
  });

  it("adds the four columns, and a guardian there before starts with no check and keeps the rest", async () => {
    const cols = (await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_name = 'recovery_guardians' and column_name in ('checked_at', 'check_sent_at', 'check_token_hash', 'unreachable_at') order by column_name`,
    )).rows;
    expect(cols).toEqual([
      { column_name: "check_sent_at", data_type: "timestamp with time zone" },
      { column_name: "check_token_hash", data_type: "text" },
      { column_name: "checked_at", data_type: "timestamp with time zone" },
      { column_name: "unreachable_at", data_type: "timestamp with time zone" },
    ]);
    expect((await db.query(`select status, value, checked_at, check_sent_at, check_token_hash, unreachable_at from public.recovery_guardians`)).rows)
      .toEqual([{ status: "confirmed", value: "g@friends.test", checked_at: null, check_sent_at: null, check_token_hash: null, unreachable_at: null }]);
  });

  it("its Check counts open checks and marks", async () => {
    await db.exec(`update public.recovery_guardians set check_sent_at = now(), unreachable_at = now()`);
    expect((await db.query(after("Check"))).rows).toEqual([{ open: 1, unreachable: 1 }]);
  });

  it("its Rollback removes the four columns and nothing else", async () => {
    await db.exec(after("Rollback"));
    const cols = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'recovery_guardians' order by ordinal_position`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(["id", "user_id", "guardian_type", "value", "status", "confirmed_at", "created_at"]);
  });
});
