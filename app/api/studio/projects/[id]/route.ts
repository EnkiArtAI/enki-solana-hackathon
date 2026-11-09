import { NextResponse } from "next/server";
import { NOT_DELETED, NOT_READ, NOT_SAVED, PROJECT_NAME_TAKEN, STUDIO_BUCKET, type ProjectDetail } from "@/lib/studio/types";
import {
  COLS, badRequest, charactersOf, contentsOf, isUuid, notFound, overLimit, pathsOf, readBody, readText, say, signAssets,
  studioFailure, studioHandler, toMasterPrompt, toProject, toStyle,
} from "@/lib/studio/server";

// One project of the signed-in account's (lib/studio/types.ts, SQL 53); someone else's reads as none (404).
// GET                → ProjectDetail: the project, its assets (newest first, signed), characters, styles and master
//                      prompts (oldest first: the first style and master prompt are a new content piece's defaults) and
//                      content pieces (newest first, with their counts and covers)
// PATCH ProjectInput → { project }: an absent field stays, null clears an optional one
// DELETE             → { deleted: true }: the project and everything in it, for good (its renders stay in the gallery)

export const GET = studioHandler<{ id: string }>(async ({ supabase, me, params: { id } }) => {
  if (!isUuid(id)) return notFound();
  const [project, assets, characters, styles, masterPrompts, contents] = await Promise.all([
    supabase.from("studio_projects").select(COLS.project).eq("id", id).eq("user_id", me).maybeSingle(),
    supabase.from("studio_assets").select(COLS.asset).eq("project_id", id).eq("user_id", me).order("created_at", { ascending: false }),
    supabase.from("studio_characters").select(COLS.character).eq("project_id", id).eq("user_id", me).order("created_at", { ascending: true }),
    supabase.from("studio_styles").select(COLS.style).eq("project_id", id).eq("user_id", me).order("created_at", { ascending: true }),
    supabase.from("studio_master_prompts").select(COLS.masterPrompt).eq("project_id", id).eq("user_id", me).order("created_at", { ascending: true }),
    supabase.from("studio_contents").select(COLS.content).eq("project_id", id).eq("user_id", me).order("created_at", { ascending: false }),
  ]);
  if (project.error || assets.error || characters.error || styles.error || masterPrompts.error || contents.error) {
    return studioFailure(project.error ?? assets.error ?? characters.error ?? styles.error ?? masterPrompts.error ?? contents.error, NOT_READ);
  }
  if (!project.data) return notFound();
  const signedAssets = await signAssets(supabase, assets.data);
  if (!signedAssets) return say(NOT_READ, 500);
  const [chars, pieces] = await Promise.all([
    charactersOf(supabase, me, characters.data, signedAssets),
    contentsOf(supabase, me, contents.data),
  ]);
  if (chars instanceof Response) return chars;
  if (pieces instanceof Response) return pieces;
  const detail: ProjectDetail = {
    project: toProject(project.data), assets: signedAssets, characters: chars,
    styles: styles.data.map(toStyle), masterPrompts: masterPrompts.data.map(toMasterPrompt), contents: pieces,
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
  const { data, error } = await supabase.from("studio_projects")
    .update({ ...text.values, updated_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", me)
    .select(COLS.project).maybeSingle();
  if (error) return studioFailure(error, NOT_SAVED, PROJECT_NAME_TAKEN);
  return data ? NextResponse.json({ project: toProject(data) }) : notFound();
});

export const DELETE = studioHandler<{ id: string }>(async ({ req, supabase, me, params: { id } }) => {
  const limited = overLimit(req, me);
  if (limited) return limited;
  if (!isUuid(id)) return notFound();
  // Its pictures' files, read before the rows go with the project (SQL 53 cascades every child row).
  const files = await supabase.from("studio_assets").select("path, thumb_path").eq("project_id", id).eq("user_id", me);
  if (files.error) return studioFailure(files.error, NOT_DELETED);
  const { data, error } = await supabase.from("studio_projects").delete().eq("id", id).eq("user_id", me).select("id");
  if (error) return studioFailure(error, NOT_DELETED);
  if (!data.length) return notFound();
  // Best effort, as app/api/references: a file left behind stays private, and the project is gone either way.
  const paths = files.data.flatMap(pathsOf);
  if (paths.length) await supabase.storage.from(STUDIO_BUCKET).remove(paths).catch(() => null);
  return NextResponse.json({ deleted: true });
});
