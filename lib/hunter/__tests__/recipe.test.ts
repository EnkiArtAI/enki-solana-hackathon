import { describe, it, expect } from "vitest";
import type { XPost } from "../x-api";
import { RECIPE_DEFAULT, huntModeOf, parseRecipe } from "../recipe";
import { cutByRecipe, manualCut, rawText } from "../recipe-cut";

/**
 * A creator's recipe (Kev, 2026-11-01: "setting up the structure and then just cut everything around the social-post
 * behavior"), on @AmirMushich's posts and replies as FxTwitter gave them (status 2050998863104745900, 2048113624560918680).
 */
const post = (id: string, text: string): XPost => ({
  id, url: `https://x.com/AmirMushich/status/${id}`, text, author: { id: "249795230", handle: "AmirMushich", name: "Amir" },
  photos: [{ url: `https://pbs.twimg.com/media/${id}.jpg` }], replyingTo: null, quote: null, likes: 0, conversationId: id,
} as XPost);
const MAIN = post("2050998863104745900", "Nano Banana smart prompt \n\nEthereal brand landscape\n\nPrompt 👇\nGrab more designer prompts in my pinned 📌");
const BODY = "Act as a CGI Art Director and Environment Photographer creating a cinematic hero landscape with a glass logo sculpture emerging from a misty valley at dawn.";
const REPLY = post("2050998866896375815", `Prompt:  \n(access Nano Banana 2 here: https://amirmushich.link/AMIR-LTX)\n\n[BRAND NAME]\n\n${BODY}`);
const PROMO = post("2050998869840847296", "Make 2026 your creative growth year\n\nUse my free & pro assets 💪👇\nhttps://amirmushich.gumroad.com");
const AMIR = { from: "reply" as const, after: "(access", before: "", titleLine: 2 };

describe("cutByRecipe", () => {
  it("cuts the prompt from the reply after the marker line, and names it by a line of the post", () => {
    expect(cutByRecipe(MAIN, [REPLY, PROMO], AMIR)).toEqual({ ok: true, prompt: `[BRAND NAME]\n\n${BODY}`, from: "reply", reply: REPLY, title: "Ethereal brand landscape" });
    // No title line: none, the find is named by the prompt's first words.
    expect(cutByRecipe(MAIN, [REPLY], { ...AMIR, titleLine: 0 })).toMatchObject({ ok: true, title: "" });
  });

  it("skips the lines a parenthesis of the marker line still holds open", () => {
    const two = post("2048113629816312018", `Prompt:\n(access pro tools for AI design:\nhttps://amirmushich.link/AMIR-LTX)\n\n[BRAND NAME = CHANGE TO YOUR BRAND]. \n${BODY}`);
    const got = cutByRecipe(MAIN, [two], AMIR);
    expect(got.ok && got.prompt.startsWith("[BRAND NAME = CHANGE TO YOUR BRAND].")).toBe(true);
    expect(got.ok && got.prompt).not.toContain("amirmushich.link");
  });

  it("ends before the end marker, and takes calls to action and bare links off the end", () => {
    const tail = post("3", `Prompt:\n${BODY}\n\nGrab more designer prompts in my pinned 📌\nhttps://x.com/a/status/1\n#ai #design`);
    expect(cutByRecipe(tail, [], { from: "text", after: "prompt:", before: "", titleLine: 0 })).toMatchObject({ ok: true, prompt: BODY, from: "text", reply: null });
    const ended = post("4", `Prompt:\n${BODY}\nWorks with GPT Image too\nmore below`);
    expect(cutByRecipe(ended, [], { from: "text", after: "Prompt:", before: "works with", titleLine: 0 })).toMatchObject({ ok: true, prompt: BODY });
  });

  // Review 2026-11-01: one pattern over a credits line backtracked exponentially (24 mentions took 550 ms, doubling).
  it("takes a long line of mentions and hashtags off the end at once", () => {
    const credits = `${Array.from({ length: 40 }, (_, i) => `@u${i}`).join(" ")} #a#b#c#d#e#f#g#h#i#j#k#l#m#n#o#p#q#r#s#t`;
    const started = Date.now();
    expect(cutByRecipe(post("7", `Prompt:\n${BODY}\n${credits}`), [], { from: "text", after: "Prompt:", before: "", titleLine: 0 })).toMatchObject({ ok: true, prompt: BODY });
    expect(cutByRecipe(post("8", `Prompt:\n${BODY}\n${Array.from({ length: 40 }, (_, i) => `@u${i}`).join(" ")} thanks!`), [], { from: "text", after: "Prompt:", before: "", titleLine: 0 })).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("says why it could not cut: no reply, no marker, or too short a cut", () => {
    expect(cutByRecipe(MAIN, [], AMIR)).toEqual({ ok: false, reason: "the author left no reply" });
    expect(cutByRecipe(MAIN, [PROMO], AMIR)).toEqual({ ok: false, reason: 'no reply holds "(access"' });
    expect(cutByRecipe(MAIN, [post("5", "(access here)\nthanks!")], AMIR)).toEqual({ ok: false, reason: "the cut is too short for a prompt" });
  });

  it("takes the reply that reads as a prompt when no start marker is set", () => {
    expect(cutByRecipe(MAIN, [PROMO, post("6", BODY)], { from: "reply", after: "", before: "", titleLine: 0 })).toMatchObject({ ok: true, prompt: BODY });
  });
});

describe("the recipe's shape", () => {
  it("falls back to the default on anything off its shape, and trims and caps the markers", () => {
    expect(parseRecipe(null)).toEqual(RECIPE_DEFAULT);
    expect(parseRecipe({ from: "text", after: `  ${"x".repeat(90)} `, before: 3, titleLine: 11 })).toEqual({ from: "text", after: "x".repeat(80), before: "", titleLine: 0 });
    expect(parseRecipe({ from: "elsewhere", titleLine: 2.5 })).toMatchObject({ from: "reply", titleLine: 0 });
    expect([huntModeOf("recipe"), huntModeOf("manual"), huntModeOf("nope"), huntModeOf(undefined)]).toEqual(["recipe", "manual", "auto", "auto"]);
  });

  it("gives manual mode the post's whole text and the author's replies, as written", () => {
    expect(rawText(MAIN, [REPLY])).toBe(`${MAIN.text.trim()}\n\n${REPLY.text.trim()}`);
  });
});

// Kev, 2026-11-03: "meistens ist es dann eifnach der gesamte text ab der letzten vorherigen leeren zeile. manchmal mit oder ohne überschrift".
describe("manualCut's order", () => {
  const LABELLED = `New set\n\nPrompt: ${BODY}`;
  const PROMO_REPLY = post("3", "I built a free tool that turns any photo into this exact look, try it here: https://t.co/abc");
  it("a labelled prompt or a code block in the post comes before any reply", () => {
    expect(manualCut(post("1", LABELLED), [PROMO_REPLY])).toEqual({ ok: true, prompt: BODY, from: "text", reply: null, title: "" });
    expect(manualCut(post("1", `New set\n\n\`\`\`\n${BODY}\n\`\`\``), [PROMO_REPLY])).toMatchObject({ prompt: BODY, from: "text" });
    // Unsure words in the post do not: the reply is read first, as before.
    const toThePost = { ...PROMO_REPLY, replyingTo: "1" };
    expect(manualCut(post("1", `New set\n\n${BODY}`), [toThePost])).toMatchObject({ from: "reply", reply: toThePost });
    // A reply the link named comes first even so.
    expect(manualCut(post("1", LABELLED), [PROMO_REPLY], PROMO_REPLY)).toMatchObject({ from: "reply", reply: PROMO_REPLY });
  });
  it("a reply that shows an example is no prompt: not even the longest", () => {
    const EXAMPLE_2 = post("4", `Example 2: the same prompt with a red car and a blue sky at night, and more words to be the longest here`);
    expect(manualCut(post("1", `New set\n\n${BODY}`), [EXAMPLE_2])).toMatchObject({ from: "text", reply: null, prompt: BODY });
    const real = { ...post("5", "A cat on a plain table in soft window light, 85mm, film grain"), replyingTo: "1" };
    expect(manualCut(post("1", `New set\n\n${BODY}`), [{ ...EXAMPLE_2, replyingTo: "1" }, real])).toMatchObject({ from: "reply", prompt: real.text });
  });
});

describe("manualCut's heading", () => {
  it("a first line that opens a fence, a brace or a bracket stays in the prompt, with letters in it or not", () => {
    const fenced = "```json\n{\n  \"subject\": \"a lighthouse keeper at dawn in the fog\"\n}\n```";
    expect(manualCut(post("1", "New set"), [{ ...post("2", fenced), replyingTo: "1" }])).toMatchObject({ title: "", prompt: fenced, from: "reply" });
    const compact = "{\"style\": \"noir\",\n\"subject\": \"a lighthouse keeper at dawn in the fog\"}";
    expect(manualCut(post("1", `Intro\n\n${compact}`), [])).toMatchObject({ title: "", prompt: compact });
    const slot = "[BRAND] on a card\nA matte black card on a plain table, soft north light, 85mm lens";
    expect(manualCut(post("1", `Intro\n\n${slot}`), [])).toMatchObject({ title: "", prompt: slot });
    // A plain short line is still the heading.
    expect(manualCut(post("1", "Intro\n\nGolden hour\nA matte black card on a plain table, soft north light, 85mm lens"), [])).toMatchObject({ title: "Golden hour" });
  });
});

describe("manualCut down a thread", () => {
  const under = (id: string, to: string, text: string) => ({ ...post(id, text), replyingTo: to });
  const DEEP = `And a long word on what came next in this thread, which is its own post: ${"more ".repeat(30)}`;
  it("takes the longest direct reply before a longer one further down, and a deeper one when no direct one could be a prompt", () => {
    expect(manualCut(post("1", "New set"), [under("3", "2", DEEP), under("2", "1", BODY)])).toMatchObject({ prompt: BODY, from: "reply" });
    expect(manualCut(post("1", "New set"), [under("2", "1", "Enjoy!"), under("3", "2", BODY)])).toMatchObject({ prompt: BODY, from: "reply" });
    // The post's own words come before a reply further down.
    expect(manualCut(post("1", `New set\n\n${BODY}`), [under("2", "1", "Enjoy!"), under("3", "2", DEEP)])).toMatchObject({ prompt: BODY, from: "text" });
    expect(manualCut(post("1", "New set"), [under("2", "1", "Enjoy!")])).toMatchObject({ ok: false });
    // A direct reply that is all call to action, with the prompt under it.
    const cta = under("2", "1", "Follow me for more of these, every one of them is free 🔁");
    expect(manualCut(post("1", "New set"), [cta, under("3", "2", BODY)])).toMatchObject({ prompt: BODY, from: "reply", reply: { id: "3" } });
    const longCta = under("2", "1", `${"Follow me for more of these, every one of them is free ".repeat(8)}🔁`);
    expect(manualCut(post("1", "New set"), [longCta, under("3", "2", BODY)])).toMatchObject({ prompt: BODY, reply: { id: "3" } });
    expect(manualCut(post("1", "New set"), [cta])).toMatchObject({ ok: false });
  });
});

describe("manualCut with a reply the link named", () => {
  const LONGER = post("3", `Make 2026 your creative growth year with my free assets and all the courses I sell, every last one of them: ${"more ".repeat(30)}`);
  const NAMED = post("2", BODY);
  it("takes that reply before a longer one, and any reply when it could not be a prompt", () => {
    const direct = (r: XPost) => ({ ...r, replyingTo: "1" });
    expect(manualCut(post("1", "New set"), [direct(NAMED), direct(LONGER)], direct(NAMED))).toMatchObject({ ok: true, from: "reply", reply: { id: "2" }, prompt: BODY });
    expect(manualCut(post("1", "New set"), [direct(NAMED), direct(LONGER)])).toMatchObject({ ok: true, reply: { id: "3" } });
    expect(manualCut(post("1", "New set"), [direct(post("4", "Enjoy!")), direct(LONGER)], post("4", "Enjoy!"))).toMatchObject({ ok: true, reply: { id: "3" } });
  });
});

describe("manualCut", () => {
  const P = "A cinematic portrait of a lighthouse keeper at dawn, soft fog, 35mm film grain";
  const Q = "Warm light from the left, the sea behind him, a gull on the rail, long exposure";
  const ok = (c: ReturnType<typeof manualCut>) => { if (!c.ok) throw new Error(c.reason); return c; };

  it("takes the author's longest reply that could be a prompt, its heading and tail off, the promotion left", () => {
    const c = ok(manualCut(MAIN, [PROMO, REPLY]));
    expect(c).toMatchObject({ from: "reply", reply: REPLY, title: "Prompt:" });
    expect(c.prompt).toBe(`(access Nano Banana 2 here: https://amirmushich.link/AMIR-LTX)\n\n[BRAND NAME]\n\n${BODY}`);
    expect(ok(manualCut(MAIN, [post("2", `${P}\n\n${Q}\n\nFollow me for more 🔁\nhttps://x.com/a`), PROMO])).prompt).toBe(`${P}\n\n${Q}`);
  });

  it("leaves a reply too short to be a prompt, for the post", () => {
    expect(ok(manualCut(post("1", `New set\n\n${P}`), [post("2", "Enjoy!")]))).toMatchObject({ from: "text", reply: null, prompt: P });
  });

  it("takes the post with its first block off and the tail of links and calls to action off, the prompt's own empty lines kept", () => {
    expect(ok(manualCut(post("1", `Free prompt for you all\n\n${P}\n\n${Q}\n\nhttps://t.co/abc\n\nFollow me for more`), [])).prompt).toBe(`${P}\n\n${Q}`);
  });

  it("keeps one block whole, a tail of its own lines off", () => {
    expect(ok(manualCut(post("1", P), [])).prompt).toBe(P);
    expect(ok(manualCut(post("1", `${P}\n${Q}\nFollow me for more`), [])).prompt).toBe(`${P}\n${Q}`);
  });

  it("makes a short first line with a line under it the title, and only that", () => {
    expect(ok(manualCut(post("1", `Intro\n\nGolden hour\n${P}`), []))).toMatchObject({ title: "Golden hour", prompt: P });
    expect(ok(manualCut(post("1", `Intro\n\n${P}\n${Q}`), []))).toMatchObject({ title: "", prompt: `${P}\n${Q}` });
    // Alone on its line it is the prompt's last words, not a heading; a brace or a fence opens the prompt.
    expect(ok(manualCut(post("1", `Intro\n\n${P}`), []))).toMatchObject({ title: "", prompt: P });
    const json = `{\n "subject": "${P}"\n}`;
    expect(ok(manualCut(post("1", `Intro\n\n${json}`), []))).toMatchObject({ title: "", prompt: json });
  });

  it("says why when what is left could be no prompt", () => {
    expect(manualCut(post("1", "gm"), [])).toEqual({ ok: false, reason: "the cut is too short for a prompt: the whole text" });
    expect(manualCut(post("1", `${P}\n\nSo good`), [])).toEqual({ ok: false, reason: "the cut is too short for a prompt: the whole text" });
    expect(manualCut(post("1", `Heading\ngm`), []).ok).toBe(false);
  });
});
