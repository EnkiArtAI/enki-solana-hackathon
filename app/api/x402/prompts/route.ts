/**
 * GET /api/x402/prompts?q=…&creator=…&sort=trending|newest|top|best_selling&limit=1..20
 *
 * The artist prompts an AGENT can buy renders of (Kev, 2026-08-24: "i want
 * agents to purchase artists prompts"), found the way a person finds them:
 * by words (the search RPC /api/search uses), by artist, in four orders.
 * Public like every x402 route (proxy.ts) and free: it only reads. The
 * enki-render plugin's enki_find_prompts calls it and keeps exactly the
 * fields answered here (its src/plugin.ts toPrompt).
 *
 * What a visitor may not see, an agent does not either: only live prompts
 * (isListed, in SQL), never 18+ (an agent cannot confirm an age), never a
 * banned or deleted creator's (hiddenOwners). The agent buys renders, never
 * text: no encrypted_* column, no public excerpt and no description is even
 * selected, for a free prompt neither.
 *
 * Each variable is listed under the key /api/x402/generate takes for it in
 * variableValues: its stored name, never its label (agent-prompt-inputs), so
 * an agent sends back exactly what it was given.
 */
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { isSearchNotMigrated, searchNotMigratedResponse, searchQuery } from "@/lib/search/db";
import { isPublicText } from "@/lib/prompt-visibility";
import { hiddenOwners } from "@/lib/hidden-owners";
import { offeredModels } from "@/lib/offered-models";
import { toModelFamily } from "@/lib/generation/model-family";
import { renditionsByUrl, withRenditions } from "@/lib/marketplace/renditions";
import { videoColumns } from "@/lib/marketplace/video-columns";

const SORTS = ["trending", "newest", "top", "best_selling"] as const;
type Sort = (typeof SORTS)[number];

const querySchema = z.object({
  q: z.string().trim().max(200).optional(),
  creator: z.string().trim().max(100).optional(),
  sort: z.enum(SORTS).default("trending"),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

/*
 * The orders, from columns the prompts row keeps (like_count by trigger, SQL 29):
 *   newest        released last (published_at, else created_at)
 *   top           most liked
 *   trending      likes per age with Hacker News gravity, likes / (hours + 2)^1.5:
 *                 a new prompt's few likes outweigh an old one's many
 *   best_selling  most paid renders (a generations row with an intent or an
 *                 amount, record.ts isPaid), then most liked
 * The database picks POOL candidates by the order's own column (the latest
 * for newest and trending, the most liked for top and best_selling); the
 * ranking within runs here. Measured 2026-10-17: 6 live prompts and 61 renders
 * with a prompt, so the pool is the whole catalogue and counting reads 61 rows.
 * Past POOL live prompts, trending ranks only the latest POOL and best_selling
 * the most liked POOL; past RENDERS_READ renders on a pool the counts stop
 * short. Either is the point for a counting RPC.
 */
const POOL = 100;
const RENDERS_READ = 20_000;
const BY_LIKES = new Set<Sort>(["top", "best_selling"]);
/** Enough rows of search_creators to hold every exact match: it ranks them first (similarity 1). */
const CREATOR_MATCHES = 10;

/** No text column: see the top of this file. */
const PROMPT_SELECT =
  "id, title, price_usd_cents, prompt_type, is_free_showcase, like_count, published_at, created_at, creator_id, showcase_images, ai_model, ai_settings";

type PromptRow = {
  id: string;
  title: string | null;
  price_usd_cents: number | null;
  prompt_type: string | null;
  is_free_showcase: boolean | null;
  like_count: number | null;
  published_at: string | null;
  created_at: string | null;
  creator_id: string | null;
  showcase_images: unknown;
  ai_model: string | null;
  ai_settings: unknown;
};
type VariableRow = { prompt_id: string; name: string; label: string | null; data_type: string | null; options: unknown; is_required: boolean | null };
type Variable = { name: string; label: string; type: string; options?: string[]; required: boolean };
type Counts = Map<string, { renders: number; paid: number }>;

export async function GET(req: NextRequest) {
  // 60 searches per minute per address, the x402 route's rate, in a bucket of its own.
  const rate = checkRequestRateLimit(rateLimitKey(req, "x402:prompts"), 60, 60_000);
  if (!rate.allowed) return rateLimitResponse(rate.retryAfterSeconds);

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json({ error: `${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid"}` }, { status: 400 });
  }
  const { creator, sort, limit } = parsed.data;

  try {
    const prompts = await find(getSupabaseServerClient(), { q: searchQuery(parsed.data.q ?? null), creator, sort, limit }, req.nextUrl.origin);
    return NextResponse.json({ prompts });
  } catch (error) {
    if (isDbUnreachable(error)) return dbUnavailableResponse();
    if (isSearchNotMigrated(error)) return searchNotMigratedResponse(error);
    console.error("/api/x402/prompts failed:", error);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}

async function find(supabase: SupabaseClient, { q, creator, sort, limit }: { q: string; creator?: string; sort: Sort; limit: number }, origin: string) {
  const owners = creator ? await creatorIds(supabase, creator) : null;
  if (owners?.length === 0) return [];

  let matches: string[] | null = null;
  if (q) {
    const { data, error } = await supabase.rpc("search_prompts", { q, lim: POOL, off: 0, show_adult: false, models: null });
    if (error) throw error;
    matches = ((data ?? []) as { id: string }[]).map((r) => String(r.id));
    if (matches.length === 0) return [];
  }

  // isListed, in SQL, and never 18+: the same rows whether the search found them or not.
  let query = supabase.from("prompts").select(PROMPT_SELECT)
    .eq("is_listed", true).eq("listing_status", "active").is("deleted_at", null)
    .eq("is_adult", false);
  if (matches) query = query.in("id", matches);
  if (owners) query = query.in("creator_id", owners);
  // An agent buys images: /api/x402/generate makes no video, so a video prompt is not on offer here. Before SQL 52 there is none.
  if (await videoColumns(supabase)) query = query.neq("media_type", "video");
  if (BY_LIKES.has(sort)) query = query.order("like_count", { ascending: false });
  const { data, error } = await query.order("published_at", { ascending: false, nullsFirst: false }).limit(POOL);
  if (error) throw error;
  const pool = (data ?? []) as PromptRow[];

  // A banned or deleted creator's prompts are not sold (generation-quote), so not offered.
  const hidden = await hiddenOwners(supabase, pool.map((p) => String(p.creator_id ?? "")));
  if (!hidden) throw new Error("creators could not be read");
  const visible = pool.filter((p) => !hidden.has(String(p.creator_id)));

  // best_selling ranks by the counts, so it counts the pool; the other orders count the page.
  const poolCounts = sort === "best_selling" ? await renderCounts(supabase, visible.map((p) => String(p.id))) : null;
  const page = visible.sort(order(sort, poolCounts)).slice(0, limit);
  const ids = page.map((p) => String(p.id));
  const [variables, creators, renditions, counts] = await Promise.all([
    variablesOf(supabase, ids),
    creatorsOf(supabase, page),
    renditionsByUrl(supabase, page.flatMap((p) => firstImage(p) ?? [])),
    poolCounts ?? renderCounts(supabase, ids),
  ]);

  return page.map((p) => {
    const id = String(p.id);
    const by = creators.get(String(p.creator_id));
    const first = firstImage(p);
    const [image] = withRenditions(first ? [{ url: first }] : [], renditions);
    const n = counts?.get(id);
    const models = offeredModels(p.ai_settings);
    return {
      promptId: id,
      title: String(p.title ?? ""),
      ...(by ? { creator: by } : {}),
      // The artist's price per image as computeQuote takes it: price_usd_cents
      // (integer cents), and nothing for a prompt whose text is public.
      priceUsdc: isPublicText(p) ? "0.00" : (Math.max(0, Math.round(Number(p.price_usd_cents) || 0)) / 100).toFixed(2),
      likes: likes(p),
      // Left out when generations could not be read: no number rather than a wrong one.
      ...(n ? { renders: n.renders, paidRenders: n.paid } : {}),
      ...(image ? { thumbnailUrl: image.thumb ?? image.preview ?? image.url } : {}),
      // The link the Share button hands out (ComposerHeader): it unfurls with the
      // showcase and opens the prompt over the feed (GeneratorClient → promptPage).
      pageUrl: new URL(`/generator/${encodeURIComponent(id)}`, origin).href,
      // The generators the artist offers, the primary first; a prompt saved before that list, the one it was made with.
      // As modelFamily keys ("nano-banana-pro"), which an agent passes straight back to /api/x402/generate.
      models: [...new Set((models.length ? models : p.ai_model ? [p.ai_model] : []).map(toModelFamily))],
      variables: variables.get(id) ?? [],
    };
  });
}

/**
 * The artists a handle or a display name stands for, exactly (case and a
 * leading @ aside); an unknown one lists nothing. search_creators knows only
 * active, unbanned artists with a live prompt below 18+, like this list.
 */
async function creatorIds(supabase: SupabaseClient, creator: string): Promise<string[]> {
  const wanted = creator.replace(/^@/, "").toLowerCase();
  if (!wanted) return [];
  const { data, error } = await supabase.rpc("search_creators", { q: wanted, lim: CREATOR_MATCHES, show_adult: false });
  if (error) throw error;
  return ((data ?? []) as { id: string; handle: string | null; display_name: string | null }[])
    .filter((u) => u.handle?.toLowerCase() === wanted || u.display_name?.toLowerCase() === wanted)
    .map((u) => String(u.id));
}

const at = (p: PromptRow) => Date.parse(p.published_at ?? p.created_at ?? "") || 0;
const likes = (p: PromptRow) => Math.max(0, Number(p.like_count) || 0);
const newest = (a: PromptRow, b: PromptRow) => at(b) - at(a);
const mostLiked = (a: PromptRow, b: PromptRow) => likes(b) - likes(a) || newest(a, b);

function order(sort: Sort, counts: Counts | null): (a: PromptRow, b: PromptRow) => number {
  switch (sort) {
    case "newest":
      return newest;
    case "top":
      return mostLiked;
    case "trending": {
      const now = Date.now();
      const heat = (p: PromptRow) => likes(p) / Math.pow(Math.max(0, now - at(p)) / 3_600_000 + 2, 1.5);
      return (a, b) => heat(b) - heat(a) || newest(a, b);
    }
    case "best_selling": {
      // Without counts every prompt counts 0: the order is top's.
      const paid = (p: PromptRow) => counts?.get(String(p.id))?.paid ?? 0;
      return (a, b) => paid(b) - paid(a) || mostLiked(a, b);
    }
  }
}

/** Renders and paid renders per prompt; null when generations could not be read. */
async function renderCounts(supabase: SupabaseClient, ids: string[]): Promise<Counts | null> {
  const counts: Counts = new Map(ids.map((id) => [id, { renders: 0, paid: 0 }]));
  if (ids.length === 0) return counts;
  const { data, error } = await supabase
    .from("generations")
    .select("prompt_id, amount_paid_cents, payment_intent_id")
    .in("prompt_id", ids)
    .is("deleted_at", null)
    .limit(RENDERS_READ);
  if (error) return null;
  for (const g of (data ?? []) as { prompt_id: string; amount_paid_cents: number | null; payment_intent_id: string | null }[]) {
    const c = counts.get(String(g.prompt_id));
    if (!c) continue;
    c.renders += 1;
    if (g.payment_intent_id != null || g.amount_paid_cents != null) c.paid += 1;
  }
  return counts;
}

/**
 * Each prompt's variables as /api/x402/generate takes them (agent-prompt-inputs):
 * the stored name; for a choice its options' promptValue, which fit() compares;
 * for a checkbox "true" or "false". A var_<position> variable is left out:
 * no key reaches it and the route refuses it.
 */
async function variablesOf(supabase: SupabaseClient, ids: string[]): Promise<Map<string, Variable[]>> {
  const out = new Map<string, Variable[]>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("prompt_variables")
    .select("prompt_id, name, label, data_type, options, is_required, position")
    .in("prompt_id", ids)
    .is("deleted_at", null)
    .order("position", { ascending: true });
  // Without its variables an agent cannot fill a prompt: an error, never an empty list.
  if (error) throw error;
  for (const v of (data ?? []) as VariableRow[]) {
    if (/^var_\d+$/.test(v.name)) continue;
    const type = v.data_type ?? "text";
    const options = type === "checkbox" ? ["true", "false"] : choices(v.options);
    const list = out.get(String(v.prompt_id)) ?? [];
    list.push({ name: v.name, label: v.label || v.name, type, ...(options.length ? { options } : {}), required: v.is_required === true });
    out.set(String(v.prompt_id), list);
  }
  return out;
}

/** The values a select takes: each option's promptValue, or the option itself (agent-prompt-inputs optionValues). */
const choices = (options: unknown): string[] =>
  Array.isArray(options)
    ? options.map((o) => (typeof o === "string" ? o : (o as { promptValue?: unknown })?.promptValue)).filter((v): v is string => typeof v === "string")
    : [];

async function creatorsOf(supabase: SupabaseClient, page: PromptRow[]): Promise<Map<string, { name: string; handle: string }>> {
  const ids = [...new Set(page.map((p) => String(p.creator_id ?? "")).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from("users").select("id, handle, display_name").in("id", ids);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; handle: string; display_name: string | null }[])
    .map((u) => [String(u.id), { name: u.display_name || u.handle, handle: u.handle }]));
}

/** The cover: the first showcase image (jsonb URL strings). */
const firstImage = (p: PromptRow): string | null =>
  Array.isArray(p.showcase_images) && typeof p.showcase_images[0] === "string" && p.showcase_images[0] ? p.showcase_images[0] : null;
