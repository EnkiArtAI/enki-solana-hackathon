// Every prompt has a title; one made on the side is "enki-" and a unique id
// (Kev, 2026-10-17). Prompts a Quick Create or editor test render made before
// that are called "Untitled"; this gives each the title one gets now
// (lib/generation/auto-title.ts).
//
//   node scripts/backfill-prompt-titles.mjs           dry run: counts only
//   node scripts/backfill-prompt-titles.mjs --apply   writes them
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local. Prints
// counts only. A row whose title changed since it was read is left alone.
//
// Until the deploy that stops new prompts from being saved "Untitled", the old
// code keeps making them: run it once more after that deploy, and BEFORE the
// CHECK in migrations/2026-10-17-prompts-title-real.sql.
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const jiti = createJiti(import.meta.url);
const { autoTitle } = await jiti.import("../lib/generation/auto-title.ts");
const { isRealTitle } = await jiti.import("../lib/prompt-title.ts");

const apply = process.argv.includes("--apply");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const res = await fetch(`${url}/rest/v1/prompts?select=id,creator_id,title&order=created_at.asc`, { headers });
if (!res.ok) throw new Error(`GET prompts: ${res.status}`);
const untitled = (await res.json()).filter((p) => !isRealTitle(p.title));

const counts = { untitled: untitled.length, owners: new Set(untitled.map((p) => p.creator_id)).size, written: 0, changedMeanwhile: 0 };
if (apply) {
  for (const p of untitled) {
    const same = p.title === null ? "title=is.null" : `title=eq.${encodeURIComponent(p.title)}`;
    const patch = await fetch(`${url}/rest/v1/prompts?id=eq.${p.id}&${same}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ title: autoTitle() }),
    });
    if (!patch.ok) throw new Error(`PATCH ${p.id}: ${patch.status}`);
    (await patch.json()).length ? counts.written++ : counts.changedMeanwhile++;
  }
}
console.log(`${apply ? "applied" : "dry run (--apply writes)"}: ${JSON.stringify(counts)}`);
