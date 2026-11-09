import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_USAGE, parseCreatorConfig, searchChanged } from "@/lib/hunter/creator-config";
import { LEADS_TO, type CreatorConfig, type CreatorMedia, type CreatorOutcome, type CreatorRow, type CreatorRunRow, type HuntUsage, type PlayStop } from "@/lib/hunter/creator-types";
import { HUNT_MODES, huntModeOf, parseRecipe } from "@/lib/hunter/recipe";

/**
 * The creators on the Prompt Hunter's list as the admin panel shows them, and their settings as it saves them (Kev,
 * 2026-10-30: "einen creator reinpacken, such kriterien einstellen, und go"). A creator is a hunter_accounts row with
 * SQL 56's columns; its Enki account is the users row of its X id (imported_x_id); its Plays are hunter_runs rows
 * with its handle. Before SQL 56 ran, `ready` is false and nothing is written.
 */

export const ACCOUNT_COLUMNS =
  "handle, x_user_id, newest_id, oldest_id, exhausted, dry, dry_streak, posts_read, found, error, last_run_at, added_at, "
  + "words, media, min_likes, since_days, preferred_generator, posts_per_play, spend_cap_usd, spent_usd, dry_after, playing_since, gap_top, gap_low, added_by";

/** A hunter_accounts row with SQL 56's columns (numeric columns may arrive as text). */
export interface CreatorAccount {
  handle: string;
  x_user_id: string | null;
  newest_id: string | null;
  oldest_id: string | null;
  exhausted: boolean;
  dry: boolean;
  dry_streak: number;
  posts_read: number;
  found: number;
  error: string | null;
  last_run_at: string | null;
  added_at: string;
  words: string[] | null;
  media: CreatorMedia;
  min_likes: number;
  since_days: number;
  preferred_generator: string | null;
  posts_per_play: number;
  spend_cap_usd: number | string;
  spent_usd: number | string;
  dry_after: number;
  playing_since: string | null;
  /** What is new, cut short: the newest id read and the lowest taken (SQL 56); the next Play reads on below gap_low. */
  gap_top: string | null;
  gap_low: string | null;
  added_by: string | null;
}

/** A Play holds its creator this long at most: a round lasts four minutes (TIME_CAP_MS), a crashed one is taken over after. */
export const LOCK_MS = 5 * 60_000;

export const HANDLE_RE = /^[a-z0-9_]{1,15}$/;
export const normalizeXHandle = (h: unknown) => String(h ?? "").replace(/^@/, "").trim().toLowerCase();

export const configOf = (a: CreatorAccount): CreatorConfig => ({
  words: a.words ?? [], media: a.media, minLikes: a.min_likes, sinceDays: a.since_days, preferredGenerator: a.preferred_generator,
  postsPerPlay: a.posts_per_play, spendCapUsd: Number(a.spend_cap_usd), dryAfter: a.dry_after,
});

export const columnsOf = (c: CreatorConfig) => ({
  words: c.words, media: c.media, min_likes: c.minLikes, since_days: c.sinceDays, preferred_generator: c.preferredGenerator,
  posts_per_play: c.postsPerPlay, spend_cap_usd: c.spendCapUsd, dry_after: c.dryAfter,
});

/** What a Play counted, from hunter_runs.usage: the counts, and why it stopped. */
export function usageOf(raw: unknown): { usage: HuntUsage; stopped: PlayStop | null } {
  const u = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const usage = { ...EMPTY_USAGE };
  for (const k of Object.keys(usage) as (keyof HuntUsage)[]) if (typeof u[k] === "number") usage[k] = u[k] as number;
  return { usage, stopped: typeof u.stopped === "string" ? (u.stopped as PlayStop) : null };
}

const isPlaying = (since: string | null, now: number) => !!since && now - Date.parse(since) < LOCK_MS;

export async function loadCreators(supabase: SupabaseClient, now = Date.now()): Promise<{ ready: boolean; creators: CreatorRow[]; modesReady?: boolean }> {
  const { data, error } = await supabase.from("hunter_accounts").select(ACCOUNT_COLUMNS).order("added_at", { ascending: true });
  // SQL 56 not run yet: its columns are missing.
  if (error) return { ready: false, creators: [] };
  const accounts = (data ?? []) as unknown as CreatorAccount[];
  const xIds = accounts.flatMap((a) => (a.x_user_id ? [a.x_user_id] : []));
  const [profiles, identities, runs] = await Promise.all([
    xIds.length ? supabase.from("users").select("id, handle, display_name, imported_x_id").in("imported_x_id", xIds) : Promise.resolve({ data: [] }),
    xIds.length ? supabase.from("auth_identities").select("subject, user_id").eq("provider", "x").in("subject", xIds) : Promise.resolve({ data: [] }),
    Promise.all(accounts.map((a) => supabase.from("hunter_runs")
      .select("id, started_at, finished_at, found, queued, published, skipped, usage, est_usd, error")
      .eq("handle", a.handle).order("started_at", { ascending: false }).limit(10))),
  ]);
  const byXId = new Map((profiles.data ?? []).map((p) => [String(p.imported_x_id), p]));
  const holders = (identities.data ?? []) as { subject: string; user_id: string }[];
  const profileIds = [...byXId.values()].map((p) => String(p.id));
  const [holderUsers, pending, modes, waitingLinks] = await Promise.all([
    holders.length ? supabase.from("users").select("id, handle").in("id", holders.map((h) => h.user_id)) : Promise.resolve({ data: [] }),
    profileIds.length ? supabase.from("hunt_submissions").select("hunter_user_id").eq("status", "pending").in("hunter_user_id", profileIds) : Promise.resolve({ data: [] }),
    // How each cuts its finds (SQL 59; before it runs the read fails and every creator is "auto").
    supabase.from("hunter_accounts").select("handle, mode, recipe"),
    supabase.from("hunter_posts").select("handle").eq("outcome", "waiting"),
  ]);
  const modeOf = new Map(((modes.error ? [] : modes.data) ?? []).map((m) => [String(m.handle), m]));
  const linksOf = new Map<string, number>();
  for (const r of (waitingLinks.data ?? []) as { handle: string }[]) linksOf.set(r.handle, (linksOf.get(r.handle) ?? 0) + 1);
  const holderHandle = new Map((holderUsers.data ?? []).map((u) => [String(u.id), (u.handle as string | null) ?? "an Enki account"]));
  const onEnki = new Map(holders.map((h) => [String(h.subject), holderHandle.get(String(h.user_id)) ?? "an Enki account"]));
  const waiting = new Map<string, number>();
  for (const r of (pending.data ?? []) as { hunter_user_id: string }[]) waiting.set(String(r.hunter_user_id), (waiting.get(String(r.hunter_user_id)) ?? 0) + 1);

  const creators = accounts.map((a, i): CreatorRow => {
    const p = a.x_user_id ? byXId.get(a.x_user_id) : undefined;
    const rows = (runs[i].data ?? []) as Record<string, unknown>[];
    return {
      handle: a.handle,
      xUserId: a.x_user_id,
      profile: p ? { userId: String(p.id), handle: (p.handle as string | null) ?? null, name: (p.display_name as string | null) ?? null } : null,
      onEnki: a.x_user_id ? onEnki.get(a.x_user_id) ?? null : null,
      config: configOf(a),
      state: {
        newestId: a.newest_id, oldestId: a.oldest_id, backDone: a.exhausted, dry: a.dry, catchingUp: a.gap_low != null, postsRead: a.posts_read, found: a.found,
        spentUsd: Number(a.spent_usd), error: a.error, lastRunAt: a.last_run_at, addedAt: a.added_at, playing: isPlaying(a.playing_since, now),
      },
      runs: rows.map((r): CreatorRunRow => ({
        id: String(r.id), at: String(r.started_at), done: (r.finished_at as string | null) ?? null,
        found: Number(r.found ?? 0), queued: Number(r.queued ?? 0), published: Number(r.published ?? 0),
        skipped: (r.skipped as Record<string, number>) ?? {}, ...usageOf(r.usage), estUsd: Number(r.est_usd ?? 0), error: (r.error as string | null) ?? null,
      })),
      pending: p ? waiting.get(String(p.id)) ?? 0 : 0,
      mode: huntModeOf(modeOf.get(a.handle)?.mode),
      recipe: parseRecipe(modeOf.get(a.handle)?.recipe),
      links: linksOf.get(a.handle) ?? 0,
    };
  });
  return { ready: true, creators, modesReady: !modes.error };
}

/** A creator's mode and recipe (Kev, 2026-11-01), saved apart from the search settings; SQL 59 must have run. */
export async function saveMode(supabase: SupabaseClient, p: { handle: unknown; mode: unknown; recipe: unknown }): Promise<{ ok: true } | { ok: false; status: 400 | 404 | 409 | 500; error: string }> {
  const handle = normalizeXHandle(p.handle);
  if (!HANDLE_RE.test(handle)) return { ok: false, status: 400, error: `Not an X handle: ${handle || "(empty)"}` };
  if (!(HUNT_MODES as readonly string[]).includes(p.mode as string)) return { ok: false, status: 400, error: "A mode is auto, recipe or manual." };
  const recipe = parseRecipe(p.recipe);
  const { data, error } = await supabase.from("hunter_accounts").update({ mode: p.mode, recipe }).eq("handle", handle).select("handle");
  if (error) return error.code === "42703" ? { ok: false, status: 409, error: "Modes need SQL 59 (sql-to-run/59-hunter-modes.sql)." } : { ok: false, status: 500, error: error.message };
  return data?.length ? { ok: true } : { ok: false, status: 404, error: `@${handle} is not on the list.` };
}

/**
 * Saves the settings of a creator on the list (the panel adds one with addAccounts, which only inserts). A change to
 * what X is asked (words, media, min likes, how far back) starts its reading over: the next Play reads from the start,
 * skips the posts already taken, and X bills the re-read. Not while a Play holds it, whose last round would write the
 * old cursors back. A creator removed meanwhile (another tab) is not brought back with no spend and no cursors (review
 * 2026-10-30, F14).
 */
/** Every cursor back to the start: the next Play reads the creator from the top (a changed search, or "Start over"). */
export const RESTART = { newest_id: null, oldest_id: null, exhausted: false, dry: false, dry_streak: 0, gap_top: null, gap_low: null };
/** The marks a "Start over" takes back: the post was not judged, the model, its reply, its pictures' host or the way to its core let it down; or its find was rejected through a chain, read again as any rejected find is. By its prefix in the write below, one that led to someone not on the list too, who may be on it now. */
const RETRIED: CreatorOutcome[] = ["distill_failed", "reply_missing", "follow_failed", "pictures_failed", "rejected"];
/** What such a mark becomes: unread for the next Play, and still a line in the log until its new outcome replaces it. */
export const RETRY: CreatorOutcome = "retry";

/**
 * "Start over" (Kev, 2026-10-31: "nach rejecten und wieder einfügen des links sagt er \"up to date\", wobei ich das ja neu
 * laufen lassen möchte"): the cursors back to the start, so the next Play reads every post again (free through FxTwitter);
 * a post already found is skipped as a duplicate, and one whose find was rejected is read again. So is one that failed
 * (RETRIED), which the next Play pays for: its mark changes last, as a mark changed with the cursors still past it is
 * never read. The cursors and the hold go in one write, as a Play takes it: no Play starts between the two and saves its
 * old cursors over these at its end, or passes a mark not changed yet.
 */
export async function restartCreator(supabase: SupabaseClient, rawHandle: unknown, now = Date.now()): Promise<{ ok: true } | { ok: false; status: 404 | 409 | 500; error: string }> {
  const handle = normalizeXHandle(rawHandle);
  const hold = new Date(now).toISOString();
  const { data: held, error } = await supabase.from("hunter_accounts").update({ ...RESTART, playing_since: hold })
    .eq("handle", handle).or(`playing_since.is.null,playing_since.lt.${new Date(now - LOCK_MS).toISOString()}`).select("handle");
  if (error) return { ok: false, status: 500, error: error.message };
  if (!held?.length) {
    const { data: cur, error: readError } = await supabase.from("hunter_accounts").select("handle").eq("handle", handle).maybeSingle();
    if (readError) return { ok: false, status: 500, error: readError.message };
    return cur ? { ok: false, status: 409, error: `@${handle} is playing: stop its Play first.` } : { ok: false, status: 404, error: `@${handle} is not on the list.` };
  }
  const { error: markError } = await supabase.from("hunter_posts").update({ outcome: RETRY }).eq("handle", handle).or(`outcome.in.(${RETRIED.join(",")}),outcome.like.${LEADS_TO}*`);
  const { error: freeError } = await supabase.from("hunter_accounts").update({ playing_since: null }).eq("handle", handle).eq("playing_since", hold);
  if (freeError) console.error("[creators] the hold was not released:", freeError.message);
  return markError ? { ok: false, status: 500, error: markError.message } : { ok: true };
}

export async function saveCreator(
  supabase: SupabaseClient,
  p: { handle: unknown; config: unknown; catalogue: string[]; now?: number },
): Promise<{ ok: true } | { ok: false; status: 400 | 404 | 409 | 500; error: string }> {
  const handle = normalizeXHandle(p.handle);
  if (!HANDLE_RE.test(handle)) return { ok: false, status: 400, error: `Not an X handle: ${handle || "(empty)"}` };
  const parsed = parseCreatorConfig(p.config, p.catalogue, handle);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const { data: cur, error } = await supabase.from("hunter_accounts").select(ACCOUNT_COLUMNS).eq("handle", handle).maybeSingle();
  if (error) return { ok: false, status: 500, error: `Could not read @${handle}: ${error.message}` };
  if (!cur) return { ok: false, status: 404, error: `@${handle} is not on the list any more.` };
  const cols = columnsOf(parsed.config);
  const account = cur as unknown as CreatorAccount;
  const restart = searchChanged(configOf(account), parsed.config);
  if (restart && isPlaying(account.playing_since, p.now ?? Date.now())) {
    return { ok: false, status: 409, error: `@${handle} is playing: stop it before changing its search.` };
  }
  const reset = restart ? RESTART : {};
  const { error: updateError } = await supabase.from("hunter_accounts").update({ ...cols, ...reset }).eq("handle", handle);
  return updateError ? { ok: false, status: 500, error: `Could not save @${handle}: ${updateError.message}` } : { ok: true };
}
