import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { cleanText } from "@/lib/editor/post-import";

/**
 * What is left of the Prompt Hunter's list run (Kev, 2026-10-14), retired on 2026-10-30 (DEC-2026-10-30-605): the
 * hunter_config and hunter_accounts rows the admin panel still reads, and what a creator's Play (lib/hunter/creator-run)
 * shares with it.
 */
export interface HunterConfig {
  mode: "queue" | "publish";
  posts_per_run: number;
  min_likes: number;
  /** 0 = no cap. */
  per_author_daily: number;
  /** Posts in a row without a prompt after which an account is left; 0 = never. */
  dry_after: number;
  publisher_user_id: string | null;
}

export interface HunterAccount {
  handle: string;
  x_user_id: string | null;
  newest_id: string | null;
  oldest_id: string | null;
  exhausted: boolean;
  /** Left because dry_after posts in a row carried no prompt (exhausted too). */
  dry: boolean;
  dry_streak: number;
  posts_read: number;
  found: number;
  error: string | null;
  last_run_at: string | null;
  added_at: string;
}

export type Outcome =
  | "reply" | "no_prompt" | "below_likes" | "duplicate" | "author_cap" | "refused" | "unchecked" | "not_saved"
  | "queued" | "published" | "publish_failed";

/** A round stops reading when this much of the request's time is gone (the route allows 300 s). */
export const TIME_CAP_MS = 240_000;
/** A queued preview waits for an admin; the dialog's hour would be gone by morning. */
export const QUEUE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** The text's fingerprint: the same prompt posted twice is one prompt. */
export const promptHash = (prompt: string): string =>
  createHash("sha256").update(cleanText(prompt).toLowerCase().replace(/\s+/g, " ")).digest("hex");

/**
 * The request a hunted post is judged with: the admin's abort signal and none of their headers. The post is an X
 * author's, not the admin's who pressed Play, and recordWarning and recordImageCase take the account from
 * X-Session-Token and the address from x-forwarded-for: a creator's explicit or child-safety prompt, or a picture of
 * their post, struck, suspended and filed cases under the admin (review 2026-10-30, F1). Without both, a warning or a
 * case is filed under no account and no address: the admins get its mail and the admin panel's automod list shows it,
 * but not the People list, which groups by account or address (view moderation_people). Whether it belongs to the
 * imported creator's account instead is Kev's call.
 */
export const asNobody = (request: NextRequest): NextRequest => new NextRequest("https://enki.invalid/prompt-hunter", { signal: request.signal });

/** Every active image generator's catalogue name: what a free prompt without a named one is offered on. */
export async function imageGenerators(supabase: SupabaseClient): Promise<string[]> {
  const { data } = await supabase.from("models").select("name, media_type").eq("active", true);
  return (data ?? []).flatMap((m) => (typeof m.name === "string" && m.media_type !== "video" ? [m.name] : []));
}
