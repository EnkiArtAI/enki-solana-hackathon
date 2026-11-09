import type { SupabaseClient } from "@supabase/supabase-js";
import { hiddenOwners } from "@/lib/hidden-owners";
import { isListed } from "@/lib/prompt-visibility";

/**
 * One generated image as a share page and its card show it (SHR, Kev's go
 * 2026-10-17): only an image its owner made public, never an upload, never
 * 18+, never deleted, never from a banned or deleted account. The prompt is
 * named only when it is listed and its creator not hidden: a draft's title
 * can be the first words of a prompt nobody else should read. Nothing of a
 * prompt's text is ever selected. Anything else, a failed lookup included,
 * is null: one answer, so nobody can probe whether an image exists.
 */
export interface PublicImage {
  id: string;
  /** The original (PNG or JPEG), what the card draws. */
  url: string;
  /** The WebP preview the page shows, else the original. */
  shown: string;
  width: number | null;
  height: number | null;
  owner: string | null;
  prompt: { id: string; title: string } | null;
}

/** An image's size scaled to fit a box, aspect kept; unknown dimensions: the box's height, square. */
export function fitInto(width: number | null, height: number | null, maxW: number, maxH: number): { w: number; h: number } {
  if (!width || !height || width <= 0 || height <= 0) return { w: maxH, h: maxH };
  const scale = Math.min(maxW / width, maxH / height);
  return { w: Math.round(width * scale), h: Math.round(height * scale) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const httpUrl = (u: unknown): u is string => typeof u === "string" && /^https:\/\//.test(u);

export async function publicImage(supabase: SupabaseClient, id: string): Promise<PublicImage | null> {
  if (!UUID.test(id)) return null;
  try {
    const { data: img } = await supabase
      .from("generated_images")
      .select("id, user_id, storage_url, preview_url, width, height, prompt_id")
      .eq("id", id)
      .eq("visibility", "public")
      .eq("is_uploaded", false)
      .eq("is_adult", false)
      .is("deleted_at", null)
      .maybeSingle();
    if (!img || !httpUrl(img.storage_url)) return null;
    const owner = String(img.user_id ?? "");
    const hidden = await hiddenOwners(supabase, [owner]);
    if (!hidden || hidden.has(owner)) return null;

    const [{ data: user }, { data: p }] = await Promise.all([
      supabase.from("users").select("handle").eq("id", owner).maybeSingle(),
      img.prompt_id
        ? supabase.from("prompts").select("id, title, is_listed, listing_status, deleted_at, creator_id, is_adult").eq("id", img.prompt_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    let prompt: PublicImage["prompt"] = null;
    if (p && p.title && p.is_adult !== true && isListed(p)) {
      const creatorHidden = await hiddenOwners(supabase, [String(p.creator_id ?? "")]);
      if (creatorHidden && !creatorHidden.has(String(p.creator_id))) prompt = { id: String(p.id), title: String(p.title) };
    }
    return {
      id: String(img.id),
      url: img.storage_url,
      shown: httpUrl(img.preview_url) ? img.preview_url : img.storage_url,
      width: typeof img.width === "number" ? img.width : null,
      height: typeof img.height === "number" ? img.height : null,
      owner: typeof user?.handle === "string" ? user.handle : null,
      prompt,
    };
  } catch {
    return null;
  }
}
