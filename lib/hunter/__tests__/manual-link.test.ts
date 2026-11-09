import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreatorDeps } from "../creator-run";

/**
 * "Add link manually" (Kev, 2026-10-31): the link is read through FxTwitter (a stubbed fetch here, no paid X read), the
 * author is listed, and the post goes through the creator Play's own chain with X's paid API left out. The Play itself
 * is tested in creator-run.test.ts ("takes one post by its link").
 */
const played = vi.hoisted(() => [] as { handle: string; deps: CreatorDeps }[]);
vi.mock("../creator-run", async (orig) => ({
  ...(await orig<object>()),
  playCreator: vi.fn(async (_s: unknown, handle: string, _r: unknown, deps: CreatorDeps) => {
    played.push({ handle, deps });
    return { status: 200, summary: { queued: 1 } };
  }),
}));
import { addLinkManually, queueLink, linkSettled } from "../manual-link";

const tweet = (id: string, o: { text?: string; authorId?: string; screen?: string; replyTo?: string; videos?: unknown[] } = {}) => {
  const same = {
    url: `https://x.com/${o.screen ?? "HexMethod"}/status/${id}`, text: o.text ?? "New set, prompt in the comments 👇",
    author: { id: o.authorId ?? "1500000000000000001", name: "Hex Method", screen_name: o.screen ?? "HexMethod" },
  };
  const photos = o.videos ? [] : [{ url: `https://pbs.twimg.com/media/${id}.jpg`, altText: "" }];
  // The one read names no video (lib/editor/post-import fetchPost); the other is FxTwitter's v2, by the same stub.
  return { tweet: { ...same, media: { photos }, replying_to_status: o.replyTo ?? null }, status: { ...same, id, media: { photos, videos: o.videos }, replying_to: o.replyTo ? { status: o.replyTo } : null } };
};
const fx = (answers: Record<string, unknown>) => {
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(String(url));
    const id = String(url).split("/").pop()!;
    const key = String(url).includes("/2/conversation/") ? `conversation:${id}` : id;
    return answers[key] ? { ok: true, status: 200, json: async () => answers[key] } : { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { f, asked };
};
const upserts: unknown[] = [];
const known = new Map<string, string>();
const supabase = { from: () => ({
  upsert: async (row: unknown) => { upserts.push(row); return { error: null }; },
  select: () => ({ eq: (_c: string, url: string) => ({ limit: async () => ({ data: known.has(url) ? [{ status: known.get(url) }] : [], error: null }) }) }),
}) } as unknown as SupabaseClient;
const deps = { x: { user: vi.fn(), search: vi.fn(), replies: vi.fn() } } as unknown as CreatorDeps;

beforeEach(() => { played.length = 0; upserts.length = 0; known.clear(); });

describe("addLinkManually", () => {
  it("reads the post for free, lists its author, and hands the Play that one post with no paid X read", async () => {
    const { f, asked } = fx({ "1850000000000000001": tweet("1850000000000000001"), "conversation:1850000000000000001": { replies: [] } });
    expect(await addLinkManually(supabase, "https://x.com/HexMethod/status/1850000000000000001?s=20", "kev", deps, f)).toEqual({ status: 200, summary: { queued: 1 }, handle: "hexmethod" });
    expect(asked).toEqual(["https://api.fxtwitter.com/status/1850000000000000001", "https://api.fxtwitter.com/2/status/1850000000000000001"]);
    expect(upserts).toEqual([{ handle: "hexmethod", added_by: "kev", mode: "manual" }]);
    const [{ handle, deps: d }] = played;
    expect(handle).toBe("hexmethod");
    expect(d.only).toMatchObject({ id: "1850000000000000001", author: { id: "1500000000000000001" }, photos: [{ url: "https://pbs.twimg.com/media/1850000000000000001.jpg" }] });
    expect(await d.x.user("hexmethod")).toEqual({ id: "1500000000000000001", handle: "HexMethod", name: "Hex Method" });
    expect(await d.x.search("", { id: "", handle: "", name: "" }, { archive: false, max: 10 })).toEqual({ posts: [], nextToken: null });
    expect(await d.x.replies(d.only!, { id: "", handle: "", name: "" }, false)).toEqual([]);
    expect(deps.x.search).not.toHaveBeenCalled();
  });

  it("takes a link to the author's own reply as the post it answers, with that reply as where the prompt sits", async () => {
    const { f } = fx({
      "1850000000000000002": tweet("1850000000000000002", { text: "Prompt: a lighthouse keeper at dawn, soft fog, 35mm film grain", replyTo: "1850000000000000001" }),
      "1850000000000000001": tweet("1850000000000000001"),
    });
    expect((await addLinkManually(supabase, "x.com/HexMethod/status/1850000000000000002", "kev", deps, f)).status).toBe(200);
    const d = played[0].deps;
    expect(d.only?.id).toBe("1850000000000000001");
    expect(d.comment?.id).toBe("1850000000000000002");
  });

  it("climbs a reply of a reply to the thread's first post, and refuses a thread under someone else's post or too long to climb", async () => {
    const R = (n: number) => String(BigInt("1850000000000000100") + BigInt(n));
    const chain: Record<string, unknown> = { [R(0)]: tweet(R(0)), [R(1)]: tweet(R(1), { replyTo: R(0) }), [R(2)]: tweet(R(2), { replyTo: R(1) }) };
    expect((await addLinkManually(supabase, `https://x.com/HexMethod/status/${R(2)}`, "kev", deps, fx(chain).f)).status).toBe(200);
    expect(played[0].deps.only?.id).toBe(R(0));
    expect(played[0].deps.comment?.id).toBe(R(2));
    const stranger = { ...chain, [R(0)]: tweet(R(0), { authorId: "9", screen: "Other" }) };
    expect(await addLinkManually(supabase, `https://x.com/HexMethod/status/${R(2)}`, "kev", deps, fx(stranger).f)).toMatchObject({ status: 400, error: "That reply is not by the post's author: only their own reply carries their prompt." });
    // Someone else's reply between them ends the climb: it is not the author's own thread.
    const between = { ...chain, [R(1)]: tweet(R(1), { replyTo: R(0), authorId: "9", screen: "Other" }) };
    expect(await addLinkManually(supabase, `https://x.com/HexMethod/status/${R(2)}`, "kev", deps, fx(between).f)).toMatchObject({ status: 400 });
    const gone = { [R(1)]: chain[R(1)], [R(2)]: chain[R(2)] };
    expect(await addLinkManually(supabase, `https://x.com/HexMethod/status/${R(2)}`, "kev", deps, fx(gone).f)).toMatchObject({ status: 404 });
    const long = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [R(i), tweet(R(i), { replyTo: R(i + 1) })]));
    const tooFar = fx(long);
    expect(await addLinkManually(supabase, `https://x.com/HexMethod/status/${R(0)}`, "kev", deps, tooFar.f)).toEqual({ status: 400, error: "This reply sits too far down its thread: add the link of the thread's first post." });
    expect(tooFar.asked).toHaveLength(26);
    expect(played).toHaveLength(1);
  });

  it("finds the prompt in the author's own reply from the post's link alone, free (Kev, 2026-10-31: \"all things gotta be derived from the link\")", async () => {
    const reply = (id: string, authorId: string, to: string, text: string) => ({ id, url: `https://x.com/u/status/${id}`, text, author: { id: authorId }, media: {}, replying_to: { status: to } });
    const { f, asked } = fx({
      "2116173811842208129": tweet("2116173811842208129", { text: "PROMPT DROP. Prompt in reply." }),
      "conversation:2116173811842208129": { replies: [
        reply("2116173816133030187", "1500000000000000001", "2116173811842208129", "Use the uploaded character sheet as the only person. Scene: pure black field."),
        reply("2116174289875640649", "2053883771477262336", "2116173811842208129", "Absolutely adore this! Use my prompt instead, it is longer than forty characters."),
        reply("2116215613525831999", "1500000000000000001", "2116200007481082317", "Thanks! (the author answering someone else, not the post)"),
      ] },
    });
    expect((await addLinkManually(supabase, "https://x.com/AurenVossVT/status/2116173811842208129", "kev", deps, f)).status).toBe(200);
    const d = played[0].deps;
    const replies = await d.x.replies(d.only!, { id: "", handle: "", name: "" }, false);
    expect(replies!.map((r) => [r.id, r.replyingTo, r.author.id])).toEqual([["2116173816133030187", "2116173811842208129", "1500000000000000001"]]);
    expect(asked).toEqual(["https://api.fxtwitter.com/status/2116173811842208129", "https://api.fxtwitter.com/2/status/2116173811842208129", "https://api.fxtwitter.com/2/conversation/2116173811842208129"]);
    // FxTwitter down: the reader says so, and the Play stops rather than read it as no replies (creator-run.test.ts).
    const down = fx({ "2116173811842208129": tweet("2116173811842208129") });
    await addLinkManually(supabase, "https://x.com/AurenVossVT/status/2116173811842208129", "kev", deps, down.f);
    expect(await played[1].deps.x.replies(played[1].deps.only!, { id: "", handle: "", name: "" }, false)).toBeNull();
  });

  // Kev, 2026-11-03: "nicht verwerfen". The first read of a link names no video, so a post read only by it went on as one without.
  it("hands the Play a post's and a reply's videos, by every address, and a read that says nothing about them stops", async () => {
    const VIDEO = { id: "9", url: "https://video.twimg.com/v/9.mp4", thumbnail_url: "https://pbs.twimg.com/t/9.jpg", duration: 12.5, width: 720, height: 1280, formats: [{ url: "https://video.twimg.com/v/9.m3u8", container: "m3u8" }] };
    const POST = "1850000000000000001", REPLY = "1850000000000000002";
    const { f } = fx({ [POST]: tweet(POST, { videos: [VIDEO] }) });
    expect((await addLinkManually(supabase, `https://x.com/HexMethod/status/${POST}`, "kev", deps, f)).status).toBe(200);
    expect(played[0].deps.only).toMatchObject({ id: POST, videos: 1, videoData: [VIDEO] });
    const { f: viaReply } = fx({ [REPLY]: tweet(REPLY, { replyTo: POST, videos: [VIDEO] }), [POST]: tweet(POST) });
    expect((await addLinkManually(supabase, `https://x.com/HexMethod/status/${REPLY}`, "kev", deps, viaReply)).status).toBe(200);
    expect(played[1].deps.comment).toMatchObject({ id: REPLY, videos: 1, videoData: [VIDEO] });
    // The same of a linked reply: its second read fails, and neither the parent nor anything else goes on.
    const replyFirstOnly = { tweet: tweet(REPLY, { replyTo: POST, videos: [VIDEO] }).tweet };
    const failed = await addLinkManually(supabase, `https://x.com/HexMethod/status/${REPLY}`, "kev", deps, fx({ [REPLY]: replyFirstOnly, [POST]: tweet(POST) }).f);
    expect(failed).toMatchObject({ status: 503, error: "The post could not be read right now. Try again in a minute." });
    expect(linkSettled(failed)).toBe(false);
    expect(played).toHaveLength(2);
    // The first read works and the second, which alone knows of videos, does not: nothing goes on, and the link stays in line.
    const only = { tweet: tweet(POST).tweet };
    const got = await addLinkManually(supabase, `https://x.com/HexMethod/status/${POST}`, "kev", deps, fx({ [POST]: only }).f);
    expect(got).toMatchObject({ status: 503 });
    expect(linkSettled(got)).toBe(false);
    expect(played).toHaveLength(2);
  });

  it("a linked reply deleted between its two reads goes on as the first read gave it", async () => {
    const POST = "1850000000000000001", REPLY = "1850000000000000002";
    const answers: Record<string, unknown> = { [`/status/${REPLY}`]: { tweet: tweet(REPLY, { replyTo: POST }).tweet }, [`/status/${POST}`]: { tweet: tweet(POST).tweet }, [`/2/status/${POST}`]: { status: tweet(POST).status } };
    const f = (async (url: string) => { const key = String(url).replace("https://api.fxtwitter.com", ""); return key in answers ? { ok: true, status: 200, json: async () => answers[key] } : { ok: false, status: 404, json: async () => ({}) }; }) as unknown as typeof fetch;
    const pause = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);
    try {
      expect((await addLinkManually(supabase, `https://x.com/HexMethod/status/${REPLY}`, "kev", deps, f)).status).toBe(200);
    } finally {
      pause.mockRestore();
    }
    expect(played[0].deps).toMatchObject({ only: { id: POST }, comment: { id: REPLY, videos: 0 } });
  });

  it("opens nothing for a post already in Enki, by its link or by its author's reply (Kev, 2026-10-31)", async () => {
    known.set("x.com/status/1850000000000000001", "approved");
    const { f, asked } = fx({ "1850000000000000002": tweet("1850000000000000002", { replyTo: "1850000000000000001" }), "1850000000000000001": tweet("1850000000000000001") });
    expect(await addLinkManually(supabase, "https://x.com/HexMethod/status/1850000000000000001", "kev", deps, f)).toEqual({ status: 409, error: "This post is on Enki already.", known: { postId: "1850000000000000001", handle: null, waiting: false } });
    expect(asked).toEqual([]);
    // The log's line names the link that was added, not the post it leads to.
    expect(await addLinkManually(supabase, "https://x.com/HexMethod/status/1850000000000000002", "kev", deps, f)).toEqual({ status: 409, error: "This post is on Enki already.", known: { postId: "1850000000000000002", handle: null, waiting: false } });
    known.set("x.com/status/1850000000000000003", "pending");
    expect(await addLinkManually(supabase, "https://x.com/HexMethod/status/1850000000000000003", "kev", deps, f)).toEqual({ status: 409, error: "This post is waiting in Pending imports already.", known: { postId: "1850000000000000003", handle: null, waiting: true } });
    expect(played).toEqual([]);
  });

  it("follows a forward to its core post, gives the find to the core's author, and counts the chain's reach (Kev, 2026-10-31)", async () => {
    const v2 = (id: string, text: string, authorId: string, screen: string, counts: [number, number, number], quoteId?: string) =>
      ({ status: { id, url: `https://x.com/${screen}/status/${id}`, text, likes: counts[0], reposts: counts[1], quotes: counts[2], author: { id: authorId, name: screen, screen_name: screen }, media: { photos: [{ url: `https://pbs.twimg.com/media/${id}.jpg` }] }, replying_to: null, quote: quoteId ? { id: quoteId } : null } });
    const pages: Record<string, unknown> = {
      "/status/2113702884378279966": tweet("2113702884378279966", { text: "Try this prompt and tag!", authorId: "77", screen: "Purple8419" }),
      "/2/status/2113702884378279966": v2("2113702884378279966", "Try this prompt and tag! 💜\n\nThanks for the invite Sam! 💜\n\nPlease see @VoxxiVicious post for this beautiful prompt here - https://x.com/voxxivicious/status/2113329101423444425?s=46\n\nI’ll tag @EtoileAniko @LoveSerasAI @SukottoRyne @solak42_AI", "77", "Purple8419", [18, 2, 2], "2113582786791506305"),
      "/2/status/2113329101423444425": v2("2113329101423444425", "Halloween witch set, prompt in reply.", "88", "VoxxiVicious", [120, 30, 9]),
    };
    const asked: string[] = [];
    const f = (async (url: string) => {
      const key = String(url).replace("https://api.fxtwitter.com", "");
      asked.push(key);
      return key in pages ? { ok: true, status: 200, json: async () => pages[key] } : { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    expect((await addLinkManually(supabase, "https://x.com/Purple8419/status/2113702884378279966", "kev", deps, f)).status).toBe(200);
    const d = played[0].deps;
    expect(played[0].handle).toBe("voxxivicious");
    expect(d.only).toMatchObject({ id: "2113329101423444425", author: { id: "88" } });
    expect(d.reach).toEqual({ core: { likes: 120, reposts: 30, quotes: 9 }, chain: { posts: 2, likes: 138, reposts: 32, quotes: 11 } });
    expect(asked).not.toContain("/2/status/2113582786791506305");
    known.set("x.com/status/2113329101423444425", "pending");
    expect(await queueLink(supabase, "https://x.com/Purple8419/status/2113702884378279966", "kev", f)).toEqual({ status: 409, error: "This post is waiting in Pending imports already.", known: { postId: "2113702884378279966", handle: null, waiting: true } });
  });

  // Kev, 2026-11-01, @AmirMushich status 2018449250406006985 as FxTwitter gave it: his post only says how to use
  // @AleRVG's system prompt, in the thread he quotes; its bracket line was taken for the prompt.
  it("follows a post that only says how to use the quoted post's prompt to that post, and gives the find to its author", async () => {
    const amir = "1 prompt to become a brand history expert👀\n\nThe prompt below is your guide to\n• design history\n• brands/products heritage\n• industrial evolution\n\nHow to use it:\n1. Use Alex's workflow below 👇\n2. Add this ops-prompt to create a custom heritage:\n\n[Use this prompt structure to develop a visual guide for the [BRAND/PRODUCT NAME]. First, execute PHASE 1-4 of the instructions, populate the verified_data block with factual evidence, and then generate the final image.]\n\nSave this post for later 🔖";
    const alex = "-- DESIGN HERITAGE  --\nHeritage vs. Innovation are not opposites, are layers. \nWe sell everything as revolutionary, but it’s really 80% legacy management and 20% true innovation.\n\nThis System Prompt runs exclusively on verified data, visualizing it through a design lens.🧵";
    const v2 = (id: string, text: string, authorId: string, screen: string, quoteId?: string) =>
      ({ status: { id, url: `https://x.com/${screen}/status/${id}`, text, likes: 1, reposts: 0, quotes: 0, author: { id: authorId, name: screen, screen_name: screen }, media: { photos: [{ url: `https://pbs.twimg.com/media/${id}.jpg` }] }, replying_to: null, quote: quoteId ? { id: quoteId } : null } });
    const pages: Record<string, unknown> = {
      "/status/2018449250406006985": tweet("2018449250406006985", { text: amir, authorId: "249795230", screen: "AmirMushich" }),
      "/2/status/2018449250406006985": v2("2018449250406006985", amir, "249795230", "AmirMushich", "2018416617328140562"),
      "/2/status/2018416617328140562": v2("2018416617328140562", alex, "99", "AleRVG"),
    };
    const f = (async (url: string) => {
      const key = String(url).replace("https://api.fxtwitter.com", "");
      return key in pages ? { ok: true, status: 200, json: async () => pages[key] } : { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    expect((await addLinkManually(supabase, "https://x.com/AmirMushich/status/2018449250406006985", "kev", deps, f)).status).toBe(200);
    expect(played[0].handle).toBe("alervg");
    expect(played[0].deps.only).toMatchObject({ id: "2018416617328140562", author: { id: "99" } });
  });

  // Kev, 2026-11-01: "importiere dann nicht jeden link direkt ... sondern lasse mich erst das einstellen und dann play drücken".
  it("puts a link in line under its creator, the post a reply answers resolved, and plays nothing", async () => {
    const { f } = fx({
      "1850000000000000003": tweet("1850000000000000003", { replyTo: "1850000000000000002", text: `Prompt: ${"a lighthouse at dawn, soft fog, ".repeat(3)}` }),
      "1850000000000000002": tweet("1850000000000000002"),
    });
    expect(await queueLink(supabase, "https://x.com/HexMethod/status/1850000000000000003", "kev", f)).toEqual({ status: 200, handle: "hexmethod" });
    expect(played).toHaveLength(0);
    expect(upserts).toEqual([
      { handle: "hexmethod", added_by: "kev", mode: "manual" },
      expect.objectContaining({ post_id: "1850000000000000003", handle: "hexmethod", author_id: "1500000000000000001", outcome: "waiting" }),
    ]);
    // A post already in Enki is not put in line.
    known.set("x.com/status/1850000000000000004", "pending");
    expect(await queueLink(supabase, "https://x.com/HexMethod/status/1850000000000000004", "kev", f)).toEqual({ status: 409, error: "This post is waiting in Pending imports already.", known: { postId: "1850000000000000004", handle: null, waiting: true } });
  });

  // Review 2026-11-01: a waiting link was dropped when its Play stopped at a cap, the creator was held, or the save failed.
  it("lets a played link leave the line only once it is settled", () => {
    const summary = (o: Partial<{ queued: number; published: number; skipped: Record<string, number> }>) => ({ queued: 0, published: 0, skipped: {}, ...o }) as never;
    expect([
      linkSettled({ status: 200, summary: summary({ queued: 1 }) }),
      linkSettled({ status: 200, summary: summary({ skipped: { no_prompt: 1 } }) }),
      linkSettled({ status: 404, error: "That post is gone." }),
      linkSettled({ status: 400, error: "Not a link to a post on X." }),
      linkSettled({ status: 409, error: "This post is on Enki already." }),
    ]).toEqual([true, true, true, true, true]);
    expect([
      linkSettled({ status: 200, summary: summary({}) }),
      linkSettled({ status: 409, error: "@hexmethod is already playing." }),
      linkSettled({ status: 500, error: "A find of @hexmethod could not be saved" }),
      linkSettled({ status: 503, error: "The post could not be read right now." }),
    ]).toEqual([false, false, false, false]);
  });

  // Review 2026-11-02: a forward whose hop could not be read was filed as a find under the forwarder, its words as the prompt.
  describe("a forward whose way to its core is not known", () => {
    const v2 = (id: string, text: string, o: { quote?: string; to?: string; screen?: string; authorId?: string } = {}) =>
      ({ status: { id, url: `https://x.com/h/status/${id}`, text, author: { id: o.authorId ?? "77", name: "h", screen_name: o.screen ?? "HexMethod" }, media: { photos: [] }, replying_to: o.to ? { status: o.to } : null, quote: o.quote ? { id: o.quote } : null } });
    const answering = (code: number, pages: Record<string, unknown>) => (async (url: string) => {
      const key = String(url).replace("https://api.fxtwitter.com", "");
      return key in pages ? { ok: true, status: 200, json: async () => pages[key] } : { ok: false, status: code, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const ID = "1850000000000000001", NEXT = "1850000000000000002", PARENT = "1850000000000000003";
    const LINK = `https://x.com/h/status/${ID}`;
    const start = { [`/status/${ID}`]: tweet(ID, { text: "Love this one, go try it!" }), [`/2/status/${ID}`]: v2(ID, "Love this one, go try it!", { quote: NEXT }) };
    const real = setTimeout;
    const quick = () => vi.spyOn(globalThis, "setTimeout").mockImplementation(((f: () => void, ms?: number) => real(f, ms === 1500 ? 0 : ms)) as never);

    it("takes nothing and lists nobody when a hop could not be read, played or put in line", async () => {
      const pause = quick();
      try {
        const said = { status: 503, error: "The way from this post to the post it forwards could not be read to its end. Try again in a minute, or add the link of the post that holds the prompt." };
        expect(await addLinkManually(supabase, LINK, "kev", deps, answering(500, start))).toEqual(said);
        expect(await queueLink(supabase, LINK, "kev", answering(500, start))).toEqual(said);
        expect(played).toEqual([]);
        expect(upserts).toEqual([]);
      } finally {
        pause.mockRestore();
      }
    });

    it("says so when the post it forwards is gone, and takes a post with words of its own", async () => {
      const pause = quick();
      try {
        expect(await addLinkManually(supabase, LINK, "kev", deps, answering(404, start))).toEqual({ status: 404, error: "The post this link forwards: That post is gone." });
        expect(await queueLink(supabase, LINK, "kev", answering(404, start))).toEqual({ status: 404, error: "The post this link forwards: That post is gone." });
        expect(played).toEqual([]);
        const WORDS = "A cinematic portrait of a lighthouse keeper at dawn, soft fog, 35mm";
        const own = { [`/status/${ID}`]: tweet(ID, { text: WORDS }), [`/2/status/${ID}`]: v2(ID, WORDS, { quote: NEXT }) };
        expect((await addLinkManually(supabase, LINK, "kev", deps, answering(404, own))).status).toBe(200);
        expect(played[0].deps.only?.id).toBe(ID);
      } finally {
        pause.mockRestore();
      }
    });

    it("plays a chain's core that is a comment as the post it answers, that comment as the reply", async () => {
      const f = answering(500, { ...start, [`/2/status/${NEXT}`]: v2(NEXT, "Prompt: a lighthouse keeper at dawn, soft fog, 35mm film grain", { to: PARENT, screen: "Vox", authorId: "88" }), [`/2/status/${PARENT}`]: v2(PARENT, "Nice set", { screen: "Vox", authorId: "88" }) });
      expect((await addLinkManually(supabase, LINK, "kev", deps, f)).status).toBe(200);
      const d = played[0].deps;
      expect([played[0].handle, d.only?.id]).toEqual(["vox", PARENT]);
      expect(d.comment?.id).toBe(NEXT);
      expect(d.reach?.chain.posts).toBe(3);
    });
  });

  it("refuses what is not a post on X, a post that cannot be read, and someone else's reply, before any Play", async () => {
    expect(await addLinkManually(supabase, "https://example.com/a", "kev", deps, fx({}).f)).toEqual({ status: 400, error: "Not a link to a post on X." });
    expect(await addLinkManually(supabase, "https://x.com/a/status/1850000000000000009", "kev", deps, fx({}).f)).toEqual({ status: 404, error: "That post is gone." });
    const { f } = fx({
      "1850000000000000002": tweet("1850000000000000002", { authorId: "999", screen: "fan", replyTo: "1850000000000000001" }),
      "1850000000000000001": tweet("1850000000000000001"),
    });
    expect(await addLinkManually(supabase, "https://x.com/fan/status/1850000000000000002", "kev", deps, f))
      .toEqual({ status: 400, error: "That reply is not by the post's author: only their own reply carries their prompt." });
    expect(played).toEqual([]);
    expect(upserts).toEqual([]);
  });
});
