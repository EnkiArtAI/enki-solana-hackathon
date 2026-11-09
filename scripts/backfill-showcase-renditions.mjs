// The small renditions (SQL 60) of every prompt's example images; lib/generation/small-renditions.
//
//   node scripts/backfill-showcase-renditions.mjs           dry run: how many images need them
//   node scripts/backfill-showcase-renditions.mjs --apply   makes and stores them (Vercel Blob: two puts an image)
//
// Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and BLOB_READ_WRITE_TOKEN from .env.local; prints counts only. Run after
// SQL 60. An image already done is skipped, so it can run again.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { createClient } from "@supabase/supabase-js";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } });
const { ensureShowcaseRenditions } = await jiti.import("../lib/generation/small-renditions.ts");
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: prompts, error } = await db.from("prompts").select("showcase_images").is("deleted_at", null).limit(5000);
if (error) throw new Error(error.message);
const urls = [...new Set(prompts.flatMap((p) => (Array.isArray(p.showcase_images) ? p.showcase_images : [])).filter((u) => typeof u === "string"))];
if (!process.argv.includes("--apply")) {
  const rows = [];
  for (let i = 0; i < urls.length; i += 40) {
    const { data, error: readError } = await db.from("generated_images").select("storage_url, view_url, tiny_url").in("storage_url", urls.slice(i, i + 40));
    if (readError) throw new Error(`SQL 60 first? ${readError.message}`);
    rows.push(...data);
  }
  const need = rows.filter((r) => !r.view_url || !r.tiny_url).length;
  console.log(`${urls.length} example images, ${rows.length} rows, ${need} need renditions: ${need * 2} Blob puts (dry run; --apply writes)`);
} else {
  const made = await ensureShowcaseRenditions(db, urls, { deadline: Date.now() + 30 * 60_000 });
  console.log(`${urls.length} example images, ${made} got their renditions`);
}
