import type { SupabaseClient } from "@supabase/supabase-js";
import { columnMissing } from "@/lib/prompt-references";
import { VIDEO_SQL, videoColumns } from "@/lib/marketplace/video-columns";

/** The files a paid video needs, and the buckets one of them makes. */
export const STORAGE_SQL = "66-video-storage.sql";
export const JOBS_SQL = "69-video-jobs.sql";
export const HOLD_SQL = "70-intent-hold.sql";
export const VIDEO_BUCKET = "videos";
export const ORIGINALS_BUCKET = "video-originals";

/** A person's videos under way at once. */
export const MAX_RUNNING = 3;
export const RUNNING = ["submitting", "running", "transcoding"];

const missingTable = (e: { code?: string } | null) => e?.code === "PGRST205" || e?.code === "42P01";

/**
 * The file that must run before anyone can pay for a video, null when none: a buyer never signs for a render whose record has
 * nowhere to go. Asked only once an operator is set, so it costs an image nothing. A failed read that is no missing file throws.
 */
export async function videoFileToRun(db: SupabaseClient): Promise<string | null> {
  if (!(await videoColumns(db))) return VIDEO_SQL;
  const [jobs, hold, bucket] = await Promise.all([
    db.from("video_jobs").select("id").limit(1),
    db.from("generation_payment_intents").select("hold_until").limit(1),
    db.storage.getBucket(VIDEO_BUCKET),
  ]);
  if (missingTable(jobs.error)) return JOBS_SQL;
  if (hold.error && columnMissing(hold.error)) return HOLD_SQL;
  if (jobs.error || hold.error) throw jobs.error ?? hold.error;
  return bucket.error || !bucket.data ? STORAGE_SQL : null;
}

/** How many of this person's videos are under way; null before SQL 69: a head read of a missing table answers no error and no count (see app/api/references). */
export async function runningJobs(db: SupabaseClient, userId: string): Promise<number | null> {
  const { count, error } = await db.from("video_jobs").select("id", { count: "exact", head: true }).eq("user_id", userId).in("status", RUNNING);
  if (missingTable(error)) return null;
  if (error) throw error;
  return count;
}
