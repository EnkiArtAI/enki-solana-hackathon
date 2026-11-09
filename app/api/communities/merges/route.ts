import { NextResponse } from "next/server";
import { ADMIN_ONLY, NOT_READ, NOT_SAVED, type CommunityCardRow, type MergeGroup } from "@/lib/communities/types";
import {
  COLS, audit, badRequest, communityFailure, communityHandler, handlesOf, isUuid, notFound, overLimit, readBody, say, staffOf, toCard,
} from "@/lib/communities/server";

// The merge queue, admins only (Kev, 2026-10-30: "ich hab kb, dass es aber auch duplikate gibt wie gundam 1, gundam 2, und
// gundam iwas"; agreed: possible duplicates grouped by a core word, "merge into another (its links move, old handle
// redirects) or keep"; lib/communities/types.ts, SQL 54).
// GET                 → { groups }: live communities sharing a core word while one of them is not kept apart yet, the
//                       biggest group first, the biggest community first in each
// POST { from, into } → { merged: { from, into, links, members } } (handles); 400 MERGE_SAME; 409 MERGED_ALREADY
// POST { keep: ids }  → { kept }: those live communities kept apart until a new one of their core comes

const MAX_KEEP = 100;

export const GET = communityHandler(async ({ req, supabase, me }) => {
  const limited = overLimit(req, null, "read");
  if (limited) return limited;
  if ((await staffOf(supabase, me)) !== "admin") return say(ADMIN_ONLY, 403);
  const open = await supabase.from("communities").select("core").is("merged_into", null).is("core_reviewed_at", null).limit(1000);
  if (open.error) return communityFailure(open.error, NOT_READ);
  const cores = [...new Set((open.data as { core: string }[]).map((c) => c.core))];
  const read = cores.length ? await supabase.from("community_cards").select(COLS.card).in("core", cores) : { data: [], error: null };
  if (read.error) return communityFailure(read.error, NOT_READ);
  const rows = read.data as CommunityCardRow[];
  const creators = await handlesOf(supabase, rows.map((r) => r.created_by));
  if (creators instanceof Response) return creators;
  const size = (r: CommunityCardRow) => r.members + r.works;
  const groups: MergeGroup[] = cores
    .map((core) => rows.filter((r) => r.core === core).sort((a, b) => size(b) - size(a) || a.handle.localeCompare(b.handle)))
    .filter((g) => g.length >= 2)
    .sort((a, b) => b.length - a.length || a[0].core.localeCompare(b[0].core))
    .map((g) => ({
      core: g[0].core,
      communities: g.map((r) => ({ ...toCard(r), createdAt: r.created_at, createdBy: r.created_by ? creators.get(r.created_by) ?? null : null, reviewed: r.core_reviewed_at != null })),
    }));
  return NextResponse.json({ groups });
}, { session: "required" });

export const POST = communityHandler(async ({ req, supabase, me }) => {
  const limited = overLimit(req, me, "write");
  if (limited) return limited;
  const role = await staffOf(supabase, me);
  if (role !== "admin") return say(ADMIN_ONLY, 403);
  const body = await readBody(req);
  if (body && Array.isArray(body.keep)) {
    const ids = [...new Set(body.keep)];
    if (!ids.length || ids.length > MAX_KEEP || !ids.every(isUuid)) return badRequest();
    const { data, error } = await supabase.from("communities").update({ core_reviewed_at: new Date().toISOString() }).in("id", ids).is("merged_into", null).select("id");
    if (error) return communityFailure(error, NOT_SAVED);
    return audit(supabase, req, { userId: me, role }, { action: "keep", ids }, NextResponse.json({ kept: data.length }));
  }
  if (!body || !isUuid(body.from) || !isUuid(body.into)) return badRequest();
  const named = await supabase.from("communities").select("id, handle").in("id", [body.from, body.into]);
  if (named.error) return communityFailure(named.error, NOT_READ);
  const handle = new Map((named.data as { id: string; handle: string }[]).map((c) => [c.id, c.handle]));
  if (!handle.has(body.from) || !handle.has(body.into)) return notFound();
  // SQL 54's merge_community, one transaction: 'community merge same' 400, 'community merge gone' 409.
  const { data, error } = await supabase.rpc("merge_community", { p_from: body.from, p_into: body.into });
  if (error) return communityFailure(error, NOT_SAVED);
  const moved = data as { links: number; members: number };
  const merged = { from: handle.get(body.from)!, into: handle.get(body.into)!, links: moved.links, members: moved.members };
  return audit(supabase, req, { userId: me, role }, { action: "merge", id: body.from, handle: merged.into }, NextResponse.json({ merged }));
}, { session: "required" });
