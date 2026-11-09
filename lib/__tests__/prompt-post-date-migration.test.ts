import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { snowflakeDate } from "@/lib/hunter/x-api";

/** SQL 58 (Kev, 2026-10-31: "save inside of the prompts the date of the post"): the column, and the post's date backfilled from its X id. */
const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(join(ROOT, "migrations", "2026-10-31-prompt-post-date.sql"), "utf8");

describe("SQL 58: a prompt keeps its post's date", () => {
  it("adds source_posted_at and fills it for hunted prompts from the X id, the same instant the app reads; runs twice", async () => {
    const db = await PGlite.create();
    await db.exec(`create table public.prompts (id uuid primary key);
      alter table public.prompts add column aspect_ratio text;
      create table public.hunt_submissions (minted_prompt_id uuid, normalized_source_url text);
      create table public.generated_images (prompt_id uuid, sequence_index int, is_uploaded boolean, width int, height int);
      insert into public.generated_images values ('00000000-0000-4000-8000-000000000001', 0, true, 1107, 619), ('00000000-0000-4000-8000-000000000001', 1, true, 600, 900);
      insert into public.prompts values ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
      insert into public.hunt_submissions values ('00000000-0000-4000-8000-000000000001', 'x.com/status/2116173811842208129'), (null, 'x.com/status/1');`);
    await db.exec(SQL);
    await db.exec(SQL);
    const rows = (await db.query<{ id: string; at: Date | null }>(`select id::text, source_posted_at as at from public.prompts order by id`)).rows;
    expect(rows[0].at?.toISOString()).toBe(snowflakeDate("2116173811842208129")!.toISOString());
    expect(rows[0].at?.toISOString().slice(0, 16)).toBe("2026-10-30T14:22");
    expect(rows[1].at).toBeNull();
    // The imported prompt's first picture's shape, so cards show it whole (Kev, 2026-10-31).
    expect((await db.query(`select aspect_ratio from public.prompts order by id`)).rows).toEqual([{ aspect_ratio: "1107:619" }, { aspect_ratio: null }]);
    await db.close();
  }, 60_000);
});
