/**
 * Likes on a prompt (lib/likes.ts: one row each in reactions, the count on
 * prompts.like_count, kept by a trigger; SQL 29, 2026-10-15).
 *
 *   GET  → { count, mine }   mine = whether the session user likes it
 *   POST → { count, mine }   toggles the session user's like
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { UUID_RE } from "@/lib/dm";
import { likeCount, likedBy, setLike } from "@/lib/likes";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const supabase = getSupabaseServerClient();
  const target = { type: "prompt", id } as const;
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  const [count, mine] = await Promise.all([likeCount(supabase, target), userId ? likedBy(supabase, userId, target) : false]);
  if (count === null || mine === null) return NextResponse.json({ error: "Likes unavailable" }, { status: 503 });
  return NextResponse.json({ count, mine });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const limit = checkRequestRateLimit(rateLimitKey(req, "prompt-like"), 30, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const state = await setLike(supabase, userId, { type: "prompt", id }, null);
  if (!state) return NextResponse.json({ error: "Couldn't save the like" }, { status: 503 });
  return NextResponse.json(state);
}
