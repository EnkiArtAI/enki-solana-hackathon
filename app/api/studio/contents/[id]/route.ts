import { NextResponse } from "next/server";
import { CONTENT_NAME_TAKEN, NOT_DELETED, NOT_READ, NOT_SAVED, type ContentDetail } from "@/lib/studio/types";
import {
  COLS, badRequest, brandOf, contentsOf, isUuid, liveRenders, notFound, overLimit, pictureOf, readBody, readText, say,
  studioFailure, studioHandler, toContent,
} from "@/lib/studio/server";

// One content piece of the signed-in account's (lib/studio/types.ts, SQL 53); someone else's reads as none (404).
// GET                → ContentDetail: the piece, its project's name, and its renders newest first (deleted ones left out)
// PATCH ContentInput → { content }: an absent field stays; the style and master prompt are its project's, or none
// DELETE             → { deleted: true }: the piece and its filings; the renders stay in the gallery

export const GET = studioHandler<{ id: string }>(async ({ supabase, me, params: { id } }) => {
  if (!isUuid(id)) return notFound();
  const piece = await supabase.from("studio_contents").select(COLS.content).eq("id", id).eq("user_id", me).maybeSingle();
  if (piece.error) return studioFailure(piece.error, NOT_READ);
  if (!piece.data) return notFound();
  const [project, links] = await Promise.all([
    supabase.from("studio_projects").select("id, name").eq("id", piece.data.project_id).eq("user_id", me).maybeSingle(),
    supabase.from("studio_content_images").select("image_id, added_at").eq("content_id", id).eq("user_id", me).order("added_at", { ascending: false }),
  ]);
  if (project.error || links.error) return studioFailure(project.error ?? links.error, NOT_READ);
  if (!project.data) return notFound();
  const renders = await liveRenders(supabase, me, links.data.map((l) => l.image_id));
  if (renders instanceof Response) return renders;
  const images = links.data.flatMap((l) => {
    const render = renders.get(l.image_id);
    const picture = pictureOf(render);
    return picture ? [{ imageId: l.image_id, promptId: render!.prompt_id, ...picture, addedAt: l.added_at }] : [];
  });
  const detail: ContentDetail = {
    content: { ...toContent(piece.data), count: images.length, cover: images.slice(0, 4).map((i) => i.thumb) },
    project: { id: project.data.id, name: project.data.name },
    images,
  };
  return NextResponse.json(detail);
});

export const PATCH = studioHandler<{ id: string }>(async ({ req, supabase, me, params: { id } }) => {
  const limited = overLimit(req, me);
  if (limited) return limited;
  if (!isUuid(id)) return notFound();
  const body = await readBody(req);
  if (!body) return badRequest();
  const text = readText(body, ["name", "description", "link"], false);
  if ("error" in text) return say(text.error, 400);
  const piece = await supabase.from("studio_contents").select("project_id").eq("id", id).eq("user_id", me).maybeSingle();
  if (piece.error) return studioFailure(piece.error, NOT_SAVED);
  if (!piece.data) return notFound();
  const brand = await brandOf(supabase, me, piece.data.project_id, body, false);
  if (brand instanceof Response) return brand;
  const { data, error } = await supabase.from("studio_contents")
    .update({ ...text.values, ...brand, updated_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", me)
    .select(COLS.content).maybeSingle();
  if (error) return studioFailure(error, NOT_SAVED, CONTENT_NAME_TAKEN);
  if (!data) return notFound();
  const pieces = await contentsOf(supabase, me, [data]);
  return pieces instanceof Response ? pieces : NextResponse.json({ content: pieces[0] });
});

export const DELETE = studioHandler<{ id: string }>(async ({ req, supabase, me, params: { id } }) => {
  const limited = overLimit(req, me);
  if (limited) return limited;
  if (!isUuid(id)) return notFound();
  const { data, error } = await supabase.from("studio_contents").delete().eq("id", id).eq("user_id", me).select("id");
  if (error) return studioFailure(error, NOT_DELETED);
  return data.length ? NextResponse.json({ deleted: true }) : notFound();
});
