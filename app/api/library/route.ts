import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { requireActionStepUp } from "@/lib/webauthn";

/**
 * Private prompt / workflow library (Kev, 2026-09-05). Every row belongs to
 * the session's user and is only ever read back to that user — there is no
 * public listing and no other user's id is accepted anywhere.
 *   GET            → { items }      newest first
 *   DELETE ?id=    → { ok }
 * No client saved through a POST any more; it went with its image checks (2026-10-28).
 */
export const dynamic = "force-dynamic";

async function owner(request: NextRequest) {
  const supabase = getSupabaseServerClient();
  try {
    const userId = await resolveSessionUserId(supabase, request.headers.get("X-Session-Token"));
    return { supabase, userId, down: false };
  } catch (e) {
    if (isDbUnreachable(e)) return { supabase, userId: null, down: true };
    throw e;
  }
}

export async function GET(request: NextRequest) {
  const { supabase, userId, down } = await owner(request);
  if (down) return dbUnavailableResponse();
  if (!userId) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const { data, error } = await supabase
    .from("saved_workflows")
    .select("id, name, kind, graph, prompt_text, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) return isDbUnreachable(error) ? dbUnavailableResponse() : NextResponse.json({ error: "Library unavailable" }, { status: 500 });
  return NextResponse.json({ items: data ?? [] });
}

export async function DELETE(request: NextRequest) {
  const { supabase, userId, down } = await owner(request);
  if (down) return dbUnavailableResponse();
  if (!userId) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  // MFA-3: once a factor is enrolled (and deleting is on in Settings), one
  // tap deletes this item and no other.
  const blocked = await requireActionStepUp(request, userId, "delete", `delete-library:${id.toLowerCase()}`);
  if (blocked) return blocked;
  // The owner filter is what makes this safe: a foreign id deletes nothing.
  const { error, count } = await supabase
    .from("saved_workflows")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) return isDbUnreachable(error) ? dbUnavailableResponse() : NextResponse.json({ error: "Could not delete" }, { status: 500 });
  if (!count) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
