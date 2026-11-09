import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { UUID_RE } from "@/lib/dm";
import { signed } from "@/lib/reference-library";
import {
  BAD_LINK, BAD_PALETTE, CHARACTERS_FULL, CONTENT_IMAGES_FULL, CONTENTS_FULL, MASTER_PROMPTS_FULL, MAX_PALETTE, NAME_NEEDED,
  NOT_IN_PROJECT, NOT_READ, NOT_SAVED, PROJECT_ASSETS_FULL, PROJECTS_FULL, PROMPT_NEEDED, STUDIO_ASSETS_FULL, STUDIO_NOT_READY,
  STUDIO_TEXT, STUDIO_UPLOADS_PER_MIN, STUDIO_WRITES_PER_MIN, STYLES_FULL, TOO_LONG,
  type Asset, type Character, type Content, type ItemKind, type MasterPrompt, type Project, type StudioAssetRow,
  type StudioCharacterRow, type StudioContentRow, type StudioMasterPromptRow, type StudioPicture, type StudioProjectRow,
  type StudioStyleRow, type Style,
} from "@/lib/studio/types";

/**
 * What every app/api/studio route shares (Kev, 2026-10-30: "At the end i want basically within studio a collection of
 * projects containing different content pieces that all access the same reference images, characters, styles and
 * master prompts"; lib/studio/types.ts, migrations/2026-10-30-studio.sql = SQL 53): the session, the write limits, the
 * field rules, the failures and the rows as the API answers them. Service role, so every read and write is filtered by
 * its owner in the route itself: someone else's row reads as none at all (404).
 */

export type Supabase = ReturnType<typeof getSupabaseServerClient>;
type Row<T> = Omit<T, "user_id">;
type Body = Record<string, unknown>;

/** The columns the routes read, per table. */
export const COLS = {
  project: "id, name, description, link, created_at, updated_at",
  asset: "id, project_id, path, thumb_path, content_hash, created_at",
  character: "id, project_id, name, image_id, asset_id, sheet_prompt_id, created_at",
  style: "id, project_id, name, words, palette, created_at, updated_at",
  masterPrompt: "id, project_id, name, prompt, created_at, updated_at",
  content: "id, project_id, name, description, link, style_id, master_prompt_id, created_at, updated_at",
} as const;
/** The tables app/api/studio/[kind]/[id] changes and deletes. */
export const ITEM_TABLE = {
  assets: "studio_assets", characters: "studio_characters", styles: "studio_styles", "master-prompts": "studio_master_prompts",
} as const satisfies Record<ItemKind, string>;

export const say = (error: string, status: number) => NextResponse.json({ error }, { status });
export const notFound = () => say("Not found", 404);
export const badRequest = () => say("Bad request", 400);
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** One Studio handler: the caller's session first (401 for a guest, nothing read), then `run`; a database that cannot be
 *  reached is the outage 503, never a guest or a 500. */
export function studioHandler<P extends object = object>(
  run: (c: { req: NextRequest; supabase: Supabase; me: string; params: P }) => Promise<Response>,
) {
  return async (req: NextRequest, { params }: { params: Promise<P> }) => {
    try {
      const supabase = getSupabaseServerClient();
      const me = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
      if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
      return await run({ req, supabase, me, params: await params });
    } catch (e) {
      if (isDbUnreachable(e)) return dbUnavailableResponse();
      throw e;
    }
  };
}

/** The write limit, per account and minute: a picture's upload counts apart (as app/api/references). Null when within. */
export function overLimit(req: NextRequest, me: string, upload = false) {
  const limit = upload
    ? checkRequestRateLimit(rateLimitKey(req, "studio-asset", me), STUDIO_UPLOADS_PER_MIN, 60_000)
    : checkRequestRateLimit(rateLimitKey(req, "studio", me), STUDIO_WRITES_PER_MIN, 60_000);
  return limit.allowed ? null : rateLimitResponse(limit.retryAfterSeconds);
}

/** The body when it is a JSON object, else null. */
export async function readBody(req: NextRequest): Promise<Body | null> {
  const body: unknown = await req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : null;
}

/** The sentence for each cap SQL 53's trigger meets, by its message ('studio cap <table> <column>'). */
const CAPS: Record<string, string> = {
  "studio cap studio_projects user_id": PROJECTS_FULL,
  "studio cap studio_assets project_id": PROJECT_ASSETS_FULL,
  "studio cap studio_assets user_id": STUDIO_ASSETS_FULL,
  "studio cap studio_characters project_id": CHARACTERS_FULL,
  "studio cap studio_styles project_id": STYLES_FULL,
  "studio cap studio_master_prompts project_id": MASTER_PROMPTS_FULL,
  "studio cap studio_contents project_id": CONTENTS_FULL,
  "studio cap studio_content_images content_id": CONTENT_IMAGES_FULL,
};

/** A failed read or write: the outage 503, SQL 53 not run yet (503), a cap (409), a name taken (409, when the write
 *  has one), else `sentence` (500). */
export function studioFailure(error: { code?: string; message?: string } | null, sentence: string, taken?: string) {
  if (isDbUnreachable(error)) return dbUnavailableResponse();
  if (error?.code === "PGRST205" || error?.code === "42P01") return say(STUDIO_NOT_READY, 503);
  const cap = error?.code === "23514" ? CAPS[error.message ?? ""] : undefined;
  if (cap) return say(cap, 409);
  if (error?.code === "23505" && taken) return say(taken, 409);
  return say(sentence, 500);
}

type TextField = keyof typeof STUDIO_TEXT;
const REQUIRED: Partial<Record<TextField, string>> = { name: NAME_NEEDED, prompt: PROMPT_NEEDED };
/** http(s) only, as SQL 53's CHECK, and an address that parses: the server never guesses (the UI adds https://). */
const webLink = (s: string) => /^https?:\/\//.test(s) && URL.canParse(s);

/**
 * The text fields of a body as SQL 53 keeps them: trimmed, within STUDIO_TEXT, a name and a master prompt never blank,
 * a link http(s). On a create every field is read (an absent optional one is null, a style's words ""); on a PATCH an
 * absent field stays as it is and null clears an optional one. A sentence for the first field that is not.
 */
export function readText(body: Body, fields: readonly TextField[], create: boolean): { values: Partial<Record<TextField, string | null>> } | { error: string } {
  const values: Partial<Record<TextField, string | null>> = {};
  for (const f of fields) {
    const raw = body[f];
    if (raw === undefined && !create) continue;
    if (raw != null && typeof raw !== "string") return { error: "Bad request" };
    // A scheme in any case is the same scheme ("HTTPS://", a phone's "Https://"); SQL 53's CHECK takes it lower-cased.
    const v = f === "link" ? (raw ?? "").trim().replace(/^https?:/i, (s) => s.toLowerCase()) : (raw ?? "").trim();
    if (!v && REQUIRED[f]) return { error: REQUIRED[f] };
    if (v.length > STUDIO_TEXT[f]) return { error: TOO_LONG[f] };
    if (f === "link" && v && !webLink(v)) return { error: BAD_LINK };
    values[f] = v || (f === "words" ? "" : null);
  }
  return { values };
}

/** A palette as SQL 53 keeps it: up to MAX_PALETTE colours, each "#rrggbb", lower-cased here; none for null. Null when
 *  it is not one. */
export function readPalette(v: unknown): string[] | null {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_PALETTE) return null;
  const colours = v.map((c) => (typeof c === "string" ? c.trim().toLowerCase() : ""));
  return colours.every((c) => /^#[0-9a-f]{6}$/.test(c)) ? colours : null;
}

/**
 * A content piece's style and master prompt: this project's, or none. SQL 53's keys on them are plain (a composite
 * key could not SET NULL one column before Postgres 15), so the route checks. On a PATCH an absent one stays.
 */
export async function brandOf(supabase: Supabase, me: string, project: string, body: Body, create: boolean) {
  const out: { style_id?: string | null; master_prompt_id?: string | null } = {};
  for (const [key, column, table] of [["styleId", "style_id", "studio_styles"], ["masterPromptId", "master_prompt_id", "studio_master_prompts"]] as const) {
    const v = body[key];
    if (v === undefined && !create) continue;
    if (v == null) {
      out[column] = null;
      continue;
    }
    if (!isUuid(v)) return say(NOT_IN_PROJECT, 400);
    const { data, error } = await supabase.from(table).select("id").eq("id", v).eq("project_id", project).eq("user_id", me).maybeSingle();
    if (error) return studioFailure(error, NOT_SAVED);
    if (!data) return say(NOT_IN_PROJECT, 400);
    out[column] = v;
  }
  return out;
}

/* ── Rows as the API answers them. ── */

export const toProject = (r: Row<StudioProjectRow>): Project =>
  ({ id: r.id, name: r.name, description: r.description, link: r.link, createdAt: r.created_at, updatedAt: r.updated_at });
export const toStyle = (r: Row<StudioStyleRow>): Style =>
  ({ id: r.id, projectId: r.project_id, name: r.name, words: r.words, palette: r.palette, createdAt: r.created_at, updatedAt: r.updated_at });
export const toMasterPrompt = (r: Row<StudioMasterPromptRow>): MasterPrompt =>
  ({ id: r.id, projectId: r.project_id, name: r.name, prompt: r.prompt, createdAt: r.created_at, updatedAt: r.updated_at });
export const toContent = (r: Row<StudioContentRow>) => ({
  id: r.id, projectId: r.project_id, name: r.name, description: r.description, link: r.link, styleId: r.style_id,
  masterPromptId: r.master_prompt_id, createdAt: r.created_at, updatedAt: r.updated_at,
});
export const pathsOf = (r: { path: string; thumb_path: string | null }) => (r.thumb_path ? [r.path, r.thumb_path] : [r.path]);

/** Asset rows signed in one call (lib/reference-library signed: an hour, the tile or the picture where it has none); a
 *  row whose file is gone is left out. Null when the store cannot sign. */
export async function signAssets(supabase: Supabase, rows: Row<StudioAssetRow>[]): Promise<Asset[] | null> {
  const done = await signed(supabase, rows);
  if (!done) return null;
  const by = new Map(rows.map((r) => [r.id, r]));
  return done.map(({ id, url, thumb, hash }) => ({ id, projectId: by.get(id)!.project_id, url, thumb, hash, createdAt: by.get(id)!.created_at }));
}

type Render = { id: string; prompt_id: string | null; storage_url: string | null; preview_url: string | null; thumbnail_url: string | null };
/** A render as a picture: its detail rendition to send, its thumbnail to show (as app/api/prompts/[id]/images). */
export function pictureOf(r: Render | undefined): StudioPicture | null {
  const url = r?.preview_url ?? r?.storage_url;
  return url ? { url, thumb: r!.thumbnail_url ?? url } : null;
}

/** The caller's renders among `ids` still in their gallery, by id (a deleted one is left out). 100 ids a read: a piece
 *  can name 200, more than one address should carry. */
export async function liveRenders(supabase: Supabase, me: string, ids: string[]): Promise<Map<string, Render> | Response> {
  const unique = [...new Set(ids)];
  const parts = Array.from({ length: Math.ceil(unique.length / 100) }, (_, i) => unique.slice(i * 100, (i + 1) * 100));
  const reads = await Promise.all(parts.map((part) => supabase.from("generated_images")
    .select("id, prompt_id, storage_url, preview_url, thumbnail_url").in("id", part).eq("user_id", me).is("deleted_at", null)));
  const failed = reads.find((r) => r.error);
  if (failed) return studioFailure(failed.error, NOT_READ);
  return new Map(reads.flatMap((r) => r.data as Render[]).map((r) => [r.id, r]));
}

/** Characters with their pictures: a render's (null once it left the gallery) or an asset's, signed. `assets` are the
 *  project's when the caller has them signed already. */
export async function charactersOf(supabase: Supabase, me: string, rows: Row<StudioCharacterRow>[], assets?: Asset[]): Promise<Character[] | Response> {
  const assetIds = rows.flatMap((r) => (r.asset_id ? [r.asset_id] : []));
  let pictures = assets;
  if (!pictures) {
    const read = assetIds.length ? await supabase.from("studio_assets").select(COLS.asset).in("id", assetIds).eq("user_id", me) : { data: [], error: null };
    if (read.error) return studioFailure(read.error, NOT_READ);
    pictures = (await signAssets(supabase, read.data)) ?? [];
  }
  const renders = await liveRenders(supabase, me, rows.flatMap((r) => (r.image_id ? [r.image_id] : [])));
  if (renders instanceof Response) return renders;
  const byAsset = new Map(pictures.map((a) => [a.id, { url: a.url, thumb: a.thumb }]));
  return rows.map((r) => ({
    id: r.id, projectId: r.project_id, name: r.name,
    picture: r.image_id ? pictureOf(renders.get(r.image_id)) : byAsset.get(r.asset_id!) ?? null,
    source: r.image_id ? "render" : "asset", imageId: r.image_id, assetId: r.asset_id, sheetPromptId: r.sheet_prompt_id, createdAt: r.created_at,
  }));
}

/** Content pieces with how many renders each holds and its 4 newest renders' thumbnails (deleted renders left out). */
export async function contentsOf(supabase: Supabase, me: string, rows: Row<StudioContentRow>[]): Promise<Content[] | Response> {
  if (!rows.length) return [];
  const links = await supabase.from("studio_content_images").select("content_id, image_id")
    .in("content_id", rows.map((r) => r.id)).eq("user_id", me).order("added_at", { ascending: false });
  if (links.error) return studioFailure(links.error, NOT_READ);
  const renders = await liveRenders(supabase, me, links.data.map((l) => l.image_id));
  if (renders instanceof Response) return renders;
  return rows.map((r) => {
    const live = links.data.filter((l) => l.content_id === r.id).flatMap((l) => pictureOf(renders.get(l.image_id)) ?? []);
    return { ...toContent(r), count: live.length, cover: live.slice(0, 4).map((p) => p.thumb) };
  });
}
