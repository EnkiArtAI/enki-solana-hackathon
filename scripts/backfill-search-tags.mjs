// Recompute prompts.tags for every prompt with the publish rules of
// lib/search/tags.ts (Kev, 2026-10-07: tags are ours, automatic; 2026-10-31: a
// paid body yields what the piece is, subjects and formats, one tag per 30
// words), and the tags of the finds waiting in Pending imports.
//
//   node scripts/backfill-search-tags.mjs           dry run: prints title -> tags
//   node scripts/backfill-search-tags.mjs --apply   writes them
//
// Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the field encryption keys
// from .env.local. Prints titles and the computed tags only, never a body or a
// key. The body is decrypted in this process, matched, and dropped.
//
// A row changed since it was read is left alone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
// The "@/" alias of tsconfig, for lib modules that import through it (lib/referral/preview-token.ts).
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } });
const { decryptString } = await jiti.import("../lib/crypto.ts");
const { extractTags, storedTags } = await jiti.import("../lib/search/tags.ts");
const { isPublicText } = await jiti.import("../lib/prompt-visibility.ts");

const apply = process.argv.includes("--apply");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const get = async (path) => {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]}: ${res.status}`);
  return res.json();
};

const prompts = await get(
  "prompts?select=id,title,tags,updated_at,prompt_type,is_free_showcase,encrypted_content,encrypted_content_iv,encrypted_content_tag,encrypted_content_kid&order=created_at.asc",
);
const variables = await get("prompt_variables?select=prompt_id,name,label,default_value,options&deleted_at=is.null");

let changed = 0;
for (const p of prompts) {
  let body = "";
  if (p.encrypted_content) {
    try {
      body = decryptString({ encrypted: p.encrypted_content, iv: p.encrypted_content_iv, authTag: p.encrypted_content_tag, kid: p.encrypted_content_kid ?? undefined });
    } catch {
      // Still replace the creator's tags: title and variables are enough.
      console.warn(`${p.id}: body does not decrypt, tagging from title and variables only`);
    }
  }
  const variableText = variables
    .filter((v) => v.prompt_id === p.id)
    .flatMap((v) => [v.name, v.label, v.default_value, ...(Array.isArray(v.options) ? v.options : []).flatMap((o) => [o?.visibleName, o?.label, o?.promptValue])])
    .filter((s) => typeof s === "string")
    .join("\n");
  const tags = storedTags(extractTags(body, { body: true, paid: !isPublicText(p) }), extractTags(`${p.title ?? ""}\n${variableText}`));
  const old = p.tags ?? [];
  const same = JSON.stringify(tags) === JSON.stringify(old);
  console.log(`${same ? "=" : "~"} ${String(p.title ?? "").slice(0, 60)}: [${old.join(", ")}] -> [${tags.join(", ")}]`);
  if (same) continue;
  changed++;
  if (apply) {
    const res = await fetch(`${url}/rest/v1/prompts?id=eq.${p.id}&updated_at=eq.${encodeURIComponent(p.updated_at)}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ tags }),
    });
    if (!res.ok) throw new Error(`PATCH ${p.id}: ${res.status}`);
    if ((await res.json()).length === 0) console.warn(`${p.id}: changed since it was read, left alone`);
  }
}
console.log(`${prompts.length} prompts, ${changed} ${apply ? "updated" : "would change (dry run; --apply writes)"}`);

// The finds waiting in Pending imports get tags from their prompt and title. Their sealed tags are not read back: those
// hold the old matcher's false hits, with no telling them from the model's words. The sealed preview is sealed again with
// them and keeps its expiry: an expired find stays expired.
const { openPreview, sealPreview } = await jiti.import("../lib/referral/preview-token.ts");
const finds = await get("hunt_submissions?select=id,preview_token,preview&status=eq.pending&order=submitted_at.desc");
let retagged = 0;
for (const f of finds) {
  const sealed = openPreview(f.preview_token, 0);
  if (!sealed) { console.warn(`${f.id}: preview does not open, left alone`); continue; }
  const tags = storedTags(extractTags(sealed.prompt, { body: true }), extractTags(sealed.title));
  const same = JSON.stringify(tags) === JSON.stringify(sealed.tags);
  console.log(`${same ? "=" : "~"} find ${String(sealed.title).slice(0, 60)}: [${sealed.tags.join(", ")}] -> [${tags.join(", ")}]`);
  if (same) continue;
  retagged++;
  if (apply) {
    const res = await fetch(`${url}/rest/v1/hunt_submissions?id=eq.${f.id}&status=eq.pending`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ preview_token: sealPreview({ ...sealed, tags }), preview: { ...f.preview, tags }, suggested_tags: tags }),
    });
    if (!res.ok) throw new Error(`PATCH find ${f.id}: ${res.status}`);
  }
}
console.log(`${finds.length} finds waiting, ${retagged} ${apply ? "retagged" : "would change (dry run; --apply writes)"}`);
