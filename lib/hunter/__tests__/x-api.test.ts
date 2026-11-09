import { describe, it, expect, vi } from "vitest";
import { postOf, snowflakeDate, xApi } from "../x-api";

/**
 * X's API v2 as the Prompt Hunter reads it: a handle's id, a page of a
 * user's posts with their pictures and likes in a window of ids, every call
 * with the bearer token, every post in our Post shape, and whether X has
 * more beyond the page. Pay-per-use, so the caller's budget is what the
 * query asks for, clamped to what X allows (5..100).
 */
const res = (status: number, body?: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const fetchOf = (...answers: Response[]) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), init }); return answers.shift() ?? res(500); }) as unknown as typeof fetch;
  return { fetchFn, calls };
};

describe("postOf", () => {
  const media = new Map([
    ["m1", { media_key: "m1", type: "photo", url: "https://pbs.twimg.com/media/1.jpg", alt_text: "a lighthouse" }],
    ["m2", { media_key: "m2", type: "video", url: "https://video.twimg.com/2.mp4" }],
    ["m3", { media_key: "m3", type: "photo", url: "https://pbs.twimg.com/media/3.jpg", alt_text: "  " }],
    ["m4", { media_key: "m4", type: "photo" }],
  ]);
  const author = { id: "42", handle: "hex", name: "Hex" };

  it("keeps the photos in the post's order, none of the videos, with their alt text when it says something", () => {
    const p = postOf({ id: "30", text: "Prompt: x", attachments: { media_keys: ["m3", "m2", "m1", "m4", "m9"] }, public_metrics: { like_count: 7 }, referenced_tweets: [{ type: "replied_to", id: "9" }] }, media, author);
    expect(p).toEqual({
      id: "30", url: "https://x.com/hex/status/30", text: "Prompt: x", author, likes: 7, replyingTo: "9", quote: null,
      photos: [{ url: "https://pbs.twimg.com/media/3.jpg", alt: null }, { url: "https://pbs.twimg.com/media/1.jpg", alt: "a lighthouse" }],
      videos: 1, conversationId: null,
    });
  });

  it("takes at most four pictures, no likes as zero, and a quote as no reply", () => {
    const five = new Map(Array.from({ length: 5 }, (_, i) => [`k${i}`, { media_key: `k${i}`, type: "photo", url: `https://pbs.twimg.com/media/${i}.jpg` }]));
    const p = postOf({ id: "31", text: "t", attachments: { media_keys: [...five.keys()] }, referenced_tweets: [{ type: "quoted", id: "5" }] }, five, author);
    expect(p.photos).toHaveLength(4);
    expect(p.likes).toBe(0);
    expect(p.quoteId).toBe("5");
    expect(p.replyingTo).toBeNull();
  });
});

describe("snowflakeDate", () => {
  it("reads the time out of a post id, and nothing out of what is not one", () => {
    // HexMethod's post of 2026-10-13 (the one Kev tested the referral with), and the very first snowflake moment.
    expect(snowflakeDate("2109863311571312798")?.toISOString()).toBe("2026-10-13T04:26:27.500Z");
    expect(snowflakeDate("20")?.toISOString()).toBe("2010-11-04T01:42:54.657Z");
    expect(snowflakeDate("abc")).toBeNull();
    expect(snowflakeDate("")).toBeNull();
  });
});

describe("xApi", () => {
  it("needs the token only when it reads, and sends it with every read", async () => {
    const { fetchFn, calls } = fetchOf(res(200, { data: { id: "42" } }));
    const api = xApi(fetchFn, "secret-token");
    expect(await api.userId("@hex")).toBe("42");
    expect(calls[0].url).toBe("https://api.x.com/2/users/by/username/hex?user.fields=id");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    await expect(xApi(fetchFn, null).userId("hex")).rejects.toThrow("X_API_BEARER_TOKEN is not set");
  });

  it("asks X for no handle that cannot be one, and answers null for one X does not know", async () => {
    const { fetchFn, calls } = fetchOf(res(404), res(200, { errors: [{ title: "Not Found" }] }));
    const api = xApi(fetchFn, "t");
    expect(await api.userId("not a handle")).toBeNull();
    expect(await api.userId("sixteen_chars_xx")).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await api.userId("gone")).toBeNull();
    expect(await api.userId("odd")).toBeNull();
    await expect(api.userId("hex")).rejects.toThrow("x api 500");
  });

  it("reads a page of a user's posts without reposts in the id window asked, as many as the budget allows within X's 5..100, and says whether X has more", async () => {
    const body = {
      data: [{ id: "30", text: "Prompt: x", author_id: "42", attachments: { media_keys: ["m1"] }, public_metrics: { like_count: 3 } }],
      includes: { media: [{ media_key: "m1", type: "photo", url: "https://pbs.twimg.com/media/1.jpg" }], users: [{ id: "42", username: "HexMethod", name: "Hex" }] },
      meta: { result_count: 1, next_token: "n1" },
    };
    const { fetchFn, calls } = fetchOf(res(200, body), res(200, { ...body, meta: { result_count: 1 } }), res(200, {}), res(404));
    const api = xApi(fetchFn, "t");
    const first = await api.posts("42", "hex", { max: 250, sinceId: "10", untilId: "90" });
    const q = new URL(calls[0].url);
    expect(q.origin + q.pathname).toBe("https://api.x.com/2/users/42/tweets");
    expect(q.searchParams.get("max_results")).toBe("100");
    expect(q.searchParams.get("since_id")).toBe("10");
    expect(q.searchParams.get("until_id")).toBe("90");
    expect(q.searchParams.get("exclude")).toBe("retweets,replies");
    expect(q.searchParams.get("expansions")).toBe("attachments.media_keys,author_id");
    expect(q.searchParams.get("media.fields")).toBe("url,type,alt_text");
    expect(q.searchParams.get("tweet.fields")).toContain("public_metrics");
    expect(first).toEqual({ more: true, posts: [{
      id: "30", url: "https://x.com/HexMethod/status/30", text: "Prompt: x", author: { id: "42", handle: "HexMethod", name: "Hex" },
      photos: [{ url: "https://pbs.twimg.com/media/1.jpg", alt: null }], replyingTo: null, quote: null, likes: 3, videos: 0, conversationId: null,
    }] });

    const last = await api.posts("42", "hex", { max: 2, sinceId: null, untilId: null });
    const q2 = new URL(calls[1].url);
    expect(q2.searchParams.get("max_results")).toBe("5");
    expect(q2.searchParams.has("since_id")).toBe(false);
    expect(q2.searchParams.has("until_id")).toBe(false);
    expect(last.more).toBe(false);

    expect(await api.posts("42", "hex", { max: 10 })).toEqual({ posts: [], more: false });
    expect(await api.posts("42", "hex", { max: 10 })).toEqual({ posts: [], more: false });
  });
});

/**
 * The Creator Hunter's reads (Kev, 2026-10-30): one author's matching posts through X's search (billed per post
 * returned), the long text a long post keeps in note_tweet, the thread a "prompt below" points into, and X's refusals
 * said plainly, never retried.
 */
describe("the creator hunter's reads", () => {
  const author = { id: "42", handle: "HexMethod", name: "Hex" };
  const LONG = "Prompt: " + "a very long prompt word ".repeat(20);

  it("prefers a long post's whole text, counts its videos and GIFs, and keeps its thread", () => {
    const media = new Map([
      ["v", { media_key: "v", type: "video" }],
      ["g", { media_key: "g", type: "animated_gif" }],
      ["p", { media_key: "p", type: "photo", url: "https://pbs.twimg.com/media/p.jpg" }],
    ]);
    const p = postOf({ id: "30", text: "Prompt: a very long pro...", conversation_id: "29", note_tweet: { text: LONG }, attachments: { media_keys: ["v", "g", "p"] } }, media, author);
    expect(p.text).toBe(LONG);
    expect(p.videos).toBe(2);
    expect(p.conversationId).toBe("29");
    expect(p.photos).toEqual([{ url: "https://pbs.twimg.com/media/p.jpg", alt: null }]);
    // The endpoint pages' name for the same field.
    expect(postOf({ id: "31", text: "cut", note_post: { text: LONG } }, new Map(), author).text).toBe(LONG);
    expect(postOf({ id: "32", text: "short", note_tweet: { text: "" } }, new Map(), author).text).toBe("short");
  });

  it("says who X says wrote the post: a handle can change hands, the author is X's id", () => {
    expect(postOf({ id: "30", text: "t", author_id: "42" }, new Map(), author).author).toBe(author);
    expect(postOf({ id: "30", text: "t" }, new Map(), author).author).toBe(author);
    const other = postOf({ id: "31", text: "t", author_id: "99" }, new Map(), author);
    expect(other.author).toEqual({ id: "99", handle: "HexMethod", name: "" });
    expect(other.url).toBe("https://x.com/HexMethod/status/31");
  });

  it("looks an account up with its name, not its picture (Enki shows none), and asks for no handle that cannot be one", async () => {
    const { fetchFn, calls } = fetchOf(res(200, { data: { id: "42", username: "HexMethod", name: "Hex", profile_image_url: "https://pbs.twimg.com/profile_images/1/a_normal.jpg" } }), res(200, { errors: [{}] }));
    const api = xApi(fetchFn, "t");
    expect(await api.user("@hexmethod")).toEqual({ id: "42", handle: "HexMethod", name: "Hex" });
    expect(new URL(calls[0].url).searchParams.get("user.fields")).toBe("name,username");
    expect(await api.user("odd")).toBeNull();
    expect(await api.user("not a handle")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("searches the recent posts or the full archive, newest first, with the long text, the thread and the alt texts, no author expansion", async () => {
    const body = {
      data: [{ id: "30", text: "Prompt: x", attachments: { media_keys: ["m1"] }, conversation_id: "30" }],
      includes: { media: [{ media_key: "m1", type: "photo", url: "https://pbs.twimg.com/media/1.jpg", alt_text: "the prompt" }] },
      meta: { result_count: 1, next_token: "n2" },
    };
    const { fetchFn, calls } = fetchOf(res(200, body), res(200, { meta: { result_count: 0 } }));
    const api = xApi(fetchFn, "t");
    const page = await api.search("from:HexMethod prompt has:images -is:retweet -is:reply", author, { archive: false, max: 250, sinceId: "10", startTime: "2026-01-01T00:00:00.000Z" });
    const q = new URL(calls[0].url);
    expect(q.origin + q.pathname).toBe("https://api.x.com/2/tweets/search/recent");
    expect(q.searchParams.get("query")).toBe("from:HexMethod prompt has:images -is:retweet -is:reply");
    expect(q.searchParams.get("max_results")).toBe("100");
    expect(q.searchParams.get("sort_order")).toBe("recency");
    expect(q.searchParams.get("since_id")).toBe("10");
    // At most one of start_time and since_id.
    expect(q.searchParams.has("start_time")).toBe(false);
    expect(q.searchParams.get("tweet.fields")).toBe("public_metrics,created_at,author_id,referenced_tweets,attachments,conversation_id,note_tweet");
    expect(q.searchParams.get("expansions")).toBe("attachments.media_keys");
    expect(q.searchParams.get("media.fields")).toBe("url,type,alt_text");
    expect(q.searchParams.has("user.fields")).toBe(false);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect(page.nextToken).toBe("n2");
    expect(page.posts).toEqual([{
      id: "30", url: "https://x.com/HexMethod/status/30", text: "Prompt: x", author, likes: 0, replyingTo: null, quote: null,
      photos: [{ url: "https://pbs.twimg.com/media/1.jpg", alt: "the prompt" }], videos: 0, conversationId: "30",
    }]);

    const back = await api.search("q", author, { archive: true, max: 3, untilId: "20", startTime: "2025-10-30T00:00:00.000Z", nextToken: "n2" });
    const q2 = new URL(calls[1].url);
    expect(q2.pathname).toBe("/2/tweets/search/all");
    expect(q2.searchParams.get("max_results")).toBe("10");
    expect(q2.searchParams.get("until_id")).toBe("20");
    expect(q2.searchParams.get("start_time")).toBe("2025-10-30T00:00:00.000Z");
    expect(q2.searchParams.get("next_token")).toBe("n2");
    expect(q2.searchParams.has("since_id")).toBe(false);
    expect(back).toEqual({ posts: [], nextToken: null });
  });

  it("reads the author's own replies in the post's thread, oldest first", async () => {
    const body = { data: [{ id: "35", text: "second" }, { id: "33", text: "first" }] };
    const { fetchFn, calls } = fetchOf(res(200, body), res(200, {}));
    const api = xApi(fetchFn, "t");
    const post = { id: "30", url: "", text: "", author, photos: [], replyingTo: null, quote: null, likes: 0, conversationId: "29" };
    expect((await api.replies(post, author, true))!.map((r) => r.text)).toEqual(["first", "second"]);
    const q = new URL(calls[0].url);
    expect(q.pathname).toBe("/2/tweets/search/all");
    expect(q.searchParams.get("query")).toBe("conversation_id:29 from:HexMethod is:reply");
    expect(q.searchParams.get("max_results")).toBe("10");
    expect(await api.replies({ ...post, conversationId: null }, author, false)).toEqual([]);
    expect(new URL(calls[1].url).pathname).toBe("/2/tweets/search/recent");
    expect(new URL(calls[1].url).searchParams.get("query")).toBe("conversation_id:30 from:HexMethod is:reply");
  });

  it("says why X refused: the rate limit, the token, or X's own words for a bad request; and calls nothing without a token", async () => {
    const { fetchFn } = fetchOf(res(429), res(401), res(403, { title: "Client Forbidden", reason: "client-not-enrolled", detail: "…" }), res(400, { errors: [{ message: "min_likes is not available" }] }), res(400, null), res(503));
    const api = xApi(fetchFn, "t");
    const q = () => api.search("q", author, { archive: false, max: 10 });
    await expect(q()).rejects.toEqual(new Error("X rate limit: press Play again in a minute"));
    await expect(q()).rejects.toEqual(new Error("X refused the token (401)"));
    await expect(q()).rejects.toEqual(new Error("X refused the token (403: Client Forbidden, client-not-enrolled)"));
    await expect(q()).rejects.toEqual(new Error("X refused the request: min_likes is not available"));
    await expect(q()).rejects.toEqual(new Error("X refused the request: bad request"));
    await expect(q()).rejects.toEqual(new Error("x api 503"));
    const none = fetchOf();
    await expect(xApi(none.fetchFn, null).search("q", author, { archive: false, max: 10 })).rejects.toThrow("X_API_BEARER_TOKEN is not set");
    expect(none.calls).toHaveLength(0);
  });
});
