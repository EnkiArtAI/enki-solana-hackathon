import type { Outcome } from "@/lib/hunter/run";
import type { HuntMode, Recipe } from "@/lib/hunter/recipe";

/**
 * The Creator Hunter's contract (Kev, 2026-10-30: "da will ich iwann einen creator reinpacken, such kriterien
 * einstellen, und go"; "ja go ... und ja 1 und 2"): the Prompt Hunter's list becomes a list of creators, each with
 * its own search, its own preferred generator ("der genutzt werden soll wenn nicht explizit etwas dazu drin steht"),
 * its own Play with a cost estimate first, its own caps and its own results. Every creator gets an Enki account
 * keyed by X's numeric user id, so the prompts are theirs ("account fürn creator angelegt werden, damit generierungen
 * auf seinen namen ihm später guthaben generieren können"); what their renders earn follows the X id to the author
 * vault, claimed by connecting that X account (lib/referral/shares.ts, docs/ESCROW-V2-SHARES.md).
 *
 * Types and constants only, no behaviour: app/admin/page.tsx imports this file, so it stays client-safe (the one
 * import is type-only). Columns: SQL 56 (migrations/2026-10-30-creator-hunter.sql).
 */

/** Where a post's prompt was found: the post's own text, an image's alt text, or the author's own reply. */
export type PromptFrom = "text" | "alt" | "reply";

/** How it was cut out: lib/editor/post-import's heuristics (a code block, a one-line label), an alt text taken whole, or the model. */
export type PromptHow = "block" | "label" | "alt" | "model" | "recipe" | "manual";

/** Where the offered generators came from: named in the post, the creator's preferred one, or every generator. */
export type GeneratorFrom = "post" | "preferred" | "all";

/** has:images, has:media (videos are then counted and skipped), or no media filter. */
export type CreatorMedia = "images" | "media" | "any";

/** A creator's settings (hunter_accounts' SQL 56 columns). */
export interface CreatorConfig {
  /** Searched in the post's text, any of them (X's tokenized keyword match); a phrase of several words is quoted. Empty = every post. */
  words: string[];
  media: CreatorMedia;
  /** Sent as X's min_likes: operator, so posts below it are neither returned nor billed. */
  minLikes: number;
  /** How far back the first look goes, in days; 0 = X's whole archive (asked from X_ARCHIVE_START: X's own default is the last 30 days). */
  sinceDays: number;
  /** A catalogue name (models.name, active image model): offered when a post names no generator; null = every generator. */
  preferredGenerator: string | null;
  /** Posts X may bill for one Play (search hits and the author's replies together). */
  postsPerPlay: number;
  /** All Plays of this creator together, estimated from counts (HUNT_PRICES); a Play stops before it would pass it. */
  spendCapUsd: number;
  /** Search hits in a row without a prompt after which the look back stops; 0 = never. */
  dryAfter: number;
}

export const CREATOR_DEFAULTS: CreatorConfig = {
  words: ["prompt", "prompts"],
  media: "images",
  minLikes: 0,
  sinceDays: 365,
  preferredGenerator: null,
  postsPerPlay: 100,
  spendCapUsd: 5,
  dryAfter: 30,
};

/** SQL 56's CHECKs, which the save validates first. */
export const CREATOR_LIMITS = {
  words: 10,
  wordChars: 40,
  minLikes: { min: 0, max: 1_000_000 },
  sinceDays: { min: 0, max: 7300 },
  /** A page and one replies read at least (PLAY_MIN_POSTS). */
  postsPerPlay: { min: 20, max: 1000 },
  spendCapUsd: { min: 0, max: 1000 },
  dryAfter: { min: 0, max: 1000 },
} as const;

/**
 * What one unit costs, in USD, from the code's own price comments (never measured):
 * - xPost, xUser: lib/hunter/x-api.ts:4 ("about $0.005 per post read, $0.01 per user lookup"); docs.x.com pricing
 *   says the same per resource, deduplicated within a UTC day.
 * - promptCheck: gpt-6-luna at $0.10 / $0.50 per million tokens (lib/moderation/prompt-check.ts:25), at most about
 *   950 tokens in (instruction, schema, a 2,000-character prompt) and 80 out (max_completion_tokens): $0.000135.
 * - describe: lib/referral/describe-prompt.ts:6, "about 0.03 cents".
 * - imageCheck: gpt-6-luna in high detail, lib/moderation/image-check.ts:125 ("$0.00016 an image"); its other judge,
 *   omni-moderation, is free (lib/moderation/tier2-openai.ts:12).
 * - distill: gpt-6-luna, at most about 3,250 tokens in (12,000 characters of sources) and 160 out: $0.000405.
 */
export const HUNT_PRICES = {
  xPost: 0.005,
  xUser: 0.01,
  promptCheck: 0.00014,
  describe: 0.0003,
  imageCheck: 0.00016,
  distill: 0.00041,
} as const;

/** The most model work one post can cause: a distill, the judge (prompt check, name, four pictures) and the publish's prompt check. */
export const MODEL_USD_PER_POST_MAX =
  HUNT_PRICES.distill + 2 * HUNT_PRICES.promptCheck + HUNT_PRICES.describe + 4 * HUNT_PRICES.imageCheck;

/** X's smallest search page: a Play with fewer posts left stops. */
export const SEARCH_MIN_PAGE = 10;

/** The author's replies read for a post whose prompt is "below" (lib/hunter/x-api replies: max_results). */
export const REPLIES_MAX = 10;

/**
 * The fewest posts a Play needs room for: a page, and one replies read, which every page leaves room for, so the post at
 * its top can always read its replies and every Play moves on (review 2026-10-30, F3).
 */
export const PLAY_MIN_POSTS = SEARCH_MIN_PAGE + REPLIES_MAX;

/** X's full archive starts here (docs.x.com): sent as start_time for sinceDays 0, as X's default is the last 30 days. */
export const X_ARCHIVE_START = "2006-03-21T00:00:00.000Z";

/** What a Play counted; its estimated cost is these times HUNT_PRICES. Stored in hunter_runs.usage (SQL 56). */
export interface HuntUsage {
  /** Search hits X returned (billed). */
  posts: number;
  /** The author's replies X returned for posts whose prompt is "below" (billed). */
  replies: number;
  /** User lookups (billed). */
  users: number;
  distills: number;
  /** Judged prompts: one prompt check and one description each. */
  checks: number;
  /** The posts' pictures judged. */
  photos: number;
  /** Prompts published (one more prompt check each, app/api/prompt/route.ts:591). */
  publishes: number;
  /** Videos seen and saved, not imported (video prompts wait, Kev's step 3). Costs nothing extra. */
  videos: number;
}

/** What the panel shows before Play is pressed. */
export interface PlayEstimate {
  /** Posts this Play may read: postsPerPlay, or fewer when the spend cap leaves less room. */
  posts: number;
  /** At most, on X: posts × xPost, plus a user lookup while the creator has no profile yet. */
  xUsd: number;
  /** At most, on the models: posts × MODEL_USD_PER_POST_MAX. */
  modelUsd: number;
  totalUsd: number;
  spentUsd: number;
  capUsd: number;
  /** Why Play cannot start: the cap leaves room for fewer than PLAY_MIN_POSTS posts, or the account is on Enki. */
  blocked: null | "spend_cap" | "on_enki";
}

/** Why a Play's round ended. "time" is the only one after which the panel presses again by itself. */
export type PlayStop = "done" | "time" | "posts_cap" | "spend_cap" | "dry" | "on_enki" | "error";

/**
 * What became of one post, recorded in hunter_posts.outcome: the legacy outcomes and the creator run's own. too_long:
 * the prompt's source was longer than the model reads (lib/hunter/distill SOURCE_MAX), so no end it names is trusted.
 * forwarded: the post only forwards one whose find is its author's; follow_failed: the way there could not be read.
 * retry: a "Start over" took its failure back: the next Play reads it as unread and writes its new outcome here.
 * rejected: an admin rejected the find it gave through a chain, so another post forwarding it does not bring it back.
 * leads_to:<handle>: the post forwards one that may hold a prompt, by someone not on the list, who only Kev adds. The handle
 * sits in the outcome: hunter_posts has no column for it, and outcome has no CHECK (live probe 2026-11-03).
 * video_only, no_media: the post is kept in hunter_parked, for the admin's tabs: a prompt always has media (Kev, 2026-11-03).
 * pictures_failed: its pictures could not be read just now, so it is kept there too, and "Start over" tries it again.
 */
export type CreatorOutcome = Outcome | "video_only" | "no_media" | "pictures_failed" | "reply_missing" | "distill_failed" | "too_long" | "forwarded" | "follow_failed" | "retry" | "rejected" | `leads_to:${string}`;
export const LEADS_TO = "leads_to:";

/** The table behind the Videos and No media tabs, for the sentence that says to run it. */
export const PARKED_SQL = "SQL 64 (sql-to-run/64-hunter-parked.sql)";
/** How a read or a write answers while that table is not there: Postgres, or PostgREST's schema cache. */
export const parkedMissing = (e: { code?: string } | null): boolean => e?.code === "42P01" || e?.code === "PGRST205";

export type ParkedKind = "video" | "no_media";
/** One saved post as the Videos and No media tabs read it (GET /api/admin?parked=). */
export interface ParkedRow {
  postId: string;
  handle: string;
  /** To the post on X, made from its id, never the stored address. */
  link: string;
  at: string;
  /** From the post's id: X's ids are snowflakes. */
  posted: string | null;
  text: string;
  replies: { id: string; text: string }[];
  /** poster: X's own host only. inReply: the video sits in the author's reply. */
  videos: { poster: string | null; duration: number | null; gif: boolean; inReply: boolean }[];
  why: string | null;
  /** Its find, when it has one: a post with both is in the queue and here. */
  find: "pending" | "published" | null;
}
export type ParkedPage = { ready: boolean; rows: ParkedRow[]; total: number };

/** A Play's skips and a post's outcome said in words where the outcome's own name says too little. */
export const CR_SKIPPED: Partial<Record<string, string>> = { too_long: "prompt too long to cut", already_in_enki: "already in Enki", follow_failed: "forward could not be followed", retry: "to be tried again", video_only: "video: saved in the Videos tab", no_media: "no picture or video: saved in the No media tab", pictures_failed: "pictures could not be read: Start over tries again" };
/** Where a post went that is neither a find nor a failure, for the admin who added its link. */
export const parkedSaid = (skipped: Record<string, number>): string | null =>
  skipped.video_only ? "It has a video and no picture: saved in the Videos tab." : skipped.no_media ? "It has no picture or video: saved in the No media tab."
    : skipped.pictures_failed ? "Its pictures could not be read just now: saved, and Start over tries it again." : null;
/** What the admin reads for an outcome; any other reads as its name. */
export const outcomeWords = (o: string) => (o.startsWith(LEADS_TO) ? `leads to @${o.slice(LEADS_TO.length)}, not on your list` : CR_SKIPPED[o] ?? o.replace(/_/g, " "));

/**
 * How a queued prompt was found, for the queue row: stored as `hunt` inside hunt_submissions.preview (jsonb) next to
 * lib/referral/judge-post's ImportShown, so no column is needed.
 */
export interface HuntFacts {
  from: PromptFrom;
  how: PromptHow;
  /** The author's reply the prompt came from, when from = "reply". */
  replyUrl: string | null;
  generatorFrom: GeneratorFrom;
  /** A generator the post names that the catalogue does not offer (e.g. "Midjourney"), as written; such a find is queued unless the post also names one of ours. */
  foreignGenerator: string | null;
  /** Videos on the post and in the author's replies: saved beside the find (hunter_parked), not imported. The name is what stored rows hold. */
  videosSkipped: number;
  creator: { handle: string; xUserId: string };
  /** The prompt's [variables] in Enki's form (lib/hunter/variables), saved with it at the publish. */
  variables?: HuntVariable[];
  /** How far it spread (lib/hunter/fx-api reachOf). */
  reach?: HuntReach;
  /** Why the creator's recipe, or manual mode's cut, did not cut it: the whole text is the prompt then, for the admin to cut (lib/hunter/recipe). */
  recipeMiss?: string;
  /** Manual mode's whole text where the cut took less, for the one click that takes it instead. In the row's preview only: the sealed one holds the prompt alone. */
  raw?: string;
  /** That text as the creator wrote it, where forming its variables changed it, for "Show full post text". */
  rawWords?: string;
}

/** A variable as a find carries it and app/api/prompt takes it (lib/editor/release SavedVariable's shape, kept here so
 *  no route reaches the editor's client modules). */
export interface HuntVariable {
  name: string; label: string; description: string; type: string; defaultValue: unknown; required: boolean; position: number;
}

/** A find's reach (Kev, 2026-10-31: "core likes, sum likes, sum retweets ... how contagious a tweet gets"). */
export interface HuntReach {
  core: { likes: number; reposts: number; quotes: number };
  chain: { posts: number; likes: number; reposts: number; quotes: number };
}

/** One Play as the panel lists it (hunter_runs with handle set). */
export interface CreatorRunRow {
  id: string;
  at: string;
  done: string | null;
  found: number;
  queued: number;
  published: number;
  skipped: Record<string, number>;
  usage: HuntUsage;
  estUsd: number;
  stopped: PlayStop | null;
  error: string | null;
}

/** One creator as GET /api/admin answers it in hunter.creators. */
export interface CreatorRow {
  /** Lower case, without the @ (hunter_accounts.handle). */
  handle: string;
  xUserId: string | null;
  /** The Enki account made for this author (users.imported_x_id), once the first Play looked the author up. No picture: Enki shows none. */
  profile: { userId: string; handle: string | null; name: string | null } | null;
  /** The Enki handle of the account this X account logs into (auth_identities): its posts are its own to publish, Play refuses. */
  onEnki: string | null;
  config: CreatorConfig;
  state: {
    newestId: string | null;
    oldestId: string | null;
    /** The look back is over: it reached sinceDays or X's end, or went dry (hunter_accounts.exhausted). */
    backDone: boolean;
    /** The look back stopped after dryAfter hits in a row without a prompt. */
    dry: boolean;
    /** A Play cut the read of new posts short: the next Play reads on below where it stopped (hunter_accounts.gap_low). */
    catchingUp: boolean;
    postsRead: number;
    found: number;
    spentUsd: number;
    error: string | null;
    lastRunAt: string | null;
    addedAt: string;
    /** A Play holds the creator (hunter_accounts.playing_since within the last five minutes). */
    playing: boolean;
  };
  /** The last ten Plays, newest first. */
  runs: CreatorRunRow[];
  /** Its finds waiting in Pending imports. */
  pending: number;
  /** How its finds are cut, and the recipe (SQL 59; "auto" before it runs). */
  mode: HuntMode;
  recipe: Recipe;
  /** Links added for it and waiting for "Play links" (hunter_posts, outcome 'waiting'). */
  links: number;
}

/** What one round of a Play answers (POST /api/admin, resource "hunter", action "play"). */
export interface CreatorRunSummary {
  /** The Play's hunter_runs row; the panel sends it back with the next round, so caps hold across rounds. */
  runId: string;
  found: number;
  queued: number;
  published: number;
  skipped: Record<string, number>;
  /** The whole Play so far, not only this round. */
  usage: HuntUsage;
  estUsd: number;
  /** The creator's spend after this round, all Plays together. */
  spentUsd: number;
  /** This round's model work on the creators its forwards lead to: on their spend, not this creator's. */
  followedUsd?: number;
  stopped: PlayStop;
  /** Press again: only after "time". */
  more: boolean;
  error?: string;
}
