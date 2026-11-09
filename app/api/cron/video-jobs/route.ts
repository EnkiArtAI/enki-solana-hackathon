import { NextRequest, NextResponse } from "next/server";
import { cronDenied } from "@/lib/cron";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { runVideoJobs } from "@/lib/video/jobs";

export const runtime = "nodejs";
/** Vercel Pro's maximum (docs, last updated 2026-08-24). The one function ffmpeg is traced into (next.config.ts). */
export const maxDuration = 800;
/** What the function keeps for itself after its last step. */
const RESERVE_MS = 20_000;

/** Every minute: follows every video under way. With none due it is one read and an answer (lib/video/jobs runVideoJobs). */
export async function GET(req: NextRequest) {
  const denied = cronDenied(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await runVideoJobs(getSupabaseServerClient(), { request: req, deadlineAt: Date.now() + maxDuration * 1000 - RESERVE_MS }));
  } catch {
    console.error("[video] the job run failed");
    return NextResponse.json({ error: "The video run is temporarily unavailable." }, { status: 503 });
  }
}
