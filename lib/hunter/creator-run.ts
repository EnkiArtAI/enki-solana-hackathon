import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { importSaid, type ImportPlan } from "@/lib/editor/post-import";
import { asEnki, judgeImport, plainImport, type Judged } from "@/lib/referral/judge-post";
import { huntModeOf, parseRecipe } from "@/lib/hunter/recipe";
import { cutByRecipe, manualCut, rawText, type RecipeCut } from "@/lib/hunter/recipe-cut";
import { importVariables } from "@/lib/hunter/variables";
import { sealPreview } from "@/lib/referral/preview-token";
import { publishImported, type PublishInput, type PublishResult } from "@/lib/hunter/publish";
import { QUEUE_TTL_MS, TIME_CAP_MS, asNobody, imageGenerators, promptHash } from "@/lib/hunter/run";
import { snowflakeAt, snowflakeDate, type XPost, type XSearchApi, type XSearchPage, type XUser } from "@/lib/hunter/x-api";
import { authorReplies, followChain, forwardTo, fxApi, onePostApi, ownWords, reachOf } from "@/lib/hunter/fx-api";
import { distillPrompt, locatePrompt, resolveGenerators, type Distilled, type Located, type Sources } from "@/lib/hunter/distill";
import { ensureCreatorProfile, onEnki, xAvatar, type CreatorProfile } from "@/lib/hunter/creator-profile";
import { EMPTY_USAGE, PER_POST_MAX_USD, searchQuery, spentOf } from "@/lib/hunter/creator-config";
import { ACCOUNT_COLUMNS, HANDLE_RE, LOCK_MS, RETRY, configOf, normalizeXHandle, usageOf, type CreatorAccount } from "@/lib/hunter/creators";
import {
  HUNT_PRICES, LEADS_TO, MODEL_USD_PER_POST_MAX, PARKED_SQL, PLAY_MIN_POSTS, REPLIES_MAX, SEARCH_MIN_PAGE, X_ARCHIVE_START, parkedMissing,
  type CreatorOutcome, type CreatorRunSummary, type HuntFacts, type HuntUsage, type PlayStop, type PromptFrom, type PromptHow, type HuntReach } from "@/lib/hunter/creator-types";

/**
 * One round of a creator's Play (Kev, 2026-10-30: "einen creator reinpacken, such kriterien einstellen, und go"; "ja
 * go ... und ja 1 und 2"). X's search for the creator's matching posts (billed per post returned: only the hits),
 * first what is new since the last Play, then ever further back until `sinceDays` or X's end; each post's prompt found
 * in its text, an alt text or the author's own reply, cut as written (lib/hunter/distill), judged as a referral is,
 * queued or published under the creator's own Enki account (lib/hunter/creator-profile), on the generator the post
 * names, else the creator's preferred one ("der genutzt werden soll wenn nicht explizit etwas dazu drin steht").
 * Within the Play's posts cap and the creator's spend cap, both estimated from counts (HUNT_PRICES); a round ends
 * after TIME_CAP_MS and the panel presses again. Videos are saved, not imported, until video prompts exist (Kev's step 3).
 */

export interface CreatorDeps {
  x: XSearchApi;
  /** text: the post's own words, which the find is named by (judgeImport's post). */
  judge: (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, text: string) => Promise<Judged>;
  /** Recipe and manual modes' find: no check, no model, only a look at the cases its pictures have (lib/referral/judge-post plainImport). */
  plain: (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => Promise<Judged>;
  distill: (sources: Sources) => Promise<Distilled>;
  publish: (input: PublishInput) => Promise<PublishResult>;
  /** The active image generators' catalogue names. */
  catalogue: () => Promise<string[]>;
  profile: (x: XUser) => Promise<CreatorProfile>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** One post by its link instead of the search (lib/hunter/manual-link): always queued, no cursor moves. */
  only?: XPost;
  /** The reach of that post's chain (lib/hunter/manual-link); a Play's own post counts alone. */
  reach?: HuntReach;
  /** The author's reply that link named, where the prompt sits: read first, the author's other replies after it. */
  comment?: XPost | null;
  /** How a post that only forwards another is followed to it: free through FxTwitter, whichever reader lists the creator. Without it every post is read as its own. */
  fxFetch?: typeof fetch;
  /** A forward's core played for a Play in recipe or manual mode: no model, whatever its creator's mode (Kev, 2026-11-03: "ich möchte im manual form $0 haben"). A recipe of its own still cuts it: that asks none. */
  plainOnly?: boolean;
}

export function defaultCreatorDeps(supabase: SupabaseClient, request: NextRequest): CreatorDeps {
  // The creator's posts are judged as nobody's request: never under the admin who pressed Play (lib/hunter/run asNobody).
  const nobody = asNobody(request);
  return {
    // Read through FxTwitter, free (Kev, 2026-10-31: "ja play gratis über fxtwitter"); X's own API (xApi) bills and needs credits.
    x: fxApi(),
    judge: (plan, link, userId, text) => judgeImport(supabase, { plan, link, userId, post: text, account: userId, request: nobody, surface: "prompt-hunter" }),
    plain: (plan, link, userId, title) => plainImport(supabase, { plan, link, userId, title }),
    distill: (sources) => distillPrompt(sources),
    publish: (input) => publishImported(supabase, input),
    catalogue: () => imageGenerators(supabase),
    profile: (x) => ensureCreatorProfile(supabase, x, (u) => xAvatar(u, asEnki)),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    fxFetch: asEnki,
  };
}

/** What became of one post. */
type Taken = { outcome: CreatorOutcome; submissionId?: string };

export type PlayResult =
  | { status: 200; summary: CreatorRunSummary }
  | { status: 404 | 409 | 500 | 503; error: string; summary?: CreatorRunSummary }
  | { status: 400; error: string };

/**
 * Whether a played link leaves the line (review 2026-11-01): read and taken or passed, or refused for good (not a post,
 * gone, someone else's reply, already in Enki, its author on Enki). A Play that stopped before it (a cap), a held
 * creator ("already playing"), a failed save or FxTwitter down keep it waiting for the next "Play links".
 */
export function linkSettled(r: PlayResult): boolean {
  if (r.status === 200) return r.summary.queued + r.summary.published + Object.values(r.summary.skipped).reduce((n, k) => n + k, 0) > 0;
  return r.status === 400 || r.status === 404 || (r.status === 409 && !r.error.endsWith("is already playing."));
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The recent endpoint reaches 7 days back; a gap older than this goes to the full archive. */
export const RECENT_DAYS = 6;
/** The full archive answers one request a second (docs.x.com rate limits). */
export const ARCHIVE_GAP_MS = 1100;
/**
 * A round renews its hold this often, before a post at the latest: a post takes at most about 164 s (every call's
 * timeout: the replies, the distill, the prompt check, four pictures' download and check, the description), so the
 * hold never runs out mid-round (LOCK_MS). Following a forward renews it again before the core is played.
 */
export const KEEP_MS = 60_000;
/** Hits in a row without a prompt; a find or a duplicate resets the streak. */
const DRY: string[] = ["no_prompt", "reply_missing", "distill_failed"];
/** Neither a prompt nor its absence: the streak stands. A link waiting in line is not read yet. */
const NEUTRAL: string[] = ["reply", "video_only", "no_media", "pictures_failed", "too_long", "waiting", "follow_failed"];
const neutral = (outcome: string) => NEUTRAL.includes(outcome) || outcome.startsWith(LEADS_TO);
const NO_MEDIA = "no picture or video on the post or in the author's replies";
/** A forward's core that stands for a find, an admin's rejected one too: the post is settled by it. Any other core gave none, and the post is read as its own, whoever wrote the core. */
const CORE_FOUND: string[] = ["queued", "published", "publish_failed", "duplicate", "waiting", "rejected"];
/** No prompt of its own in its words, its alt texts or the author's replies: only such a post may forward. */
const promptless = (at: Located) => at.kind === "none" || (at.kind === "unsure" && !at.reply && !at.sources.alt_1);
/** A find's pictures: the post's; none there, those of the reply its prompt came from, else of the author's first reply that has any. */
const picturesOf = (post: XPost, reply: XPost | null, replies: XPost[]) =>
  (post.photos.length ? post : reply?.photos.length ? reply : replies.find((r) => r.photos.length))?.photos ?? [];

/** What a row held and what a new read saw, each once by its key, the new read's copy kept. */
function union<T>(had: unknown, read: T[], key: (x: T) => unknown): T[] {
  return [...new Map([...(Array.isArray(had) ? (had as T[]) : []), ...read].map((x) => [key(x), x] as const)).values()];
}

const newer = (a: string | null, b: string) => (a === null || BigInt(b) > BigInt(a) ? b : a);
const older = (a: string | null, b: string) => (a === null || BigInt(b) < BigInt(a) ? b : a);
const plus = (a: HuntUsage, b: HuntUsage): HuntUsage =>
  Object.fromEntries(Object.keys(EMPTY_USAGE).map((k) => [k, a[k as keyof HuntUsage] + b[k as keyof HuntUsage]])) as unknown as HuntUsage;

export async function playCreator(supabase: SupabaseClient, rawHandle: unknown, runIdIn: unknown, deps: CreatorDeps): Promise<PlayResult> {
  const handle = normalizeXHandle(rawHandle);
  if (!HANDLE_RE.test(handle)) return { status: 400, error: `Not an X handle: ${handle || "(empty)"}` };
  const { data: cfg, error: cfgError } = await supabase.from("hunter_config").select("mode").eq("id", 1).maybeSingle();
  if (cfgError || !cfg) return { status: 500, error: "The hunter is not configured (migrations/2026-10-14-prompt-hunter.sql)." };
  const { data: row, error: rowError } = await supabase.from("hunter_accounts").select(ACCOUNT_COLUMNS).eq("handle", handle).maybeSingle();
  if (rowError) return { status: 500, error: "The creator hunter needs SQL 56 (sql-to-run/56-creator-hunter.sql)." };
  if (!row) return { status: 404, error: `@${handle} is not on the list.` };
  const acc = row as unknown as CreatorAccount;
  const config = configOf(acc);
  // How its finds are cut. A read that failed is no "auto": a manual creator's whole round would ask the model.
  const { data: how, error: howError } = await supabase.from("hunter_accounts").select("mode, recipe").eq("handle", handle).maybeSingle();
  if (howError) return { status: 500, error: `The mode of @${handle} could not be read: nothing was played. Press Play again.` };
  const own = huntModeOf(how?.mode);
  const mode = deps.plainOnly && own === "auto" ? "manual" : own;
  const recipe = parseRecipe(how?.recipe);
  const started = deps.now();
  const iso = (ms: number) => new Date(ms).toISOString();

  // Two tabs never bill the same reads twice: the round holds the creator, a crashed round's hold runs out.
  let hold = iso(started);
  const { data: held, error: lockError } = await supabase.from("hunter_accounts").update({ playing_since: hold })
    .eq("handle", handle).or(`playing_since.is.null,playing_since.lt.${iso(started - LOCK_MS)}`).select("handle");
  if (lockError) return { status: 500, error: `Could not start @${handle}: ${lockError.message}` };
  if (!held?.length) return { status: 409, error: `@${handle} is already playing.` };
  let heldAt = started;
  const LOST = `@${handle} was taken over by another Play: this round stopped and saved nothing more.`;
  /**
   * The hold renewed, with `cols` written beside it, while this round still has it. A round that outlives LOCK_MS keeps
   * its creator, and one whose hold another Play took over writes nothing more over that Play's cursors and spend
   * (review 2026-10-30, F10: the hold was written once, and the last round to finish erased the other's spend).
   */
  const keep = async (cols: Record<string, unknown> = {}): Promise<void> => {
    const at = deps.now();
    const { data, error } = await supabase.from("hunter_accounts").update({ ...cols, playing_since: iso(at) })
      .eq("handle", handle).eq("playing_since", hold).select("handle");
    if (error) { console.error("[creator-run] the creator's row was not updated:", error.message); return; }
    if (!data?.length) throw new Error(LOST);
    hold = iso(at);
    heldAt = at;
  };

  const s = { ...acc };
  const round: HuntUsage = { ...EMPTY_USAGE };
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const counts = { found: 0, queued: 0, published: 0 };
  let followedUsd = 0;
  /** The creator's spend with this round's counts. */
  // Reads through FxTwitter cost nothing (deps.x.free): the spend, the room and the cap count the model work alone.
  const free = deps.x.free === true;
  // Recipe and manual modes through a free reader spend nothing: only the posts cap holds them (review 2026-11-01).
  const costless = free && mode !== "auto";
  const perPost = free ? MODEL_USD_PER_POST_MAX : PER_POST_MAX_USD;
  const spentNow = () => Math.round((Number(acc.spent_usd) + spentOf(round, free)) * 10_000) / 10_000;
  // Set inside the round (a closure), so declared wide: TypeScript does not see those assignments.
  let stopped = "done" as PlayStop;
  let failure = null as string | null;
  let status = 200 as 200 | 404 | 409 | 500 | 503;
  let run = null as { id: string; usage: HuntUsage; found: number; queued: number; published: number; posts_read: number; skipped: Record<string, number> } | null;

  /** The round itself; an early return leaves `stopped`, `status` and `failure` as it set them. */
  const go = async (): Promise<void> => {
    // The Play's row: the panel hands it back with every next round, so the posts cap holds across rounds.
    if (typeof runIdIn === "string" && /^[0-9a-f-]{36}$/i.test(runIdIn)) {
      const { data } = await supabase.from("hunter_runs").select("id, usage, found, queued, published, posts_read, skipped")
        .eq("id", runIdIn).eq("handle", handle).is("finished_at", null).maybeSingle();
      if (data) run = { id: String(data.id), usage: usageOf(data.usage).usage, found: data.found ?? 0, queued: data.queued ?? 0, published: data.published ?? 0, posts_read: data.posts_read ?? 0, skipped: (data.skipped as Record<string, number>) ?? {} };
    }
    if (!run) {
      const { data, error } = await supabase.from("hunter_runs").insert({ handle }).select("id").single();
      if (error || !data) throw error ?? new Error("the Play was not recorded");
      run = { id: String(data.id), usage: { ...EMPTY_USAGE }, found: 0, queued: 0, published: 0, posts_read: 0, skipped: {} };
    }
    const play = run.usage;
    const thisRun = run;
    /**
     * What X billed, written as soon as it is billed: a round the platform ends mid-post (the route's maxDuration)
     * still counts its reads against the spend cap and the Play's posts. Cursors move only with hunter_posts.
     */
    const checkpoint = async () => {
      const usage = plus(play, round);
      const [, b] = await Promise.all([
        keep({ spent_usd: spentNow(), posts_read: s.posts_read }),
        supabase.from("hunter_runs").update({ usage, est_usd: spentOf(usage, free), posts_read: thisRun.posts_read + round.posts }).eq("id", thisRun.id),
      ]);
      if (b.error) console.error("[creator-run] the round's reads were not saved yet:", b.error.message);
    };
    const spentBefore = Number(acc.spent_usd);
    // The posts of the page in hand still to be taken: their model work is held back from the room, so the cap is never passed.
    let pending = 0;
    const room = () => config.spendCapUsd - spentBefore - spentOf(round, free) - followedUsd - pending * MODEL_USD_PER_POST_MAX;
    /**
     * The next page's size, or why there is none: the Play's posts cap, or the creator's spend cap. A page leaves room
     * for one replies read (`reserve`), so the post at its top can always read its replies and every Play moves on by a
     * post at least: a page that used the whole budget stopped before a "prompt below" post at its top, Play after Play
     * (review 2026-10-30, F3). The replies read asks with no reserve: it needs REPLIES_MAX, which is X's smallest page.
     */
    const nextPage = (reserve = REPLIES_MAX): number | PlayStop => {
      const posts = config.postsPerPlay - (play.posts + play.replies + round.posts + round.replies) - reserve;
      if (posts < SEARCH_MIN_PAGE) return "posts_cap";
      if (costless) return Math.min(100, posts);
      const affordable = Math.floor(room() / perPost + 1e-9) - reserve;
      if (affordable < SEARCH_MIN_PAGE) return "spend_cap";
      return Math.min(100, posts, affordable);
    };
    const outOfTime = () => deps.now() - started > TIME_CAP_MS;
    let lastArchive = -Infinity;
    const pace = async (archive: boolean) => {
      if (!archive) return;
      const wait = lastArchive + ARCHIVE_GAP_MS - deps.now();
      if (wait > 0) await deps.sleep(wait);
      lastArchive = deps.now();
    };
    const archiveFor = (id: string) => started - (snowflakeDate(id)?.getTime() ?? 0) > RECENT_DAYS * DAY_MS;

    // Who the author is: X's id (one lookup: free through FxTwitter, $0.01 on X's API) and their Enki account, made once.
    let profile: CreatorProfile | null = null;
    if (s.x_user_id) {
      const { data: p, error } = await supabase.from("users").select("id, handle").eq("imported_x_id", s.x_user_id).maybeSingle();
      if (error) throw error;
      if (p) profile = { userId: String(p.id), handle: (p.handle as string | null) ?? null };
    }
    const first = nextPage();
    if (typeof first === "string") { stopped = first; return; }
    // A new creator's lookup comes before any post (estimatePlay's fixed cost): room for it, a page and one replies read.
    if (!costless && !profile && room() - (free ? 0 : HUNT_PRICES.xUser) < PLAY_MIN_POSTS * perPost) { stopped = "spend_cap"; return; }
    let xUser: XUser | null = null;
    if (!s.x_user_id || !profile) {
      round.users += 1;
      xUser = await deps.x.user(handle);
      if (!xUser) { failure = "No such account on X"; stopped = "error"; status = 404; return; }
      s.x_user_id = xUser.id;
    }
    // An X account that logs in to Enki publishes its own posts.
    const holder = await onEnki(supabase, s.x_user_id!);
    if (holder) {
      failure = `@${handle} is on Enki as @${holder}: their posts are theirs to publish.`;
      stopped = "on_enki"; status = 409;
      return;
    }
    profile ??= await deps.profile(xUser!);
    const me = profile;
    const author = { id: s.x_user_id!, handle, name: xUser?.name ?? "" };
    /**
     * The creator is the X id, the search asks by handle (from:), and a handle can change hands: a post X says another
     * account wrote ends the round before anything of it is filed under this creator, or paid to their author share.
     */
    const mine = (posts: XPost[]): XPost[] => {
      const other = posts.find((p) => p.author.id !== author.id);
      if (other) throw new Error(`@${handle} is another X account now (${other.author.id}, not ${author.id}): nothing of it was taken. Look up the creator's new handle on X.`);
      return posts;
    };
    // A link's post too: nothing of it is filed under the account this handle was.
    if (deps.only) mine([deps.only]);
    const query = searchQuery(handle, config);
    const search = async (opts: Parameters<XSearchApi["search"]>[2]): Promise<XSearchPage> => {
      await pace(opts.archive);
      const page = await deps.x.search(query, author, opts);
      round.posts += page.posts.length;
      s.posts_read += page.posts.length;
      await checkpoint();
      mine(page.posts);
      return page;
    };
    let names: string[] | null = null;
    /**
     * The model could not be asked (a distill or the judge's check unavailable): the round stops before the post, which
     * is neither recorded nor passed, so the next Play reads it again. Recorded as "unchecked", it was passed for good,
     * and an outage spent a whole Play's reads on nothing (review 2026-10-30, F5).
     */
    const down = (): { stop: PlayStop } => {
      failure = "The model could not be asked: nothing was skipped. Press Play again in a minute.";
      status = 503;
      return { stop: "error" };
    };

    /** The author's replies through the reader, counted as soon as they are billed, or why the round stops before the post. */
    const repliesOf = async (post: XPost): Promise<XPost[] | { stop: PlayStop }> => {
      if (free) {
        // A free read stops nothing: a page in hand is read to its end, or one that filled the cap stopped before its first
        // post, Play after Play (F3 again, FxTwitter ignoring the size asked). Only what this post's model work may cost does.
        if (!costless && room() + pending * MODEL_USD_PER_POST_MAX + 1e-9 < MODEL_USD_PER_POST_MAX) return { stop: "spend_cap" };
      } else {
        const size = nextPage(0);
        if (typeof size === "string") return { stop: size };
      }
      const archive = archiveFor(post.id);
      await pace(archive);
      const replies = await deps.x.replies(post, author, archive);
      // Not "no replies": a reply's video or prompt would go unseen and the post be marked read, as `down` says of the model.
      if (!replies) {
        failure = `The author's replies under a post of @${handle} could not be read: nothing was skipped. Press Play again in a minute.`;
        status = 503;
        return { stop: "error" };
      }
      round.replies += replies.length;
      await checkpoint();
      return mine(replies);
    };

    /**
     * A post kept in hunter_parked (SQL 64) for what comes after it (Kev, 2026-11-03: "nicht verwerfen, we will implement
     * them, save them"), before it is marked read: its link, words, the author's replies, and each video and picture by
     * every address the reader gives. Addresses only: the files are the video import's to fetch, and a post deleted before
     * that can take its video with it. A post read again keeps what an earlier read saved, whatever this read saw (a reply
     * link read alone, a reply deleted since): a video stays, and a video post stays one. What it is saved as; or the round
     * stops before the post, which the next Play reads again (as `down`, F5).
     */
    const park = async (kind: "video" | "no_media", post: XPost, replies: XPost[], why: string, reach?: HuntReach): Promise<{ stop: PlayStop } | "video" | "no_media"> => {
      const { data: had, error: readError } = await supabase.from("hunter_parked").select("kind, why, replies, videos, photos").eq("post_id", post.id).maybeSingle();
      const held = had?.kind === "video" && kind === "no_media";
      const { error } = readError ? { error: readError } : await supabase.from("hunter_parked").upsert({
        post_id: post.id, kind: held ? "video" : kind, handle, author_id: author.id, url: post.url, post_text: post.text,
        replies: union(had?.replies, replies.map((r) => ({ id: r.id, url: r.url, text: r.text })), (r) => r.id),
        videos: union<Record<string, unknown>>(had?.videos, [...(post.videoData ?? []), ...replies.flatMap((r) => (r.videoData ?? []).map((v) => ({ ...v, reply_id: r.id })))], (v) => v.id ?? v.url),
        photos: union(had?.photos, [post, ...replies].flatMap((p) => p.photos.map((x) => x.url)), (u) => u),
        reach: reach ?? reachOf([post]), why: held ? had.why : why, read_at: iso(deps.now()),
      }, { onConflict: "post_id" });
      if (!error) return held ? "video" : kind;
      failure = parkedMissing(error)
        ? `A post of @${handle} could not be saved: its table needs ${PARKED_SQL}. Nothing was skipped: run it, then press Play again.`
        : `A post of @${handle} could not be saved (${error.message}): nothing was skipped. Press Play again.`;
      status = 500;
      return { stop: "error" };
    };
    /** A prompt always has media (Kev, 2026-11-03: "ein prompt ohne media soll separat geloggt sein in nem reiter"): no find, and kept for his look. */
    const noMedia = async (post: XPost, replies: XPost[], why: string, reach?: HuntReach): Promise<Taken | { stop: PlayStop }> => {
      const saved = await park("no_media", post, replies, why, reach);
      return typeof saved === "string" ? { outcome: saved === "video" ? "video_only" : "no_media" } : saved;
    };

    /**
     * A find into the queue under the creator's account. Pictures that all failed to download leave a find with none,
     * from either judge (lib/referral/judge-post): no find for now. It is saved, a post with a video staying one (park), and
     * its mark is one "Start over" takes back: a host's bad minute is no verdict on the post. A save that failed stops the round
     * before the post, which the next Play reads again (as `down`, F5).
     */
    const file = async (post: XPost, replies: XPost[], normalized: string, judged: Extract<Judged, { ok: true }>, hunt: HuntFacts, hash: string): Promise<{ token: string; submissionId: string } | Taken | { stop: PlayStop }> => {
      if (!judged.preview.photos.length) {
        const saved = await park("no_media", post, replies, "its pictures could not be read", hunt.reach);
        return typeof saved === "string" ? { outcome: "pictures_failed" } : saved;
      }
      const token = sealPreview({ ...judged.preview, exp: deps.now() + QUEUE_TTL_MS });
      const { data: sub, error: insertError } = await supabase.from("hunt_submissions").insert({
        hunter_user_id: me.userId, source_url: post.url, normalized_source_url: normalized, source_platform: "x",
        // The author by X id: the author vault's seed and the claim's key (docs/ESCROW-V2-SHARES.md).
        source_author_id: author.id, source_author_handle: handle,
        suggested_title: judged.preview.title, suggested_tags: judged.preview.tags, status: "pending",
        preview_token: token, preview: { ...judged.shown, hunt }, prompt_hash: hash,
      }).select("id").single();
      if (insertError || !sub) {
        failure = `A find of @${handle} could not be saved (${insertError?.message ?? "no row came back"}): nothing was skipped. Press Play again.`;
        status = 500;
        return { stop: "error" };
      }
      return { token, submissionId: String(sub.id) };
    };

    /** What hunter_posts held for this round's pages, and a forward's core taken in this round: a later page row is not taken twice. */
    const taken = new Map<string, string>();
    /** A post a link or a forward reached through its author's comment: that comment first, then the reader's answer. */
    const given = new Map<string, XPost>(deps.only && deps.comment ? [[deps.only.id, deps.comment]] : []);

    /**
     * A post that only forwards another, followed as an added link is (lib/hunter/manual-link): the core's author owns the
     * find, on the creator list and on that creator's spend cap, always queued, with the chain's reach; the core in Enki
     * already, or any post of the chain, is not taken again. The reads are free, under any reader. A chain or a core that
     * could not be read leaves the post marked follow_failed, for "Start over", and the round reads on; a core its creator's
     * Play could not finish (the model down, a failed save) stops the round before the post, as `down` does. null: read the post
     * as its own, as it is not a forward, its core gave no find, or what it leads to is deleted or private. Someone not on
     * the list is never listed and never given an account (Kev, 2026-11-03: "warum sollte ein fremder in der liste landen,
     * wenn ich die doch alle prüfe"), and no model is asked of them: a post of theirs that may hold a prompt marks this post
     * leads_to:<handle>, for the log, neutral and taken back by "Start over", which plays it once Kev has listed them; one
     * that cannot (a reply, a video, no words) reads the post as its own. A Play in recipe or manual mode plays the core with
     * no model (plainOnly). What an auto Play's core costs in model work stays on the core's creator, and counts here too
     * (followedUsd), against this creator's cap for the round.
     */
    const forward = async (post: XPost): Promise<Taken | { stop: PlayStop } | null> => {
      const fetchFn = deps.fxFetch;
      if (!fetchFn || deps.only || !forwardTo(post)) return null;
      const failed: Taken = { outcome: "follow_failed" };
      const chain = await followChain(post.id, fetchFn);
      if (!chain || chain.broken) return failed;
      if (chain.gone) return null;
      const { core, hops, reply = null } = chain;
      if (core.id === post.id) return null;
      const [inEnki, read] = await Promise.all([
        supabase.from("hunt_submissions").select("id").in("normalized_source_url", hops.map((h) => `x.com/status/${h.id}`)).limit(1),
        supabase.from("hunter_posts").select("outcome").eq("post_id", core.id).maybeSingle(),
      ]);
      if (inEnki.error || read.error) return failed;
      if (inEnki.data?.length) return { outcome: "forwarded" };
      if (read.data && read.data.outcome !== RETRY) return CORE_FOUND.includes(String(read.data.outcome)) ? { outcome: "forwarded" } : null;
      if (outOfTime()) return { stop: "time" };
      if (deps.now() - heldAt >= KEEP_MS) await keep();
      const reach = reachOf(hops);
      // The creator's own earlier post: this round holds its creator, so it is taken here, one model call for the post as ever.
      if (core.author.id === author.id) {
        if (reply) given.set(core.id, reply);
        const got = await take(core, reach);
        if ("stop" in got) return got;
        taken.set(core.id, got.outcome);
        const { error } = await supabase.from("hunter_posts").upsert(
          { post_id: core.id, handle, author_id: author.id, likes: core.likes, outcome: got.outcome, submission_id: got.submissionId ?? null, read_at: new Date().toISOString() },
          { onConflict: "post_id" },
        );
        if (error) throw error;
        return CORE_FOUND.includes(got.outcome) ? got : null;
      }
      const coreHandle = normalizeXHandle(core.author.handle);
      if (!core.author.id || !HANDLE_RE.test(coreHandle)) return failed;
      // The creator is the X id: one who renamed is on the list still, under the handle it knows.
      const [sameId, sameHandle] = await Promise.all([
        supabase.from("hunter_accounts").select("handle").eq("x_user_id", core.author.id).limit(1),
        supabase.from("hunter_accounts").select("x_user_id").eq("handle", coreHandle).maybeSingle(),
      ]);
      if (sameId.error || sameHandle.error) return failed;
      const listed: string | null = sameId.data?.[0]?.handle ?? (sameHandle.data ? coreHandle : null);
      // The handle is another X account now: nothing goes to the old one, which the list and its Enki account still name.
      if (!sameId.data?.length && sameHandle.data?.x_user_id && sameHandle.data.x_user_id !== core.author.id) return failed;
      if (!listed) {
        if (core.replyingTo || (core.videos && !core.photos.length)) return null;
        let at = locatePrompt(core, null, true);
        if (at.kind === "reply") at = locatePrompt(core, reply ? [reply] : (await authorReplies(core, fetchFn)) ?? [], true);
        // "Prompt in the comments" with no comment to be seen may still hold one, whether the read failed or found none.
        return at.kind === "none" && at.outcome === "no_prompt" ? null : { outcome: `${LEADS_TO}${coreHandle}` };
      }
      if (!costless && spentBefore + spentOf(round, free) + followedUsd >= config.spendCapUsd) return { stop: "spend_cap" };
      const played = await playCreator(supabase, listed, undefined, { ...deps, only: core, reach, x: onePostApi(core, fetchFn), comment: reply, plainOnly: mode !== "auto" });
      if ("summary" in played && played.summary) followedUsd += played.summary.estUsd;
      if (played.status === 503 || played.status === 500) {
        failure = played.error;
        status = played.status;
        return { stop: "error" };
      }
      if (played.status === 200 && (played.summary.found > 0 || played.summary.skipped.duplicate)) return { outcome: "forwarded" };
      return linkSettled(played) ? null : failed;
    };

    /**
     * Recipe and manual modes (Kev, 2026-11-01): the author's replies read, the prompt cut by the creator's recipe or by
     * manual mode's cut (whole where either missed, with why), no model and no check; always queued for a look.
     */
    const takePlain = async (post: XPost, replies: XPost[], videos: number, normalized: string, reach?: HuntReach): Promise<Taken | { stop: PlayStop }> => {
      // The reply a link named holds the prompt if the recipe finds it there; else any of them.
      const named = given.get(post.id);
      const inNamed = mode === "recipe" && named ? cutByRecipe(post, [named], recipe) : null;
      const cut = mode !== "recipe" ? null : inNamed?.ok ? inNamed : cutByRecipe(post, replies, recipe);
      // Words that could be a prompt stay the creator's here, for the person who looks: no model tells them from a forward's.
      if (!reach && !cut?.ok && !ownWords(post) && promptless(locatePrompt(post, replies, true))) {
        const onward = await forward(post);
        if (onward) return onward;
      }
      if (!picturesOf(post, null, replies).length) {
        const at = cut?.ok ? null : locatePrompt(post, replies, true);
        return at?.kind === "none" ? { outcome: at.outcome } : noMedia(post, replies, NO_MEDIA, reach);
      }
      let chosen = cut ?? manualCut(post, replies, named);
      const formed = (c: RecipeCut) => importVariables(c.ok ? c.prompt : rawText(post, replies));
      let vars = formed(chosen);
      const written = rawText(post, replies);
      const wholeVars = importVariables(written);
      const whole = wholeVars.prompt;
      const hashedBefore = async (prompt: string) => {
        const { data: dup, error: dupError } = await supabase.from("hunt_submissions").select("id").eq("prompt_hash", promptHash(prompt)).limit(1);
        if (dupError) throw dupError;
        return !!dup?.length;
      };
      if (await hashedBefore(vars.prompt)) {
        // A reply's cut alone proves no duplicate: the same promotion can sit under every post, and each real prompt would die
        // here without a row to look at. The post's own words decide; with none, the whole text, and a person looks.
        if (cut) return { outcome: "duplicate" };
        chosen = manualCut(post, []);
        vars = formed(chosen);
        if (await hashedBefore(vars.prompt)) return { outcome: "duplicate" };
      }
      const hash = promptHash(vars.prompt);
      names ??= await deps.catalogue();
      const reply = chosen.ok ? chosen.reply : null;
      const gen = resolveGenerators({
        texts: [post.text, ...post.photos.map((p) => p.alt ?? ""), ...replies.map((r) => r.text)], prompt: vars.prompt, modelGenerator: "", preferred: config.preferredGenerator, catalogue: names,
      });
      const photos = picturesOf(post, reply, replies);
      const plan: ImportPlan = {
        prompt: vars.prompt, generators: gen.generators, photos, source: { url: post.url, handle, authorId: author.id },
        said: importSaid({ handle, photos: photos.length, generators: gen.generators }),
      };
      const judged = await deps.plain(plan, { url: post.url, normalized }, me.userId, chosen.ok ? chosen.title : "");
      if (!judged.ok) return judged.status === 503 ? down() : { outcome: "refused" };
      // A value defined outside the cut stays its slot's, for the cut and for the whole text taken instead (slotVariables reads only a prompt's own slots).
      const valued = new Map(wholeVars.variables.map((v) => [v.name, v]));
      const hunt: HuntFacts = {
        from: chosen.ok ? chosen.from : "text", how: cut?.ok ? "recipe" : "manual", replyUrl: reply?.url ?? null, generatorFrom: gen.from, foreignGenerator: gen.foreign,
        videosSkipped: videos, creator: { handle, xUserId: author.id },
        variables: cut ? vars.variables : [...vars.variables.map((v) => (v.defaultValue === v.name ? valued.get(v.name) ?? v : v)), ...wholeVars.variables.filter((w) => !vars.variables.some((v) => v.name === w.name))],
        reach: reach ?? reachOf([post]),
        ...(!chosen.ok ? { recipeMiss: chosen.reason } : {}),
        ...(!cut && whole !== vars.prompt ? { raw: whole, ...(written !== whole ? { rawWords: written } : {}) } : {}),
      };
      const filed = await file(post, replies, normalized, judged, hunt, hash);
      return "token" in filed ? { outcome: "queued", submissionId: filed.submissionId } : filed;
    };

    /** One post: what became of it, or why the round stops before it. reach: it is a chain's core. */
    const take = async (post: XPost, reach = deps.reach): Promise<Taken | { stop: PlayStop }> => {
      // Main posts only (Kev, 2026-10-14): the query leaves replies out; one that slips through is not read.
      if (post.replyingTo) return { outcome: "reply" };
      // A free reader reads the author's replies of every post first: what they hold decides, and is saved. A billed one
      // is not asked one read more for it: there a video in a reply goes unseen, and a saved video lacks the replies' words.
      const comment = given.get(post.id) ?? null;
      let replies = comment && [comment];
      if (free) {
        const got = await repliesOf(post);
        if (!Array.isArray(got)) return got;
        replies = comment ? [comment, ...got.filter((r) => r.id !== comment.id)] : got;
      }
      const videos = [post, ...(replies ?? [])].reduce((n, p) => n + (p.videos ?? 0), 0);
      if (videos) {
        const pictured = picturesOf(post, null, replies ?? []).length > 0;
        const saved = await park("video", post, replies ?? [], pictured ? "beside pictures" : "no picture", reach);
        if (typeof saved !== "string") return saved;
        round.videos += videos;
        if (!pictured) return { outcome: "video_only" };
      }
      // Referred by a person already: no model call, and on a billed reader no reply read.
      const normalized = `x.com/status/${post.id}`;
      const { data: known, error: knownError } = await supabase.from("hunt_submissions").select("id").eq("normalized_source_url", normalized).limit(1);
      if (knownError) throw knownError;
      if (known?.length) return { outcome: "duplicate" };
      if (mode !== "auto") {
        if (!replies) {
          const got = await repliesOf(post);
          if (!Array.isArray(got)) return got;
          replies = got;
        }
        return takePlain(post, replies, videos, normalized, reach);
      }

      let at = locatePrompt(post, replies, free || !!comment);
      if (at.kind === "reply") {
        const got = await repliesOf(post);
        if (!Array.isArray(got)) return got;
        replies = got;
        at = locatePrompt(post, replies, free);
      }
      // Words that could be a prompt go to the model first, and are followed only if it finds none in them: a creator's own
      // short prompt above a quote is not lost to what it quotes. Shorter words than that only forward.
      const followLast = !reach && at.kind === "unsure" && ownWords(post);
      if (!reach && !followLast && promptless(at)) {
        const onward = await forward(post);
        if (onward) return onward;
      }
      if (at.kind === "none") return { outcome: at.outcome };
      if (at.kind === "reply") return { outcome: "reply_missing" };
      // Before any model call, so it costs nothing. Words of its own that also forward are followed first, as the model's "none" would have them.
      if (!picturesOf(post, null, replies ?? []).length) {
        const onward = followLast && promptless(at) ? await forward(post) : null;
        return onward ?? noMedia(post, replies ?? [], NO_MEDIA, reach);
      }
      let prompt: string, from: PromptFrom, how: PromptHow, modelGenerator = "";
      if (at.kind === "sure") ({ prompt, from, how } = at);
      else {
        round.distills += 1;
        const d = await deps.distill(at.sources);
        if (!d.ok && d.why === "unchecked") return down();
        if (!d.ok) {
          const onward = followLast && promptless(at) ? await forward(post) : null;
          return onward ?? { outcome: d.why };
        }
        ({ prompt } = d);
        from = d.source === "text" ? "text" : d.source === "reply" ? "reply" : "alt";
        how = "model";
        modelGenerator = d.generator;
      }
      const reply = from === "reply" ? at.reply : null;
      // Its [variables] in Enki's form before anything is hashed, judged or sealed (lib/hunter/variables).
      const vars = importVariables(prompt);
      prompt = vars.prompt;
      const hash = promptHash(prompt);
      const { data: dup, error: dupError } = await supabase.from("hunt_submissions").select("id").eq("prompt_hash", hash).limit(1);
      if (dupError) throw dupError;
      if (dup?.length) return { outcome: "duplicate" };

      names ??= await deps.catalogue();
      const gen = resolveGenerators({
        texts: [post.text, ...post.photos.map((p) => p.alt ?? ""), at.reply?.text ?? ""], prompt, modelGenerator, preferred: config.preferredGenerator, catalogue: names,
      });
      const photos = picturesOf(post, reply, replies ?? []);
      const plan: ImportPlan = {
        prompt, generators: gen.generators, photos, source: { url: post.url, handle, authorId: author.id },
        said: importSaid({ handle, photos: photos.length, generators: gen.generators }),
      };
      round.checks += 1;
      round.photos += photos.length;
      // Sealed for the creator's own account: its prompts are theirs, and so is the queue row.
      const judged = await deps.judge(plan, { url: post.url, normalized }, me.userId, post.text);
      if (!judged.ok) return judged.status === 503 ? down() : { outcome: "refused" };
      const hunt: HuntFacts = {
        from, how, replyUrl: reply?.url ?? null, generatorFrom: gen.from, foreignGenerator: gen.foreign, videosSkipped: videos,
        creator: { handle, xUserId: author.id }, variables: vars.variables, reach: reach ?? reachOf([post]),
      };
      const filed = await file(post, replies ?? [], normalized, judged, hunt, hash);
      if (!("token" in filed)) return filed;
      const { token, submissionId } = filed;
      // A generator we do not offer, and none of ours named: a person looks first, whatever the mode.
      if (cfg.mode !== "publish" || deps.only || reach || (gen.foreign && gen.from !== "post")) return { outcome: "queued", submissionId };
      const generators = judged.preview.generators.length ? judged.preview.generators : names;
      round.publishes += 1;
      const published = await deps.publish({
        publisherId: me.userId, token, title: judged.preview.title, category: judged.preview.category,
        aiModel: generators[0] ?? "", aiModels: generators, photoCount: judged.preview.photos.length, variables: vars.variables,
      });
      return { outcome: published.ok ? "published" : "publish_failed", submissionId };
    };

    /**
     * A page, post by post, newest first; stops before a post when the round must. The phase's lower cursor follows each
     * post taken (oldest_id back, gap_low new). The dry brake is the look back's alone: what is new is read to its end.
     * A post a "Start over" took back is unread, its new outcome written over the mark. Failing again adds nothing to the
     * streak: the brake is for posts never read, and it stopping at the retries was a wall no Start over could pass.
     */
    const takePage = async (posts: XPost[], back: boolean): Promise<PlayStop | null> => {
      if (!posts.length) return null;
      const { data: seen, error } = await supabase.from("hunter_posts").select("post_id, outcome").in("post_id", posts.map((p) => p.id));
      if (error) throw error;
      for (const r of seen ?? []) taken.set(String(r.post_id), String(r.outcome));
      const records: Record<string, unknown>[] = [];
      const retried: Record<string, unknown>[] = [];
      let stop: PlayStop | null = null;
      pending = posts.length;
      for (const post of posts) {
        if (outOfTime()) { stop = "time"; break; }
        if (deps.now() - heldAt >= KEEP_MS) await keep();
        const was = taken.get(post.id);
        if (was !== undefined && was !== RETRY) {
          skip("seen");
          // A find read again ends a streak as it did the first time: failures a "Start over" retries were not in a row across it.
          if (back && !DRY.includes(was) && !neutral(was)) s.dry_streak = 0;
        } else {
          const got = await take(post);
          if ("stop" in got) { stop = got.stop; break; }
          const o = got.outcome;
          if (o === "queued" || o === "published" || o === "publish_failed") { counts.found += 1; s.found += 1; }
          if (o === "published") counts.published += 1;
          else if (o === "queued" || o === "publish_failed") counts.queued += 1;
          if (o !== "queued" && o !== "published") skip(o);
          const row = { post_id: post.id, handle, author_id: author.id, likes: post.likes, outcome: o, submission_id: got.submissionId ?? null };
          if (was) retried.push({ ...row, read_at: new Date().toISOString() });
          else records.push(row);
          if (back && DRY.includes(o)) s.dry_streak += was ? 0 : 1;
          else if (back && !neutral(o)) s.dry_streak = 0;
        }
        pending -= 1;
        if (back) s.oldest_id = older(s.oldest_id, post.id);
        else s.gap_low = older(s.gap_low, post.id);
        if (back && config.dryAfter > 0 && s.dry_streak >= config.dryAfter) { s.dry = true; s.exhausted = true; stop = "dry"; break; }
      }
      pending = 0;
      if (records.length) {
        const { error: recError } = await supabase.from("hunter_posts").upsert(records, { onConflict: "post_id", ignoreDuplicates: true });
        if (recError) throw recError;
      }
      if (retried.length) {
        const { error: againError } = await supabase.from("hunter_posts").upsert(retried, { onConflict: "post_id" });
        if (againError) throw againError;
      }
      return stop;
    };

    // One post by its link (Kev, 2026-10-31: "Add link manually"): taken as above, and none of the cursors move, so the
    // creator's own Plays read on where they were.
    if (deps.only) {
      const got = await take(deps.only);
      if ("stop" in got) { stopped = got.stop; return; }
      const o = got.outcome;
      if (o === "queued" || o === "publish_failed") { counts.found += 1; counts.queued += 1; s.found += 1; }
      else skip(o);
      // In the log with every Play's posts (Kev, 2026-10-31: "im log auch sehen bei welchem link es welche fehler gab"); a
      // link added again writes its newest outcome and time, so it comes first in the log again.
      const { error: logError } = await supabase.from("hunter_posts").upsert(
        { post_id: deps.only.id, handle, author_id: author.id, likes: deps.only.likes, outcome: o, submission_id: got.submissionId ?? null, read_at: new Date().toISOString() },
        { onConflict: "post_id" },
      );
      if (logError) console.warn("[creator-run] the link was not logged:", logError.message);
      stopped = "done";
      return;
    }

    let stop: PlayStop | null = null;
    // What is new since the last Play, from the top down. Cut short, it keeps the newest id read (gap_top) and the
    // lowest taken (gap_low), and the next round reads on below gap_low; newest_id moves once the gap is closed.
    if (s.newest_id) {
      const since = s.newest_id;
      const until = s.gap_low;
      const archive = archiveFor(since);
      let top = s.gap_top ?? since;
      let nextToken: string | null = null;
      for (;;) {
        const size = nextPage();
        if (typeof size === "string") { stop = size; break; }
        if (outOfTime()) { stop = "time"; break; }
        const page = await search({ archive, max: size, sinceId: since, untilId: until, nextToken });
        for (const p of page.posts) top = newer(top, p.id);
        s.gap_top = top;
        stop = await takePage(page.posts, false);
        if (stop) break;
        if (!page.nextToken) { s.newest_id = top; s.gap_top = null; s.gap_low = null; break; }
        nextToken = page.nextToken;
      }
    }
    // Back, older than what was read, until sinceDays or X's end, through the full archive. Only a page without a next
    // token is X's end: an empty one with a token is paged on by it, as X says to page (review 2026-10-30, F16).
    let backToken: string | null = null;
    while (!stop && !s.exhausted) {
      const size = nextPage();
      if (typeof size === "string") { stop = size; break; }
      if (outOfTime()) { stop = "time"; break; }
      const page = await search({
        archive: true, max: size, untilId: s.oldest_id, nextToken: backToken,
        // sinceDays 0 is the whole archive, asked from its start: X's own default is the last 30 days (review 2026-10-30, F7).
        startTime: config.sinceDays > 0 ? iso(started - config.sinceDays * DAY_MS) : X_ARCHIVE_START,
      });
      if (!s.newest_id) for (const p of page.posts) s.newest_id = newer(s.newest_id, p.id);
      stop = await takePage(page.posts, true);
      if (stop) break;
      if (!page.nextToken) s.exhausted = true;
      // Posts moved oldest_id, and the next page is asked below it; an empty page leaves it, and X's token goes on.
      backToken = page.posts.length ? null : page.nextToken;
    }
    // A look back that found nothing leaves no newest id to read on from: the round's start stands in (an id from the
    // time, as X's ids are), or no later Play would ask X for the creator's new posts again.
    if (s.exhausted && !s.newest_id) s.newest_id = snowflakeAt(started);
    stopped = stop ?? "done";
  };

  try {
    await go();
  } catch (e) {
    stopped = "error";
    status = 500;
    // supabase-js answers a refused query with a plain object, not an Error: its message is the cause (review 2026-10-30, F11).
    const m = (e as { message?: unknown } | null)?.message;
    failure = typeof m === "string" && m ? m : "The round failed.";
  }
  // Always: the creator's cursors, counts and spend, the hold released, while this round still holds it; and the Play's row.
  {
    const end = deps.now();
    // On Enki is the creator's state (loadCreators reads it), not an error on its row.
    s.error = stopped === "on_enki" ? null : failure;
    const spentUsd = spentNow();
    const { data: saved, error: saveError } = await supabase.from("hunter_accounts").update({
      x_user_id: s.x_user_id, newest_id: s.newest_id, oldest_id: s.oldest_id, gap_top: s.gap_top, gap_low: s.gap_low,
      exhausted: s.exhausted, dry: s.dry, dry_streak: s.dry_streak,
      posts_read: s.posts_read, found: s.found, spent_usd: spentUsd, error: s.error, last_run_at: iso(end), playing_since: null,
    }).eq("handle", handle).eq("playing_since", hold).select("handle");
    if (saveError) console.error("[creator-run] the creator's row was not saved:", saveError.message);
    // Another Play holds the creator now (a lost hold ends here too): nothing of this round is written over its (F10).
    else if (!saved?.length) { failure = LOST; status = 409; }
    const usage = run ? plus(run.usage, round) : round;
    const merged = { ...(run?.skipped ?? {}) };
    for (const [k, n] of Object.entries(skipped)) merged[k] = (merged[k] ?? 0) + n;
    if (run) {
      const { error: runError } = await supabase.from("hunter_runs").update({
        usage: { ...usage, stopped }, est_usd: spentOf(usage, free), posts_read: run.posts_read + round.posts,
        found: run.found + counts.found, queued: run.queued + counts.queued, published: run.published + counts.published,
        skipped: merged, error: failure, finished_at: stopped === "time" ? null : iso(end),
      }).eq("id", run.id);
      if (runError) console.error("[creator-run] the Play was not recorded:", runError.message);
    }
    const summary: CreatorRunSummary = {
      runId: run?.id ?? "", ...counts, skipped, usage, estUsd: spentOf(usage, free), spentUsd, ...(followedUsd ? { followedUsd: Math.round(followedUsd * 10_000) / 10_000 } : {}), stopped, more: stopped === "time",
      ...(failure ? { error: failure } : {}),
    };
    return status === 200 ? { status, summary } : { status, error: failure ?? "The round failed.", summary };
  }
}
