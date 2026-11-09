import { describe, it, expect } from "vitest";
import { CHAIN_MAX, followChain, forwardTo, fxApi, postOfFx, queryFilter } from "../fx-api";
import { searchQuery } from "../creator-config";
import { CREATOR_DEFAULTS } from "../creator-types";
import { NextRequest } from "next/server";
import { defaultCreatorDeps } from "../creator-run";

/**
 * The Play reading X through FxTwitter, free (Kev, 2026-10-31: "ja play gratis über fxtwitter"). FxTwitter is a stubbed
 * fetch here, shaped as its answers were read live on 2026-10-31 (/2/profile, /2/profile/<h>/media, /2/conversation).
 */
const AUTHOR = { id: "2061077139319918598", handle: "AurenVossVT", name: "Auren" };
const status = (id: string, text: string, o: { likes?: number; replyTo?: string; photos?: number; videos?: number; author?: string } = {}) => ({
  id, url: `https://x.com/AurenVossVT/status/${id}`, text, likes: o.likes ?? 50,
  author: { id: o.author ?? AUTHOR.id, name: "Auren", screen_name: "AurenVossVT" },
  media: { photos: Array.from({ length: o.photos ?? 1 }, (_, i) => ({ url: `https://pbs.twimg.com/media/${id}-${i}.jpg`, altText: i ? "" : "an alt" })), ...(o.videos ? { videos: Array.from({ length: o.videos }, () => ({})) } : {}) },
  replying_to: o.replyTo ? { status: o.replyTo } : null,
});
const fx = (pages: Record<string, unknown>) => {
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(String(url).replace("https://api.fxtwitter.com/2", ""));
    const key = String(url).replace("https://api.fxtwitter.com/2", "");
    return key in pages ? { ok: true, status: 200, json: async () => pages[key] } : { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { api: fxApi(f), asked };
};
const sf = (ms: number, n = 0) => ((BigInt(ms - 1288834974657) << BigInt(22)) + BigInt(n)).toString();
const NOW = Date.parse("2026-10-31T00:00:00Z");
const DAY = 86_400_000;

describe("followChain", () => {
  const v2 = (id: string, text: string, o: { author?: string; to?: string; quote?: string } = {}) => ({ status: { ...status(id, text, { author: o.author, replyTo: o.to }), quote: o.quote ? { id: o.quote } : null } });
  const reads = (pages: Record<string, unknown>) => {
    const asked: string[] = [];
    const f = (async (url: string) => {
      const key = String(url).replace("https://api.fxtwitter.com/2", "");
      asked.push(key);
      return key in pages ? { ok: true, status: 200, json: async () => pages[key] } : { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    return { f, asked };
  };
  const WORDS = "Love this, go try it";

  it("takes a forward that lands on a comment up that author's thread to its first post, the comment still the reply", async () => {
    const { f } = reads({ "/status/1": v2("1", WORDS, { quote: "4" }), "/status/4": v2("4", "Prompt: a lighthouse keeper at dawn, soft fog, 35mm film grain", { author: "88", to: "3" }), "/status/3": v2("3", "the middle of the thread", { author: "88", to: "2" }), "/status/2": v2("2", "the set", { author: "88" }) });
    const chain = await followChain("1", f, 0);
    expect(chain).toMatchObject({ core: { id: "2" }, reply: { id: "4" } });
    expect(chain?.hops.map((h) => h.id)).toEqual(["1", "4", "3", "2"]);
  });

  it("stops at someone else's post, says broken on a read that failed or a thread past THREAD_MAX", async () => {
    const someone = reads({ "/status/1": v2("1", WORDS, { quote: "4" }), "/status/4": v2("4", "Prompt: a lighthouse keeper at dawn, soft fog, 35mm film grain", { author: "88", to: "3" }), "/status/3": v2("3", "their own answer", { author: "88", to: "2" }), "/status/2": v2("2", "a stranger's", { author: "9" }) });
    expect(await followChain("1", someone.f, 0)).toMatchObject({ core: { id: "3" }, reply: { id: "4" } });
    const failing = (async (url: string) => (String(url).endsWith("/status/3") ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ "/status/1": v2("1", WORDS, { quote: "4" }), "/status/4": v2("4", "Prompt: a lighthouse keeper at dawn, soft fog, 35mm film grain", { author: "88", to: "3" }) }[String(url).replace("https://api.fxtwitter.com/2", "")]) })) as unknown as typeof fetch;
    expect(await followChain("1", failing, 0)).toMatchObject({ core: { id: "4" }, broken: true });
    const ID = (n: number) => String(1000 + n);
    const long: Record<string, unknown> = { "/status/1": v2("1", WORDS, { quote: ID(0) }) };
    for (let i = 0; i < 40; i++) long[`/status/${ID(i)}`] = v2(ID(i), "Prompt: a lighthouse keeper at dawn, soft fog, 35mm film grain", { author: "88", to: ID(i + 1) });
    expect(await followChain("1", reads(long).f, 0)).toMatchObject({ core: { id: ID(0) }, broken: true });
  });
});

describe("fxApi", () => {
  it("is what a Play reads with by default: free, not X's paid API", () => {
    const d = defaultCreatorDeps({} as never, new NextRequest("http://localhost:3008/api/admin"));
    expect(d.x.free).toBe(true);
    // And a forward is followed there.
    expect(typeof d.fxFetch).toBe("function");
  });

  it("says its reads are free and finds the profile, or null for an unknown handle", async () => {
    const { api } = fx({ "/profile/AurenVossVT": { user: { id: AUTHOR.id, name: "Auren", screen_name: "AurenVossVT" } } });
    expect(api.free).toBe(true);
    expect(await api.user("AurenVossVT")).toEqual(AUTHOR);
    expect(await api.user("nobody_here")).toBeNull();
  });

  it("keeps the creator's own posts the query asks for: words, likes floor, no replies; pages by FxTwitter's cursor", async () => {
    const q = searchQuery("aurenvossvt", { ...CREATOR_DEFAULTS, words: ["prompt", "free prompt"], minLikes: 20 });
    expect(queryFilter(q)).toEqual({ words: ["prompt", "free prompt"], minLikes: 20 });
    const a = sf(NOW - DAY, 3), b = sf(NOW - DAY, 2), c = sf(NOW - DAY, 1), d = sf(NOW - 2 * DAY, 9);
    const { api, asked } = fx({
      "/profile/AurenVossVT/media": { results: [status(a, "💥PROMPT DROP💥 Prompt in reply."), status(b, "gm everyone"), status(c, "a PROMPT for you", { likes: 3 }), status(d, "my prompt", { replyTo: "1" })], cursor: { bottom: "CUR2" } },
      "/profile/AurenVossVT/media?cursor=CUR2": { results: [], cursor: { bottom: "CUR3" } },
    });
    const one = await api.search(q, AUTHOR, { archive: true, max: 100 });
    expect(one.posts.map((p) => p.id)).toEqual([a]);
    expect(one.nextToken).toBe("CUR2");
    expect(one.posts[0]).toMatchObject({ author: AUTHOR, likes: 50, videos: 0, replyingTo: null, photos: [{ url: `https://pbs.twimg.com/media/${a}-0.jpg`, alt: "an alt" }] });
    // An empty page is the end.
    expect(await api.search(q, AUTHOR, { archive: true, max: 100, nextToken: "CUR2" })).toEqual({ posts: [], nextToken: null });
    expect(asked).toEqual(["/profile/AurenVossVT/media", "/profile/AurenVossVT/media?cursor=CUR2"]);
  });

  it("reads only what is new above sinceId, older than untilId from where that post's page ended, and stops at the look back's start", async () => {
    const q = searchQuery("aurenvossvt", { ...CREATOR_DEFAULTS, words: [] });
    const ids = [5, 4, 3, 2].map((n) => sf(NOW - n * DAY));
    const { api, asked } = fx({
      "/profile/AurenVossVT/media": { results: [ids[3], ids[2]].map((id) => status(id, "x")), cursor: { bottom: "P2" } },
      "/profile/AurenVossVT/media?cursor=P2": { results: [ids[1], ids[0]].map((id) => status(id, "x")), cursor: { bottom: "P3" } },
    });
    // Newest first: ids[3] (2 days old) and ids[2] on page 1, ids[1] and ids[0] (5 days old) on page 2.
    const fresh = await api.search(q, AUTHOR, { archive: false, max: 100, sinceId: ids[2] });
    expect(fresh).toEqual({ posts: [expect.objectContaining({ id: ids[3] })], nextToken: null });
    // Below ids[2], the look back goes on from page 1's cursor instead of the top.
    const back = await api.search(q, AUTHOR, { archive: true, max: 100, untilId: ids[2] });
    expect(back.posts.map((p) => p.id)).toEqual([ids[1], ids[0]]);
    expect(asked.at(-1)).toBe("/profile/AurenVossVT/media?cursor=P2");
    // A look back that starts 4 days ago keeps ids[1] and ends there.
    const since = await api.search(q, AUTHOR, { archive: true, max: 100, nextToken: "P2", startTime: new Date(NOW - 4.5 * DAY).toISOString() });
    expect(since).toEqual({ posts: [expect.objectContaining({ id: ids[1] })], nextToken: null });
  });

  it("counts a post's videos, carries each as FxTwitter gives it, and reads the author's own replies to the post only", async () => {
    expect(postOfFx(status("7", "clip", { photos: 0, videos: 2 }))).toMatchObject({ videos: 2, photos: [] });
    const video = { id: "v", url: "https://video.twimg.com/v.mp4", thumbnail_url: "https://pbs.twimg.com/t.jpg", duration: 3, width: 1, height: 2, type: "video", formats: [{ url: "https://video.twimg.com/v.m3u8", container: "m3u8" }] };
    const raw = status("7", "clip", { photos: 0 }) as unknown as { media: { videos?: unknown[] } };
    expect(postOfFx({ ...raw, media: { videos: [video, null, "no"] } } as never)).toMatchObject({ videos: 3, videoData: [video] });
    expect(postOfFx(status("7", "no video", { photos: 1 }))?.videoData).toEqual([]);
    expect(postOfFx({ id: "7" })).toBeNull();
    const post = postOfFx(status("100", "Prompt in reply."))!;
    const { api } = fx({
      "/conversation/100": { replies: [status("101", "Use the uploaded sheet. Scene: black field.", { replyTo: "100", photos: 0 }), status("102", "love it", { replyTo: "100", author: "9" }), status("103", "thanks!", { replyTo: "555" })] },
    });
    expect((await api.replies(post, AUTHOR, false))!.map((r) => [r.id, r.replyingTo])).toEqual([["101", "100"]]);
  });

  it("asks a timeline page that answered 404 once more, and then stops the round instead of reading it as the end (Kev, 2026-10-31)", async () => {
    const answers = [404, 404, 404, 200];
    let calls = 0;
    const flaky = fxApi((async () => { calls += 1; const s = answers.shift() ?? 404; return { ok: s === 200, status: s, json: async () => ({ results: [status("5", "a prompt")], cursor: { bottom: "N" } }) }; }) as unknown as typeof fetch, 0);
    expect((await flaky.search("from:a prompt", AUTHOR, { archive: true, max: 10 })).posts.map((p) => p.id)).toEqual(["5"]);
    expect(calls).toBe(4);
    await expect(flaky.search("from:a prompt", AUTHOR, { archive: true, max: 10 })).rejects.toThrow("FxTwitter did not list the posts right now: press Play again in a minute");
    expect(calls).toBe(8);
  });

  it("asks the conversation up to four times when it fails, then reads the author's reply (Kev, 2026-10-31: @AmirMushich's)", async () => {
    const post = postOfFx(status("100", "Prompt 🔽"))!;
    const answers = [404, 502, 200];
    let calls = 0;
    const f = (async () => { calls += 1; const s = answers.shift() ?? 404; return { ok: s === 200, status: s, json: async () => ({ replies: [status("101", "the prompt itself, long enough to count", { replyTo: "100", photos: 0 })] }) }; }) as unknown as typeof fetch;
    expect((await fxApi(f, 0).replies(post, AUTHOR, false))!.map((r) => r.id)).toEqual(["101"]);
    expect(calls).toBe(3);
  });

  it("reads the author's own thread below the post at any depth and in any order, and never their answers to someone else", async () => {
    const post = postOfFx(status("100", "New set"))!;
    const { api } = fx({ "/conversation/100": { replies: [
      status("103", "the third, with the clip", { replyTo: "102", photos: 0, videos: 1 }),
      status("101", "the first", { replyTo: "100", photos: 0 }),
      status("102", "the second", { replyTo: "101", photos: 0 }),
      status("200", "a fan's question", { replyTo: "100", author: "9", photos: 0 }),
      status("201", "the author's answer to the fan", { replyTo: "200", photos: 0, videos: 1 }),
      status("202", "and on from that answer", { replyTo: "201", photos: 0 }),
      status("300", "under a post not on this page", { replyTo: "555", photos: 0 }),
    ] } });
    // The direct one first, the page's order after it.
    expect((await api.replies(post, AUTHOR, false))!.map((r) => [r.id, r.videos, r.conversationId])).toEqual([["101", 0, "100"], ["103", 1, "100"], ["102", 0, "100"]]);
  });

  it("tells a conversation that failed from one with no replies: null, never an empty list", async () => {
    const post = postOfFx(status("100", "Prompt 🔽"))!;
    let calls = 0;
    const failing = (async () => { calls += 1; return { ok: false, status: 500, json: async () => ({}) }; }) as unknown as typeof fetch;
    expect(await fxApi(failing, 0).replies(post, AUTHOR, false)).toBeNull();
    expect(calls).toBe(4);
    const thrown = (async () => { throw new Error("FxTwitter is down"); }) as unknown as typeof fetch;
    expect(await fxApi(thrown, 0).replies(post, AUTHOR, false)).toBeNull();
    const none = (async () => ({ ok: true, status: 200, json: async () => ({ replies: [] }) })) as unknown as typeof fetch;
    expect(await fxApi(none, 0).replies(post, AUTHOR, false)).toEqual([]);
  });

  // A forward: short words and a link or a quote, the link first; own words past 280 characters or a label are its own prompt.
  it("says where a post forwards to, and null while it holds a prompt of its own", () => {
    const of = (text: string, quote?: string) => postOfFx({ ...status("1", text), quote: quote ? { id: quote } : null })!;
    expect(of("Love this", "7").quoteId).toBe("7");
    expect(of("Love this").quoteId).toBeNull();
    expect(forwardTo(of("Love this", "7"))).toBe("7");
    expect(forwardTo(of("Love this https://x.com/a/status/9?s=46", "7"))).toBe("9");
    expect(forwardTo(of("Love this https://twitter.com/a/status/8"))).toBe("8");
    expect(forwardTo(of("Love this"))).toBeNull();
    expect(forwardTo(of("Prompt: a lighthouse keeper at dawn, soft fog, 35mm film grain", "7"))).toBeNull();
    expect(forwardTo(of("New set, prompt in the comments 👇", "7"))).toBeNull();
    expect(forwardTo(of("word ".repeat(56).trim(), "7"))).toBe("7");
    expect(forwardTo(of(`${"word ".repeat(56)}more`, "7"))).toBeNull();
    // Mentions and links do not count as its own words.
    expect(forwardTo(of(`${"@someone ".repeat(60)}x`, "7"))).toBe("7");
    // Words on how to use a prompt held elsewhere are a forward however they are labelled.
    expect(forwardTo(of("Prompt: use this prompt structure and execute PHASE 1-4 of the instructions below, then generate the final image", "7"))).toBe("7");
  });

  it("follows a chain to its core, stops at CHAIN_MAX and at a loop, and says when a post it leads to could not be read", async () => {
    const hop = (n: number, next: number | null) => ({ status: { ...status(String(n), "Love this"), quote: next ? { id: String(next) } : null } });
    const of = (pages: Record<string, unknown>) => (async (url: string) => {
      const key = String(url).split("/").pop()!;
      if (key in pages) return { ok: true, status: 200, json: async () => pages[key] };
      throw new Error("down");
    }) as unknown as typeof fetch;
    const two = await followChain("1", of({ 1: hop(1, 2), 2: hop(2, null) }));
    expect([two?.core.id, two?.hops.map((h) => h.id), two?.broken]).toEqual(["2", ["1", "2"], undefined]);
    const long = await followChain("1", of(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, hop(i + 1, i + 2)]))));
    expect(long?.hops).toHaveLength(CHAIN_MAX);
    expect(long?.broken).toBe(true);
    const loop = await followChain("1", of({ 1: hop(1, 2), 2: hop(2, 1) }));
    expect([loop?.core.id, loop?.broken]).toEqual(["2", true]);
    // A post that links itself forwards nothing.
    const self = await followChain("1", of({ 1: hop(1, 1) }));
    expect([self?.core.id, self?.broken]).toEqual(["1", undefined]);
    const cut = await followChain("1", of({ 1: hop(1, 2) }));
    expect([cut?.core.id, cut?.broken]).toEqual(["1", true]);
    expect(await followChain("1", of({}))).toBeNull();
  });

  it("tells a post that is gone from a read that failed: the last hop with words of its own is the core, one without is nothing to follow", async () => {
    const hop = (n: number, text: string, next: number) => ({ status: { ...status(String(n), text), quote: { id: String(next) } } });
    const answering = (code: number, pages: Record<string, unknown>) => (async (url: string) => {
      const key = String(url).split("/").pop()!;
      return key in pages ? { ok: true, status: 200, json: async () => pages[key] } : { ok: false, status: code, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const LONG = "A cinematic portrait of a lighthouse keeper at dawn, soft fog, 35mm";
    for (const code of [404, 401]) {
      const short = await followChain("1", answering(code, { 1: hop(1, "Love this", 2) }), 0);
      expect([code, short?.core.id, short?.gone, short?.broken]).toEqual([code, "1", true, undefined]);
      const own = await followChain("1", answering(code, { 1: hop(1, LONG, 2) }), 0);
      expect([code, own?.core.id, own?.gone, own?.broken]).toEqual([code, "1", undefined, undefined]);
      const deeper = await followChain("1", answering(code, { 1: hop(1, "Love this", 2), 2: hop(2, LONG, 3) }), 0);
      expect([code, deeper?.core.id, deeper?.gone, deeper?.hops.length]).toEqual([code, "2", undefined, 2]);
      expect(await followChain("1", answering(code, {}), 0)).toBeNull();
    }
    const failed = await followChain("1", answering(500, { 1: hop(1, LONG, 2) }), 0);
    expect([failed?.core.id, failed?.gone, failed?.broken]).toEqual(["1", undefined, true]);
    // Words on how to use a prompt held elsewhere are no words of its own, however long.
    const defers = await followChain("1", answering(404, { 1: hop(1, "Use this prompt structure and execute PHASE 1-4 of the instructions below, then generate", 2) }), 0);
    expect(defers?.gone).toBe(true);
  });

  it("takes a chain's core that is a comment as the post its author answers, with the comment as the reply, and not another's", async () => {
    const hop = (n: number, next: number) => ({ status: { ...status(String(n), "Love this", { author: "77" }), quote: { id: String(next) } } });
    const comment = (n: number, to: number) => ({ status: status(String(n), "Prompt: a lighthouse keeper at dawn, soft fog, 35mm film grain", { replyTo: String(to) }) });
    const answering = (code: number, pages: Record<string, unknown>) => (async (url: string) => {
      const key = String(url).split("/").pop()!;
      return key in pages ? { ok: true, status: 200, json: async () => pages[key] } : { ok: false, status: code, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const mine = await followChain("1", answering(404, { 1: hop(1, 2), 2: comment(2, 3), 3: { status: status("3", "Nice set") } }), 0);
    expect([mine?.core.id, mine?.reply?.id, mine?.hops.map((h) => h.id), mine?.broken]).toEqual(["3", "2", ["1", "2", "3"], undefined]);
    const another = await followChain("1", answering(404, { 1: hop(1, 2), 2: comment(2, 3), 3: { status: status("3", "Nice set", { author: "99" }) } }), 0);
    expect([another?.core.id, another?.reply, another?.broken]).toEqual(["2", undefined, undefined]);
    const gone = await followChain("1", answering(404, { 1: hop(1, 2), 2: comment(2, 3) }), 0);
    expect([gone?.core.id, gone?.reply, gone?.broken]).toEqual(["2", undefined, undefined]);
    const failed = await followChain("1", answering(500, { 1: hop(1, 2), 2: comment(2, 3) }), 0);
    expect([failed?.core.id, failed?.broken]).toEqual(["2", true]);
    // A post asked for itself that is a comment is the caller's to climb.
    const alone = await followChain("2", answering(404, { 2: comment(2, 3), 3: { status: status("3", "Nice set") } }), 0);
    expect([alone?.core.id, alone?.reply]).toEqual(["2", undefined]);
  });

  it("gives a core with no picture the nearest forward's, without its alt text; never a video-only core's, or over a comment's own", async () => {
    const hop = (n: number, next: number, photos = 1) => ({ status: { ...status(String(n), "Love this", { author: "77", photos }), quote: { id: String(next) } } });
    const of = (pages: Record<string, unknown>) => (async (url: string) => {
      const key = String(url).split("/").pop()!;
      return key in pages ? { ok: true, status: 200, json: async () => pages[key] } : { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const TEXT = "Prompt: a lighthouse keeper at dawn, soft fog, 35mm film grain";
    const plain = await followChain("1", of({ 1: hop(1, 2), 2: hop(2, 3, 0), 3: { status: status("3", TEXT, { photos: 0 }) } }), 0);
    expect(plain?.core.photos).toEqual([{ url: "https://pbs.twimg.com/media/1-0.jpg", alt: null }]);
    expect(plain?.hops[2].photos).toEqual([]);
    const near = await followChain("1", of({ 1: hop(1, 2), 2: hop(2, 3), 3: { status: status("3", TEXT, { photos: 0 }) } }), 0);
    expect(near?.core.photos[0].url).toBe("https://pbs.twimg.com/media/2-0.jpg");
    const own = await followChain("1", of({ 1: hop(1, 3), 3: { status: status("3", TEXT) } }), 0);
    expect(own?.core.photos[0]).toEqual({ url: "https://pbs.twimg.com/media/3-0.jpg", alt: "an alt" });
    const video = await followChain("1", of({ 1: hop(1, 3), 3: { status: status("3", TEXT, { photos: 0, videos: 1 }) } }), 0);
    expect(video?.core.photos).toEqual([]);
    const withComment = await followChain("1", of({ 1: hop(1, 2), 2: { status: status("2", TEXT, { replyTo: "3" }) }, 3: { status: status("3", "Nice set", { photos: 0 }) } }), 0);
    expect([withComment?.core.id, withComment?.core.photos]).toEqual(["3", []]);
    const bareComment = await followChain("1", of({ 1: hop(1, 2), 2: { status: status("2", TEXT, { replyTo: "3", photos: 0 }) }, 3: { status: status("3", "Nice set", { photos: 0 }) } }), 0);
    expect([bareComment?.core.id, bareComment?.core.photos[0]?.url]).toEqual(["3", "https://pbs.twimg.com/media/1-0.jpg"]);
  });

  it("says FxTwitter is busy on 429 and fails on other errors, so the round stops and nothing is skipped", async () => {
    const busy = fxApi((async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch);
    await expect(busy.search("from:a", AUTHOR, { archive: true, max: 10 })).rejects.toThrow("FxTwitter is busy: press Play again in a minute");
    const down = fxApi((async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch);
    await expect(down.user("a")).rejects.toThrow("FxTwitter could not be read (502)");
  });
});
