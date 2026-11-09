/**
 * How a creator's finds are cut (Kev, 2026-11-01: "kinda setting up the structure and then just cut everything around
 * the social-post behavior"), in hunter_accounts.mode and .recipe (SQL 59):
 * - auto: as before, the heuristics and the model cut and name it, the checks judge it;
 * - recipe: the admin's markers cut it, no model and no check;
 * - manual: the post's whole text and the author's replies, for the admin to cut by hand; no model and no check.
 * Client-safe: the admin page shows and checks the same values; the cut itself is lib/hunter/recipe-cut (server).
 */
export const HUNT_MODES = ["auto", "recipe", "manual"] as const;
export type HuntMode = (typeof HUNT_MODES)[number];

export interface Recipe {
  /** Where the prompt is: the post's own text, or the author's first reply holding the start marker. */
  from: "text" | "reply";
  /** The prompt starts on the line after the first line holding this text ("" = from the top); case is ignored. */
  after: string;
  /** The prompt ends before the first line after it holding this text ("" = to the end); case is ignored. */
  before: string;
  /** The title is this line of the post's text, counting non-empty lines from 1 (0 = none: the prompt's first words). */
  titleLine: number;
}

export const RECIPE_DEFAULT: Recipe = { from: "reply", after: "", before: "", titleLine: 0 };
export const MARKER_MAX = 80;
export const TITLE_LINE_MAX = 10;

export const huntModeOf = (v: unknown): HuntMode => (HUNT_MODES as readonly string[]).includes(v as string) ? (v as HuntMode) : "auto";

/** A recipe from what the page or the database holds; anything off its shape falls back to the default's value. */
export function parseRecipe(raw: unknown): Recipe {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const marker = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, MARKER_MAX) : "");
  const line = Number(r.titleLine);
  return {
    from: r.from === "text" ? "text" : "reply",
    after: marker(r.after),
    before: marker(r.before),
    titleLine: Number.isInteger(line) && line >= 0 && line <= TITLE_LINE_MAX ? line : 0,
  };
}
