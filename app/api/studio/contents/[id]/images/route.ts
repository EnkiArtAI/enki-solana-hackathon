import { NextResponse } from "next/server";
import { MAX_FILE_AT_ONCE, NOT_DELETED, NOT_SAVED, NOT_YOUR_RENDER } from "@/lib/studio/types";
import { isUuid, notFound, overLimit, readBody, say, studioFailure, studioHandler } from "@/lib/studio/server";

// The renders filed in a content piece of the signed-in account's (Kev, 2026-10-30: "subfolders for every content piece
// i create"; lib/studio/types.ts, SQL 53); someone else's piece reads as none (404). Create > Image files what it renders
// in a piece's context, and the viewer files one by hand.
// POST { imageIds }   → { filed }: 1 to 8 of the caller's own renders (never an upload), all or none; those filed
//                       before count as filed
// DELETE ?imageId=    → { removed: true }: out of the piece, still in the gallery

const NOTHING = "Nothing to file";

export const POST = studioHandler<{ id: string }>(async ({ req, supabase, me, params: { id } }) => {
  const limited = overLimit(req, me);
  if (limited) return limited;
  if (!isUuid(id)) return notFound();
  const asked = (await readBody(req))?.imageIds;
  // Lower-cased as Postgres answers a uuid, so an id sent in upper case is the same render (and found filed).
  const ids = Array.isArray(asked) ? [...new Set(asked.map((v) => (typeof v === "string" ? v.toLowerCase() : v)))] : [];
  if (!ids.length || ids.length > MAX_FILE_AT_ONCE) return say(NOTHING, 400);
  if (!ids.every(isUuid)) return say(NOT_YOUR_RENDER, 400);
  const piece = await supabase.from("studio_contents").select("id").eq("id", id).eq("user_id", me).maybeSingle();
  if (piece.error) return studioFailure(piece.error, NOT_SAVED);
  if (!piece.data) return notFound();
  const [renders, there] = await Promise.all([
    supabase.from("generated_images").select("id").in("id", ids).eq("user_id", me).eq("is_uploaded", false).is("deleted_at", null),
    supabase.from("studio_content_images").select("image_id").eq("content_id", id).eq("user_id", me).in("image_id", ids),
  ]);
  if (renders.error || there.error) return studioFailure(renders.error ?? there.error, NOT_SAVED);
  // All or none: one render that is not the caller's own files nothing.
  if (renders.data.length !== ids.length) return say(NOT_YOUR_RENDER, 400);
  // Read first, never upserted: SQL 53's cap counts a conflicting row's insert too.
  const filed = new Set(there.data.map((r) => r.image_id));
  const fresh = ids.filter((i) => !filed.has(i));
  if (fresh.length) {
    const { error: added } = await supabase.from("studio_content_images").insert(fresh.map((image_id) => ({ content_id: id, user_id: me, image_id })));
    // 23514: the piece's 200.
    if (added) return studioFailure(added, NOT_SAVED);
  }
  return NextResponse.json({ filed: ids });
});

export const DELETE = studioHandler<{ id: string }>(async ({ req, supabase, me, params: { id } }) => {
  const limited = overLimit(req, me);
  if (limited) return limited;
  const imageId = req.nextUrl.searchParams.get("imageId");
  if (!isUuid(id) || !isUuid(imageId)) return notFound();
  const { data, error } = await supabase.from("studio_content_images").delete()
    .eq("content_id", id).eq("image_id", imageId).eq("user_id", me).select("image_id");
  if (error) return studioFailure(error, NOT_DELETED);
  return data.length ? NextResponse.json({ removed: true }) : notFound();
});
