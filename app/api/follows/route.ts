import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { UUID_RE } from "@/lib/dm";

// Following someone (Kev, 2026-10-29: "go A"; migrations/2026-10-29-follows.sql).
// GET  ?user=id               → { following, notify } for the signed-in viewer; a guest follows nobody
// POST { user, follow: bool } → follow (bell off) or unfollow
// POST { user, notify: bool } → the bell: their new prompts and public images in my notifications

export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get("user")?.toLowerCase() ?? "";
  if (!UUID_RE.test(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const supabase = getSupabaseServerClient();
  const me = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!me) return NextResponse.json({ following: false, notify: false });
  const { data, error } = await supabase
    .from("follows")
    .select("notify_on_new_prompt, notify_on_new_post")
    .eq("follower_id", me)
    .eq("followee_id", user)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not read the follow" }, { status: 500 });
  return NextResponse.json({ following: !!data, notify: !!data && (data.notify_on_new_prompt || data.notify_on_new_post) });
}

export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const me = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const limit = checkRequestRateLimit(rateLimitKey(req, "follow", me), 30, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const body = (await req.json().catch(() => null)) as { user?: unknown; follow?: unknown; notify?: unknown } | null;
  const user = typeof body?.user === "string" ? body.user.toLowerCase() : "";
  if (!UUID_RE.test(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (user === me.toLowerCase()) return NextResponse.json({ error: "That's you" }, { status: 400 });

  if (typeof body?.notify === "boolean") {
    // One bell for both kinds of post (Kev: "a new post (prompt creation or post of an image)").
    const { error, count } = await supabase
      .from("follows")
      .update({ notify_on_new_prompt: body.notify, notify_on_new_post: body.notify }, { count: "exact" })
      .eq("follower_id", me)
      .eq("followee_id", user);
    if (error) return NextResponse.json({ error: "Could not change the bell" }, { status: 500 });
    if (!count) return NextResponse.json({ error: "Follow them first" }, { status: 409 });
    return NextResponse.json({ following: true, notify: body.notify });
  }

  if (body?.follow === false) {
    const { error } = await supabase.from("follows").delete().eq("follower_id", me).eq("followee_id", user);
    if (error) return NextResponse.json({ error: "Could not unfollow" }, { status: 500 });
    return NextResponse.json({ following: false, notify: false });
  }
  if (body?.follow !== true) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const { data: peer } = await supabase.from("users").select("id").eq("id", user).is("deleted_at", null).maybeSingle();
  if (!peer) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // The bell starts off (Kev: "once followed the bell button to turn on notifications"), against the live
  // column default; following again keeps whatever the bell was.
  const { error } = await supabase
    .from("follows")
    .upsert({ follower_id: me, followee_id: user, notify_on_new_prompt: false, notify_on_new_post: false },
      { onConflict: "follower_id,followee_id", ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: "Could not follow" }, { status: 500 });
  return NextResponse.json({ following: true });
}
