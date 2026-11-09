/**
 * Likes on an image (Kev, 2026-10-15: the heart on the gallery's images),
 * the same rows as prompt likes with target_type "generated_image"
 * (lib/likes.ts; the count on generated_images.like_count, SQL 29).
 *
 *   GET  → { count, mine }
 *   POST { liked?: boolean } → { count, mine }   sets the like, or toggles it without a body
 *
 * Only an image the viewer may see takes a like: their own, or a published,
 * checked one of an account still shown, 18+ only for a viewer who opted in.
 * Anything else answers 404, so a like never confirms that an image exists.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { mayShowAdult, viewer } from "@/lib/adult-content";
import { hiddenOwners } from "@/lib/hidden-owners";
import { UUID_RE } from "@/lib/dm";
import { likeCount, likedBy, setLike } from "@/lib/likes";

type Supabase = ReturnType<typeof getSupabaseServerClient>;
type Viewer = Awaited<ReturnType<typeof viewer>>;

/** Whether this viewer may see (and so like) the image; null when it cannot be told. */
async function visible(supabase: Supabase, v: Viewer, id: string): Promise<boolean | null> {
  const { data: img, error } = await supabase.from("generated_images")
    .select("user_id, visibility, is_uploaded, is_adult, deleted_at").eq("id", id).maybeSingle();
  if (error) return null;
  if (!img || img.deleted_at) return false;
  const owner = String(img.user_id ?? "");
  if (img.is_adult && !mayShowAdult(v, owner)) return false;
  if (owner === v.userId) return true;
  if (img.visibility !== "public" || img.is_uploaded) return false;
  const hidden = await hiddenOwners(supabase, [owner]);
  if (!hidden) return null;
  return !hidden.has(owner);
}

const NOT_FOUND = () => NextResponse.json({ error: "Not found" }, { status: 404 });
const UNAVAILABLE = () => NextResponse.json({ error: "Likes unavailable" }, { status: 503 });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NOT_FOUND();
  const supabase = getSupabaseServerClient();
  const v = await viewer(supabase, req);
  const may = await visible(supabase, v, id);
  if (may === null) return UNAVAILABLE();
  if (!may) return NOT_FOUND();
  const target = { type: "generated_image", id } as const;
  const [count, mine] = await Promise.all([likeCount(supabase, target), v.userId ? likedBy(supabase, v.userId, target) : false]);
  if (count === null || mine === null) return UNAVAILABLE();
  return NextResponse.json({ count, mine });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NOT_FOUND();
  // Generous: the gallery's bar likes every marked image at once.
  const limit = checkRequestRateLimit(rateLimitKey(req, "image-like"), 120, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const v = await viewer(supabase, req);
  if (!v.userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const may = await visible(supabase, v, id);
  if (may === null) return UNAVAILABLE();
  if (!may) return NOT_FOUND();

  const body = (await req.json().catch(() => null)) as { liked?: unknown } | null;
  const want = typeof body?.liked === "boolean" ? body.liked : null;
  const state = await setLike(supabase, v.userId, { type: "generated_image", id }, want);
  if (!state) return NextResponse.json({ error: "Couldn't save the like" }, { status: 503 });
  return NextResponse.json(state);
}
