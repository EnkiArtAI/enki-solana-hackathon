/**
 * Server-side notification writer. One atomic RPC per event (notify_event,
 * see migrations/2026-07-13-notifications.sql): repeat events on the same
 * target coalesce into a counter row per day, so even hot prompts produce a
 * handful of rows, not thousands.
 *
 * Fire-and-forget by design: a notification must NEVER break the flow that
 * triggered it — failures (e.g. migration not run yet) are logged and dropped.
 */
import type { getSupabaseServerClient } from "@/lib/supabaseServer";

type Supabase = ReturnType<typeof getSupabaseServerClient>;

export type NotificationKind =
  | "comment"
  | "rating"
  | "generation"
  | "guardian_confirmed"
  | "guardian_declined"
  | "new_prompt"
  | "new_image";

export async function notifyEvent(
  supabase: Supabase,
  n: {
    userId: string; // recipient
    kind: NotificationKind;
    title: string;
    body?: string;
    targetType?: "prompt" | "guardian" | "image";
    targetId?: string; // uuid of the prompt/guardian row (coalescing identity)
    actorUserId?: string;
    meta?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    const { error } = await supabase.rpc("notify_event", {
      p_user: n.userId,
      p_kind: n.kind,
      p_title: n.title,
      p_body: n.body ?? null,
      p_target_type: n.targetType ?? null,
      p_target: n.targetId ?? null,
      p_actor: n.actorUserId ?? null,
      p_meta: n.meta ?? {},
    });
    if (error) console.error("[notify] dropped:", n.kind, error.message);
  } catch (e) {
    console.error("[notify] dropped:", n.kind, e instanceof Error ? e.message : e);
  }
}

/**
 * A new post for everyone who follows its maker with the bell on (DEC-512, migrations/2026-10-29-follower-
 * notifications.sql): one statement for all of them, at most one row per follower, post and day. Named by the maker's
 * display name, else handle; the caller passes the picture only for a post that is not 18+, as a follower may not see
 * 18+. Fire-and-forget like notifyEvent.
 */
export async function notifyFollowers(
  supabase: Supabase,
  n: { actorUserId: string; kind: "new_prompt" | "new_image"; targetId: string; body?: string | null; thumb?: string | null }
): Promise<void> {
  try {
    const { data: actor } = await supabase.from("users").select("handle, display_name").eq("id", n.actorUserId).maybeSingle();
    const name = actor?.display_name || (actor?.handle ? `@${actor.handle}` : "Someone you follow");
    const { error } = await supabase.rpc("notify_followers", {
      p_actor: n.actorUserId,
      p_kind: n.kind,
      p_title: n.kind === "new_prompt" ? `${name} released a new prompt` : `${name} posted a new image`,
      p_body: n.body || null,
      p_target_type: n.kind === "new_prompt" ? "prompt" : "image",
      p_target: n.targetId,
      p_meta: n.thumb ? { thumb: n.thumb } : {},
    });
    if (error) console.error("[notify] followers dropped:", n.kind, error.message);
  } catch (e) {
    console.error("[notify] followers dropped:", n.kind, e instanceof Error ? e.message : e);
  }
}
