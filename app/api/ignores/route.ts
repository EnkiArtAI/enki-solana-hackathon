import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { UUID_RE } from "@/lib/dm";
import { IGNORES_NOT_READY, MAX_IGNORED, ignoresNotReady } from "@/lib/ignores";

// Ignoring people (Kev, 2026-10-29; lib/ignores.ts, migrations/2026-10-29-user-ignores.sql).
// GET                         → { people: [{ id, handle, displayName, avatarUrl }] }, newest first; a guest ignores nobody
// POST { user, ignore: bool } → ignore or un-ignore; no ban, nobody is told, a follow and its bell stay

type Failure = { code?: string } | null;
const failed = (error: Failure, sentence: string) =>
  isDbUnreachable(error) ? dbUnavailableResponse()
  : ignoresNotReady(error) ? NextResponse.json({ error: IGNORES_NOT_READY }, { status: 503 })
  : NextResponse.json({ error: sentence }, { status: 500 });

export async function GET(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();
    const me = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!me) return NextResponse.json({ people: [] });
    const { data, error } = await supabase
      .from("user_ignores")
      .select("ignored_id")
      .eq("user_id", me)
      .order("created_at", { ascending: false })
      .limit(MAX_IGNORED);
    if (error) return failed(error, "Could not read the people you ignore");
    const ids = (data ?? []).map((r) => String(r.ignored_id));
    if (!ids.length) return NextResponse.json({ people: [] });
    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("id, handle, display_name, avatar_url")
      .in("id", ids)
      .is("deleted_at", null);
    if (usersError) return failed(usersError, "Could not read the people you ignore");
    const byId = new Map((users ?? []).map((u) => [String(u.id), u]));
    const people = ids.flatMap((id) => {
      const u = byId.get(id);
      return u ? [{ id, handle: u.handle ?? "", displayName: u.display_name || u.handle || "", avatarUrl: u.avatar_url }] : [];
    });
    return NextResponse.json({ people });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();
    const me = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const limit = checkRequestRateLimit(rateLimitKey(req, "ignore", me), 30, 60_000);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const body = (await req.json().catch(() => null)) as { user?: unknown; ignore?: unknown } | null;
    const user = typeof body?.user === "string" ? body.user.toLowerCase() : "";
    if (!UUID_RE.test(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (user === me.toLowerCase()) return NextResponse.json({ error: "That's you" }, { status: 400 });
    if (typeof body?.ignore !== "boolean") return NextResponse.json({ error: "Bad request" }, { status: 400 });

    if (!body.ignore) {
      const { error } = await supabase.from("user_ignores").delete().eq("user_id", me).eq("ignored_id", user);
      if (error) return failed(error, "Could not un-ignore");
      return NextResponse.json({ ignored: false });
    }

    const { data: peer, error: peerError } = await supabase.from("users").select("id").eq("id", user).is("deleted_at", null).maybeSingle();
    if (peerError) return failed(peerError, "Could not ignore");
    if (!peer) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { error } = await supabase.from("user_ignores").insert({ user_id: me, ignored_id: user });
    // 23514: SQL 48's cap, held one ignore at a time per account (yourself is answered above). 23505: already
    // ignored, which is what was asked, at the cap too.
    if (error?.code === "23514") {
      return NextResponse.json({ error: `You can ignore up to ${MAX_IGNORED} people. Un-ignore someone first.` }, { status: 409 });
    }
    if (error && error.code !== "23505") return failed(error, "Could not ignore");
    return NextResponse.json({ ignored: true });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}
