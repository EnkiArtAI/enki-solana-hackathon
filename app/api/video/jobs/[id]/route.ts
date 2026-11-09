import { NextRequest, NextResponse } from "next/server";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { UUID_RE } from "@/lib/dm";
import { resolveSessionUserId } from "@/lib/session-user";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { VIEW_COLUMNS, jobView } from "@/lib/video/job-view";

/** GET: one of the signed-in account's own video jobs; someone else's reads as none at all. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getSupabaseServerClient();
    const me = await resolveSessionUserId(db, req.headers.get("X-Session-Token"));
    if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { data, error } = await db.from("video_jobs").select(VIEW_COLUMNS).eq("id", id).eq("user_id", me).maybeSingle();
    if (error && error.code !== "PGRST205" && error.code !== "42P01") throw error;
    return data ? NextResponse.json({ job: jobView(data) }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[video] job read failed");
    return NextResponse.json({ error: "Could not read this video" }, { status: 500 });
  }
}
