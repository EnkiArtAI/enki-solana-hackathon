import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { putDurably } from "@/lib/generation/derivative-store";
import { makeSmallRenditions } from "@/lib/imageDerivatives";
import { inChunks } from "@/lib/in-chunks";

/**
 * The two small renditions of a prompt's example images (SQL 60; Kev, 2026-11-02: "stärkere kompression"): the image
 * view's stage and its tiles. Only for examples, at the release and by scripts/backfill-showcase-renditions.mjs, so a
 * render's own store is no slower. Never in the way: before SQL 60 the read fails and nothing is done, an image that
 * cannot be read or stored stays on its preview and thumb, and a next run picks it up.
 */
const URLS_PER_QUERY = 40;
const RELEASE_MS = 60_000;

type Row = { id: string; storage_url: string; preview_url: string | null; view_url: string | null; tiny_url: string | null };

/** How many images got their renditions. */
export async function ensureShowcaseRenditions(
  supabase: SupabaseClient, urls: string[], deps: { fetchFn?: typeof fetch; put?: typeof putDurably; deadline?: number } = {},
): Promise<number> {
  const { fetchFn = fetch, put = putDurably, deadline = Date.now() + RELEASE_MS } = deps;
  let rows: Row[];
  try {
    rows = await inChunks<Row>(
      [...new Set(urls.filter(Boolean))],
      async (chunk) => {
        const res = await supabase.from("generated_images").select("id, storage_url, preview_url, view_url, tiny_url").in("storage_url", chunk);
        if (res.error) throw new Error(res.error.message);
        return { data: res.data as Row[] };
      },
      URLS_PER_QUERY,
    );
  } catch (e) {
    console.warn("[small-renditions] not read (SQL 60?):", e instanceof Error ? e.message : e);
    return 0;
  }
  let made = 0;
  for (const row of rows) {
    if (row.view_url && row.tiny_url) continue;
    if (Date.now() > deadline) break;
    try {
      const res = await fetchFn(row.preview_url ?? row.storage_url);
      if (!res.ok) continue;
      const { view, tiny } = await makeSmallRenditions(Buffer.from(await res.arrayBuffer()));
      // The original's own name is not always a path (a store's fallback): a hash of it, the same on a next run.
      const base = `renditions/${createHash("sha256").update(row.storage_url).digest("hex").slice(0, 32)}`;
      const [viewUrl, tinyUrl] = await Promise.all([
        put(`${base}.view.webp`, view.buffer, "image/webp", deadline),
        put(`${base}.tiny.webp`, tiny.buffer, "image/webp", deadline),
      ]);
      if (!viewUrl || !tinyUrl) continue;
      const { error } = await supabase.from("generated_images").update({ view_url: viewUrl, tiny_url: tinyUrl }).eq("id", row.id);
      if (error) console.warn("[small-renditions] not saved:", error.message);
      else made += 1;
    } catch (e) {
      console.warn("[small-renditions] skipped an image:", e instanceof Error ? e.message : e);
    }
  }
  return made;
}
