import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { after } from "next/server";
import { screenFirst } from "@/lib/moderation";
import { checkPrompt, NOT_CHECKED } from "@/lib/moderation/prompt-check";
import { recordWarning, warningMessage } from "@/lib/moderation/warnings";
import { checkImageBytes, heldBack } from "@/lib/moderation/image-check-bytes";
import { recordImageCase } from "@/lib/moderation/image-case";
import { casedImages, imageCleared } from "@/lib/moderation/image-clearance";
import type { ImportPlan } from "@/lib/editor/post-import";
import { describePrompt, fallbackDescription, generatorOnly } from "@/lib/referral/describe-prompt";
import { extractTags, storedTags } from "@/lib/search/tags";
import { downloadPhoto, sha256, USER_AGENT } from "@/lib/referral/post-photos";
import { PREVIEW_TTL_MS, type ImportPreview } from "@/lib/referral/preview-token";

/**
 * A referred post, judged as a release is judged and named by the model:
 * what "Refer a prompt" shows before the check mark, and what the Prompt
 * Hunter puts into the queue. The text is checked first (refused for good,
 * or not now), then every picture on its bytes (one that cannot be read is
 * left out), then the name, the shelf and the tags. 18+ is the checks' call
 * alone (Kev, 2026-10-14).
 */
// The preview route's answers live here: a route file may export nothing but its handlers (Next's route typing).
export const ALREADY = "This post was already referred.";
export const NOT_X = "Only a post on X can be imported here; other links go to the moderators.";
export const PHOTOS_REFUSED = "One of the post's images can't be used on Enki.";
export const PHOTOS_UNCHECKED = "The post's images could not be checked right now. Try again in a minute.";
export const PROMPT_UNCHECKED = "The prompt could not be checked right now. Try again in a minute.";

/** Our reads of X say who they are, as FxTwitter asks. */
export const asEnki: typeof fetch = (input, init) =>
  fetch(input, { ...init, headers: { "User-Agent": USER_AGENT, ...((init?.headers as Record<string, string> | undefined) ?? {}) } });

/** What a dialog or a queue row shows of a judged post. */
export interface ImportShown {
  prompt: string;
  title: string;
  category: string;
  tags: string[];
  adult: boolean;
  generators: string[];
  photos: string[];
  source: { url: string; handle: string };
}

export type Judged =
  | { ok: true; preview: ImportPreview; shown: ImportShown }
  | { ok: false; status: 422 | 503; error: string };

export async function judgeImport(
  supabase: SupabaseClient,
  p: {
    plan: ImportPlan; link: { url: string; normalized: string }; userId: string; request: NextRequest; surface?: string; fetchFn?: typeof fetch;
    /** The post's own text, for the name (the Prompt Hunter: describePrompt names it in two to four words by it). */
    post?: string;
    /** The account a refusal's case is about, with no sanction (the Prompt Hunter: the imported creator's). */
    account?: string;
  },
): Promise<Judged> {
  const { plan } = p;
  const surface = p.surface ?? "referral-import";
  const fetchFn = p.fetchFn ?? asEnki;

  const inputs = { content: plan.prompt };
  const check = screenFirst(inputs) ? NOT_CHECKED : await checkPrompt(inputs, { hidden: false, signal: p.request.signal });
  if (check.verdict === "minor_sexual" || check.verdict === "explicit_sexual") {
    const outcome = await recordWarning(supabase, {
      surface, request: p.request, account: p.account, category: check.verdict, confidence: check.confidence,
      text: JSON.stringify({ source: plan.source.url }), withheld: plan.prompt,
    });
    return { ok: false, status: 422, error: warningMessage(check.verdict, outcome, "save") };
  }
  if (check.verdict !== "clear") return { ok: false, status: 503, error: PROMPT_UNCHECKED };

  const photos: ImportPreview["photos"] = [];
  let photosAdult = false;
  for (const photo of plan.photos) {
    const got = await downloadPhoto(photo.url, fetchFn);
    if (!got) continue;
    let seen = await checkImageBytes(got.buf, { signal: p.request.signal });
    if (seen.verdict === "child_safety") {
      // The hunter's import alone, not "Refer a prompt": exactly these bytes, which the moderation owner looked at and cleared.
      if (surface === "prompt-hunter" && seen.otherwise && (await imageCleared(supabase, sha256(got.buf)))) seen = seen.otherwise;
      else after(recordImageCase(supabase, { surface, request: p.request, account: p.account, bytes: got.buf, scores: seen.scores, about: `A picture of the post ${plan.source.url} being referred.` }));
    }
    if (heldBack(seen)) {
      return seen.verdict === "unavailable" ? { ok: false, status: 503, error: PHOTOS_UNCHECKED } : { ok: false, status: 422, error: PHOTOS_REFUSED };
    }
    if (seen.verdict === "adult") photosAdult = true;
    photos.push({ url: photo.url, sha256: sha256(got.buf) });
  }

  const said = (await describePrompt(plan.prompt, undefined, p.post)) ?? fallbackDescription(plan.prompt);
  const preview: ImportPreview = {
    v: 1,
    userId: p.userId,
    exp: Date.now() + PREVIEW_TTL_MS,
    source: { url: p.link.url, normalized: p.link.normalized, handle: plan.source.handle, authorId: plan.source.authorId },
    prompt: plan.prompt,
    generators: plan.generators,
    photos,
    title: said.title,
    category: said.category,
    // The tags the publish will store (a find is published free): what its prompt and the model's words say the piece is
    // and looks like, and its title's words (Kev, 2026-10-31: a logo prompt tagged "latex, vinyl"), so Pending imports
    // shows and edits those.
    tags: storedTags(extractTags(plan.prompt, { body: true }), extractTags(said.tags.join("\n"), { body: true }), extractTags(said.title)),
    // 18+ is the checks' call alone (text and pictures), as at a release; the model that names the prompt has no say (Kev, 2026-10-14).
    adult: check.adult === true || photosAdult,
  };
  return { ok: true, preview, shown: shownOf(preview) };
}

/**
 * A find the admin cuts and judges alone (Kev, 2026-11-01: recipe and manual modes, "ohne sicherheitsprüfungen, da ich
 * die ja ohnehin schon manuell mache und entscheide was rein soll"): its pictures fetched for their hashes, never judged,
 * and no model: the title given or the prompt's first words, the shelf "More", the vocabulary's tags; 18+ is the admin's
 * tick in Pending imports. No judge is asked, but bytes a child-safety image case already holds stay out, unless the
 * moderation owner cleared them: a mode an admin can switch is no way round the owner's look (lib/moderation/image-clearance).
 */
export async function plainImport(supabase: SupabaseClient, p: {
  plan: ImportPlan; link: { url: string; normalized: string }; userId: string; title?: string; fetchFn?: typeof fetch;
}): Promise<Judged> {
  const { plan } = p;
  const fetchFn = p.fetchFn ?? asEnki;
  const photos: ImportPreview["photos"] = [];
  for (const photo of plan.photos) {
    const got = await downloadPhoto(photo.url, fetchFn);
    if (got) photos.push({ url: photo.url, sha256: sha256(got.buf) });
  }
  const cased = await casedImages(supabase, photos.map((photo) => photo.sha256));
  if (!cased) return { ok: false, status: 503, error: PHOTOS_UNCHECKED };
  if (cased.held.length) return { ok: false, status: 422, error: PHOTOS_REFUSED };
  const said = fallbackDescription(plan.prompt);
  // A recipe's title line that names only a generator ("Gpt image 2") gives way to the prompt's first words.
  const title = p.title?.trim() && !generatorOnly(p.title) ? p.title.trim() : said.title;
  const preview: ImportPreview = {
    v: 1,
    userId: p.userId,
    exp: Date.now() + PREVIEW_TTL_MS,
    source: { url: p.link.url, normalized: p.link.normalized, handle: plan.source.handle, authorId: plan.source.authorId },
    prompt: plan.prompt,
    generators: plan.generators,
    photos,
    title,
    category: said.category,
    tags: storedTags(extractTags(plan.prompt, { body: true }), extractTags(title)),
    adult: false,
  };
  return { ok: true, preview, shown: shownOf(preview) };
}

/** The part of a preview a dialog or a queue row shows. */
export function shownOf(preview: ImportPreview): ImportShown {
  return {
    prompt: preview.prompt, title: preview.title, category: preview.category, tags: preview.tags, adult: preview.adult,
    generators: preview.generators, photos: preview.photos.map((x) => x.url), source: { url: preview.source.url, handle: preview.source.handle },
  };
}
