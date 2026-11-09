/**
 * GET /api/analytics/enki?period=week|month|all&sort=<column> → Enki as a whole, for the Analytics panel's Enki view
 * (Kev, 2026-10-29: "Enki-global analytics, wie users, posted images, generated images, generated revenue for artists,
 * views, halt genauso wie hier: https://hup.social/leaderboard").
 *
 *   totals  each figure in the period and in the last 24 hours, { value, day }. Views are prompts and images opened,
 *           by day (view_days).
 *   watched the ten prompts and ten images opened most in the period, with their maker.
 *   board   creators ranked by `sort` (revenue unless asked otherwise), at most 25, by public activity only. A
 *           creator without a handle comes back with handle null: there is no profile to open.
 *   period  the period these numbers are for, so the panel never shows one period's figures under another's labels.
 *
 * enki_stats (migrations/2026-10-29-view-days.sql, SQL 49) does every count in the database in one call and decides
 * what counts; before it ran, the call fails and the panel says so. Public like the Hall of Fame: numbers and handles
 * only. Revenue arrives in micro-USDC and leaves in cents.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { solanaChainKey } from "@/lib/payments/solana";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIGURES = ["users", "posts", "images", "revenue", "views", "prompts", "likes", "comments"] as const;
const SORTS = new Set(["revenue", "posts", "prompts", "views", "likes", "comments", "followers"]);
const cents = (micro: number) => Math.round(micro / 10_000);

type Stats = {
  totals?: Record<string, [number, number]>;
  board?: { rank: number; handle: string | null; prompts: number; posts: number; revenue: number; views: number; likes: number; comments: number; followers: number }[];
  watched?: { prompts?: { id: string; title: string | null; handle: string | null; n: number }[]; images?: { id: string; thumb: string | null; handle: string | null; n: number }[] };
};

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const asked = q.get("period");
  const period = asked === "week" || asked === "month" ? asked : "all";
  const days = period === "week" ? 7 : period === "month" ? 30 : null;
  const since = days === null ? null : new Date(Date.now() - days * DAY_MS).toISOString();
  const column = q.get("sort") ?? "";
  const sort = SORTS.has(column) ? column : "revenue";

  // Revenue in the money of the chain this deployment pays on (2026-10-29-artist-earnings.sql): devnet test USDC on a
  // devnet checkout, mainnet USDC in production.
  const { data, error } = await getSupabaseServerClient().rpc("enki_stats", { p_since: since, p_sort: sort, p_limit: 25, p_chain: solanaChainKey() });
  if (isDbUnreachable(error)) return dbUnavailableResponse();
  if (error) {
    console.error("[analytics/enki] enki_stats failed:", error.code || error.message);
    return NextResponse.json({ error: "Could not load Enki's numbers" }, { status: 500 });
  }

  const s = (data ?? {}) as Stats;
  const totals: Record<string, { value: number | null; day: number | null }> = {};
  for (const k of FIGURES) {
    const [value, day] = (s.totals?.[k] ?? [0, 0]).map(Number);
    totals[k] = k === "revenue" ? { value: cents(value), day: cents(day) } : { value, day };
  }
  const board = (s.board ?? []).map((r) => ({
    rank: Number(r.rank),
    handle: r.handle,
    prompts: Number(r.prompts), posts: Number(r.posts),
    revenueCents: cents(Number(r.revenue)),
    views: Number(r.views),
    likes: Number(r.likes), comments: Number(r.comments), followers: Number(r.followers),
  }));

  const watched = {
    prompts: (s.watched?.prompts ?? []).map((w) => ({ id: String(w.id), title: w.title ?? "Untitled", handle: w.handle ?? null, views: Number(w.n) })),
    images: (s.watched?.images ?? []).map((w) => ({ id: String(w.id), thumb: w.thumb ?? null, handle: w.handle ?? null, views: Number(w.n) })),
  };

  return NextResponse.json({ totals, board, sort, period, watched });
}
