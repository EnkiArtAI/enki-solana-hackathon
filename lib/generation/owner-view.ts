import { decryptString } from "@/lib/crypto";
import { isListed, isPublicText } from "@/lib/prompt-visibility";

/**
 * What the owner of a render gets to see about how it was made (Kev,
 * 2026-10-15: "the public available data that I used to generate this prompt
 * must be shown"). The text and values are encrypted at rest (record.ts
 * envelope); they are opened here, for the owner only, and a bought prompt's
 * text stays the creator's: the owner sees the values they filled in.
 */

export interface PromptRef {
  id: string;
  creator_id: string | null;
  is_listed: boolean | null;
  listing_status?: string | null;
  deleted_at?: string | null;
  prompt_type?: string | null;
  is_free_showcase?: boolean | null;
  price_usd_cents: number | null;
  title: string | null;
}

export type PromptKind = "own" | "market";

/**
 * Since when generations.rail is written by the route that made the render.
 * Older rows were labelled by the 2026-10-14 backfill, which took every row
 * without payment columns for "free", paid web renders before REC-1 included
 * (ENC review, 2026-10-17: 3 such rows live, all of someone else's prompt).
 */
export const RAIL_RECORDED_SINCE = Date.parse("2026-10-14T15:28:00Z");

/** The render ran on the free route, as recorded; a backfilled label counts as not free. */
export function renderedFree(g: Record<string, unknown> | undefined): boolean {
  return g?.rail === "free" && typeof g.created_at === "string" && Date.parse(g.created_at) >= RAIL_RECORDED_SINCE;
}

/** "own": the owner's private, unlisted prompt (Quick Create or the editor, back to Quick Create); "market": a listed
 * prompt, the owner's own included (it opens like from Home); null when the prompt is gone (Kev, 2026-10-15). */
export function promptKindOf(prompt: PromptRef | undefined, ownerId: string): PromptKind | null {
  if (!prompt) return null;
  return prompt.creator_id === ownerId && !prompt.is_listed ? "own" : "market";
}

type Envelope = Record<string, unknown>;

/** The plaintext of one envelope (`${prefix}_ct/_iv/_tag/_kid`), or null when absent or unreadable. */
export function openEnvelope(row: Envelope, prefix: string): string | null {
  const ct = row[`${prefix}_ct`], iv = row[`${prefix}_iv`], tag = row[`${prefix}_tag`], kid = row[`${prefix}_kid`];
  if (typeof ct !== "string" || typeof iv !== "string" || typeof tag !== "string" || !ct) return null;
  try {
    return decryptString({ encrypted: ct, iv, authTag: tag, kid: typeof kid === "string" ? kid : undefined });
  } catch {
    return null;
  }
}

/** The values as name → text; anything else recorded becomes its JSON. */
export function valuesOf(json: string | null): Record<string, string> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export interface OwnerView {
  prompt_kind: PromptKind | null;
  prompt_title: string | null;
  prompt_text: string | null;
  variable_values: Record<string, string> | null;
}

/**
 * The view for one render. A visitor sees the kind, and the title of a listed
 * prompt whose creator is still visible (an unlisted draft's title can be its
 * own words). The owner sees the values they filled in, and the text when it
 * is theirs to read: a render made without a prompt (their own words), their
 * own prompt, or someone else's prompt that was free when the render was made
 * (the free route refuses a paid one) and still is (isPublicText). Anything
 * else, a row that cannot be read included, keeps its text closed, whatever
 * its price or its type today (ENC review, Kev 2026-10-17).
 */
export function ownerView(i: {
  viewerId: string | null;
  ownerId: string;
  /** The render named a prompt (generated_images.prompt_id); its row may still be missing. */
  hadPrompt: boolean;
  /** The render ran on the free route (generations.rail), which only takes a prompt whose text is public. */
  freeRail: boolean;
  /** The prompt's creator is banned or deleted (hiddenOwners): a visitor sees nothing of the prompt. */
  creatorHidden?: boolean;
  prompt: PromptRef | undefined;
  text: string | null;
  values: Record<string, string> | null;
}): OwnerView {
  const kind = promptKindOf(i.prompt, i.ownerId);
  const title = i.prompt?.title ?? null;
  if (i.viewerId !== i.ownerId) {
    const listed = !!i.prompt && isListed(i.prompt) && !i.creatorHidden;
    return { prompt_kind: kind, prompt_title: listed ? title : null, prompt_text: null, variable_values: null };
  }
  const readable = !i.hadPrompt || (!!i.prompt && (i.prompt.creator_id === i.ownerId || (i.freeRail && isPublicText(i.prompt))));
  return { prompt_kind: kind, prompt_title: title, prompt_text: readable ? i.text : null, variable_values: i.values };
}
