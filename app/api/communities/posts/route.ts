import { NextResponse } from "next/server";
import {
  ALREADY_POSTED, MAKE_PUBLIC_FIRST, MAX_COMMUNITIES_PER_WORK, NOT_READ, NOT_SAVED, NOT_YOUR_RENDER, PICK_A_COMMUNITY,
  TOO_MANY_COMMUNITIES,
} from "@/lib/communities/types";
import {
  COLS, badRequest, communityFailure, communityHandler, isUuid, notFound, overLimit, postsOf, readBody, readText, say, screened,
  type Entry,
} from "@/lib/communities/server";

// Posting to the Showroom (Kev, 2026-10-30: "people would also like to just create together and share artpieces they have
// done. so we might need some sort of a showroom, decoupled from prompts completely"; lib/communities/types.ts PostInput,
// SQL 54). A post is one of the poster's own public renders, once (no uploads in v1: they would need the image-safety
// pipeline). An answer (a variation) answers its post's root and is in that post's communities.
// POST PostInput → 201 { post }; 403 NOT_YOUR_RENDER; 409 MAKE_PUBLIC_FIRST; 409 ALREADY_POSTED { postId }

export const POST = communityHandler(async ({ req, supabase, me }) => {
  const limited = overLimit(req, me, "write");
  if (limited) return limited;
  const body = await readBody(req);
  if (!body || !isUuid(body.imageId) || (body.parentId != null && !isUuid(body.parentId))) return badRequest();
  if (body.communityIds !== undefined && !(Array.isArray(body.communityIds) && body.communityIds.every(isUuid))) return badRequest();
  const render = await supabase.from("generated_images").select("user_id, visibility, is_uploaded").eq("id", body.imageId).is("deleted_at", null).maybeSingle();
  if (render.error) return communityFailure(render.error, NOT_READ);
  if (!render.data || render.data.user_id !== me || render.data.is_uploaded) return say(NOT_YOUR_RENDER, 403);
  if (render.data.visibility !== "public") return say(MAKE_PUBLIC_FIRST, 409);
  const posted = await supabase.from("showroom_posts").select("id").eq("image_id", body.imageId).maybeSingle();
  if (posted.error) return communityFailure(posted.error, NOT_READ);
  if (posted.data) return say(ALREADY_POSTED, 409, { postId: posted.data.id });
  const text = readText(body, ["title", "caption"], true);
  if ("error" in text) return say(text.error, 400);
  const refused = screened(text.values);
  if (refused) return refused;

  // An answer answers the root of what it answers, in the root's communities; a post of its own picks 1 to 18.
  let parent: string | null = null;
  let communities: string[];
  if (body.parentId) {
    const asked = await supabase.from("showroom_posts").select("id, parent_id").eq("id", body.parentId).maybeSingle();
    if (asked.error) return communityFailure(asked.error, NOT_READ);
    const root = asked.data ? (asked.data.parent_id ?? asked.data.id) : null;
    const shown = root ? await supabase.from("showroom_entries").select("id").eq("id", root).maybeSingle() : null;
    if (shown?.error) return communityFailure(shown.error, NOT_READ);
    if (!shown?.data) return notFound();
    parent = root;
    const links = await supabase.from("community_links").select("community_id").eq("post_id", root).eq("state", "shown");
    if (links.error) return communityFailure(links.error, NOT_READ);
    communities = (links.data as { community_id: string }[]).map((l) => l.community_id);
  } else {
    const asked = [...new Set((body.communityIds as string[] | undefined) ?? [])];
    if (asked.length > MAX_COMMUNITIES_PER_WORK) return say(TOO_MANY_COMMUNITIES, 409);
    const live = asked.length ? await supabase.from("communities").select("id").in("id", asked).is("merged_into", null) : { data: [], error: null };
    if (live.error) return communityFailure(live.error, NOT_READ);
    communities = (live.data as { id: string }[]).map((c) => c.id);
    if (!communities.length) return say(PICK_A_COMMUNITY, 400);
  }

  const made = await supabase.from("showroom_posts")
    .insert({ user_id: me, image_id: body.imageId, title: text.values.title, caption: text.values.caption ?? null, parent_id: parent })
    .select("id").single();
  // 23505: posted meanwhile; 23514: the day's cap, or SQL 54's guard on the render.
  if (made.error) return communityFailure(made.error, NOT_SAVED, ALREADY_POSTED);
  const id = made.data.id as string;
  if (communities.length) {
    const linked = await supabase.from("community_links").insert(communities.map((c) => ({ community_id: c, post_id: id, user_id: me })));
    if (linked.error) {
      // A post in none of the communities it was posted to is no post: it goes again.
      await supabase.from("showroom_posts").delete().eq("id", id);
      return communityFailure(linked.error, NOT_SAVED);
    }
  }
  const entry = await supabase.from("showroom_entries").select(COLS.entry).eq("id", id).maybeSingle();
  if (entry.error) return communityFailure(entry.error, NOT_READ);
  const shown = entry.data ? await postsOf(supabase, me, [entry.data as Entry]) : [];
  if (shown instanceof Response) return shown;
  return shown[0] ? NextResponse.json({ post: shown[0] }, { status: 201 }) : say(NOT_READ, 500);
}, { session: "required" });
