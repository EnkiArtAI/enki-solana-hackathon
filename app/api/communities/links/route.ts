import { NextResponse } from "next/server";
import { hiddenOwners } from "@/lib/hidden-owners";
import {
  ANSWER_FOLLOWS_ITS_POST, ITEM_KINDS, MAX_COMMUNITIES_PER_WORK, MAX_LINK_AT_ONCE, NOT_READ, NOT_SAVED, TOO_MANY_COMMUNITIES,
  type ItemCommunities, type ItemKind,
} from "@/lib/communities/types";
import {
  ITEM, badRequest, communityFailure, communityHandler, isUuid, itemCommunities, notFound, overLimit, placesOf, readBody, say,
  type Supabase,
} from "@/lib/communities/server";

// The communities of one item, and setting them (Kev, 2026-10-30: "ein bild kann auch mehreren communities zugeteilt
// werden ... max 18 communities pro werk"; lib/communities/types.ts, SQL 54). A render made from a listed prompt is in
// that prompt's communities without a row of its own (SQL 54's community_works reads it in); its owner can take it out.
// GET ?kind=&id= → ItemCommunities: anyone who may see the item (a listed prompt, a public render, a post whose render is
//                  public) or its owner; 404 else
// PUT LinksInput → { items }: its owner's, each item's whole list (its prompt's included: one left out is opted out of,
//                  one put back is in again), up to MAX_COMMUNITIES_PER_WORK; a community a moderator hid it from stays out

type Item = { id: string; owner: string; promptId: string | null; visible: boolean; answer?: boolean };

/** The items among `ids`, as their owner reads them: a render with its prompt while that prompt brings it communities
 *  (listed, its creator not hidden: SQL 54's community_reach rule), a post with whether it answers another. A prompt
 *  deleted, a render deleted or uploaded, is none. */
async function itemsOf(supabase: Supabase, kind: ItemKind, ids: string[]): Promise<Map<string, Item> | Response> {
  if (kind === "prompt") {
    const { data, error } = await supabase.from("prompts").select("id, creator_id, is_listed, listing_status").in("id", ids).is("deleted_at", null);
    if (error) return communityFailure(error, NOT_READ);
    return new Map((data as { id: string; creator_id: string; is_listed: boolean; listing_status: string }[])
      .map((p) => [p.id, { id: p.id, owner: p.creator_id, promptId: null, visible: p.is_listed && p.listing_status === "active" }]));
  }
  if (kind === "post") {
    const [posts, entries] = await Promise.all([
      supabase.from("showroom_posts").select("id, user_id, parent_id").in("id", ids),
      supabase.from("showroom_entries").select("id").in("id", ids),
    ]);
    const failed = posts.error ?? entries.error;
    if (failed) return communityFailure(failed, NOT_READ);
    const open = new Set((entries.data as { id: string }[]).map((e) => e.id));
    return new Map((posts.data as { id: string; user_id: string; parent_id: string | null }[])
      .map((p) => [p.id, { id: p.id, owner: p.user_id, promptId: null, visible: open.has(p.id), answer: p.parent_id !== null }]));
  }
  const { data, error } = await supabase.from("generated_images").select("id, user_id, prompt_id, visibility, is_uploaded")
    .in("id", ids).is("deleted_at", null);
  if (error) return communityFailure(error, NOT_READ);
  const renders = (data as { id: string; user_id: string; prompt_id: string | null; visibility: string; is_uploaded: boolean | null }[]).filter((r) => !r.is_uploaded);
  const promptIds = [...new Set(renders.flatMap((r) => (r.prompt_id ? [r.prompt_id] : [])))];
  const listed = promptIds.length
    ? await supabase.from("prompts").select("id, creator_id").in("id", promptIds).eq("is_listed", true).eq("listing_status", "active").is("deleted_at", null)
    : { data: [], error: null };
  if (listed.error) return communityFailure(listed.error, NOT_READ);
  const prompts = listed.data as { id: string; creator_id: string }[];
  const hidden = await hiddenOwners(supabase, prompts.map((p) => p.creator_id));
  if (!hidden) return say(NOT_READ, 500);
  const open = new Set(prompts.filter((p) => !hidden.has(p.creator_id)).map((p) => p.id));
  return new Map(renders.map((r) => [r.id, { id: r.id, owner: r.user_id, promptId: r.prompt_id && open.has(r.prompt_id) ? r.prompt_id : null, visible: r.visibility === "public" }]));
}

export const GET = communityHandler(async ({ req, supabase, me }) => {
  const limited = overLimit(req, null, "read");
  if (limited) return limited;
  const query = new URL(req.url).searchParams;
  const kind = query.get("kind") as ItemKind;
  const id = query.get("id");
  if (!ITEM_KINDS.includes(kind) || !isUuid(id)) return badRequest();
  const items = await itemsOf(supabase, kind, [id]);
  if (items instanceof Response) return items;
  const item = items.get(id);
  if (!item || !(item.visible || item.owner === me)) return notFound();
  const answer = await itemCommunities(supabase, kind, id, item.promptId, item.owner === me);
  return answer instanceof Response ? answer : NextResponse.json(answer);
}, { session: "optional" });

export const PUT = communityHandler(async ({ req, supabase, me }) => {
  const limited = overLimit(req, me, "write");
  if (limited) return limited;
  const body = await readBody(req);
  const { kind, ids, communityIds } = (body ?? {}) as { kind?: ItemKind; ids?: unknown; communityIds?: unknown };
  if (!ITEM_KINDS.includes(kind!) || !Array.isArray(ids) || !Array.isArray(communityIds)) return badRequest();
  if (!ids.length || ids.length > MAX_LINK_AT_ONCE || !ids.every(isUuid) || !communityIds.every(isUuid)) return badRequest();
  const items = await itemsOf(supabase, kind!, [...new Set(ids)]);
  if (items instanceof Response) return items;
  // Someone else's item reads as none at all.
  if (ids.some((id) => items.get(id)?.owner !== me)) return notFound();
  // An answer (a variation) lives under the post it answers, in that post's communities (agreed 2026-10-30): never apart.
  if (ids.some((id) => items.get(id)!.answer)) return say(ANSWER_FOLLOWS_ITS_POST, 409);

  // Kev, 2026-10-30: "max 18 communities pro werk", its prompt's included: the whole list is where it shows. Counted as
  // asked, before anything is read; then live communities only (one merged or deleted meanwhile is left out).
  const asked = [...new Set(communityIds)];
  if (asked.length > MAX_COMMUNITIES_PER_WORK) return say(TOO_MANY_COMMUNITIES, 409);
  const live = asked.length ? await supabase.from("communities").select("id").in("id", asked).is("merged_into", null) : { data: [], error: null };
  if (live.error) return communityFailure(live.error, NOT_READ);
  const wanted = new Set((live.data as { id: string }[]).map((c) => c.id));

  const { column } = ITEM[kind!];
  const order = [...new Set(ids)];
  for (const id of order) {
    const promptId = items.get(id)!.promptId;
    const [now, fromPrompt, places] = await Promise.all([
      supabase.from("community_links").select("community_id, state").eq(column, id),
      promptId ? supabase.from("community_links").select("community_id").eq("prompt_id", promptId).eq("state", "shown") : Promise.resolve({ data: [], error: null }),
      promptId ? placesOf(supabase, id) : null,
    ]);
    if (places instanceof Response) return places;
    const failed = now.error ?? fromPrompt.error;
    if (failed) return communityFailure(failed, NOT_SAVED);
    const state = new Map((now.data as { community_id: string; state: string }[]).map((l) => [l.community_id, l.state]));
    const inherited = new Set((fromPrompt.data as { community_id: string }[]).map((l) => l.community_id));
    const is = (c: string, s: string) => state.get(c) === s;
    const links = () => supabase.from("community_links");
    // Out first, so a place freed counts before one is taken: links no longer wanted (an inherited one is opted out of
    // instead), and opt-outs of the prompt's communities wanted again. Each step touches only rows in the state it names,
    // so a moderator's hidden row is never changed here.
    const drop = [...state.keys()].filter((c) => !wanted.has(c) && is(c, "shown") && !inherited.has(c));
    // Of its prompt's, only one it shows in (or has a row for) is taken out: one past its 18 was never on the list its
    // owner saw, so saving that list unchanged changes nothing.
    const optOut = [...inherited].filter((c) => !wanted.has(c) && (state.has(c) || !!places?.has(c)));
    const optIn = [...wanted].filter((c) => inherited.has(c) && is(c, "opted_out"));
    const add = [...wanted].filter((c) => !inherited.has(c));
    const steps = [
      drop.length && links().delete().eq(column, id).in("community_id", drop),
      optIn.length && links().delete().eq(column, id).eq("state", "opted_out").in("community_id", optIn),
      optOut.filter((c) => is(c, "shown")).length && links().update({ state: "opted_out" }).eq(column, id).eq("state", "shown").in("community_id", optOut),
      optOut.filter((c) => !state.has(c)).length && links().insert(optOut.filter((c) => !state.has(c)).map((c) => ({ community_id: c, [column]: id, user_id: me, state: "opted_out" }))),
      // A link opted out of while its prompt still brought it in, shown again now that it does not.
      add.filter((c) => is(c, "opted_out")).length && links().update({ state: "shown" }).eq(column, id).eq("state", "opted_out").in("community_id", add),
      add.filter((c) => !state.has(c)).length && links().insert(add.filter((c) => !state.has(c)).map((c) => ({ community_id: c, [column]: id, user_id: me }))),
    ];
    for (const step of steps) {
      if (!step) continue;
      const { error } = await step;
      // 23514: SQL 54's guard (18 places, its owner's); 23505: the same link written meanwhile.
      if (error && error.code !== "23505") return communityFailure(error, NOT_SAVED);
    }
  }
  const answers = new Map<string, ItemCommunities>();
  for (const id of order) {
    const answer = await itemCommunities(supabase, kind!, id, items.get(id)!.promptId, true);
    if (answer instanceof Response) return answer;
    answers.set(id, answer);
  }
  return NextResponse.json({ items: ids.map((id) => ({ id, ...answers.get(id)! })) });
}, { session: "required" });
