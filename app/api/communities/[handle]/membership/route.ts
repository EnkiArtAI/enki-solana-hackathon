import { NextResponse } from "next/server";
import { MERGED_ALREADY, NOT_SAVED } from "@/lib/communities/types";
import { communityFailure, communityHandler, notFound, overLimit, resolveCommunity, say, type Supabase } from "@/lib/communities/server";

// Joining and leaving a community (lib/communities/types.ts, SQL 54). A merged handle answers 409 MERGED_ALREADY: the UI
// follows GET's redirect first.
// PUT    → { joined: true, members }: already in reads as in
// DELETE → { joined: false, members }

type Params = { handle: string };

function membership(join: boolean) {
  return communityHandler<Params>(async ({ req, supabase, me, params }) => {
    const limited = overLimit(req, me, "write");
    if (limited) return limited;
    const found = await resolveCommunity(supabase, params.handle);
    if (found instanceof Response) return found;
    if (!found) return notFound();
    if (found.merged) return say(MERGED_ALREADY, 409);
    const id = found.row.id;
    const { error } = join
      ? await supabase.from("community_members").insert({ community_id: id, user_id: me })
      : await supabase.from("community_members").delete().eq("community_id", id).eq("user_id", me);
    // 23505: a member already (a second press, another tab).
    if (error && error.code !== "23505") return communityFailure(error, NOT_SAVED);
    return answer(supabase, id, join);
  }, { session: "required" });
}

/** Its members as its card counts them (SQL 54's community_cards: hidden accounts left out). */
async function answer(supabase: Supabase, id: string, joined: boolean) {
  const { data, error } = await supabase.from("community_cards").select("members").eq("id", id).maybeSingle();
  if (error) return communityFailure(error, NOT_SAVED);
  return NextResponse.json({ joined, members: (data as { members: number } | null)?.members ?? 0 });
}

export const PUT = membership(true);
export const DELETE = membership(false);
