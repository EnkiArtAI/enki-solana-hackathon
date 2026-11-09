import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import {
  IMPORT_SAID, KNOWN_GENERATORS, POST_ERROR_SAID, cleanText, detectGenerators, extractPrompt, fetchPost, importPost, importSaid, planImport, postIdOf,
  type Post,
} from "@/lib/editor/post-import";

/**
 * Import from a post on X (Kev, 2026-10-13): the prompt is read from the
 * post's text by its shape, the pictures come along, the generators it names
 * are the ones offered, and a prompt that sits in a reply is reached through
 * that reply's link. No model is asked.
 */
const CATALOGUE = ["Nano Banana Pro", "GPT-Image-2", "Nano Banana 2", "Flux (free)"];
const PROMPT = "A cinematic portrait of a lighthouse keeper at dawn, fog rolling over the rocks, 35mm film grain";
const post = (over: Partial<Post> = {}): Post =>
  ({ url: "https://x.com/ann/status/1", text: PROMPT, author: { id: "42", name: "Ann", handle: "ann" }, photos: [], replyingTo: null, quote: null, ...over });
const photo = (n: number) => ({ url: `https://pbs.twimg.com/media/p${n}.jpg`, alt: null });

const reply = (status: number, body?: unknown): Response =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const fx = (text: string, over: Record<string, unknown> = {}) =>
  ({ tweet: { url: "https://x.com/ann/status/1", text, author: { id: "42", name: "Ann", screen_name: "ann" }, ...over } });
/** A fetch that answers by the status id in the URL; unknown ids are 404. */
const fetchOf = (answers: Record<string, Response | Error>) => {
  const asked: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const u = String(input);
    asked.push(u);
    const a = answers[u.split("/status/")[1] ?? ""];
    if (a instanceof Error) throw a;
    return a ?? reply(404);
  }) as unknown as typeof fetch;
  return { f, asked };
};

describe("postIdOf", () => {
  it("reads the post's id from every spelling of an X link, and nothing else", () => {
    expect(postIdOf("https://x.com/ann/status/1234567890")).toBe("1234567890");
    expect(postIdOf("https://twitter.com/ann/status/1234567890?s=20")).toBe("1234567890");
    expect(postIdOf("https://mobile.x.com/ann/status/1234567890/photo/1")).toBe("1234567890");
    expect(postIdOf("x.com/ann/status/1234567890")).toBe("1234567890");
    expect(postIdOf("https://x.com/ann")).toBeNull();
    expect(postIdOf("https://www.instagram.com/p/abc123/")).toBeNull();
    // Another site's /status/ path is not a post on X.
    expect(postIdOf("https://mastodon.social/@ann/status/1234567890")).toBeNull();
    expect(postIdOf("not a link")).toBeNull();
  });
});

describe("cleanText", () => {
  it("drops links, the reply handles in front and the hashtags at the end, and keeps the rest", () => {
    expect(cleanText(`@bob @cy ${PROMPT} https://t.co/abc\n#ai #nanobanana\n#prompt`)).toBe(PROMPT);
    expect(cleanText(`${PROMPT} #ai #art`)).toBe(PROMPT);
    expect(cleanText(`A #retro poster of a cat\r\nin neon`)).toBe("A #retro poster of a cat\nin neon");
  });
});

describe("extractPrompt", () => {
  it("takes the text after a prompt label, however it is written", () => {
    for (const label of ["Prompt:", "Full prompt 👇", "prompt used -", "Prompt 1:", "Here's the prompt:", "Prompt below 👇", "PROMPT —"]) {
      expect(extractPrompt(`Made this today 🔥\n${label}\n${PROMPT}\n#ai`)).toEqual({ prompt: PROMPT, how: "label" });
    }
  });

  it("takes a code block or a quoted span before anything else", () => {
    expect(extractPrompt("Try it:\n```\n" + PROMPT + "\n```\nenjoy")).toEqual({ prompt: PROMPT, how: "block" });
    expect(extractPrompt(`I used “${PROMPT}” and it worked`)).toEqual({ prompt: PROMPT, how: "quoted" });
    expect(extractPrompt(`I used "${PROMPT}" and it worked`)).toEqual({ prompt: PROMPT, how: "quoted" });
    // A code block too short to be a prompt (a seed, a setting) is not one.
    const short = extractPrompt("```\nseed 42\n```\n" + PROMPT);
    expect(short).toMatchObject({ how: "whole" });
    expect(short.prompt).toContain(PROMPT);
  });

  it("takes the whole post when it is long enough and shaped like nothing else", () => {
    expect(extractPrompt(`${PROMPT} #ai`)).toEqual({ prompt: PROMPT, how: "whole" });
    expect(extractPrompt("wow 😍")).toEqual({ prompt: null, why: "none" });
  });

  it("says when the prompt sits in a reply, and prefers a body that is right here", () => {
    for (const text of ["Prompt in the comments 👇", "Full prompt below", "the prompt is in the first reply", "Prompt 🧵", "comments 👇 for the prompt"]) {
      expect(extractPrompt(`${text}\nLook at these results, the detail is unreal and it took one try`)).toEqual({ prompt: null, why: "reply" });
    }
    expect(extractPrompt(`Prompt below 👇\n${PROMPT}`)).toEqual({ prompt: PROMPT, how: "label" });
  });
});

describe("detectGenerators", () => {
  it("reads the generators a post names, in any spelling, as catalogue names", () => {
    expect(detectGenerators("made with gpt-image-2", CATALOGUE)).toEqual(["GPT-Image-2"]);
    expect(detectGenerators("GPT Image 2 prompt", CATALOGUE)).toEqual(["GPT-Image-2"]);
    expect(detectGenerators("#nanobananapro", CATALOGUE)).toEqual(["Nano Banana Pro"]);
    expect(detectGenerators("Nano Banana Pro prompt", CATALOGUE)).toEqual(["Nano Banana Pro"]);
    expect(detectGenerators("nb2 is wild", CATALOGUE)).toEqual(["Nano Banana 2"]);
    expect(detectGenerators("gpt-image-2 and nano banana 2", CATALOGUE)).toEqual(["GPT-Image-2", "Nano Banana 2"]);
    expect(detectGenerators("flux dev", CATALOGUE)).toEqual(["Flux (free)"]);
  });

  it("offers both Nano Bananas for the bare name, and none for a name the catalogue lacks or the post never gives", () => {
    expect(detectGenerators("#nanobanana", CATALOGUE)).toEqual(["Nano Banana Pro", "Nano Banana 2"]);
    expect(detectGenerators("GPT Image 2.5 Flare", CATALOGUE)).toEqual([]);
    expect(detectGenerators("GPT Image 2.5 Flare", [...CATALOGUE, "GPT-Image-2.5 Flare", "GPT-Image-2.5 Sunburst"])).toEqual(["GPT-Image-2.5 Flare"]);
    expect(detectGenerators("gpt image 2.5", [...CATALOGUE, "GPT-Image-2.5 Flare", "GPT-Image-2.5 Sunburst"])).toEqual(["GPT-Image-2.5 Flare", "GPT-Image-2.5 Sunburst"]);
    expect(detectGenerators("midjourney v7", CATALOGUE)).toEqual([]);
    expect(detectGenerators("an influx of ideas", CATALOGUE)).toEqual([]);
    expect(detectGenerators(PROMPT, CATALOGUE)).toEqual([]);
  });
});

describe("fetchPost", () => {
  it("reads the post as FxTwitter answers it: text, author, at most four photos, the parent and the quote", async () => {
    const { f } = fetchOf({
      "1": reply(200, fx(PROMPT, {
        media: { photos: [1, 2, 3, 4, 5].map((n) => ({ type: "photo", url: `https://pbs.twimg.com/media/p${n}.jpg`, altText: n === 1 ? "a lighthouse" : "" })) },
        replying_to_status: "9",
        quote: { text: "the original", media: { photos: [{ url: "https://pbs.twimg.com/media/q.jpg" }] } },
      })),
    });
    const r = await fetchPost("1", f);
    expect(r).toEqual({ ok: true, post: {
      url: "https://x.com/ann/status/1", text: PROMPT, author: { id: "42", name: "Ann", handle: "ann" },
      photos: [{ ...photo(1), alt: "a lighthouse" }, photo(2), photo(3), photo(4)],
      replyingTo: "9", quote: { text: "the original", photos: [{ url: "https://pbs.twimg.com/media/q.jpg", alt: null }] },
    } });
  });

  it("names the three refusals a user can act on, and calls the rest unreachable", async () => {
    expect(await fetchPost("1", fetchOf({ "1": reply(401) }).f)).toEqual({ ok: false, error: "private" });
    expect(await fetchPost("1", fetchOf({ "1": reply(404) }).f)).toEqual({ ok: false, error: "gone" });
    expect(await fetchPost("1", fetchOf({ "1": reply(500) }).f)).toEqual({ ok: false, error: "unreachable" });
    expect(await fetchPost("1", fetchOf({ "1": new Error("offline") }).f)).toEqual({ ok: false, error: "unreachable" });
    expect(await fetchPost("1", fetchOf({ "1": reply(200, { tweet: { author: {} } }) }).f)).toEqual({ ok: false, error: "unreachable" });
    const bare = await fetchPost("7", fetchOf({ "7": reply(200, { tweet: { text: PROMPT } }) }).f);
    expect(bare).toMatchObject({ ok: true, post: { url: "https://x.com/i/status/7", author: { id: "", name: "", handle: "" }, photos: [], replyingTo: null, quote: null } });
  });
});

describe("planImport", () => {
  it("takes the post's prompt, pictures and named generators, and says so", () => {
    const r = planImport(post({ text: `Nano Banana Pro prompt:\n${PROMPT}`, photos: [photo(1), photo(2)] }), null, CATALOGUE);
    expect(r).toEqual({ ok: true, plan: {
      prompt: PROMPT, generators: ["Nano Banana Pro"], photos: [photo(1), photo(2)], source: { url: "https://x.com/ann/status/1", handle: "ann", authorId: "42" },
      said: "Imported from @ann · 2 images · Nano Banana Pro",
    } });
  });

  it("offers every generator when the post names none, and words the note for one picture and no handle", () => {
    const r = planImport(post({ photos: [photo(1)], author: { id: "", name: "", handle: "" } }), null, CATALOGUE);
    expect(r.ok && r.plan.generators).toEqual([]);
    expect(r.ok && r.plan.said).toBe("Imported from the post · 1 image · all generators");
    expect(importSaid({ handle: "ann", photos: 0, generators: ["GPT-Image-2", "Nano Banana 2"] })).toBe("Imported from @ann · GPT-Image-2, Nano Banana 2");
  });

  it("borrows the pictures of the post a reply answers, and the generator it names", () => {
    const parent = post({ url: "https://x.com/ann/status/0", text: "Made with GPT Image 2, prompt in the comments 👇", photos: [photo(1)] });
    const r = planImport(post({ replyingTo: "0" }), parent, CATALOGUE);
    expect(r).toMatchObject({ ok: true, plan: { prompt: PROMPT, photos: [photo(1)], generators: ["GPT-Image-2"], source: { url: "https://x.com/ann/status/1" } } });
  });

  it("reads the quoted post when the post itself only points at it", () => {
    const r = planImport(post({ text: "this one 👀", quote: { text: `Prompt:\n${PROMPT}`, photos: [photo(3)] } }), null, CATALOGUE);
    expect(r).toMatchObject({ ok: true, plan: { prompt: PROMPT, photos: [photo(3)] } });
  });

  it("says where the prompt is when it is not here", () => {
    expect(planImport(post({ text: "Prompt in the comments 👇 best results yet, four tries and the fourth was the one", photos: [photo(1)] }), null, CATALOGUE))
      .toEqual({ ok: false, why: "reply", said: IMPORT_SAID.reply });
    expect(planImport(post({ text: "wow", photos: [photo(1)] }), null, CATALOGUE)).toEqual({ ok: false, why: "none", said: IMPORT_SAID.none });
  });
});

describe("importPost", () => {
  it("refuses a link that is not a post on X without asking anyone", async () => {
    const { f, asked } = fetchOf({});
    expect(await importPost("https://www.instagram.com/p/abc/", CATALOGUE, f)).toEqual({ ok: false, why: "not-x", said: POST_ERROR_SAID["not-x"] });
    expect(asked).toEqual([]);
  });

  it("fetches the parent only for a reply without pictures, and still imports when the parent cannot be read", async () => {
    const withPhotos = fetchOf({ "1": reply(200, fx(PROMPT, { replying_to_status: "0", media: { photos: [{ url: photo(1).url }] } })) });
    expect(await importPost("https://x.com/ann/status/1", CATALOGUE, withPhotos.f)).toMatchObject({ ok: true, plan: { photos: [photo(1)] } });
    expect(withPhotos.asked).toEqual(["https://api.fxtwitter.com/status/1"]);

    const bare = fetchOf({
      "1": reply(200, fx(PROMPT, { replying_to_status: "0" })),
      "0": reply(200, fx("prompt below 👇 #nanobanana", { media: { photos: [{ url: photo(2).url }] } })),
    });
    expect(await importPost("https://x.com/ann/status/1", CATALOGUE, bare.f)).toMatchObject({ ok: true, plan: { photos: [photo(2)], generators: ["Nano Banana Pro", "Nano Banana 2"] } });
    expect(bare.asked).toEqual(["https://api.fxtwitter.com/status/1", "https://api.fxtwitter.com/status/0"]);

    const orphan = fetchOf({ "1": reply(200, fx(PROMPT, { replying_to_status: "0" })), "0": reply(401) });
    expect(await importPost("https://x.com/ann/status/1", CATALOGUE, orphan.f)).toMatchObject({ ok: true, plan: { photos: [], generators: [] } });
  });

  it("passes a refusal on with its sentence", async () => {
    expect(await importPost("https://x.com/ann/status/1", CATALOGUE, fetchOf({ "1": reply(401) }).f)).toEqual({ ok: false, why: "private", said: POST_ERROR_SAID.private });
  });
});

describe("the import module for a dialog without the catalogue", () => {
  it("knows every name an alias can produce, for a dialog without the catalogue", () => {
    expect(KNOWN_GENERATORS).toEqual(["GPT-Image-2.5 Flare", "GPT-Image-2.5 Sunburst", "GPT-Image-2", "Nano Banana Pro", "Nano Banana 2", "Flux (free)"]);
    expect(detectGenerators("made with nano banana pro and gpt image 2.5 flare", KNOWN_GENERATORS)).toEqual(["GPT-Image-2.5 Flare", "Nano Banana Pro"]);
  });
});
