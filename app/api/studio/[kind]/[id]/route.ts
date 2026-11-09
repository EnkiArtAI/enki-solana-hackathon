import { NextResponse } from "next/server";
import { ASSET_IN_USE, BAD_PALETTE, ITEM_KINDS, NOT_DELETED, NOT_SAVED, STUDIO_BUCKET } from "@/lib/studio/types";
import {
  COLS, ITEM_TABLE, badRequest, charactersOf, isUuid, notFound, overLimit, pathsOf, readBody, readPalette, readText, say,
  studioFailure, studioHandler, toMasterPrompt, toStyle,
} from "@/lib/studio/server";

// One thing in a project of the signed-in account's (lib/studio/types.ts ITEM_KINDS, SQL 53); someone else's reads as
// none (404). Content pieces have their own folder (app/api/studio/contents/[id]).
// PATCH /characters/[id]     { name }                   → { character }
// PATCH /styles/[id]         { name?, words?, palette? } → { style }
// PATCH /master-prompts/[id] { name?, prompt? }         → { masterPrompt }   (an asset has nothing to change)
// DELETE /<kind>/[id]                                    → { deleted: true }; an asset a character uses is refused
//                                                          (409), and its files go after its row

export const PATCH = studioHandler<{ kind: string; id: string }>(async ({ req, supabase, me, params: { kind, id } }) => {
  if (kind !== "characters" && kind !== "styles" && kind !== "master-prompts") return notFound();
  const limited = overLimit(req, me);
  if (limited) return limited;
  if (!isUuid(id)) return notFound();
  const body = await readBody(req);
  if (!body) return badRequest();

  if (kind === "characters") {
    // A character has its name to change, nothing else: a new picture is a new character.
    const text = readText(body, ["name"], true);
    if ("error" in text) return say(text.error, 400);
    const { data, error } = await supabase.from("studio_characters").update(text.values)
      .eq("id", id).eq("user_id", me).select(COLS.character).maybeSingle();
    if (error) return studioFailure(error, NOT_SAVED);
    if (!data) return notFound();
    const made = await charactersOf(supabase, me, [data]);
    return made instanceof Response ? made : NextResponse.json({ character: made[0] });
  }

  const text = readText(body, kind === "styles" ? ["name", "words"] : ["name", "prompt"], false);
  if ("error" in text) return say(text.error, 400);
  const updated_at = new Date().toISOString();
  if (kind === "styles") {
    // An absent palette stays; null clears it.
    const palette = body.palette === undefined ? undefined : readPalette(body.palette);
    if (palette === null) return say(BAD_PALETTE, 400);
    const { data, error } = await supabase.from("studio_styles").update({ ...text.values, ...(palette && { palette }), updated_at })
      .eq("id", id).eq("user_id", me).select(COLS.style).maybeSingle();
    if (error) return studioFailure(error, NOT_SAVED);
    return data ? NextResponse.json({ style: toStyle(data) }) : notFound();
  }
  const { data, error } = await supabase.from("studio_master_prompts").update({ ...text.values, updated_at })
    .eq("id", id).eq("user_id", me).select(COLS.masterPrompt).maybeSingle();
  if (error) return studioFailure(error, NOT_SAVED);
  return data ? NextResponse.json({ masterPrompt: toMasterPrompt(data) }) : notFound();
});

export const DELETE = studioHandler<{ kind: string; id: string }>(async ({ req, supabase, me, params: { kind, id } }) => {
  if (!(ITEM_KINDS as readonly string[]).includes(kind)) return notFound();
  const limited = overLimit(req, me);
  if (limited) return limited;
  if (!isUuid(id)) return notFound();
  const asset = kind === "assets";
  const { data, error } = await supabase.from(ITEM_TABLE[kind as keyof typeof ITEM_TABLE]).delete()
    .eq("id", id).eq("user_id", me).select("*");
  // 23503: a character is made of this asset (SQL 53's key on it, checked at the statement's end).
  if (error?.code === "23503" && asset) return say(ASSET_IN_USE, 409);
  if (error) return studioFailure(error, NOT_DELETED);
  if (!data.length) return notFound();
  // Best effort, as app/api/references: a file left behind stays private, and the row is gone either way.
  if (asset) await supabase.storage.from(STUDIO_BUCKET).remove(data.flatMap(pathsOf)).catch(() => null);
  return NextResponse.json({ deleted: true });
});
