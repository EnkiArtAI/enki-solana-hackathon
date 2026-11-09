/**
 * The WebP renditions behind a prompt's showcase images.
 *
 * A release keeps the ORIGINAL's URL in prompts.showcase_images (the render
 * the creator starred: PNG or JPEG, 2 to 9 MB). Its preview and thumb (WebP,
 * ~220 KB and ~25 KB) live on the generated_images row that stored them,
 * under names of their own (derivative-store), so neither URL can be derived
 * from the other: they are looked up here, by the original's URL, a page at
 * a time. Measured 2026-10-16: the home feed's six cards weighed 16.3 MB of
 * originals; their thumbs weigh 150 KB.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { inChunks } from "@/lib/in-chunks";

/** view and tiny: an example image's stage and tile in the image view (SQL 60; lib/generation/small-renditions), once made. */
export type Renditions = { preview: string | null; thumb: string | null; view?: string; tiny?: string };
export type ShowcaseImage = { url: string } & Renditions;

/** URLs are long: forty per query keeps the request well inside what the gateway takes (in-chunks.ts). */
const URLS_PER_QUERY = 40;

/** The renditions of every original the store knows; one it does not know is simply absent. */
export async function renditionsByUrl(supabase: SupabaseClient, urls: string[]): Promise<Map<string, Renditions>> {
  const found = new Map<string, Renditions>();
  const wanted = urls.filter((u) => typeof u === "string" && u.length > 0);
  try {
    type Row = { storage_url: string; preview_url: string | null; thumbnail_url: string | null; view_url?: string | null; tiny_url?: string | null };
    const read = (columns: string) => inChunks<Row>(
      wanted,
      // An answer with an error throws: inChunks alone reads it as no rows, which would cost every page its renditions.
      async (chunk) => {
        const res = await supabase.from("generated_images").select(columns).in("storage_url", chunk);
        if (res.error) throw new Error(res.error.message);
        return { data: res.data as unknown as Row[] };
      },
      URLS_PER_QUERY,
    );
    // Before SQL 60 the small renditions' columns are not there: the page keeps its preview and thumb.
    const rows = await read("storage_url, preview_url, thumbnail_url, view_url, tiny_url").catch(() => read("storage_url, preview_url, thumbnail_url"));
    for (const r of rows) {
      found.set(r.storage_url, { preview: r.preview_url ?? null, thumb: r.thumbnail_url ?? null, ...(r.view_url ? { view: r.view_url } : {}), ...(r.tiny_url ? { tiny: r.tiny_url } : {}) });
    }
  } catch (e) {
    // A page without renditions still shows: the originals, as before.
    console.warn("[renditions] lookup failed:", e instanceof Error ? e.message : e);
  }
  return found;
}

/** Each image with its renditions; one the store does not know keeps its original alone. */
export function withRenditions(images: { url: string }[], found: Map<string, Renditions>): ShowcaseImage[] {
  return images.map(({ url }) => {
    const r = found.get(url);
    return { url, preview: r?.preview ?? null, thumb: r?.thumb ?? null, ...(r?.view ? { view: r.view } : {}), ...(r?.tiny ? { tiny: r.tiny } : {}) };
  });
}
