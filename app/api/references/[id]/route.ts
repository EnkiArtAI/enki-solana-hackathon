import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { UUID_RE } from "@/lib/dm";
import { REFERENCE_BUCKET, referenceFailure } from "@/lib/reference-library";

// DELETE → a saved reference gone from its owner's list (lib/reference-library.ts), and its files with it: nothing else
// names them, a render keeps its own checked copy (lib/generation/reference-images). The row stays, marked deleted, so
// the picker hides an earlier render's copy of the picture too (DEC-525).

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = getSupabaseServerClient();
    const me = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const limit = checkRequestRateLimit(rateLimitKey(req, "reference-delete", me), 30, 60_000);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { data, error } = await supabase
      .from("reference_uploads")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", me)
      .is("deleted_at", null)
      .select("path, thumb_path");
    if (error) return referenceFailure(error, "Could not delete that reference");
    // Someone else's, or one already deleted, reads as none at all.
    if (!data.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // Best effort: a file left behind stays private, and the row is deleted either way.
    await supabase.storage.from(REFERENCE_BUCKET)
      .remove(data.flatMap((r) => (r.thumb_path ? [r.path, r.thumb_path] : [r.path])))
      .catch(() => null);
    return NextResponse.json({ deleted: true });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}
