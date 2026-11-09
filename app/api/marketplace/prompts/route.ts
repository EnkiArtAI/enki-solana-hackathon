import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
/**
 * GET /api/marketplace/prompts
 * Advanced marketplace search and filtering with full-text search
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { PROMPT_NUMBERS_SELECT, mapPromptRow, enrichPromptCards, promptCardColumns, promptStats, readAllRows, usesByPrompt, type PromptCardRow, type PromptListing, type PromptStats } from "@/lib/marketplace/card";
import { videoColumns, videosNeedSql } from "@/lib/marketplace/video-columns";
import { ENKI_CATEGORIES } from "@/lib/categories";
import { hideAdult, viewer } from "@/lib/adult-content";
import { ignoredIds, withoutIgnored } from "@/lib/ignores";
import { communityIdOf } from "@/lib/communities/server";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { z } from "zod";

const marketplaceFiltersSchema = z.object({
  // Full-text search
  query: z.string().optional(),                    // Search terms

  // Categorical filters
  category: z.string().optional(),                // Single category
  categories: z.array(z.string()).optional(),     // Multiple categories
  licenseType: z.array(z.string()).optional(),    // Multiple license types
  tags: z.array(z.string()).optional(),           // Tag filtering

  // Price filters
  priceFilter: z.enum(['all', 'free', 'paid']).optional(), // Filter by price type
  minPrice: z.number().int().min(0).optional(),   // Minimum price in cents
  maxPrice: z.number().int().min(0).optional(),   // Maximum price in cents

  // Quality filters
  minRating: z.number().min(0).max(5).optional(), // Minimum rating
  minSales: z.number().int().min(0).optional(),   // Minimum sales count

  // Sorting options
  sortBy: z.enum([
    'relevance', 'newest', 'price_low', 'price_high',
    'popular', 'rating', 'trending', 'performance'
  ]).default('relevance'),

  sortOrder: z.enum(['asc', 'desc']).optional(),

  // Pagination
  limit: z.number().int().min(1).max(50).default(12),
  cursor: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Parse query parameters into filter object
    const filters = {
      query: searchParams.get('query') || undefined,
      category: searchParams.get('category') || undefined,
      categories: searchParams.getAll('categories').length > 0 ? searchParams.getAll('categories') : undefined,
      licenseType: searchParams.getAll('licenseType').length > 0 ? searchParams.getAll('licenseType') : undefined,
      tags: searchParams.getAll('tags').length > 0 ? searchParams.getAll('tags') : undefined,
      priceFilter: (searchParams.get('priceFilter') as 'all' | 'free' | 'paid' | null) || undefined,
      minPrice: searchParams.get('minPrice') ? parseInt(searchParams.get('minPrice')!) : undefined,
      maxPrice: searchParams.get('maxPrice') ? parseInt(searchParams.get('maxPrice')!) : undefined,
      minRating: searchParams.get('minRating') ? parseFloat(searchParams.get('minRating')!) : undefined,
      minSales: searchParams.get('minSales') ? parseInt(searchParams.get('minSales')!) : undefined,
      sortBy: (searchParams.get('sortBy') as any) || 'relevance',
      sortOrder: (searchParams.get('sortOrder') as any) || undefined,
      limit: parseInt(searchParams.get('limit') || '12'),
      cursor: searchParams.get('cursor') || undefined,
    };

    const validation = marketplaceFiltersSchema.safeParse(filters);
    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid query parameters",
          details: validation.error.issues
        },
        { status: 400 }
      );
    }

    const {
      query, category, categories, licenseType, tags,
      priceFilter, minPrice, maxPrice, minRating, minSales,
      sortOrder, limit, cursor
    } = validation.data;
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
    // Performance reads a whole shelf, so only one creator's: anywhere else it answers as newest.
    const sortBy = validation.data.sortBy === "performance" && !searchParams.get("creator") ? "newest" : validation.data.sortBy;
    const wantStats = !!searchParams.get("creator") && searchParams.get("stats") === "1";
    // These read all of a creator's renders, and performance the whole shelf: 60 a minute per IP, as /api/search.
    if (sortBy === "performance" || wantStats) {
      const rate = checkRequestRateLimit(rateLimitKey(request, "shelf"), 60, 60 * 1000);
      if (!rate.allowed) return rateLimitResponse(rate.retryAfterSeconds);
    }

    // Build MongoDB query
    const mongoQuery: any = {
      isListed: true,
      listingStatus: 'active'
    };

    // Add text search if query provided
    if (query && query.trim()) {
      mongoQuery.$text = { $search: query.trim() };
    }

    // Add category filter
    if (category) {
      mongoQuery.category = category;
    } else if (categories && categories.length > 0) {
      mongoQuery.category = { $in: categories };
    }

    // Add license type filter
    if (licenseType && licenseType.length > 0) {
      mongoQuery.licenseType = { $in: licenseType };
    }

    // Add tags filter
    if (tags && tags.length > 0) {
      mongoQuery.tags = { $in: tags };
    }

    // Add price range filter
    // Support free prompt filtering via priceFilter query param
    if (priceFilter === 'free') {
      // Filter for free prompts only (priceUsdCents === 0)
      mongoQuery.priceUsdCents = 0;
    } else if (priceFilter === 'paid') {
      // Filter for paid prompts only (priceUsdCents > 0)
      mongoQuery.priceUsdCents = { $gt: 0 };
    } else if (minPrice !== undefined || maxPrice !== undefined) {
      // Use explicit price range if provided
      mongoQuery.priceUsdCents = {};
      if (minPrice !== undefined) mongoQuery.priceUsdCents.$gte = minPrice;
      if (maxPrice !== undefined) mongoQuery.priceUsdCents.$lte = maxPrice;
    }

    // Add rating filter
    if (minRating !== undefined) {
      mongoQuery.avgRating = { $gte: minRating };
    }

    // Add sales filter
    if (minSales !== undefined) {
      mongoQuery.totalSales = { $gte: minSales };
    }

    // Build sort specification
    let sortSpec: any = {};
    const sortDirection = sortOrder === 'asc' ? 1 : -1;

    switch (sortBy) {
      case 'relevance':
        // For text search, relevance is handled by MongoDB's text score
        if (query) {
          sortSpec = { score: { $meta: "textScore" } };
        } else {
          sortSpec = { listedAt: -1 }; // Fallback to newest
        }
        break;
      case 'newest':
        sortSpec = { listedAt: -1 };
        break;
      case 'price_low':
        sortSpec = { priceUsdCents: 1 };
        break;
      case 'price_high':
        sortSpec = { priceUsdCents: -1 };
        break;
      case 'popular':
        sortSpec = { totalSales: -1, listedAt: -1 };
        break;
      case 'rating':
        sortSpec = { avgRating: -1, ratingCount: -1 };
        break;
      case 'trending':
        // Combine recency and popularity
        sortSpec = { listedAt: -1, totalSales: -1 };
        break;
      default:
        sortSpec = { listedAt: -1 };
    }

    // Execute search query
    let prompts: PromptListing[] = [];
    let stats: Map<string, PromptStats> | null = null;
    try {
      const supabase = getSupabaseServerClient();

      /* ?media=images|videos is Explore's row, All sends none and mixes both. Before SQL 52 every prompt is an image, so
         Images needs no filter and Videos has nothing, and says which file to run. */
      const media = searchParams.get("media");
      const hasVideo = await videoColumns(supabase);
      if (media === "videos" && !hasVideo) return videosNeedSql({ total: 0 });

      /*
       * Live-schema boundary (probed 2026-08-12): the columns this query used
       * to filter, sort and read — price, downloads, rating, user_id,
       * uploaded_photos — do not exist (PostgREST 400 kills the whole select).
       * Live: price_usd_cents (integer cents — the same unit minPrice/maxPrice
       * are documented in), creator_id, showcase_images (jsonb URL strings).
       * The column list and the card shape live in lib/marketplace/card.ts,
       * shared with /api/search.
       */
      /* ?community=<handle> narrows to the prompts linked to one community
         (Kev, 2026-10-30: "i want at one point to filter for a community and
         then see all images and videos with it created"; SQL 54), through an
         inner embed, so no id list travels. An unknown handle, or SQL 54 not
         run yet, answers nothing, never the whole feed. Without it the query
         is the one it always was. */
      const community = searchParams.get("community");
      const communityId = community ? await communityIdOf(supabase, community) : null;
      const card = promptCardColumns(hasVideo);
      const columns = (sortBy === "performance" || wantStats ? `${card},${PROMPT_NUMBERS_SELECT}` : card) as typeof card;
      let dbQuery = community
        ? supabase.from("prompts").select(`${columns},community_links!inner(community_id)` as typeof card)
        : supabase.from("prompts").select(columns);
      if (hasVideo && media === "images") dbQuery = dbQuery.eq("media_type", "image");
      if (hasVideo && media === "videos") dbQuery = dbQuery.eq("media_type", "video");
      if (community) {
        dbQuery = communityId
          ? dbQuery.eq("community_links.community_id", communityId).eq("community_links.state", "shown")
          : dbQuery.in("id", ["00000000-0000-0000-0000-000000000000"]);
      }

      // Released prompts only. Without this a draft was on the marketplace the
      // moment it was saved — see app/api/prompts/route.ts for the same fix.
      dbQuery = dbQuery.eq("is_listed", true).eq("listing_status", "active").is("deleted_at", null);

      /* ?models=<alias>&models=… narrows to prompts made with the picked
         generators (Kev, 2026-08-24: filter the wall by launcher). The
         client sends every alias per generator (id, name, family slug)
         because prompts.ai_model historically stores names AND slugs mixed
         — "Flux (free)" next to "nano-banana-pro". */
      const modelAliases = searchParams.getAll("models").filter(Boolean);
      if (modelAliases.length > 0) {
        dbQuery = dbQuery.in("ai_model", modelAliases);
      }

      /* ?ids=<uuid>&ids=… answers exactly these prompts, as feed cards: the
         Likes tab and a bookmark category show them like Home (Kev,
         2026-10-13). The caller keeps its own order; the listing, 18+ and
         hidden-creator rules above and below still apply. Only uuids go to
         the database, and a list without one answers nothing. */
      const askedIds = searchParams.getAll("ids");
      if (askedIds.length > 0) {
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const ids = [...new Set(askedIds.filter((id) => UUID.test(id)))].slice(0, limit);
        dbQuery = dbQuery.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
      }

      /* ?creator=<handle|uuid> narrows to one artist's shelf — the foreign
         profile page (Kev, 2026-08-24: creators render like the own profile)
         reads its Released tab through the SAME query and mapping as the
         feed, so the two can never drift. Unknown handle → empty list. */
      const creator = searchParams.get("creator");
      let creatorId: string | null = null;
      if (creator) {
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        creatorId = creator;
        if (!UUID.test(creator)) {
          const { data: u, error: creatorError } = await supabase
            .from("users").select("id").eq("handle", creator).maybeSingle();
          if (creatorError) throw creatorError;
          creatorId = u?.id ?? "00000000-0000-0000-0000-000000000000";
        }
        dbQuery = dbQuery.eq("creator_id", creatorId);
      }
      // 18+ only for a confirmed adult with the pill on; an artist's own shelf
      // always shows it.
      const v = await viewer(supabase, request);
      dbQuery = hideAdult(dbQuery, v, creatorId);
      // Whom the viewer ignores leaves the feed (Kev, 2026-10-29), not an
      // artist's own shelf, not the Likes and bookmarks the viewer picked, and
      // not when the feed's Show ignored pill asks for them (?ignored=1).
      if (!creatorId && askedIds.length === 0 && searchParams.get("ignored") !== "1") {
        dbQuery = withoutIgnored(dbQuery, "creator_id", await ignoredIds(supabase, v.userId));
      }

      if (category) {
        // The chips send "marketing"; the column holds ENKI_CATEGORIES' label "Marketing".
        const label = category.toLowerCase();
        dbQuery = dbQuery.eq("category", ENKI_CATEGORIES.find((c) => c.toLowerCase() === label) ?? category);
      }

      if (tags && tags.length > 0) {
        dbQuery = dbQuery.overlaps("tags", tags);
      }

      if (priceFilter === "free") {
        dbQuery = dbQuery.eq("price_usd_cents", 0);
      } else if (priceFilter === "paid") {
        dbQuery = dbQuery.gt("price_usd_cents", 0);
      } else if (minPrice !== undefined || maxPrice !== undefined) {
        if (minPrice !== undefined) dbQuery = dbQuery.gte("price_usd_cents", minPrice);
        if (maxPrice !== undefined) dbQuery = dbQuery.lte("price_usd_cents", maxPrice);
      }

      if (query && query.trim()) {
        dbQuery = dbQuery.ilike("title", `%${query.trim()}%`);
      }

      // Sort
      switch (sortBy) {
        case "newest":
          dbQuery = dbQuery.order("created_at", { ascending: false });
          break;
        case "popular":
          // No sales/downloads column exists live; recency is the only
          // honest order until engagement lands on the prompts row.
          dbQuery = dbQuery.order("created_at", { ascending: false });
          break;
        case "price_low":
          dbQuery = dbQuery.order("price_usd_cents", { ascending: true });
          break;
        case "price_high":
          dbQuery = dbQuery.order("price_usd_cents", { ascending: false });
          break;
        case "trending":
        default:
          dbQuery = dbQuery.order("created_at", { ascending: false });
          break;
      }
      // A shelf pages to its end: equal dates must not swap between two pages.
      if (creatorId) dbQuery = dbQuery.order("id");

      // A failed count fails the sort, which would be a wrong order; a page's numbers only go null.
      const uses = !creatorId ? null
        : sortBy === "performance" ? await usesByPrompt(supabase, creatorId)
        : wantStats ? await usesByPrompt(supabase, creatorId).catch((e) => { console.error("Uses count failed:", e); return null; })
        : null;

      let dbPrompts: PromptCardRow[];
      if (sortBy === "performance" && uses) {
        // The whole shelf, newest first by the read above; the sort is stable, so equal numbers stay that way.
        const shelf = await readAllRows<PromptCardRow>((from, to) => dbQuery.range(from, to));
        dbPrompts = shelf.sort((a, b) => {
          const x = promptStats(a, uses), y = promptStats(b, uses);
          return y.uses - x.uses || y.likes - x.likes || y.views - x.views;
        }).slice(offset, offset + limit);
      } else {
        const { data, error: dbError } = await dbQuery.range(offset, offset + limit - 1);
        if (dbError) {
          console.error("Supabase query error:", dbError);
          throw dbError;
        }
        dbPrompts = data ?? [];
      }

      if (dbPrompts.length > 0) {
        prompts = dbPrompts.map(mapPromptRow);
      }
      if (uses) stats = new Map(dbPrompts.map((row) => [row.id, promptStats(row, uses)]));

    } catch (searchError) {
      // A dead host is an answer, not an empty feed.
      if (isDbUnreachable(searchError)) return dbUnavailableResponse();
      // A shelf that could not be read is not an empty shelf (the catch below says so).
      if (searchParams.get("creator")) throw searchError;
      console.error('Search query failed:', searchError);
    }

    // Enrich with creator data and variables (lib/marketplace/card.ts).
    const enriched = await enrichPromptCards(getSupabaseServerClient(), prompts);
    // Asked for by ?stats=1 only, and null when the count failed.
    const enrichedPrompts = wantStats ? enriched.map((card) => ({ ...card, stats: stats?.get(card.id) ?? null })) : enriched;

    // Pages on the rows read: a hidden creator's card dropped from a full
    // page must not end the feed.
    const hasMore = prompts.length === limit;
    const nextCursor = hasMore ? String(offset + limit) : undefined;

    // Build response
    return NextResponse.json({
      prompts: enrichedPrompts,
      total: enrichedPrompts.length,
      hasMore,
      nextCursor,
      filters: {
        applied: {
          query,
          category,
          categories,
          licenseType,
          tags,
          priceFilter,
          minPrice,
          maxPrice,
          minRating,
          minSales,
          sortBy,
          sortOrder,
        }
      },
      searchInfo: {
        query,
        totalResults: enrichedPrompts.length,
        hasSearchQuery: !!query,
        sortApplied: sortBy,
      }
    });

  } catch (error) {
    if (isDbUnreachable(error)) return dbUnavailableResponse();
    console.error('Error fetching marketplace prompts:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
