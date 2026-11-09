import { NextResponse } from "next/server";
import { NOT_READ, NOT_SAVED, PROJECT_NAME_TAKEN, type ProjectSummary } from "@/lib/studio/types";
import { COLS, badRequest, overLimit, readBody, readText, say, signAssets, studioFailure, studioHandler, toProject } from "@/lib/studio/server";

// Studio's projects (Kev, 2026-10-30: "a collection of projects containing different content pieces that all access
// the same reference images, characters, styles and master prompts"; lib/studio/types.ts, SQL 53).
// GET               → { projects }: the signed-in account's, newest first, each with its counts and its 4 newest
//                     assets' tiles, signed for its owner (none while the store cannot sign)
// POST ProjectInput → 201 { project }

export const GET = studioHandler(async ({ supabase, me }) => {
  const [projects, assets, characters, contents] = await Promise.all([
    supabase.from("studio_projects").select(COLS.project).eq("user_id", me).order("created_at", { ascending: false }),
    supabase.from("studio_assets").select(COLS.asset).eq("user_id", me).order("created_at", { ascending: false }),
    supabase.from("studio_characters").select("project_id").eq("user_id", me),
    supabase.from("studio_contents").select("project_id").eq("user_id", me),
  ]);
  if (projects.error || assets.error || characters.error || contents.error) {
    return studioFailure(projects.error ?? assets.error ?? characters.error ?? contents.error, NOT_READ);
  }
  const of = <T extends { project_id: string }>(rows: T[], id: string) => rows.filter((r) => r.project_id === id);
  // Every cover tile in one signing call. A store that cannot sign leaves the covers empty, never the list: the menu's
  // projects need none of it (Kev, 2026-10-30: "ein untermenü meiner projekte ... FALLS ich welche hab").
  const tiles = (await signAssets(supabase, projects.data.flatMap((p) => of(assets.data, p.id).slice(0, 4)))) ?? [];
  const list: ProjectSummary[] = projects.data.map((p) => ({
    ...toProject(p),
    counts: { assets: of(assets.data, p.id).length, characters: of(characters.data, p.id).length, contents: of(contents.data, p.id).length },
    cover: tiles.filter((t) => t.projectId === p.id).map((t) => t.thumb),
  }));
  return NextResponse.json({ projects: list });
});

export const POST = studioHandler(async ({ req, supabase, me }) => {
  const limited = overLimit(req, me);
  if (limited) return limited;
  const body = await readBody(req);
  if (!body) return badRequest();
  const text = readText(body, ["name", "description", "link"], true);
  if ("error" in text) return say(text.error, 400);
  const { data, error } = await supabase.from("studio_projects").insert({ user_id: me, ...text.values }).select(COLS.project).single();
  // 23514: the account's 10 (SQL 53's cap); 23505: a project of that name (case and spaces ignored).
  if (error) return studioFailure(error, NOT_SAVED, PROJECT_NAME_TAKEN);
  return NextResponse.json({ project: toProject(data) }, { status: 201 });
});
