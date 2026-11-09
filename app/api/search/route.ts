/**
 * GET /api/search?q=…&type=prompts|creators|all&limit=20&cursor=<offset>
 *
 * Zero cost search (Kev, 2026-09-24): Postgres full text + trigram through
 * the RPCs in migrations/2026-09-24-search.sql, no model, no paid API. The
 * ranked prompt ids are loaded as the SAME card the marketplace feed serves
 * (lib/marketplace/card.ts), so a search result drops straight into the
 * wall. Behind the same team gate as /api/marketplace/prompts (proxy.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { mapPromptRow, enrichPromptCards, promptCardColumns, type PromptCardRow } from "@/lib/marketplace/card";
import { videoColumns, videosNeedSql } from "@/lib/marketplace/video-columns";
import { MAX_OFFSET, isSearchNotMigrated, searchNotMigratedResponse, searchQuery } from "@/lib/search/db";
import { SHOW_ADULT_HEADER, viewer } from "@/lib/adult-content";
import { resolveSessionUserId } from "@/lib/session-user";
import { ignoredIds, withoutIgnored } from "@/lib/ignores";
import { communityIdOf } from "@/lib/communities/server";

const TYPES = new Set(["prompts", "creators", "all"]);
const MAX_LIMIT = 40;
const CREATORS_IN_ALL = 8;

type Creator = { id: string; handle: string; display_name: string | null; avatar_url: string | null };

export async function GET(req: NextRequest) {
  // 60 searches per minute per IP.
  const rate = checkRequestRateLimit(rateLimitKey(req, "search"), 60, 60 * 1000);
  if (!rate.allowed) return rateLimitResponse(rate.retryAfterSeconds);

  const { searchParams } = new URL(req.url);
  const q = searchQuery(searchParams.get("q"));
  const type = searchParams.get("type") ?? "all";
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10) || 20));
  const offset = Math.min(MAX_OFFSET, Math.max(0, parseInt(searchParams.get("cursor") ?? "0", 10) || 0));
  // The generator filter, as the feed sends it (every alias of each pick).
  const models = searchParams.getAll("models").filter(Boolean).slice(0, 50);

  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });
  if (!TYPES.has(type)) return NextResponse.json({ error: "type must be prompts, creators or all" }, { status: 400 });

  try {
    const supabase = getSupabaseServerClient();
    // Explore's row, as on the feed: before SQL 52 every prompt is an image, and Videos has nothing and says which file to run.
    const media = searchParams.get("media");
    const hasVideo = await videoColumns(supabase);
    if (media === "videos" && !hasVideo) return videosNeedSql({ query: q, creators: [] });
    // 18+ only for a confirmed adult with the pill on, like the feed; the
    // session is looked up only when the pill asks.
    const showAdult = req.headers.get(SHOW_ADULT_HEADER) === "1" && (await viewer(supabase, req)).showAdult;
    let prompts: Awaited<ReturnType<typeof enrichPromptCards>> = [];
    let creators: { id: string; handle: string; displayName: string; avatarUrl: string | null }[] = [];
    let hasMore = false;

    if (type !== "creators") {
      // One row past the page tells us whether a next page exists.
      const { data: ranked, error } = await supabase.rpc("search_prompts", { q, lim: limit + 1, off: offset, show_adult: showAdult, models: models.length ? models : null });
      if (error) throw error;
      let page = ((ranked ?? []) as { id: string; rank: number }[]).slice(0, limit);
      hasMore = (ranked?.length ?? 0) > limit;
      // ?community=<handle> keeps the ranked prompts linked to that community (SQL 54), page by page after the
      // ranking, as whom the viewer ignores below: a page may come out short, the cursor still moves on. An unknown
      // handle, or SQL 54 not run yet, finds nothing.
      const community = searchParams.get("community");
      if (community && page.length > 0) {
        const id = await communityIdOf(supabase, community);
        const linked = id
          ? await supabase.from("community_links").select("prompt_id").eq("community_id", id).eq("state", "shown").in("prompt_id", page.map((r) => r.id))
          : { data: [], error: null };
        if (linked.error) throw linked.error;
        const kept = new Set((linked.data as { prompt_id: string }[]).map((l) => l.prompt_id));
        page = page.filter((r) => kept.has(r.id));
        if (!id) hasMore = false;
      }

      if (page.length > 0) {
        // Whom the viewer ignores leaves the results, as in the feed, unless the Show ignored pill asks (?ignored=1);
        // a session that cannot be read is a guest, as for 18+ (lib/adult-content.ts viewer).
        const ignored = searchParams.get("ignored") === "1" ? []
          : await ignoredIds(supabase, await resolveSessionUserId(supabase, req.headers.get("X-Session-Token")).catch(() => null));
        // The ranked prompts of that medium, after the ranking, as with the community above: a page may come out short.
        const read = supabase.from("prompts").select(promptCardColumns(hasVideo)).in("id", page.map((r) => r.id));
        const { data: rows, error: rowsError } = await withoutIgnored(hasVideo && (media === "images" || media === "videos")
          ? read.eq("media_type", media === "videos" ? "video" : "image") : read, "creator_id", ignored);
        if (rowsError) throw rowsError;
        // .in() loses the rank order; restore it.
        const byId = new Map(((rows ?? []) as PromptCardRow[]).map((r) => [r.id, mapPromptRow(r)]));
        const listings = page.map((r) => byId.get(r.id)).filter((p) => p !== undefined);
        prompts = await enrichPromptCards(supabase, listings);
      }
    }

    if (type !== "prompts") {
      const lim = type === "all" ? CREATORS_IN_ALL : limit;
      const { data, error } = await supabase.rpc("search_creators", { q, lim, show_adult: showAdult });
      if (error) throw error;
      creators = ((data ?? []) as Creator[]).map((u) => ({
        id: u.id,
        handle: u.handle,
        displayName: u.display_name || u.handle,
        avatarUrl: u.avatar_url,
      }));
    }

    return NextResponse.json({
      query: q,
      prompts,
      creators,
      hasMore,
      nextCursor: hasMore ? String(offset + limit) : undefined,
    });
  } catch (error) {
    if (isDbUnreachable(error)) return dbUnavailableResponse();
    if (isSearchNotMigrated(error)) return searchNotMigratedResponse(error);
    console.error("/api/search failed:", error);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
