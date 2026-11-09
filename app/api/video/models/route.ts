import { NextResponse } from "next/server";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { ROUTES_SQL, loadVideoRoutes, publicRoute } from "@/lib/video/routes";

/**
 * Each video generator's rate in micro-USD and where it can run. Never who runs it: the operator stays in its row. Read like
 * /api/models, signed in or not (a guest sees a generator's rate on the menu). Before SQL 68 it names the file to run.
 */
export async function GET() {
  try {
    const routes = await loadVideoRoutes(getSupabaseServerClient());
    if (!routes) {
      console.error(`[video] video_routes is missing or empty: run sql-to-run/${ROUTES_SQL}`);
      return NextResponse.json({ models: [], run: ROUTES_SQL });
    }
    return NextResponse.json({ models: routes.map(publicRoute) });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[video] routes read failed:", e);
    return NextResponse.json({ error: "Could not read the video generators" }, { status: 500 });
  }
}
