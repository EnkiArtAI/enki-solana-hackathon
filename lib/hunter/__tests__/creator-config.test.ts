import { describe, it, expect } from "vitest";
import { CREATOR_DEFAULTS, HUNT_PRICES, MODEL_USD_PER_POST_MAX, type CreatorConfig } from "@/lib/hunter/creator-types";
import { EMPTY_USAGE, PER_POST_MAX_USD, QUERY_MAX, estimatePlay, parseCreatorConfig, searchChanged, searchQuery, spentOf } from "../creator-config";

/**
 * A creator's search, limits and Play estimate (Kev, 2026-10-30: "such kriterien einstellen, und go"; X bills per
 * post returned, so only the hits cost). Prices from the code's own comments (HUNT_PRICES), never measured.
 */
const CATALOGUE = ["Flux (free)", "Nano Banana Pro", "GPT-Image-2"];
const cfg = (over: Partial<CreatorConfig> = {}): CreatorConfig => ({ ...CREATOR_DEFAULTS, ...over });

describe("searchQuery", () => {
  it("asks X for the creator's posts with any of the words, the media filter, no reposts, no replies, and the likes floor", () => {
    expect(searchQuery("hexmethod", cfg({ words: ["prompt", "prompts", "free prompt"], minLikes: 20 })))
      .toBe('from:hexmethod (prompt OR prompts OR "free prompt") has:images -is:retweet -is:reply min_likes:20');
    expect(searchQuery("hex", cfg({ words: ["prompt"], media: "media" }))).toBe("from:hex prompt has:media -is:retweet -is:reply");
    expect(searchQuery("hex", cfg({ words: [], media: "any" }))).toBe("from:hex -is:retweet -is:reply");
  });
});

describe("parseCreatorConfig", () => {
  it("fills the defaults, lower-cases and de-duplicates the words, and takes the preferred generator by its catalogue name", () => {
    expect(parseCreatorConfig({}, CATALOGUE)).toEqual({ ok: true, config: CREATOR_DEFAULTS });
    const got = parseCreatorConfig({ words: [" Free  Prompt ", "PROMPT", "prompt", ""], preferredGenerator: "nano banana pro", spendCapUsd: 2.345 }, CATALOGUE);
    expect(got).toEqual({ ok: true, config: { ...CREATOR_DEFAULTS, words: ["free prompt", "prompt"], preferredGenerator: "Nano Banana Pro", spendCapUsd: 2.35 } });
    expect(parseCreatorConfig({ preferredGenerator: "" }, CATALOGUE)).toMatchObject({ ok: true, config: { preferredGenerator: null } });
  });

  it("refuses what would widen the search or break SQL 56's limits", () => {
    const bad = (raw: unknown) => parseCreatorConfig(raw, CATALOGUE).ok;
    expect(bad({ words: "prompt" })).toBe(false);
    expect(bad({ words: ["from:elonmusk"] })).toBe(false);
    expect(bad({ words: ['a" OR "b'] })).toBe(false);
    expect(bad({ words: ["(x"] })).toBe(false);
    expect(bad({ words: ["-prompt"] })).toBe(false);
    expect(bad({ words: ["x".repeat(41)] })).toBe(false);
    expect(bad({ words: ["x".repeat(40)] })).toBe(true);
    expect(bad({ words: Array.from({ length: 11 }, (_, i) => `w${i}`) })).toBe(false);
    expect(bad({ words: Array.from({ length: 10 }, (_, i) => `w${i}`) })).toBe(true);
    expect(bad({ media: "videos" })).toBe(false);
    for (const [k, lo, hi] of [["minLikes", 0, 1_000_000], ["sinceDays", 0, 7300], ["postsPerPlay", 20, 1000], ["dryAfter", 0, 1000], ["spendCapUsd", 0, 1000]] as const) {
      expect(bad({ [k]: lo })).toBe(true);
      expect(bad({ [k]: hi })).toBe(true);
      expect(bad({ [k]: lo - 1 })).toBe(false);
      expect(bad({ [k]: hi + 1 })).toBe(false);
      expect(bad({ [k]: "5" })).toBe(false);
    }
    expect(bad({ postsPerPlay: 10.5 })).toBe(false);
    expect(parseCreatorConfig({ preferredGenerator: "Midjourney" }, CATALOGUE)).toEqual({ ok: false, error: "Not an active generator: Midjourney" });
    // X's recent search takes 512 characters.
    const long = Array.from({ length: 10 }, (_, i) => `${"w".repeat(19)} ${"v".repeat(19)}${i}`);
    expect(searchQuery("hexmethod", cfg({ words: long, minLikes: 1_000_000 })).length).toBeGreaterThan(QUERY_MAX);
    expect(parseCreatorConfig({ words: long, minLikes: 1_000_000 }, CATALOGUE, "hexmethod")).toEqual({ ok: false, error: `The search is longer than X's ${QUERY_MAX} characters.` });
    expect(parseCreatorConfig({ words: long, minLikes: 0 }, CATALOGUE, "hexmethod").ok).toBe(true);
  });

  it("says when a change starts the reading over: the words, media, likes or how far back, not the generator or the caps", () => {
    const a = cfg();
    expect(searchChanged(a, cfg({ preferredGenerator: "GPT-Image-2", postsPerPlay: 500, spendCapUsd: 9, dryAfter: 3 }))).toBe(false);
    expect(searchChanged(a, cfg({ words: ["prompt"] }))).toBe(true);
    expect(searchChanged(a, cfg({ media: "any" }))).toBe(true);
    expect(searchChanged(a, cfg({ minLikes: 1 }))).toBe(true);
    expect(searchChanged(a, cfg({ sinceDays: 30 }))).toBe(true);
  });
});

describe("the cost of a Play", () => {
  it("prices a post at its read on X and all the model work it may cause", () => {
    expect(MODEL_USD_PER_POST_MAX).toBeCloseTo(0.00163, 10);
    expect(PER_POST_MAX_USD).toBeCloseTo(0.00663, 10);
    expect(spentOf(EMPTY_USAGE)).toBe(0);
    const p = HUNT_PRICES;
    for (const [k, unit] of [["posts", p.xPost], ["replies", p.xPost], ["users", p.xUser], ["distills", p.distill], ["checks", p.promptCheck + p.describe], ["photos", p.imageCheck], ["publishes", p.promptCheck]] as const) {
      expect(spentOf({ ...EMPTY_USAGE, [k]: 100 })).toBeCloseTo(100 * unit, 6);
    }
    expect(spentOf({ ...EMPTY_USAGE, videos: 100 })).toBe(0);
  });

  it("estimates a new creator's first Play: 100 posts and the lookup, $0.673 at most; no picture is checked (Enki shows none)", () => {
    const row = { config: cfg(), profile: null, onEnki: null, state: { spentUsd: 0 } };
    expect(estimatePlay(row)).toEqual({ posts: 100, xUsd: 0.51, modelUsd: 0.163, totalUsd: 0.673, spentUsd: 0, capUsd: 5, blocked: null });
    const known = { ...row, profile: { userId: "u", handle: "hex", name: null } };
    expect(estimatePlay(known)).toMatchObject({ posts: 100, xUsd: 0.5, modelUsd: 0.163, totalUsd: 0.663 });
  });

  it("bills only the model work when the Play reads through FxTwitter, free (Kev, 2026-10-31)", () => {
    expect(spentOf({ ...EMPTY_USAGE, posts: 100, replies: 5, users: 1 }, true)).toBe(0);
    expect(spentOf({ ...EMPTY_USAGE, posts: 100, checks: 2 }, true)).toBe(Math.round(2 * (HUNT_PRICES.promptCheck + HUNT_PRICES.describe) * 10_000) / 10_000);
    const row = { config: cfg(), profile: null, onEnki: null, state: { spentUsd: 0 } };
    expect(estimatePlay(row, true)).toEqual({ posts: 100, xUsd: 0, modelUsd: 0.163, totalUsd: 0.163, spentUsd: 0, capUsd: 5, blocked: null });
    // A $1 cap with $0.95 spent leaves room for 30 posts of model work, where paid reads left 7.
    const tight = { config: cfg({ spendCapUsd: 1 }), profile: { userId: "u", handle: null, name: null }, onEnki: null, state: { spentUsd: 0.95 } };
    expect(estimatePlay(tight, true)).toMatchObject({ posts: 30, blocked: null });
    expect(estimatePlay(tight)).toMatchObject({ posts: 7, blocked: "spend_cap" });
  });

  // Kev, 2026-11-03: "ich möchte im manual form $0 haben".
  it("asks nothing of a recipe or manual Play through a free reader: $0, the posts cap alone, whatever is spent; on Enki still blocks", () => {
    const row = (mode: "auto" | "recipe" | "manual", onEnki: string | null = null) => ({ mode, config: cfg({ spendCapUsd: 1 }), profile: null, onEnki, state: { spentUsd: 1.5 } });
    for (const mode of ["recipe", "manual"] as const) {
      expect(estimatePlay(row(mode), true)).toEqual({ posts: 100, xUsd: 0, modelUsd: 0, totalUsd: 0, spentUsd: 1.5, capUsd: 1, blocked: null });
      expect(estimatePlay(row(mode, "realhex"), true)).toMatchObject({ blocked: "on_enki" });
      // X's paid reader still bills its reads.
      expect(estimatePlay(row(mode))).toMatchObject({ posts: 0, blocked: "spend_cap" });
    }
    expect(estimatePlay(row("auto"), true)).toMatchObject({ posts: 0, blocked: "spend_cap" });
  });

  it("reads fewer posts when the cap leaves less room, and blocks below a page and one replies read, or when the account is on Enki", () => {
    const row = (spentUsd: number, onEnki: string | null = null) => ({ config: cfg({ spendCapUsd: 1 }), profile: { userId: "u", handle: null, name: null }, onEnki, state: { spentUsd } });
    expect(estimatePlay(row(0.8))).toMatchObject({ posts: 30, blocked: null });
    // Room for 15 posts: a page leaves room for one replies read (creator-run), so no page fits.
    expect(estimatePlay(row(0.9))).toMatchObject({ posts: 15, blocked: "spend_cap" });
    expect(estimatePlay(row(0.86))).toMatchObject({ posts: 21, blocked: null });
    expect(estimatePlay(row(0.94))).toMatchObject({ posts: 9, blocked: "spend_cap" });
    expect(estimatePlay(row(1.5))).toMatchObject({ posts: 0, xUsd: 0, blocked: "spend_cap" });
    expect(estimatePlay(row(0, "realhex"))).toMatchObject({ posts: 100, blocked: "on_enki" });
  });
});
