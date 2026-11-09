import { asEnki } from "@/lib/referral/judge-post";
import { snowflakeDate, type XPost, type XSearchApi } from "@/lib/hunter/x-api";
import { defers, locatePrompt, promptLike } from "@/lib/hunter/distill";
import type { HuntReach } from "@/lib/hunter/creator-types";

/**
 * The creator Play reading X through FxTwitter, free (Kev, 2026-10-31: "ja play gratis über fxtwitter"; X's own API
 * bills every post and needs credits): the profile, its media posts newest first, paged by FxTwitter's cursor, and the
 * author's own replies to a post. The same shape as the paid client (XSearchApi), so the Play's chain is unchanged.
 * Unofficial: it can fail or slow down, and how far back it pages is FxTwitter's to say.
 */
const FX = "https://api.fxtwitter.com/2";

type FxPhoto = { url?: unknown; altText?: unknown };
type FxStatus = {
  id?: unknown; url?: unknown; text?: unknown; likes?: unknown; reposts?: unknown; quotes?: unknown; quote?: FxStatus | null;
  author?: { id?: unknown; name?: unknown; screen_name?: unknown };
  media?: { photos?: FxPhoto[]; videos?: unknown[] } | null;
  replying_to?: { status?: unknown } | null;
};
type FxPage = { results?: FxStatus[]; replies?: FxStatus[]; cursor?: { bottom?: unknown } | null } | null;

const photosOf = (s: FxStatus) =>
  (s.media?.photos ?? []).flatMap((p) => (typeof p.url === "string" ? [{ url: p.url, alt: typeof p.altText === "string" && p.altText ? p.altText : null }] : [])).slice(0, 4);

/** One FxTwitter status as the Play reads a post, or null when it lacks an id, a text or an author. */
export function postOfFx(s: FxStatus): XPost | null {
  if (typeof s.id !== "string" || typeof s.text !== "string" || typeof s.author?.id !== "string") return null;
  const to = typeof s.replying_to?.status === "string" && s.replying_to.status ? s.replying_to.status : null;
  return {
    id: s.id, url: typeof s.url === "string" ? s.url : `https://x.com/i/status/${s.id}`, text: s.text,
    author: { id: s.author.id, name: typeof s.author.name === "string" ? s.author.name : "", handle: typeof s.author.screen_name === "string" ? s.author.screen_name : "" },
    photos: photosOf(s), replyingTo: to, quote: null, likes: typeof s.likes === "number" ? s.likes : 0,
    reposts: typeof s.reposts === "number" ? s.reposts : 0, quotes: typeof s.quotes === "number" ? s.quotes : 0,
    videos: Array.isArray(s.media?.videos) ? s.media.videos.length : 0, conversationId: to ?? s.id,
    videoData: Array.isArray(s.media?.videos) ? s.media.videos.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [],
    quoteId: typeof s.quote?.id === "string" ? s.quote.id : null,
  };
}

/** The words and the likes floor of the Play's own query (lib/hunter/creator-config searchQuery): FxTwitter lists, it does not search. */
export function queryFilter(query: string): { words: string[]; minLikes: number } {
  const minLikes = Number(query.match(/\bmin_likes:(\d+)/)?.[1] ?? 0);
  const rest = query.replace(/\bfrom:\S+|\bhas:\S+|-is:\S+|\bmin_likes:\d+/g, " ");
  const words = [...rest.matchAll(/"([^"]+)"|([^\s()"]+)/g)].map((m) => (m[1] ?? m[2]).toLowerCase()).filter((w) => w !== "or");
  return { words, minLikes };
}

/** How many times a timeline page is asked, and the pause between asks: live, about one ask in four answered 404. */
export const FX_LIST_TRIES = 4;

export function fxApi(fetchFn: typeof fetch = asEnki, waitMs = 1500): XSearchApi {
  /**
   * listing: a timeline page. FxTwitter answers the same page now with posts, now with 404 and none (seen live
   * 2026-10-31, two requests in a row): a 404 there is asked once more and then stops the round, never read as the end,
   * which marked a creator read through with nothing read (Kev: "0 found, iwas ist da faul").
   */
  const get = async (path: string, listing = false): Promise<(NonNullable<FxPage> & { user?: { id?: unknown; name?: unknown; screen_name?: unknown } }) | null> => {
    let res = await fetchFn(FX + path, { signal: AbortSignal.timeout(15_000) });
    // Kev, 2026-10-31, after the round stopped on it: ask a 404 page up to FX_LIST_TRIES times, a pause between.
    for (let i = 1; listing && res.status === 404 && i < FX_LIST_TRIES; i++) {
      await new Promise((r) => setTimeout(r, waitMs));
      res = await fetchFn(FX + path, { signal: AbortSignal.timeout(15_000) });
    }
    if (listing && res.status === 404) throw new Error("FxTwitter did not list the posts right now: press Play again in a minute");
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error("FxTwitter is busy: press Play again in a minute");
    if (!res.ok) throw new Error(`FxTwitter could not be read (${res.status}): press Play again later`);
    return res.json();
  };
  // Where a page of the timeline ends, by every post id on it: the look back asks below its oldest post again and goes
  // on from that page's cursor instead of paging down from the top once more.
  const after = new Map<string, string>();

  return {
    user: async (handle) => {
      const u = (await get(`/profile/${encodeURIComponent(handle)}`))?.user;
      return typeof u?.id === "string" ? { id: u.id, handle: typeof u.screen_name === "string" ? u.screen_name : handle, name: typeof u.name === "string" ? u.name : "" } : null;
    },
    search: async (query, author, o) => {
      const { words, minLikes } = queryFilter(query);
      const cursor = o.nextToken ?? (o.untilId ? after.get(o.untilId) : undefined) ?? null;
      const page = await get(`/profile/${encodeURIComponent(author.handle)}/media${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, true);
      const rows = (page?.results ?? []).map(postOfFx).filter((p): p is XPost => !!p);
      const bottom = typeof page?.cursor?.bottom === "string" ? page.cursor.bottom : null;
      if (bottom) for (const p of rows) after.set(p.id, bottom);
      const since = o.startTime ? Date.parse(o.startTime) : null;
      const posts = rows.filter((p) => !p.replyingTo
        && (!o.sinceId || BigInt(p.id) > BigInt(o.sinceId))
        && (!o.untilId || BigInt(p.id) < BigInt(o.untilId))
        && (since === null || (snowflakeDate(p.id)?.getTime() ?? 0) >= since)
        && p.likes >= minLikes
        && (!words.length || words.some((w) => p.text.toLowerCase().includes(w))));
      // The end: nothing more, or the page reached what was read before (sinceId) or the look back's start.
      const oldest = rows.reduce<string | null>((m, p) => (!m || BigInt(p.id) < BigInt(m) ? p.id : m), null);
      const done = !rows.length || !bottom
        || (!!o.sinceId && !!oldest && BigInt(oldest) <= BigInt(o.sinceId))
        || (since !== null && !!oldest && (snowflakeDate(oldest)?.getTime() ?? 0) < since);
      return { posts, nextToken: done ? null : bottom };
    },
    replies: (post) => authorReplies(post, fetchFn, waitMs),
    free: true,
  };
}

/**
 * The author's own replies under the post, as FxTwitter's conversation lists them (free; its first page, where a "Prompt in
 * reply" sits): their direct replies first, where a prompt sits, then the rest of their thread at any depth: anyone else's
 * reply, or the author's answer to someone else, is left out. null when the read failed: a video or a prompt in a reply
 * cannot be told from none then.
 */
export async function authorReplies(post: XPost, fetchFn: typeof fetch = asEnki, waitMs = 1500): Promise<XPost[] | null> {
  try {
    // Asked up to FX_LIST_TRIES times, as a timeline page: the conversation fails now and then too, and an empty answer
    // sent @AmirMushich's post to the model without its prompt, four times (Kev, 2026-10-31).
    let res = await fetchFn(`${FX}/conversation/${post.id}`, { signal: AbortSignal.timeout(15_000) });
    for (let i = 1; !res.ok && i < FX_LIST_TRIES; i++) {
      await new Promise((r) => setTimeout(r, waitMs));
      res = await fetchFn(`${FX}/conversation/${post.id}`, { signal: AbortSignal.timeout(15_000) });
    }
    if (!res.ok) return null;
    const json = (await res.json()) as FxPage;
    const theirs = (json?.replies ?? []).flatMap((r): XPost[] => {
      const p = postOfFx(r);
      return p && p.author.id === post.author.id ? [{ ...p, author: post.author, conversationId: post.id }] : [];
    });
    // Down the thread from the post, whatever order the page has them in.
    const thread = new Set([post.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of theirs) if (p.replyingTo && thread.has(p.replyingTo) && !thread.has(p.id)) { thread.add(p.id); grew = true; }
    }
    const below = theirs.filter((p) => thread.has(p.id));
    return [...below.filter((p) => p.replyingTo === post.id), ...below.filter((p) => p.replyingTo !== post.id)];
  } catch {
    return null;
  }
}

/**
 * One post as FxTwitter's v2 answers it, asked up to FX_LIST_TRIES times: "gone" when the last answer says it is deleted
 * (404) or private (401), null when the read failed and may work later.
 */
export async function readStatus(id: string, fetchFn: typeof fetch = asEnki, waitMs = 1500): Promise<XPost | "gone" | null> {
  try {
    let res = await fetchFn(`${FX}/status/${id}`, { signal: AbortSignal.timeout(15_000) });
    for (let i = 1; !res.ok && i < FX_LIST_TRIES; i++) {
      await new Promise((r) => setTimeout(r, waitMs));
      res = await fetchFn(`${FX}/status/${id}`, { signal: AbortSignal.timeout(15_000) });
    }
    if (res.status === 404 || res.status === 401) return "gone";
    if (!res.ok) return null;
    const s = ((await res.json()) as { status?: FxStatus }).status;
    return s ? postOfFx(s) : null;
  } catch {
    return null;
  }
}

/** How many forwards are followed to the core post, how far up the author's own thread a comment is followed, and how short a forward's own words are (mentions and links out). */
export const CHAIN_MAX = 5;
export const THREAD_MAX = 25;
const FORWARD_MAX = 280;
const LINKED = /(?:x|twitter)\.com\/\w+\/status\/(\d+)/;

/**
 * The post this one forwards to, the one it links (first) or quotes; null while it holds a prompt of its own (a label, a
 * pointer to its reply) or its own words are long. A post that only says how to use the prompt of the post it quotes or
 * links is a forward too (lib/hunter/distill).
 */
export function forwardTo(post: XPost): string | null {
  const next = post.text.match(LINKED)?.[1] ?? post.quoteId ?? null;
  if (!next || defers(post.text)) return next;
  const at = locatePrompt(post, null);
  if (at.kind === "sure" || at.kind === "reply") return null;
  const own = post.text.replace(/@\w+|https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
  return own.length > FORWARD_MAX && promptLike(own) ? null : next;
}

/** Its own words read as a prompt could: long enough, and more than how to use a prompt kept elsewhere. */
export const ownWords = (post: XPost): boolean => promptLike(post.text) && !defers(post.text);

export type Chain = {
  core: XPost;
  hops: XPost[];
  /** The core is the post this comment of its author answers, and the comment is where the prompt sits. */
  reply?: XPost;
  /** The last hop is no core: a post the chain leads to could not be read, or the chain was cut (CHAIN_MAX, a loop). */
  broken?: boolean;
  /** The post it leads to is deleted or private, and the last hop has no words of its own: nothing to follow, ever. */
  gone?: boolean;
};

/**
 * A core with no picture shows the nearest forward's, its alt text no source of the prompt; a video-only core stays one,
 * and a comment's own picture goes first. It is queued, so a person sees whose picture it is.
 */
const pictured = (core: XPost, hops: XPost[], reply?: XPost): XPost => {
  if (core.photos.length || core.videos || reply?.photos.length) return core;
  const from = [...hops].reverse().find((h) => h.photos.length);
  return from ? { ...core, photos: from.photos.map((p) => ({ ...p, alt: null })) } : core;
};

/**
 * A forwarded prompt followed to its core (Kev, 2026-10-31: "a retweet of a RT of a RT ... until in the core prompt in one
 * of the comments was that prompt"): while a post holds no prompt of its own (no label, no pointer to its reply) and its
 * own words are short, the post it links (first) or quotes is read, up to CHAIN_MAX posts, free through FxTwitter. Every
 * post read is a hop; the last is the core, whose author the find then belongs to. A hop that leads to a deleted or private
 * post is the core if it has words of its own. A core that is a comment gives way to the first post of its thread, up its
 * own author's replies.
 */
export async function followChain(id: string, fetchFn: typeof fetch = asEnki, waitMs = 1500): Promise<Chain | null> {
  const first = await readStatus(id, fetchFn, waitMs);
  if (!first || first === "gone") return null;
  let cur = first;
  const hops: XPost[] = [];
  for (;;) {
    hops.push(cur);
    const next = forwardTo(cur);
    if (!next || next === cur.id) break;
    if (hops.length >= CHAIN_MAX || hops.some((h) => h.id === next)) return { core: cur, hops, broken: true };
    const n = await readStatus(next, fetchFn, waitMs);
    if (!n) return { core: cur, hops, broken: true };
    if (n === "gone") {
      if (ownWords(cur)) break;
      return { core: cur, hops, gone: true };
    }
    cur = n;
  }
  if (hops.length > 1 && cur.replyingTo) {
    const all = [...hops];
    let top = cur;
    while (top.replyingTo) {
      if (all.length - hops.length >= THREAD_MAX) return { core: cur, hops, broken: true };
      const parent = await readStatus(top.replyingTo, fetchFn, waitMs);
      if (!parent) return { core: cur, hops, broken: true };
      if (parent === "gone" || parent.author.id !== cur.author.id) break;
      all.push(parent);
      top = parent;
    }
    if (top !== cur) return { core: pictured(top, all, cur), hops: all, reply: cur };
  }
  return { core: pictured(cur, hops), hops };
}

/**
 * The reader of a Play of one post (an added link, a forward's core), nothing of X's paid API: the author as FxTwitter
 * names them, no search, the author's own replies.
 */
export function onePostApi(post: XPost, fetchFn: typeof fetch = asEnki): XSearchApi {
  const author = { id: post.author.id, handle: post.author.handle, name: post.author.name };
  return { user: async () => author, search: async () => ({ posts: [], nextToken: null }), replies: (p) => authorReplies(p, fetchFn), free: true };
}

/** A find's reach: the core post's own likes, reposts and quotes, and their sums over every post of its chain. */
export function reachOf(hops: XPost[]): HuntReach {
  const core = hops[hops.length - 1];
  const sum = (k: "likes" | "reposts" | "quotes") => hops.reduce((n, p) => n + (p[k] ?? 0), 0);
  return {
    core: { likes: core.likes ?? 0, reposts: core.reposts ?? 0, quotes: core.quotes ?? 0 },
    chain: { posts: hops.length, likes: sum("likes"), reposts: sum("reposts"), quotes: sum("quotes") },
  };
}
