import { NextResponse } from "next/server";
import { NOT_A_REFERENCE, readUpload, thumbOf } from "@/lib/reference-library";
import {
  BAD_PALETTE, CONTENT_NAME_TAKEN, MAX_PROJECT_ASSETS, MAX_STUDIO_ASSETS, NOT_IN_PROJECT, NOT_SAVED, NOT_YOUR_RENDER, ONE_PICTURE, PROJECT_KINDS,
  PROJECT_ASSETS_FULL, SHEET_GONE, STUDIO_ASSETS_FULL, STUDIO_BUCKET, STUDIO_NOT_READY, STUDIO_PREFIX,
} from "@/lib/studio/types";
import {
  COLS, badRequest, brandOf, charactersOf, isUuid, notFound, overLimit, readBody, readPalette, readText, say, signAssets,
  studioFailure, studioHandler, toContent, toMasterPrompt, toStyle, type Supabase,
} from "@/lib/studio/server";

// What a project of the signed-in account's gets (lib/studio/types.ts, SQL 53); someone else's project reads as none.
// POST /assets         { image }          → 201 { asset }, or 200 with the row already there for the same picture
// POST /characters     CharacterInput     → 201 { character }: one of the caller's renders or one of this project's assets
// POST /styles         StyleInput         → 201 { style }
// POST /master-prompts MasterPromptInput  → 201 { masterPrompt }
// POST /contents       ContentInput       → 201 { content }: its style and master prompt this project's, or none

type Body = Record<string, unknown>;
type Make = (supabase: Supabase, me: string, project: string, body: Body) => Promise<Response>;

export const POST = studioHandler<{ id: string; kind: string }>(async ({ req, supabase, me, params: { id, kind } }) => {
  if (!(PROJECT_KINDS as readonly string[]).includes(kind)) return notFound();
  const limited = overLimit(req, me, kind === "assets");
  if (limited) return limited;
  if (!isUuid(id)) return notFound();
  const project = await supabase.from("studio_projects").select("id").eq("id", id).eq("user_id", me).maybeSingle();
  if (project.error) return studioFailure(project.error, NOT_SAVED);
  if (!project.data) return notFound();
  const body = await readBody(req);
  if (kind === "assets") return addAsset(supabase, me, id, body ?? {});
  if (!body) return badRequest();
  return MAKE[kind as keyof typeof MAKE](supabase, me, id, body);
});

const answerAsset = async (supabase: Supabase, row: Parameters<typeof signAssets>[1][number], status: number) => {
  const [asset] = (await signAssets(supabase, [row])) ?? [];
  return asset ? NextResponse.json({ asset }, { status }) : say(NOT_SAVED, 503);
};

/** A picture, as the reference picker reads it (lib/reference-library readUpload), kept in SQL 51's private bucket. */
const addAsset: Make = async (supabase, me, project, body) => {
  const upload = readUpload(body.image);
  if (!upload) return say(NOT_A_REFERENCE, 400);
  const assets = () => supabase.from("studio_assets");
  const same = () => assets().select(COLS.asset).eq("project_id", project).eq("user_id", me).eq("content_hash", upload.hash).maybeSingle();
  // The same picture in this project is that row: no second row, and no second file while its own is there. A row
  // whose file is gone (a delete of the picture beside an add of it) is left out of every answer yet counted: its files
  // are stored again below, so it shows again, and the insert meets the row and answers it.
  const there = await same();
  if (there.error) return studioFailure(there.error, NOT_SAVED);
  if (there.data) {
    const kept = await signAssets(supabase, [there.data]);
    if (!kept) return say(NOT_SAVED, 503);
    if (kept.length) return NextResponse.json({ asset: kept[0] }, { status: 200 });
  } else {
    // Before anything is stored, so a full account or project leaves no file behind (in the order SQL 53's triggers
    // fire, by name: the account's cap, then the project's). The triggers hold both against two adds at once.
    const [inAccount, inProject] = await Promise.all([
      assets().select("id", { count: "exact", head: true }).eq("user_id", me),
      assets().select("id", { count: "exact", head: true }).eq("project_id", project).eq("user_id", me),
    ]);
    const countError = inAccount.error ?? inProject.error;
    if (countError) return studioFailure(countError, NOT_SAVED);
    // A head read of a table SQL 53 has not made answers no error and no count (app/api/references/route.ts).
    if (inAccount.count === null || inProject.count === null) return say(STUDIO_NOT_READY, 503);
    if (inAccount.count >= MAX_STUDIO_ASSETS) return say(STUDIO_ASSETS_FULL, 409);
    if (inProject.count >= MAX_PROJECT_ASSETS) return say(PROJECT_ASSETS_FULL, 409);
  }

  const tile = await thumbOf(upload.bytes);
  if (!tile) return say(NOT_A_REFERENCE, 400);
  // Named by the picture's hash within its project, so the same picture again overwrites its own files.
  const base = `${STUDIO_PREFIX}/${me}/${project}/${upload.hash}`;
  const [path, tilePath] = [`${base}.${upload.type.slice("image/".length)}`, `${base}.tile.webp`];
  const bucket = supabase.storage.from(STUDIO_BUCKET);
  const [stored, tiled] = await Promise.all([
    bucket.upload(path, upload.bytes, { contentType: upload.type, upsert: true }),
    bucket.upload(tilePath, tile, { contentType: "image/webp", upsert: true }),
  ]);
  if (stored.error) return say(NOT_SAVED, 503);
  const { data, error } = await assets()
    .insert({ project_id: project, user_id: me, path, thumb_path: tiled.error ? null : tilePath, content_hash: upload.hash })
    .select(COLS.asset).single();
  if (!error) return answerAsset(supabase, data, 201);
  // The same picture, added beside this one, is that row, and these files are its files (whichever key or cap met
  // this insert first).
  const again = await same();
  if (again.data) return answerAsset(supabase, again.data, 200);
  // Otherwise nothing names them: a cap met by an add beside this one (23514), or a failure.
  await bucket.remove([path, tilePath]).catch(() => null);
  return studioFailure(error, NOT_SAVED);
};

/** A character: exactly one picture, one of the caller's own renders (never an upload) or one of this project's assets,
 *  and the character sheet it was rendered with. */
const addCharacter: Make = async (supabase, me, project, body) => {
  const text = readText(body, ["name"], true);
  if ("error" in text) return say(text.error, 400);
  const { imageId, assetId, sheetPromptId } = body;
  if ((imageId == null) === (assetId == null)) return say(ONE_PICTURE, 400);
  if (sheetPromptId != null && !isUuid(sheetPromptId)) return badRequest();
  if (imageId != null) {
    if (!isUuid(imageId)) return say(NOT_YOUR_RENDER, 400);
    const render = await supabase.from("generated_images").select("id")
      .eq("id", imageId).eq("user_id", me).eq("is_uploaded", false).is("deleted_at", null).maybeSingle();
    if (render.error) return studioFailure(render.error, NOT_SAVED);
    if (!render.data) return say(NOT_YOUR_RENDER, 400);
  } else {
    if (!isUuid(assetId)) return say(NOT_IN_PROJECT, 400);
    const asset = await supabase.from("studio_assets").select("id").eq("id", assetId).eq("project_id", project).eq("user_id", me).maybeSingle();
    if (asset.error) return studioFailure(asset.error, NOT_SAVED);
    if (!asset.data) return say(NOT_IN_PROJECT, 400);
  }
  const { data, error } = await supabase.from("studio_characters")
    .insert({ project_id: project, user_id: me, name: text.values.name, image_id: imageId ?? null, asset_id: assetId ?? null, sheet_prompt_id: sheetPromptId ?? null })
    .select(COLS.character).single();
  // 23503 on the sheet's key: that prompt is no longer on Enki.
  if (error?.code === "23503" && /sheet_prompt_id/.test(error.message)) return say(SHEET_GONE, 400);
  if (error) return studioFailure(error, NOT_SAVED);
  const made = await charactersOf(supabase, me, [data]);
  return made instanceof Response ? made : NextResponse.json({ character: made[0] }, { status: 201 });
};

const MAKE: Record<"characters" | "styles" | "master-prompts" | "contents", Make> = {
  characters: addCharacter,

  styles: async (supabase, me, project, body) => {
    const text = readText(body, ["name", "words"], true);
    if ("error" in text) return say(text.error, 400);
    const palette = readPalette(body.palette);
    if (!palette) return say(BAD_PALETTE, 400);
    const { data, error } = await supabase.from("studio_styles")
      .insert({ project_id: project, user_id: me, ...text.values, palette }).select(COLS.style).single();
    if (error) return studioFailure(error, NOT_SAVED);
    return NextResponse.json({ style: toStyle(data) }, { status: 201 });
  },

  "master-prompts": async (supabase, me, project, body) => {
    const text = readText(body, ["name", "prompt"], true);
    if ("error" in text) return say(text.error, 400);
    const { data, error } = await supabase.from("studio_master_prompts")
      .insert({ project_id: project, user_id: me, ...text.values }).select(COLS.masterPrompt).single();
    if (error) return studioFailure(error, NOT_SAVED);
    return NextResponse.json({ masterPrompt: toMasterPrompt(data) }, { status: 201 });
  },

  contents: async (supabase, me, project, body) => {
    const text = readText(body, ["name", "description", "link"], true);
    if ("error" in text) return say(text.error, 400);
    const brand = await brandOf(supabase, me, project, body, true);
    if (brand instanceof Response) return brand;
    const { data, error } = await supabase.from("studio_contents")
      .insert({ project_id: project, user_id: me, ...text.values, ...brand }).select(COLS.content).single();
    if (error) return studioFailure(error, NOT_SAVED, CONTENT_NAME_TAKEN);
    return NextResponse.json({ content: { ...toContent(data), count: 0, cover: [] } }, { status: 201 });
  },
};
