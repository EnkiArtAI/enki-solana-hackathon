import type { Post } from "@/lib/editor/post-import";
import { REPLIES_MAX } from "@/lib/hunter/creator-types";

/**
 * X's API v2, pay-per-use (about $0.005 per post read, $0.01 per user
 * lookup), with the app's bearer token from the environment. Only what the
 * Prompt Hunter needs: a handle's user id, and a page of a user's posts with
 * their pictures and like counts, as our Post shape, in a window of ids so a
 * run can read ever older (until_id) and, later, newer (since_id). Every
 * call is a paid call: the caller counts posts against its budget. Main
 * posts only, no reposts and no replies (Kev, 2026-10-14): X then serves a
 * user's newest 800 (3,200 with replies), and bills only what it serves.
 */
const API = "https://api.x.com/2";
const TIMEOUT_MS = 20_000;

export interface XPost extends Post {
  id: string;
  likes: number;
  /** Videos and GIFs on the post. Not imported yet (video prompts wait, Kev's step 3 of 2026-10-30): the Play saves them (hunter_parked). */
  videos?: number;
  /** Each of them as the reader gives it, when it does (FxTwitter: addresses, poster, duration, size): what the video import will need. */
  videoData?: Record<string, unknown>[];
  /** The thread's first post: a reply carrying the prompt is found by it (lib/hunter/creator-run). */
  conversationId?: string | null;
  /** Its reposts and quotes, when the reader knows them (FxTwitter does): a find's reach (lib/hunter/fx-api reachOf). */
  reposts?: number;
  quotes?: number;
  /** The post it quotes, when the reader knows it (lib/hunter/fx-api forwardTo). */
  quoteId?: string | null;
}

/** An X account as the Creator Hunter keeps it: X's numeric id is its name, the handle can change hands. No picture: Enki shows none. */
export interface XUser {
  id: string;
  handle: string;
  name: string;
}

export interface XSearchPage {
  posts: XPost[];
  /** X has more posts for the query beyond this page. */
  nextToken: string | null;
}

/**
 * The Creator Hunter's reads (Kev, 2026-10-30): an account with its name, X's search for one author's
 * posts that match (billed per post returned, docs.x.com pricing: only the hits, never the whole timeline), and the
 * author's own replies in a post's thread, where "prompt below" points. `archive` picks the full-archive endpoint
 * (back to 2006, 1 request a second) over the recent one (7 days). Every call is paid; none is retried.
 */
export interface XSearchApi {
  /** The account behind a handle, or null when X knows none. One user lookup ($0.01). */
  user(handle: string): Promise<XUser | null>;
  search(query: string, author: { id: string; handle: string; name: string }, opts: {
    archive: boolean; max: number; sinceId?: string | null; untilId?: string | null; startTime?: string | null; nextToken?: string | null;
  }): Promise<XSearchPage>;
  /** The author's replies in the post's thread (at most REPLIES_MAX), oldest first; null when the read failed, which is no "none". */
  replies(post: XPost, author: { id: string; handle: string; name: string }, archive: boolean): Promise<XPost[] | null>;
  /** Its reads cost nothing (FxTwitter, lib/hunter/fx-api): a Play counts them and bills only the model work. */
  free?: boolean;
}

export interface XPage {
  posts: XPost[];
  /** X has more posts in the window beyond this page. */
  more: boolean;
}

export interface XApi {
  /** The user id behind a handle, or null when X knows no such account. Throws on any other failure. */
  userId(handle: string): Promise<string | null>;
  /**
   * A page of the user's posts (no reposts), newest first, at most `max` (5..100), older than
   * `untilId` and newer than `sinceId` when given. Throws on failure.
   */
  posts(userId: string, handle: string, opts: { max: number; sinceId?: string | null; untilId?: string | null }): Promise<XPage>;
}

export const bearerToken = (): string | null => (process.env.X_API_BEARER_TOKEN ?? "").trim() || null;

/** A post id's time: X ids are snowflakes, the top bits are milliseconds since X's epoch. */
export function snowflakeDate(id: string): Date | null {
  if (!/^\d{1,20}$/.test(id)) return null;
  const ms = (BigInt(id) >> BigInt(22)) + BigInt("1288834974657");
  return new Date(Number(ms));
}

/** The lowest id X can give a post made at `ms`: a cursor from a time, as X's ids are snowflakes. */
export const snowflakeAt = (ms: number): string => ((BigInt(Math.floor(ms)) - BigInt("1288834974657")) << BigInt(22)).toString();

type Media = { media_key: string; type?: string; url?: string; alt_text?: string };
type Tweet = {
  id: string;
  text: string;
  author_id?: string;
  conversation_id?: string;
  public_metrics?: { like_count?: number };
  attachments?: { media_keys?: string[] };
  referenced_tweets?: { type: string; id: string }[];
  /** A long post's whole text (docs.x.com data dictionary: "the full text of a Post for long-form Posts (>280 characters)"); `text` is cut. */
  note_tweet?: { text?: string };
  note_post?: { text?: string };
};

/**
 * A post as X answers it, in our shape; pictures from the expanded media, in the order the post lists them. The
 * author is X's own author_id when X says another account wrote it: a search by handle (from:) reaches whoever holds
 * the handle now, and the caller, not this reader, decides what a stranger's post is.
 */
export function postOf(t: Tweet, media: Map<string, Media>, expected: { id: string; handle: string; name: string }): XPost {
  const author = typeof t.author_id === "string" && t.author_id !== expected.id ? { id: t.author_id, handle: expected.handle, name: "" } : expected;
  const keyed = (t.attachments?.media_keys ?? []).flatMap((k) => (media.has(k) ? [media.get(k)!] : []));
  const photos = keyed.flatMap((m) =>
    m.type === "photo" && typeof m.url === "string" ? [{ url: m.url, alt: m.alt_text?.trim() ? m.alt_text : null }] : [],
  ).slice(0, 4);
  const parent = t.referenced_tweets?.find((r) => r.type === "replied_to")?.id ?? null;
  const long = t.note_tweet?.text ?? t.note_post?.text;
  return {
    id: t.id,
    url: `https://x.com/${author.handle}/status/${t.id}`,
    text: typeof long === "string" && long ? long : t.text,
    author,
    photos,
    replyingTo: parent,
    quote: null,
    likes: t.public_metrics?.like_count ?? 0,
    videos: keyed.filter((m) => m.type === "video" || m.type === "animated_gif").length,
    conversationId: t.conversation_id ?? null,
    quoteId: t.referenced_tweets?.find((r) => r.type === "quoted")?.id,
  };
}

/**
 * The search's fields: the long text, the thread, the pictures with their alt text. No author expansion: the author
 * is known (from:), and an expanded user may bill as a user read.
 */
const SEARCH_FIELDS = {
  "tweet.fields": "public_metrics,created_at,author_id,referenced_tweets,attachments,conversation_id,note_tweet",
  expansions: "attachments.media_keys",
  "media.fields": "url,type,alt_text",
} as const;

type SearchJson = { data?: Tweet[]; includes?: { media?: Media[] }; meta?: { next_token?: string } } | null;

export function xApi(fetchFn: typeof fetch = fetch, token: string | null = bearerToken()): XApi & XSearchApi {
  const get = async (path: string): Promise<unknown> => {
    if (!token) throw new Error("X_API_BEARER_TOKEN is not set");
    const res = await fetchFn(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return null;
    // X said no: what it said is shown on the creator's row, and the round stops; nothing is retried.
    if (res.status === 429) throw new Error("X rate limit: press Play again in a minute");
    if (res.status === 401 || res.status === 403) {
      // With X's own reason (Kev, 2026-10-31: "X refused the token?"): an expired token, an app outside a project, or an
      // endpoint the plan does not include read the same otherwise.
      const body = (await res.json().catch(() => null)) as { title?: string; reason?: string; detail?: string } | null;
      const why = [body?.title, body?.reason].filter((s): s is string => typeof s === "string" && !!s).join(", ");
      throw new Error(`X refused the token (${res.status}${why ? `: ${why}` : ""})`);
    }
    if (res.status === 400) {
      // X says what it refused (a field, an operator).
      const body = (await res.json().catch(() => null)) as { errors?: { message?: string }[]; detail?: string; title?: string } | null;
      throw new Error(`X refused the request: ${body?.errors?.[0]?.message ?? body?.detail ?? body?.title ?? "bad request"}`);
    }
    if (!res.ok) throw new Error(`x api ${res.status}`);
    return res.json();
  };
  return {
    async userId(handle) {
      const h = handle.replace(/^@/, "").trim();
      if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
      const json = (await get(`/users/by/username/${encodeURIComponent(h)}?user.fields=id`)) as { data?: { id?: string }; errors?: unknown } | null;
      return typeof json?.data?.id === "string" ? json.data.id : null;
    },
    async posts(userId, handle, { max, sinceId, untilId }) {
      const n = Math.max(5, Math.min(100, Math.floor(max)));
      const q = new URLSearchParams({
        max_results: String(n),
        exclude: "retweets,replies",
        "tweet.fields": "public_metrics,created_at,author_id,referenced_tweets,attachments",
        expansions: "attachments.media_keys,author_id",
        "media.fields": "url,type,alt_text",
        "user.fields": "name,username",
      });
      if (sinceId) q.set("since_id", sinceId);
      if (untilId) q.set("until_id", untilId);
      const json = (await get(`/users/${encodeURIComponent(userId)}/tweets?${q}`)) as {
        data?: Tweet[]; includes?: { media?: Media[]; users?: { id: string; name?: string; username?: string }[] }; meta?: { next_token?: string };
      } | null;
      if (!json?.data?.length) return { posts: [], more: false };
      const media = new Map((json.includes?.media ?? []).map((m) => [m.media_key, m]));
      const user = json.includes?.users?.find((u) => u.id === userId);
      const author = { id: userId, handle: user?.username ?? handle, name: user?.name ?? "" };
      return { posts: json.data.map((t) => postOf(t, media, author)), more: typeof json.meta?.next_token === "string" };
    },
    async user(handle) {
      const h = handle.replace(/^@/, "").trim();
      if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
      const json = (await get(`/users/by/username/${encodeURIComponent(h)}?user.fields=name,username`)) as {
        data?: { id?: string; name?: string; username?: string };
      } | null;
      const u = json?.data;
      if (typeof u?.id !== "string") return null;
      return { id: u.id, handle: u.username ?? h, name: u.name ?? "" };
    },
    async search(query, author, { archive, max, sinceId, untilId, startTime, nextToken }) {
      const q = new URLSearchParams({ query, max_results: String(Math.max(10, Math.min(100, Math.floor(max)))), sort_order: "recency", ...SEARCH_FIELDS });
      if (sinceId) q.set("since_id", sinceId);
      if (untilId) q.set("until_id", untilId);
      // X takes at most one of start_time and since_id (docs.x.com search): since_id wins.
      if (startTime && !sinceId) q.set("start_time", startTime);
      if (nextToken) q.set("next_token", nextToken);
      const json = (await get(`/tweets/search/${archive ? "all" : "recent"}?${q}`)) as SearchJson;
      const media = new Map((json?.includes?.media ?? []).map((m) => [m.media_key, m]));
      const next = json?.meta?.next_token;
      return { posts: (json?.data ?? []).map((t) => postOf(t, media, author)), nextToken: typeof next === "string" && next ? next : null };
    },
    async replies(post, author, archive) {
      const thread = post.conversationId ?? post.id;
      if (!/^\d{1,20}$/.test(thread)) return [];
      const q = new URLSearchParams({ query: `conversation_id:${thread} from:${author.handle} is:reply`, max_results: String(REPLIES_MAX), sort_order: "recency", ...SEARCH_FIELDS });
      const json = (await get(`/tweets/search/${archive ? "all" : "recent"}?${q}`)) as SearchJson;
      const media = new Map((json?.includes?.media ?? []).map((m) => [m.media_key, m]));
      return (json?.data ?? []).map((t) => postOf(t, media, author)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    },
  };
}
