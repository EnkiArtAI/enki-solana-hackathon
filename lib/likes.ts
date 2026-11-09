import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Likes, one row each in public.reactions (Kev, 2026-10-15), for prompts and
 * images alike. The count is like_count on the target itself, kept by a
 * trigger in the same transaction as the row (migrations/2026-10-15-like-
 * counters.sql), so nothing here ever counts rows. A unique index makes a
 * second like by the same user impossible: a race reads as "already liked".
 */
export type LikeTargetType = "prompt" | "generated_image";
export interface LikeTarget { type: LikeTargetType; id: string }
export interface LikeState { count: number; mine: boolean }

const COUNTED_ON: Record<LikeTargetType, string> = { prompt: "prompts", generated_image: "generated_images" };
const LIKE = "like";

/** The target's like count; null when it cannot be read. */
export async function likeCount(db: SupabaseClient, t: LikeTarget): Promise<number | null> {
  const { data, error } = await db.from(COUNTED_ON[t.type]).select("like_count").eq("id", t.id).maybeSingle();
  if (error) return null;
  const n = Number((data as { like_count?: unknown } | null)?.like_count ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Whether this user likes the target; null when it cannot be read. */
export async function likedBy(db: SupabaseClient, userId: string, t: LikeTarget): Promise<boolean | null> {
  const { data, error } = await db.from("reactions").select("id")
    .eq("user_id", userId).eq("target_type", t.type).eq("target_uuid", t.id).eq("reaction_type", LIKE).maybeSingle();
  return error ? null : !!data;
}

/** Which of these targets the user likes, in one read; an empty set when nothing could be read. */
export async function likedAmong(db: SupabaseClient, userId: string, type: LikeTargetType, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data, error } = await db.from("reactions").select("target_uuid")
    .eq("user_id", userId).eq("target_type", type).eq("reaction_type", LIKE).in("target_uuid", ids);
  return error ? new Set() : new Set((data ?? []).map((r) => String((r as { target_uuid: unknown }).target_uuid)));
}

/**
 * Sets the user's like to `want`, or flips it when `want` is null. Answers the
 * fresh state, or null when the store refused; a like that already exists, or
 * appears meanwhile, is simply kept.
 */
export async function setLike(db: SupabaseClient, userId: string, t: LikeTarget, want: boolean | null): Promise<LikeState | null> {
  const now = await likedBy(db, userId, t);
  if (now === null) return null;
  const mine = want ?? !now;
  if (mine && !now) {
    const { error } = await db.from("reactions").insert({ user_id: userId, target_type: t.type, target_uuid: t.id, reaction_type: LIKE });
    if (error && error.code !== "23505") return null;
  } else if (!mine && now) {
    const { error } = await db.from("reactions").delete()
      .eq("user_id", userId).eq("target_type", t.type).eq("target_uuid", t.id).eq("reaction_type", LIKE);
    if (error) return null;
  }
  const count = await likeCount(db, t);
  return count === null ? null : { count, mine };
}
