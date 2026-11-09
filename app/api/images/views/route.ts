/**
 * POST /api/images/views  { ids: string[] } → 204
 *
 * Images opened large, batched by the browser (lib/ui/view-beacon.ts), counted on their UTC day
 * (count_image_opens, 2026-10-29-view-days.sql): only public renders, never the viewer's own. Deduped per viewer and
 * image for a day on this instance; anonymous allowed; never errors the client. Until the SQL ran nothing is counted.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  let ids: unknown;
  try {
    ({ ids } = await req.json());
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  if (!Array.isArray(ids)) return new NextResponse(null, { status: 204 });
  const fresh = [...new Set(ids.filter((i): i is string => typeof i === "string" && UUID.test(i)))]
    .slice(0, 50)
    .filter((id) => checkRequestRateLimit(rateLimitKey(req, `image-open:${id}`), 1, DAY_MS).allowed);
  if (fresh.length === 0) return new NextResponse(null, { status: 204 });

  const supabase = getSupabaseServerClient();
  const viewer = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token")).catch(() => null);
  const { error } = await supabase.rpc("count_image_opens", { p_images: fresh, p_viewer: viewer ?? null });
  if (error && error.code !== "PGRST202" && !error.message?.includes("schema cache")) {
    console.error("[images/views] count failed:", error.message);
  }
  return new NextResponse(null, { status: 204 });
}
