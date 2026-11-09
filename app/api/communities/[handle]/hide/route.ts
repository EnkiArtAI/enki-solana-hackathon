import { NextResponse } from "next/server";
import { ITEM_KINDS, MERGED_ALREADY, NOT_SAVED, STAFF_ONLY, type ItemKind } from "@/lib/communities/types";
import {
  ITEM, audit, badRequest, communityFailure, communityHandler, isUuid, notFound, overLimit, readBody, resolveCommunity, say, staffOf,
} from "@/lib/communities/server";

// A moderator takes an item out of one community, or puts it back (lib/communities/types.ts HideInput, SQL 54). Enki's
// staff only (admin, mod): a community has no moderators of its own in v1. Its owner cannot put it back.
// POST HideInput → { hidden }
//   a prompt, a post or a render linked directly: its link's state, hidden or shown
//   a render in through its prompt or a post: a hidden row of the moderator's; putting it back deletes that row

export const POST = communityHandler<{ handle: string }>(async ({ req, supabase, me, params }) => {
  const limited = overLimit(req, me, "write");
  if (limited) return limited;
  const role = await staffOf(supabase, me);
  if (!role) return say(STAFF_ONLY, 403);
  const body = await readBody(req);
  if (!body || !ITEM_KINDS.includes(body.kind as ItemKind) || !isUuid(body.id) || typeof body.hidden !== "boolean") return badRequest();
  const { kind, id, hidden } = body as { kind: ItemKind; id: string; hidden: boolean };
  const found = await resolveCommunity(supabase, params.handle);
  if (found instanceof Response) return found;
  if (!found) return notFound();
  if (found.merged) return say(MERGED_ALREADY, 409);
  const community = found.row.id;
  const { column } = ITEM[kind];

  const now = await supabase.from("community_links").select("state, user_id").eq("community_id", community).eq(column, id).maybeSingle();
  if (now.error) return communityFailure(now.error, NOT_SAVED);
  const row = now.data as { state: string; user_id: string } | null;
  let error: { code?: string; message?: string } | null = null;
  if (row?.state === "opted_out" && hidden) {
    // Out already, by its owner: nothing shows to hide, and her opt-out stays hers (an un-hide never makes it a link).
  } else if (row) {
    // A moderator's own row over a render that came in otherwise goes when put back; an owner's link turns shown again.
    const owner = kind === "image" && !hidden ? await supabase.from("generated_images").select("user_id").eq("id", id).maybeSingle() : null;
    if (owner?.error) return communityFailure(owner.error, NOT_SAVED);
    const mine = !owner || owner.data?.user_id === row.user_id;
    const at = supabase.from("community_links");
    ({ error } = hidden
      ? await at.update({ state: "hidden" }).eq("community_id", community).eq(column, id)
      : mine
        ? await at.update({ state: "shown" }).eq("community_id", community).eq(column, id).eq("state", "hidden")
        : await at.delete().eq("community_id", community).eq(column, id).eq("state", "hidden"));
  } else if (hidden) {
    // No link of its own: only a render in its works (through its prompt or a post) can be taken out.
    if (kind !== "image") return notFound();
    const work = await supabase.from("community_works").select("image_id").eq("community_id", community).eq("image_id", id).maybeSingle();
    if (work.error) return communityFailure(work.error, NOT_SAVED);
    if (!work.data) return notFound();
    ({ error } = await supabase.from("community_links").insert({ community_id: community, image_id: id, user_id: me, state: "hidden" }));
  }
  // 23514 from putting one back: its owner filled its 18 places meanwhile.
  if (error) return communityFailure(error, NOT_SAVED);
  return audit(supabase, req, { userId: me, role }, { action: hidden ? "hide" : "unhide", kind, id, handle: found.row.handle }, NextResponse.json({ hidden }));
}, { session: "required" });
