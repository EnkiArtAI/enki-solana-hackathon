import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { DbUnreachableError, dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { UUID_RE } from "@/lib/dm";
import { CLIENT_BLOCK_MESSAGE, screenFirst } from "@/lib/moderation";
import { recordAdminAction } from "@/lib/admin/audit";
import { hideAdult, type viewer } from "@/lib/adult-content";
import { withoutIgnored } from "@/lib/ignores";
import { handleKey, slugify } from "@/lib/communities/handle";
import {
  ALIASES_FULL, COMMUNITIES_NOT_READY, COMMUNITY_READS_PER_MIN, COMMUNITY_SUGGESTS_PER_MIN, COMMUNITY_TEXT,
  COMMUNITY_WRITES_PER_MIN, MAX_COMMUNITIES_PER_WORK, MERGE_SAME, MERGED_ALREADY, NAME_NEEDED, NEW_COMMUNITIES_FULL, NEW_COMMUNITIES_TODAY, NOT_READ,
  NOT_YOUR_RENDER, NOT_YOURS, POSTS_TODAY, TITLE_NEEDED, TOO_LONG, TOO_MANY_COMMUNITIES,
  type CommunityCard, type CommunityCardRow, type CommunityChip, type CommunityDetail, type CommunityRow, type ItemCommunities,
  type ItemKind, type ShowroomPost, type Work,
} from "@/lib/communities/types";

/**
 * What every app/api/communities route shares (Kev, 2026-10-30: "propose me something, that cant be duplicated and will
 * work as a harbour AND gallery ..."; lib/communities/types.ts, migrations/2026-10-30-communities.sql = SQL 54), after
 * lib/studio/server.ts: the session, the limits, the field rules, the failures, resolving a handle, and the rows as the
 * API answers them. Service role: every rule on who may read or write what is the route's (or SQL 54's triggers').
 */

export type Supabase = ReturnType<typeof getSupabaseServerClient>;
type Body = Record<string, unknown>;
type Failure = { code?: string; message?: string } | null;

/** The columns the routes read, per relation. */
export const COLS = {
  live: "id, handle, name, description, created_by, created_at, merged_into",
  card: "id, handle, handle_key, core, name, description, created_by, created_at, core_reviewed_at, members, works, works_7d, listed, cover_url",
  work: "image_id, user_id, prompt_id, mime_type, storage_url, preview_url, thumbnail_url, width, height, like_count, added_at",
  entry: "id, user_id, image_id, title, caption, parent_id, created_at, prompt_id, mime_type, storage_url, preview_url, thumbnail_url, width, height, like_count",
} as const;
/** An item's key column in community_links, and the table that owns it with its owner column. */
export const ITEM = {
  prompt: { column: "prompt_id", table: "prompts", owner: "creator_id" },
  image: { column: "image_id", table: "generated_images", owner: "user_id" },
  post: { column: "post_id", table: "showroom_posts", owner: "user_id" },
} as const satisfies Record<ItemKind, { column: string; table: string; owner: string }>;

export const say = (error: string, status: number, extra?: Body) => NextResponse.json({ error, ...extra }, { status });
export const notFound = () => say("Not found", 404);
export const badRequest = () => say("Bad request", 400);
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
/** A list's cursor: an offset, 0 for none or one that is not a whole number. */
export const offsetOf = (cursor: string | null) => Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);

/** One Communities handler: the caller's session first ("required": 401 for a guest, nothing read; "optional": a guest
 *  reads as null), then `run`; a database that cannot be reached is the outage 503, never a guest or a 500. */
export function communityHandler<P extends object = object>(
  run: (c: { req: NextRequest; supabase: Supabase; me: string | null; params: P }) => Promise<Response>,
  opts: { session: "optional" },
): (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;
export function communityHandler<P extends object = object>(
  run: (c: { req: NextRequest; supabase: Supabase; me: string; params: P }) => Promise<Response>,
  opts: { session: "required" },
): (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;
export function communityHandler<P extends object = object>(
  run: (c: { req: NextRequest; supabase: Supabase; me: string; params: P }) => Promise<Response>,
  opts: { session: "optional" | "required" },
) {
  return async (req: NextRequest, { params }: { params: Promise<P> }) => {
    try {
      const supabase = getSupabaseServerClient();
      const me = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
      if (!me && opts.session === "required") return say("Not signed in", 401);
      return await run({ req, supabase, me: me as string, params: await params });
    } catch (e) {
      if (isDbUnreachable(e)) return dbUnavailableResponse();
      throw e;
    }
  };
}

/** Writes and suggestions per account and minute, reads per address and minute (lib/rate-limit). Null when within. */
export function overLimit(req: NextRequest, me: string | null, kind: "write" | "read" | "suggest") {
  const [cap, subject] = kind === "write" ? [COMMUNITY_WRITES_PER_MIN, me] : kind === "suggest" ? [COMMUNITY_SUGGESTS_PER_MIN, me] : [COMMUNITY_READS_PER_MIN, undefined];
  const limit = checkRequestRateLimit(rateLimitKey(req, `community-${kind}`, subject ?? undefined), cap, 60_000);
  return limit.allowed ? null : rateLimitResponse(limit.retryAfterSeconds);
}

/** The body when it is a JSON object, else null. */
export async function readBody(req: NextRequest): Promise<Body | null> {
  const body: unknown = await req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : null;
}

/** Each refusal SQL 54 raises, by its message: the cap triggers ('community cap <table> <column> <window|all>'), the
 *  owner guards and the merge. */
const REFUSALS: Record<string, [string, number]> = {
  "community cap communities created_by 1 day": [NEW_COMMUNITIES_TODAY, 409],
  "community cap communities created_by all": [NEW_COMMUNITIES_FULL, 409],
  "community cap community_aliases community_id all": [ALIASES_FULL, 409],
  "community cap showroom_posts user_id 1 day": [POSTS_TODAY, 409],
  "community cap community_links prompt_id": [TOO_MANY_COMMUNITIES, 409],
  "community cap community_links image_id": [TOO_MANY_COMMUNITIES, 409],
  "community cap community_links post_id": [TOO_MANY_COMMUNITIES, 409],
  "community link not owner": [NOT_YOURS, 403],
  "showroom post not own render": [NOT_YOUR_RENDER, 403],
  "community merge same": [MERGE_SAME, 400],
  "community merge gone": [MERGED_ALREADY, 409],
};

/** A failed read or write: the outage 503, SQL 54 not run yet (503), one of SQL 54's refusals with its sentence, a key
 *  taken (409, when the write has a sentence for it), else `sentence` (500). */
export function communityFailure(error: Failure, sentence: string, taken?: string) {
  if (isDbUnreachable(error)) return dbUnavailableResponse();
  if (error?.code === "PGRST205" || error?.code === "PGRST202" || error?.code === "42P01") return say(COMMUNITIES_NOT_READY, 503);
  const refusal = error?.code === "23514" ? REFUSALS[error.message ?? ""] : undefined;
  if (refusal) return say(...refusal);
  if (error?.code === "23505" && taken) return say(taken, 409);
  return say(sentence, 500);
}

type TextField = "name" | "description" | "title" | "caption";
const REQUIRED: Partial<Record<TextField, [string, number]>> = { name: [NAME_NEEDED, 2], title: [TITLE_NEEDED, 1] };

/**
 * The text fields of a body as SQL 54 keeps them: trimmed, within COMMUNITY_TEXT, a name (2 or more characters) and a
 * title never blank. On a create every field is read (an absent optional one is null); on a PATCH an absent field stays
 * and null clears an optional one. A sentence for the first field that is not.
 */
export function readText(body: Body, fields: readonly TextField[], create: boolean): { values: Partial<Record<TextField, string | null>> } | { error: string } {
  const values: Partial<Record<TextField, string | null>> = {};
  for (const f of fields) {
    const raw = body[f];
    if (raw === undefined && !create) continue;
    if (raw != null && typeof raw !== "string") return { error: "Bad request" };
    const v = (raw ?? "").trim();
    // Counted in characters as SQL 54's char_length counts them: one emoji is one, not two UTF-16 units.
    const length = [...v].length;
    const need = REQUIRED[f];
    if (need && length < need[1]) return { error: need[0] };
    if (length > COMMUNITY_TEXT[f]) return { error: TOO_LONG[f] };
    values[f] = v || null;
  }
  return { values };
}

/** Moderation tier 1 (local rules, no request out) over the text a write keeps; its refusal, or null (decision: Community
 *  text is screened like a prompt's first pass, never sent to the paid tier 2). Nothing is recorded. */
export function screened(texts: Record<string, string | null | undefined>) {
  const kept = Object.fromEntries(Object.entries(texts).filter((e): e is [string, string] => typeof e[1] === "string"));
  return screenFirst(kept) ? say(CLIENT_BLOCK_MESSAGE, 422) : null;
}

type Filterable = { eq(column: string, value: boolean): Filterable; not(column: string, operator: string, value: unknown): Filterable };
/** A list of other people's rows as this viewer may see it: 18+ only when they may (lib/adult-content), without whom
 *  they ignore (lib/ignores), by its user_id. Typed loosely: the two generics over a typed select are too deep for tsc. */
export function visibleTo<Q>(query: Q, v: Awaited<ReturnType<typeof viewer>>, ignored: string[]): Q {
  return withoutIgnored(hideAdult(query as unknown as Filterable, v), "user_id", ignored) as unknown as Q;
}

/** The caller's Enki staff role (users.role, as app/api/admin requireAdmin reads it): admins hide, merge and delete,
 *  mods hide. A read that fails is no role; an unreachable database is the outage. */
export async function staffOf(supabase: Supabase, me: string | null): Promise<"admin" | "mod" | null> {
  if (!me) return null;
  const { data, error } = await supabase.from("users").select("role").eq("id", me).maybeSingle();
  if (isDbUnreachable(error)) throw new DbUnreachableError();
  return data?.role === "admin" || data?.role === "mod" ? data.role : null;
}

/** An admin or mod action into the admin log (lib/admin/audit.ts), after it went through. */
export const audit = (supabase: Supabase, req: NextRequest, actor: { userId: string; role: string }, body: Body, res: Response) =>
  recordAdminAction(supabase, req, actor, { resource: "community", ...body }, res).then(() => res);

export type LiveCommunity = Pick<CommunityRow, "id" | "handle" | "name" | "description" | "created_by" | "created_at" | "merged_into">;
/**
 * A handle as typed or linked, to its live community: by its key, so a look-alike finds the one it looks like and a merged
 * handle the one it was merged into. `redirect` is the live community's handle when the asked one is not it (the canonical
 * spelling, or the merge's target, `merged`). Null when there is none.
 */
export async function resolveCommunity(supabase: Supabase, raw: string): Promise<{ row: LiveCommunity; redirect: string | null; merged: boolean } | null | Response> {
  const asked = raw.trim().toLowerCase();
  const key = asked.length <= COMMUNITY_TEXT.query ? handleKey(slugify(asked)) : "";
  if (!key) return null;
  const found = await supabase.from("communities").select(COLS.live).eq("handle_key", key).maybeSingle();
  if (found.error) return communityFailure(found.error, NOT_READ);
  const row = found.data as LiveCommunity | null;
  if (!row?.merged_into) return row && { row, redirect: row.handle === asked ? null : row.handle, merged: false };
  // SQL 54's merge points every earlier merge at the newest target, so one step reaches a live one.
  const target = await supabase.from("communities").select(COLS.live).eq("id", row.merged_into).is("merged_into", null).maybeSingle();
  if (target.error) return communityFailure(target.error, NOT_READ);
  return target.data && { row: target.data as LiveCommunity, redirect: target.data.handle, merged: true };
}

/** A handle's live community id for a filter, or null: none, SQL 54 not run, or a read that failed (the filter then shows
 *  nothing, never everything). */
export async function communityIdOf(supabase: Supabase, raw: string): Promise<string | null> {
  const found = await resolveCommunity(supabase, raw);
  return found && !(found instanceof Response) ? found.row.id : null;
}

/* ── Rows as the API answers them. ── */

export const toChip = (r: { id: string; handle: string; name: string }): CommunityChip => ({ id: r.id, handle: r.handle, name: r.name });
export const toCard = (r: CommunityCardRow): CommunityCard =>
  ({ ...toChip(r), members: r.members, works: r.works, works7d: r.works_7d, listed: r.listed, cover: r.cover_url });

/** Users' handles by id, in one read. */
export async function handlesOf(supabase: Supabase, ids: (string | null)[]): Promise<Map<string, string | null> | Response> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const { data, error } = await supabase.from("users").select("id, handle").in("id", wanted);
  if (error) return communityFailure(error, NOT_READ);
  return new Map((data as { id: string; handle: string | null }[]).map((u) => [u.id, u.handle]));
}

/** Live communities as chips, by id, in one read; a merged or deleted one is left out. */
export async function chipsOf(supabase: Supabase, ids: string[]): Promise<Map<string, CommunityChip> | Response> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return new Map();
  const { data, error } = await supabase.from("communities").select("id, handle, name").in("id", wanted).is("merged_into", null);
  if (error) return communityFailure(error, NOT_READ);
  return new Map((data as CommunityChip[]).map((c) => [c.id, toChip(c)]));
}

/** GET /api/communities/[handle]'s answer for a live community and its viewer. Null when it has no card (merged or gone
 *  meanwhile). */
export async function detailOf(supabase: Supabase, id: string, me: string | null): Promise<CommunityDetail | null | Response> {
  const [card, aliases, joined, staff] = await Promise.all([
    supabase.from("community_cards").select(COLS.card).eq("id", id).maybeSingle(),
    supabase.from("community_aliases").select("alias").eq("community_id", id).order("alias", { ascending: true }),
    me ? supabase.from("community_members").select("user_id").eq("community_id", id).eq("user_id", me).maybeSingle() : Promise.resolve({ data: null, error: null }),
    staffOf(supabase, me),
  ]);
  const failed = card.error ?? aliases.error ?? joined.error;
  if (failed) return communityFailure(failed, NOT_READ);
  const row = card.data as CommunityCardRow | null;
  if (!row) return null;
  const creator = await handlesOf(supabase, [row.created_by]);
  if (creator instanceof Response) return creator;
  return {
    ...toCard(row),
    description: row.description,
    aliases: (aliases.data as { alias: string }[]).map((a) => a.alias),
    createdBy: row.created_by ? { handle: creator.get(row.created_by) ?? null } : null,
    createdAt: row.created_at,
    joined: !!joined.data,
    canEdit: !!me && (row.created_by === me || staff === "admin"),
    staff,
  };
}

type Render = {
  image_id: string; user_id: string; prompt_id: string | null; mime_type: string | null; storage_url: string | null;
  preview_url: string | null; thumbnail_url: string | null; width: number | null; height: number | null; like_count: number;
  added_at: string;
};
/** Renders as works: their owners' handles in one read, their prompts only while listed (one read), video by mime type; a
 *  render with no address is left out. */
export async function worksOf(supabase: Supabase, rows: Render[]): Promise<Work[] | Response> {
  const promptIds = [...new Set(rows.flatMap((r) => (r.prompt_id ? [r.prompt_id] : [])))];
  const [owners, listed] = await Promise.all([
    handlesOf(supabase, rows.map((r) => r.user_id)),
    promptIds.length
      ? supabase.from("prompts").select("id").in("id", promptIds).eq("is_listed", true).eq("listing_status", "active").is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (owners instanceof Response) return owners;
  if (listed.error) return communityFailure(listed.error, NOT_READ);
  const open = new Set((listed.data as { id: string }[]).map((p) => p.id));
  return rows.flatMap((r) => {
    const url = r.preview_url ?? r.storage_url;
    if (!url) return [];
    return [{
      imageId: r.image_id, kind: r.mime_type?.startsWith("video/") ? "video" : "image", url, thumb: r.thumbnail_url ?? url,
      width: r.width, height: r.height, owner: { handle: owners.get(r.user_id) ?? null },
      promptId: r.prompt_id && open.has(r.prompt_id) ? r.prompt_id : null, likes: r.like_count, addedAt: r.added_at,
    } satisfies Work];
  });
}

export type Entry = Omit<Render, "added_at"> & { id: string; title: string; caption: string | null; parent_id: string | null; created_at: string };
/** Showroom entries (SQL 54's showroom_entries / community_posts) as posts, with each one's communities (its shown
 *  links, live ones) and, for a top-level post, its answers: `answers` by parent, newest first, with their total. */
export async function postsOf(
  supabase: Supabase, me: string | null, rows: Entry[], answers: Map<string, { rows: Entry[]; total: number }> = new Map(),
): Promise<ShowroomPost[] | Response> {
  const all = [...rows, ...[...answers.values()].flatMap((a) => a.rows)];
  if (!all.length) return [];
  const links = await supabase.from("community_links").select("post_id, community_id").in("post_id", all.map((e) => e.id)).eq("state", "shown");
  if (links.error) return communityFailure(links.error, NOT_READ);
  const linked = links.data as { post_id: string; community_id: string }[];
  const [chips, works] = await Promise.all([
    chipsOf(supabase, linked.map((l) => l.community_id)),
    worksOf(supabase, all.map((e) => ({ ...e, added_at: e.created_at }))),
  ]);
  if (chips instanceof Response) return chips;
  if (works instanceof Response) return works;
  const work = new Map(works.map((w) => [w.imageId, w]));
  const post = (e: Entry, kids?: { rows: Entry[]; total: number }): ShowroomPost[] => {
    const w = work.get(e.image_id);
    if (!w) return [];
    return [{
      id: e.id, title: e.title, caption: e.caption, author: w.owner, work: w,
      communities: linked.filter((l) => l.post_id === e.id).flatMap((l) => chips.get(l.community_id) ?? []).sort((a, b) => a.handle.localeCompare(b.handle)),
      parentId: e.parent_id, answers: kids?.total ?? 0, latestAnswers: (kids?.rows ?? []).flatMap((k) => post(k)),
      mine: e.user_id === me, createdAt: e.created_at,
    }];
  };
  return rows.flatMap((e) => post(e, answers.get(e.id)));
}

/**
 * A render's places, each with the ways it came ("link", "prompt", "post"): the first MAX_COMMUNITIES_PER_WORK communities
 * it reached, in SQL 54's community_reach order (when each way began, then the community), as community_works keeps
 * them (Kev, 2026-10-30: "max 18 communities pro werk"). Public or not: its owner's list reads it before it goes public.
 */
export async function placesOf(supabase: Supabase, imageId: string): Promise<Map<string, Set<string>> | Response> {
  const { data, error } = await supabase.from("community_reach").select("community_id, via").eq("image_id", imageId)
    .order("linked_at", { ascending: true }).order("community_id", { ascending: true });
  if (error) return communityFailure(error, NOT_READ);
  const places = new Map<string, Set<string>>();
  for (const r of data as { community_id: string; via: string }[]) {
    const ways = places.get(r.community_id);
    if (ways) ways.add(r.via);
    else if (places.size < MAX_COMMUNITIES_PER_WORK) places.set(r.community_id, new Set([r.via]));
  }
  return places;
}

/**
 * The communities one item is in (GET /api/communities/links): a prompt's or a post's shown links; a render's places by
 * its own link or its listed prompt (placesOf: where its works show it; a post's places are the post's to set), its
 * prompt's marked `inherited`. Its owner also learns which of its prompt's (`promptId`, null when none, not listed or its
 * creator hidden) it was taken out of, and which a moderator hid.
 */
export async function itemCommunities(supabase: Supabase, kind: ItemKind, id: string, promptId: string | null, owner: boolean): Promise<ItemCommunities | Response> {
  const [own, fromPrompt, places] = await Promise.all([
    supabase.from("community_links").select("community_id, state").eq(ITEM[kind].column, id),
    kind === "image" && promptId
      ? supabase.from("community_links").select("community_id").eq("prompt_id", promptId).eq("state", "shown")
      : Promise.resolve({ data: [], error: null }),
    kind === "image" ? placesOf(supabase, id) : null,
  ]);
  if (places instanceof Response) return places;
  const failed = own.error ?? fromPrompt.error;
  if (failed) return communityFailure(failed, NOT_READ);
  const state = new Map((own.data as { community_id: string; state: string }[]).map((l) => [l.community_id, l.state]));
  const inherited = new Set((fromPrompt.data as { community_id: string }[]).map((l) => l.community_id));
  const ids = (pick: (c: string) => boolean) => [...new Set([...state.keys(), ...inherited])].filter(pick);
  const shown = places
    ? [...places].filter(([, ways]) => ways.has("link") || ways.has("prompt")).map(([c]) => c)
    : ids((c) => state.get(c) === "shown");
  const optedOut = owner ? ids((c) => inherited.has(c) && state.get(c) === "opted_out") : [];
  const hidden = owner ? ids((c) => state.get(c) === "hidden") : [];
  const chips = await chipsOf(supabase, [...shown, ...optedOut, ...hidden]);
  if (chips instanceof Response) return chips;
  const of = (list: string[]) => list.flatMap((c) => chips.get(c) ?? []).sort((a, b) => a.handle.localeCompare(b.handle));
  const communities = of(shown);
  return { communities, inherited: communities.filter((c) => inherited.has(c.id)).map((c) => c.id), optedOut: of(optedOut), hidden: of(hidden) };
}
