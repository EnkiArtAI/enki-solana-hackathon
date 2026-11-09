import {
  CREATOR_DEFAULTS, CREATOR_LIMITS, HUNT_PRICES, MODEL_USD_PER_POST_MAX, PLAY_MIN_POSTS,
  type CreatorConfig, type CreatorMedia, type CreatorRow, type HuntUsage, type PlayEstimate,
} from "@/lib/hunter/creator-types";
import type { HuntMode } from "@/lib/hunter/recipe";

/**
 * A creator's search, its limits and what a Play may cost (Kev, 2026-10-30: "creator reinpacken, such kriterien
 * einstellen, und go"). Pure and client-safe: the admin panel shows the query and the estimate with these, the server
 * saves and runs with the same ones. Prices: HUNT_PRICES (lib/hunter/creator-types.ts), from the code's own comments.
 */

/** X's limit for a recent-search query (docs.x.com search: 512 characters; the full archive takes more). */
export const QUERY_MAX = 512;

export const EMPTY_USAGE: HuntUsage = { posts: 0, replies: 0, users: 0, distills: 0, checks: 0, photos: 0, publishes: 0, videos: 0 };

const MEDIA: Record<CreatorMedia, string> = { images: " has:images", media: " has:media", any: "" };

/** What X is asked: `from:h (prompt OR prompts OR "free prompt") has:images -is:retweet -is:reply min_likes:n`. */
export function searchQuery(handle: string, c: Pick<CreatorConfig, "words" | "media" | "minLikes">): string {
  const words = c.words.map((w) => (/\s/.test(w) ? `"${w}"` : w));
  const group = words.length > 1 ? ` (${words.join(" OR ")})` : words.length ? ` ${words[0]}` : "";
  return `from:${handle}${group}${MEDIA[c.media]} -is:retweet -is:reply${c.minLikes > 0 ? ` min_likes:${c.minLikes}` : ""}`;
}

/** The fields that change what X returns: saving a change to one of them starts the creator's reading over. */
export const searchChanged = (a: CreatorConfig, b: CreatorConfig): boolean =>
  a.media !== b.media || a.minLikes !== b.minLikes || a.sinceDays !== b.sinceDays || a.words.join("\n") !== b.words.join("\n");

const int = (v: unknown, r: { min: number; max: number }): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= r.min && v <= r.max ? v : null;

/**
 * A creator's settings as the panel sent them, checked against SQL 56's limits; missing keys take CREATOR_DEFAULTS.
 * Words are lower case (X matches keywords in any case, and an upper-case OR or AND would be read as an operator) and
 * may not carry X's operator characters, so a word can never widen the search to another account.
 */
export function parseCreatorConfig(raw: unknown, catalogue: string[], handle = "x"): { ok: true; config: CreatorConfig } | { ok: false; error: string } {
  const r = { ...CREATOR_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) } as Record<string, unknown>;
  if (!Array.isArray(r.words) || !r.words.every((w) => typeof w === "string")) return { ok: false, error: "Search words must be a list of words." };
  const words = [...new Set((r.words as string[]).map((w) => w.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean))];
  if (words.length > CREATOR_LIMITS.words) return { ok: false, error: `At most ${CREATOR_LIMITS.words} search words.` };
  const bad = words.find((w) => w.length > CREATOR_LIMITS.wordChars || /["():]/.test(w) || /^-/.test(w));
  if (bad !== undefined) return { ok: false, error: `Not a search word: ${bad}` };
  if (r.media !== "images" && r.media !== "media" && r.media !== "any") return { ok: false, error: "Media must be images, media or any." };
  const minLikes = int(r.minLikes, CREATOR_LIMITS.minLikes);
  const sinceDays = int(r.sinceDays, CREATOR_LIMITS.sinceDays);
  const postsPerPlay = int(r.postsPerPlay, CREATOR_LIMITS.postsPerPlay);
  const dryAfter = int(r.dryAfter, CREATOR_LIMITS.dryAfter);
  const cap = r.spendCapUsd;
  const spendCapUsd = typeof cap === "number" && Number.isFinite(cap) && cap >= CREATOR_LIMITS.spendCapUsd.min && cap <= CREATOR_LIMITS.spendCapUsd.max
    ? Math.round(cap * 100) / 100 : null;
  if (minLikes === null || sinceDays === null || postsPerPlay === null || dryAfter === null || spendCapUsd === null) {
    return { ok: false, error: "A number is out of range." };
  }
  let preferredGenerator: string | null = null;
  if (r.preferredGenerator !== null && r.preferredGenerator !== undefined && r.preferredGenerator !== "") {
    const want = String(r.preferredGenerator).toLowerCase();
    preferredGenerator = catalogue.find((n) => n.toLowerCase() === want) ?? null;
    if (!preferredGenerator) return { ok: false, error: `Not an active generator: ${String(r.preferredGenerator)}` };
  }
  const config: CreatorConfig = { words, media: r.media, minLikes, sinceDays, preferredGenerator, postsPerPlay, spendCapUsd, dryAfter };
  if (searchQuery(handle, config).length > QUERY_MAX) return { ok: false, error: `The search is longer than X's ${QUERY_MAX} characters.` };
  return { ok: true, config };
}

/** Rounded to a hundredth of a cent, so sums of prices read as they add up. */
const usd = (n: number) => Math.round(n * 10_000) / 10_000;

/** What a round counted, in USD: X's reads and lookups, and every model call, at HUNT_PRICES. */
/** freeReads: read through FxTwitter, so the posts, replies and lookups cost nothing (Kev, 2026-10-31). */
export function spentOf(u: HuntUsage, freeReads = false): number {
  const p = HUNT_PRICES;
  const read = freeReads ? 0 : (u.posts + u.replies) * p.xPost + u.users * p.xUser;
  return usd(read + u.distills * p.distill
    + u.checks * (p.promptCheck + p.describe) + u.photos * p.imageCheck + u.publishes * p.promptCheck);
}

/** The most one post can cost: its read on X and all the model work it may cause. */
export const PER_POST_MAX_USD = HUNT_PRICES.xPost + MODEL_USD_PER_POST_MAX;

/**
 * What Play may cost at most, before it is pressed: postsPerPlay posts, or fewer when the spend cap leaves less room,
 * each at PER_POST_MAX_USD, plus the profile lookup while the creator has no profile yet. No picture is checked: Enki
 * shows none (review 2026-10-30, F4). Below PLAY_MIN_POSTS the Play would read nothing: a page leaves room for one
 * replies read (lib/hunter/creator-run). Recipe and manual modes through a free reader ask no model: $0, and only the posts
 * cap holds them, as in the Play (Kev, 2026-11-03: "ich möchte im manual form $0 haben").
 */
export function estimatePlay(
  c: Pick<CreatorRow, "config" | "profile" | "onEnki"> & { mode?: HuntMode; state: Pick<CreatorRow["state"], "spentUsd"> }, freeReads = false,
): PlayEstimate {
  if (freeReads && c.mode && c.mode !== "auto") {
    return { posts: c.config.postsPerPlay, xUsd: 0, modelUsd: 0, totalUsd: 0, spentUsd: c.state.spentUsd, capUsd: c.config.spendCapUsd, blocked: c.onEnki ? "on_enki" : null };
  }
  const fixedX = c.profile || freeReads ? 0 : HUNT_PRICES.xUser;
  const room = c.config.spendCapUsd - c.state.spentUsd - fixedX;
  const perPost = freeReads ? MODEL_USD_PER_POST_MAX : PER_POST_MAX_USD;
  const posts = Math.max(0, Math.min(c.config.postsPerPlay, Math.floor(room / perPost + 1e-9)));
  const xUsd = usd((freeReads ? 0 : posts * HUNT_PRICES.xPost) + fixedX);
  const modelUsd = usd(posts * MODEL_USD_PER_POST_MAX);
  return {
    posts, xUsd, modelUsd, totalUsd: usd(xUsd + modelUsd), spentUsd: c.state.spentUsd, capUsd: c.config.spendCapUsd,
    blocked: c.onEnki ? "on_enki" : posts < PLAY_MIN_POSTS ? "spend_cap" : null,
  };
}
