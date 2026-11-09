import { NextResponse } from "next/server";
import { handleKey, slugify } from "@/lib/communities/handle";
import {
  ADMIN_ONLY, ALIAS_IS_A_HANDLE, ALIASES_FULL, COMMUNITY_TEXT, MAX_ALIASES, MERGED_ALREADY, NOT_DELETED, NOT_READ, NOT_SAVED, NOT_YOURS,
  TOO_LONG,
} from "@/lib/communities/types";
import {
  audit, badRequest, communityFailure, communityHandler, detailOf, notFound, overLimit, readBody, readText, resolveCommunity, say,
  screened, staffOf,
} from "@/lib/communities/server";

// One community (lib/communities/types.ts, SQL 54).
// GET                 → { community } | { redirect }: a merged handle's target, or the canonical spelling of a look-alike
// PATCH CommunityPatch → { community }: its creator or an admin; search words replace the list
// DELETE              → { deleted: true }: an admin's, for spam on a permissionless surface; logged

type Params = { handle: string };

export const GET = communityHandler<Params>(async ({ req, supabase, me, params }) => {
  const limited = overLimit(req, null, "read");
  if (limited) return limited;
  const found = await resolveCommunity(supabase, params.handle);
  if (found instanceof Response) return found;
  if (!found) return notFound();
  if (found.redirect) return NextResponse.json({ redirect: found.redirect });
  const detail = await detailOf(supabase, found.row.id, me);
  if (detail instanceof Response) return detail;
  return detail ? NextResponse.json({ community: detail }) : notFound();
}, { session: "optional" });

export const PATCH = communityHandler<Params>(async ({ req, supabase, me, params }) => {
  const limited = overLimit(req, me, "write");
  if (limited) return limited;
  const found = await resolveCommunity(supabase, params.handle);
  if (found instanceof Response) return found;
  if (!found) return notFound();
  if (found.merged) return say(MERGED_ALREADY, 409);
  const { row } = found;
  if (row.created_by !== me && (await staffOf(supabase, me)) !== "admin") return say(NOT_YOURS, 403);
  const body = await readBody(req);
  if (!body) return badRequest();
  const text = readText(body, ["name", "description"], false);
  if ("error" in text) return say(text.error, 400);
  // Search words as handle-shaped slugs, one per key, not its own handle's; one too short to find anything is dropped.
  let aliases: string[] | undefined;
  if (body.aliases !== undefined) {
    if (!Array.isArray(body.aliases) || body.aliases.some((a) => typeof a !== "string")) return badRequest();
    if ((body.aliases as string[]).some((a) => a.trim().length > COMMUNITY_TEXT.alias)) return say(TOO_LONG.alias, 400);
    const byKey = new Map<string, string>();
    for (const slug of (body.aliases as string[]).map((a) => slugify(a, COMMUNITY_TEXT.alias))) {
      if (slug.length >= 2 && handleKey(slug) !== handleKey(row.handle) && !byKey.has(handleKey(slug))) byKey.set(handleKey(slug), slug);
    }
    if (byKey.size > MAX_ALIASES) return say(ALIASES_FULL, 409);
    aliases = [...byKey.values()];
    // Another community's handle (a merged one's too; not one merged into this) as a search word would take its search
    // and its suggestion: refused before anything is written.
    const clash = byKey.size ? await supabase.from("communities").select("id, handle_key, merged_into").in("handle_key", [...byKey.keys()]) : { data: [], error: null };
    if (clash.error) return communityFailure(clash.error, NOT_READ);
    const theirs = (clash.data as { id: string; handle_key: string; merged_into: string | null }[]).find((c) => (c.merged_into ?? c.id) !== row.id);
    if (theirs) return say(ALIAS_IS_A_HANDLE, 409, { alias: byKey.get(theirs.handle_key) });
  }
  const refused = screened({ ...text.values, aliases: aliases?.join(" ").replaceAll("_", " ") });
  if (refused) return refused;

  if (Object.keys(text.values).length) {
    const { error } = await supabase.from("communities").update({ ...text.values, updated_at: new Date().toISOString() }).eq("id", row.id);
    if (error) return communityFailure(error, NOT_SAVED);
  }
  if (aliases) {
    // The difference only: words kept stay, so a write that fails midway never loses them.
    const now = await supabase.from("community_aliases").select("alias, alias_key").eq("community_id", row.id);
    if (now.error) return communityFailure(now.error, NOT_SAVED);
    const keep = new Set(aliases.map(handleKey));
    const had = new Set((now.data as { alias_key: string }[]).map((a) => a.alias_key));
    const gone = [...had].filter((k) => !keep.has(k));
    if (gone.length) {
      const { error } = await supabase.from("community_aliases").delete().eq("community_id", row.id).in("alias_key", gone);
      if (error) return communityFailure(error, NOT_SAVED);
    }
    const added = aliases.filter((a) => !had.has(handleKey(a)));
    if (added.length) {
      const { error } = await supabase.from("community_aliases").insert(added.map((alias) => ({ community_id: row.id, alias })));
      if (error) return communityFailure(error, NOT_SAVED);
    }
  }
  const detail = await detailOf(supabase, row.id, me);
  if (detail instanceof Response) return detail;
  return detail ? NextResponse.json({ community: detail }) : notFound();
}, { session: "required" });

export const DELETE = communityHandler<Params>(async ({ req, supabase, me, params }) => {
  const limited = overLimit(req, me, "write");
  if (limited) return limited;
  const role = await staffOf(supabase, me);
  if (role !== "admin") return say(ADMIN_ONLY, 403);
  const found = await resolveCommunity(supabase, params.handle);
  if (found instanceof Response) return found;
  if (!found) return notFound();
  if (found.merged) return say(MERGED_ALREADY, 409);
  // Its links, members, search words and the handles merged into it go with it (SQL 54's cascades).
  const { error } = await supabase.from("communities").delete().eq("id", found.row.id);
  if (error) return communityFailure(error, NOT_DELETED);
  return audit(supabase, req, { userId: me, role }, { action: "delete", id: found.row.id, handle: found.row.handle }, NextResponse.json({ deleted: true }));
}, { session: "required" });
