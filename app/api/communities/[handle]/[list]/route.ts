import { NextResponse } from "next/server";
import { viewer } from "@/lib/adult-content";
import { ignoredIds } from "@/lib/ignores";
import { hiddenOwners } from "@/lib/hidden-owners";
import {
  COMMUNITY_LISTS, INLINE_ANSWERS, MEMBERS_PAGE, NOT_READ, SHOWROOM_PAGE, WORK_SORTS, WORKS_PAGE, type CommunityList, type WorkSort,
} from "@/lib/communities/types";
import {
  COLS, badRequest, communityFailure, communityHandler, handlesOf, notFound, offsetOf, overLimit, postsOf, resolveCommunity, say,
  visibleTo, worksOf, type Entry,
} from "@/lib/communities/server";

// A community's lists (lib/communities/types.ts COMMUNITY_LISTS, SQL 54); its prompts are GET /api/marketplace/prompts?community=.
// Each leaves out 18+ unless the viewer may see it, and whom the viewer ignores (works and posts; lib/adult-content,
// lib/ignores); SQL 54's views leave out hidden owners.
// GET works?sort=new|top&cursor= → { works, next }: every image and video in it (Kev, 2026-10-30: "i want at one point to
//                                   filter for a community and then see all images and videos with it created")
// GET members?cursor=           → { members, next }: newest first, its creator marked
// GET showroom?cursor=          → { posts, next }: its top-level posts, newest first, each with its newest answers

type Params = { handle: string; list: string };
const WORK_ORDER: Record<WorkSort, [string, boolean][]> = {
  new: [["added_at", false], ["image_id", true]],
  top: [["like_count", false], ["added_at", false], ["image_id", true]],
};
// The answers read for one page of posts, newest first: enough to count them and show INLINE_ANSWERS each.
const ANSWER_ROWS = 1000;

export const GET = communityHandler<Params>(async ({ req, supabase, me, params }) => {
  const limited = overLimit(req, null, "read");
  if (limited) return limited;
  if (!COMMUNITY_LISTS.includes(params.list as CommunityList)) return notFound();
  const list = params.list as CommunityList;
  const query = new URL(req.url).searchParams;
  const sort = (query.get("sort") ?? "new") as WorkSort;
  if (list === "works" && !WORK_SORTS.includes(sort)) return badRequest();
  const found = await resolveCommunity(supabase, params.handle);
  if (found instanceof Response) return found;
  if (!found) return notFound();
  const { id, created_by } = found.row;
  const offset = offsetOf(query.get("cursor"));
  const page = (rows: unknown[], size: number) => ({ rows: rows.slice(0, size), next: rows.length > size ? String(offset + size) : null });

  if (list === "members") {
    const { data, error } = await supabase.from("community_members").select("user_id, created_at").eq("community_id", id)
      .order("created_at", { ascending: false }).order("user_id", { ascending: true }).range(offset, offset + MEMBERS_PAGE);
    if (error) return communityFailure(error, NOT_READ);
    const { rows, next } = page(data, MEMBERS_PAGE);
    // A deleted, inactive or banned account is no member to show (lib/hidden-owners.ts; SQL 54's cards count it out too):
    // a page may come out short, the cursor moves on.
    const hidden = await hiddenOwners(supabase, (rows as { user_id: string }[]).map((m) => m.user_id));
    if (!hidden) return say(NOT_READ, 500);
    const members = (rows as { user_id: string; created_at: string }[]).filter((m) => !hidden.has(m.user_id));
    const handles = await handlesOf(supabase, members.map((m) => m.user_id));
    if (handles instanceof Response) return handles;
    return NextResponse.json({ members: members.map((m) => ({ handle: handles.get(m.user_id) ?? null, creator: m.user_id === created_by, joinedAt: m.created_at })), next });
  }

  const v = await viewer(supabase, req);
  const ignored = await ignoredIds(supabase, v.userId);
  if (list === "works") {
    let read = visibleTo(supabase.from("community_works").select(COLS.work).eq("community_id", id), v, ignored);
    for (const [column, ascending] of WORK_ORDER[sort]) read = read.order(column, { ascending });
    const { data, error } = await read.range(offset, offset + WORKS_PAGE);
    if (error) return communityFailure(error, NOT_READ);
    const { rows, next } = page(data, WORKS_PAGE);
    const works = await worksOf(supabase, rows as Parameters<typeof worksOf>[1]);
    return works instanceof Response ? works : NextResponse.json({ works, next });
  }

  const posts = () => visibleTo(supabase.from("community_posts").select(COLS.entry).eq("community_id", id), v, ignored);
  const { data, error } = await posts().is("parent_id", null)
    .order("created_at", { ascending: false }).order("id", { ascending: true }).range(offset, offset + SHOWROOM_PAGE);
  if (error) return communityFailure(error, NOT_READ);
  const { rows, next } = page(data, SHOWROOM_PAGE);
  const top = rows as Entry[];
  const kids = top.length
    ? await posts().in("parent_id", top.map((p) => p.id)).order("created_at", { ascending: false }).order("id", { ascending: true }).limit(ANSWER_ROWS)
    : { data: [], error: null };
  if (kids.error) return communityFailure(kids.error, NOT_READ);
  const answers = new Map<string, { rows: Entry[]; total: number }>();
  for (const k of kids.data as Entry[]) {
    const a = answers.get(k.parent_id!) ?? { rows: [], total: 0 };
    if (a.rows.length < INLINE_ANSWERS) a.rows.push(k);
    a.total += 1;
    answers.set(k.parent_id!, a);
  }
  const shown = await postsOf(supabase, me, top, answers);
  return shown instanceof Response ? shown : NextResponse.json({ posts: shown, next });
}, { session: "optional" });
