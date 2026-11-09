import { NextResponse } from "next/server";
import { mayShowAdult, viewer } from "@/lib/adult-content";
import { ignoredIds } from "@/lib/ignores";
import { NOT_DELETED, NOT_READ, NOT_YOURS, POST_ANSWERS } from "@/lib/communities/types";
import {
  COLS, audit, communityFailure, communityHandler, isUuid, notFound, overLimit, postsOf, say, staffOf, visibleTo, type Entry,
} from "@/lib/communities/server";

// One Showroom post (lib/communities/types.ts, SQL 54).
// GET    → { post }: while its render may be shown (18+ only to whom may see it), with up to POST_ANSWERS answers, newest first
// DELETE → { deleted: true }: its poster's, or Enki staff's (logged); its answers become posts of their own

type Params = { id: string };

export const GET = communityHandler<Params>(async ({ req, supabase, me, params: { id } }) => {
  const limited = overLimit(req, null, "read");
  if (limited) return limited;
  if (!isUuid(id)) return notFound();
  const v = await viewer(supabase, req);
  const found = await supabase.from("showroom_entries").select(`${COLS.entry}, is_adult`).eq("id", id).maybeSingle();
  if (found.error) return communityFailure(found.error, NOT_READ);
  const entry = found.data as (Entry & { is_adult: boolean }) | null;
  if (!entry || (entry.is_adult && !mayShowAdult(v, entry.user_id))) return notFound();
  const kids = await visibleTo(supabase.from("showroom_entries").select(COLS.entry, { count: "exact" }).eq("parent_id", id), v, await ignoredIds(supabase, v.userId))
    .order("created_at", { ascending: false }).order("id", { ascending: true }).limit(POST_ANSWERS);
  if (kids.error) return communityFailure(kids.error, NOT_READ);
  const posts = await postsOf(supabase, me, [entry], new Map([[id, { rows: kids.data as Entry[], total: kids.count ?? kids.data.length }]]));
  if (posts instanceof Response) return posts;
  return posts[0] ? NextResponse.json({ post: posts[0] }) : notFound();
}, { session: "optional" });

export const DELETE = communityHandler<Params>(async ({ req, supabase, me, params: { id } }) => {
  const limited = overLimit(req, me, "write");
  if (limited) return limited;
  if (!isUuid(id)) return notFound();
  const found = await supabase.from("showroom_posts").select("user_id").eq("id", id).maybeSingle();
  if (found.error) return communityFailure(found.error, NOT_DELETED);
  if (!found.data) return notFound();
  const role = found.data.user_id === me ? null : await staffOf(supabase, me);
  if (found.data.user_id !== me && !role) return say(NOT_YOURS, 403);
  const { error } = await supabase.from("showroom_posts").delete().eq("id", id);
  if (error) return communityFailure(error, NOT_DELETED);
  const done = NextResponse.json({ deleted: true });
  return role ? audit(supabase, req, { userId: me, role }, { action: "delete-post", id }, done) : done;
}, { session: "required" });
