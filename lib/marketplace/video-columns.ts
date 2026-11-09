import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { columnMissing } from "@/lib/prompt-references";

/** The file that adds prompts.media_type and showcase_video. */
export const VIDEO_SQL = "52-video-prompts.sql";

const FOR_MS = 60_000;
let known: { yes: boolean; at: number } | null = null;

/**
 * Whether SQL 52 ran, read at most once a minute per instance. The card's read asks for its columns only then: a select
 * naming a column that is not there fails whole (42703), and All and Images must work before the file runs. A read that
 * fails for any other reason says no and is not kept: the card's own read then answers the outage as it always did.
 */
export async function videoColumns(supabase: SupabaseClient): Promise<boolean> {
  if (known && Date.now() - known.at < FOR_MS) return known.yes;
  try {
    const { error } = await supabase.from("prompts").select("media_type").limit(1);
    if (error && !columnMissing(error)) return false;
    known = { yes: !error, at: Date.now() };
    return known.yes;
  } catch {
    return false;
  }
}

/** Whether this prompt makes videos; no before SQL 52. A link's card asks, so as not to call a video free. */
export async function isVideoPrompt(supabase: SupabaseClient, id: string): Promise<boolean> {
  if (!(await videoColumns(supabase))) return false;
  const { data } = await supabase.from("prompts").select("media_type").eq("id", id).maybeSingle();
  return data?.media_type === "video";
}

/** ?media=videos before SQL 52: nothing to show, and whoever reads the log or the answer is told which file to run. */
export function videosNeedSql(answer: Record<string, unknown>) {
  console.error(`[videos] prompts.media_type is missing: run sql-to-run/${VIDEO_SQL}`);
  return NextResponse.json({ ...answer, prompts: [], hasMore: false, run: VIDEO_SQL });
}
