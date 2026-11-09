import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPost, postIdOf, type Post, type PostError } from "@/lib/editor/post-import";
import { normalizeXHandle } from "@/lib/hunter/creators";
import { asEnki } from "@/lib/referral/judge-post";
import { THREAD_MAX, followChain, onePostApi, reachOf, readStatus, type Chain } from "@/lib/hunter/fx-api";
import { linkSettled, playCreator, type CreatorDeps, type PlayResult } from "@/lib/hunter/creator-run";
import { LEADS_TO } from "@/lib/hunter/creator-types";
import type { XPost } from "@/lib/hunter/x-api";

/**
 * One post on X by its link, through the creator Play's own chain (Kev, 2026-10-31: "Add link manually ... weil es eine
 * feste funktion sein soll"): read for free through FxTwitter (no paid X read), its author put on the creator list when
 * not on it yet, the post taken as a Play takes it and always queued for a look; none of the creator's cursors move. A
 * link to the author's own reply takes the first post of their thread, with that reply as where the prompt sits ("in the comments").
 */
const READ: Record<PostError, string> = {
  "not-x": "Not a link to a post on X.",
  private: "That post is private: it cannot be read.",
  gone: "That post is gone.",
  unreachable: "The post could not be read right now. Try again in a minute.",
};

const asX = (id: string, p: Post): XPost => ({ ...p, id, likes: 0, videos: 0, conversationId: id });

/** A link Enki knows already, for the hunter's log: the post the link asked for, and the find's author and state. */
export type KnownLink = { postId: string; handle: string | null; waiting: boolean };

async function alreadyIn(supabase: SupabaseClient, postId: string, asked: string): Promise<{ status: 409; error: string; known: KnownLink } | null> {
  const { data } = await supabase.from("hunt_submissions").select("status, source_author_handle").eq("normalized_source_url", `x.com/status/${postId}`).limit(1);
  const row = data?.[0] as { status?: string; source_author_handle?: string | null } | undefined;
  if (!row) return null;
  const waiting = row.status === "pending";
  return { status: 409, error: waiting ? "This post is waiting in Pending imports already." : "This post is on Enki already.", known: { postId: asked, handle: row.source_author_handle ?? null, waiting } };
}

type Resolved = { id: string; post: XPost; reply: XPost | null; chain: Chain; handle: string };

/**
 * A waiting link whose chain ends elsewhere now than when it was put in line (a post deleted since, a read that failed
 * then): "Play links" on the creator it waited under lists no one and spends no one else's mode (Kev, 2026-11-03: "warum
 * sollte ein fremder in der liste landen"; "im manual form $0"). It goes to wait under that creator if listed, its 503
 * keeping it in line (linkSettled); if not, it is marked as a forward to a stranger is, and adding the link again is
 * Kev's own act of listing them.
 */
async function movedOn(supabase: SupabaseClient, id: string, handle: string): Promise<{ status: 409 | 500 | 503; error: string }> {
  const { data: listed, error } = await supabase.from("hunter_accounts").select("handle").eq("handle", handle).maybeSingle();
  const { error: writeError } = error ? { error } : await supabase.from("hunter_posts").update(listed ? { handle } : { outcome: `${LEADS_TO}${handle}` }).eq("post_id", id).eq("outcome", "waiting");
  if (writeError) return { status: 500, error: `This link leads to @${handle} now, and could not be moved: ${writeError.message}` };
  return listed
    ? { status: 503, error: `This link leads to @${handle} now: it waits under them, in their mode.` }
    : { status: 409, error: `This link leads to @${handle} now, who is not on your list. Add the link again to list them.` };
}

/**
 * Whose find a link is: the post (the post a reply answers, the core a forward leads to), on the creator list; or why
 * it is not taken. Shared by queueLink (the link waits under its creator) and addLinkManually (it is played; `under`:
 * the creator whose "Play links" pressed it).
 */
async function resolveLink(supabase: SupabaseClient, url: unknown, addedBy: string, fetchFn: typeof fetch, under = ""): Promise<Resolved | { status: 400 | 404 | 409 | 500 | 503; error: string; known?: KnownLink }> {
  const id = typeof url === "string" ? postIdOf(url) : null;
  if (!id) return { status: 400, error: READ["not-x"] };
  // A post already in Enki is not opened again (Kev, 2026-10-31: "if i add a duplicate that we dont open it up"): its
  // find, waiting or published, is in hunt_submissions by its link; a rejected one was deleted and may come again.
  const known = await alreadyIn(supabase, id, id);
  if (known) return known;
  const got = await fetchPost(id, fetchFn);
  if (!got.ok) return { status: got.error === "unreachable" ? 503 : 404, error: READ[got.error] };
  let post = asX(id, got.post);
  let reply: XPost | null = null;
  if (got.post.replyingTo) {
    // Up the author's own thread: a post that is itself a reply is no find, and the Play's listing leaves it out too.
    let at = got.post.replyingTo;
    let parent = await fetchPost(at, fetchFn);
    for (let hop = 1; parent.ok && parent.post.replyingTo && parent.post.author.id === got.post.author.id; hop++) {
      if (hop >= THREAD_MAX) return { status: 400, error: "This reply sits too far down its thread: add the link of the thread's first post." };
      at = parent.post.replyingTo;
      parent = await fetchPost(at, fetchFn);
    }
    if (!parent.ok) return { status: parent.error === "unreachable" ? 503 : 404, error: `The post this reply answers: ${READ[parent.error]}` };
    // Its videos too: this read of the link names no video (asX). A read that failed cannot tell, and read as none its
    // video would be lost without a word; a post deleted since has nothing more to tell.
    const own = await readStatus(id, fetchFn);
    if (!own) return { status: 503, error: READ.unreachable };
    reply = own === "gone" ? post : own;
    post = asX(at, parent.post);
    const knownParent = await alreadyIn(supabase, post.id, id);
    if (knownParent) return knownParent;
    if (reply.author.id !== post.author.id) return { status: 400, error: "That reply is not by the post's author: only their own reply carries their prompt." };
  }
  // A forward is followed to its core post, whose author the find belongs to; the chain gives its reach (Kev, 2026-10-31).
  const chain = await followChain(post.id, fetchFn);
  // Whether it holds a video is known from here alone: read as asX has it, a video would be lost without a word.
  if (!chain) return { status: 503, error: READ.unreachable };
  // Its way to the core not known: the forward's own words are no find, under the forwarder or in line.
  if (chain.broken) return { status: 503, error: "The way from this post to the post it forwards could not be read to its end. Try again in a minute, or add the link of the post that holds the prompt." };
  if (chain.gone) return { status: 404, error: `The post this link forwards: ${READ.gone}` };
  if (chain.core.id !== post.id) {
    const knownCore = await alreadyIn(supabase, chain.core.id, id);
    if (knownCore) return knownCore;
    reply = chain.reply ?? null;
  }
  post = chain.core;
  const handle = normalizeXHandle(post.author.handle);
  if (!post.author.id || !/^[a-z0-9_]{1,15}$/.test(handle)) return { status: 503, error: READ.unreachable };
  if (under && handle !== under) return movedOn(supabase, id, handle);
  // A new author starts in manual, so their link costs $0 (Kev, 2026-11-03: "ich möchte im manual form $0 haben"); ignoreDuplicates keeps a listed creator's own mode.
  const { error } = await supabase.from("hunter_accounts").upsert({ handle, added_by: addedBy, mode: "manual" }, { onConflict: "handle", ignoreDuplicates: true });
  if (error) return { status: 500, error: `@${handle} could not be put on the list: ${error.message}` };
  return { id, post, reply, chain, handle };
}

/**
 * A link put in line under its creator, not played (Kev, 2026-11-01: "importiere dann nicht jeden link direkt ... sondern
 * lasse mich erst das einstellen und dann play drücken"): the creator is on the list, the link waits in hunter_posts
 * (outcome 'waiting') until "Play links" plays it in the creator's mode. Reads FxTwitter only, free.
 */
export async function queueLink(supabase: SupabaseClient, url: unknown, addedBy: string, fetchFn: typeof fetch = asEnki): Promise<{ status: 200; handle: string } | { status: 400 | 404 | 409 | 500 | 503; error: string; known?: KnownLink }> {
  const r = await resolveLink(supabase, url, addedBy, fetchFn);
  if ("error" in r) return r;
  const { error } = await supabase.from("hunter_posts").upsert(
    { post_id: r.id, handle: r.handle, author_id: r.post.author.id, likes: r.post.likes ?? 0, outcome: "waiting", read_at: new Date().toISOString() },
    { onConflict: "post_id" },
  );
  return error ? { status: 500, error: `The link could not be put in line: ${error.message}` } : { status: 200, handle: r.handle };
}

export { linkSettled };

export async function addLinkManually(
  supabase: SupabaseClient, url: unknown, addedBy: string, deps: CreatorDeps, fetchFn: typeof fetch = asEnki, under?: unknown,
): Promise<PlayResult & { handle?: string; known?: KnownLink }> {
  const r = await resolveLink(supabase, url, addedBy, fetchFn, normalizeXHandle(under));
  if ("error" in r) return r;
  const { post, reply, chain, handle } = r;
  const played = await playCreator(supabase, handle, undefined, {
    ...deps,
    only: post,
    reach: reachOf(chain.hops),
    x: onePostApi(post, fetchFn),
    comment: reply,
  });
  return { ...played, handle };
}
