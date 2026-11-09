import { describe, expect, it } from "vitest";
import type { Job } from "@/lib/ui/kit/render-queue";
import type { EditorSetup } from "@/lib/editor/generate-checks";
import { imageValues, dismissShare, offerShare, shareOffer, subscribeShare } from "../after-release";
import { blocksFor, caption, captionBlocks, contentFrom, exampleOf, shortText } from "../content";

const ORIGIN = "https://enki.gallery";
const SENTINEL = "ZZ-THE-ARTISTS-SECRET-WORDS-ZZ";
const image = { url: "https://b/1.png", preview: "https://b/1p.webp", view: "https://b/1v.jpg", thumb: "https://b/1t.webp" };

const paidApi = {
  id: "p1", title: "Neon koi", description: "A moody portrait", prompt_type: "paid-prompt", ai_model: "Nano Banana Pro", mediaType: "image",
  showcaseImages: [image],
  promptData: { variables: [{ name: "animal", label: "animal", type: "text", defaultValue: "a koi", position: 0, options: null }] },
  // None of these may pass: the fields a route could one day add, under names the card does not know.
  secret: SENTINEL, encrypted_content: SENTINEL, public_prompt_text: SENTINEL, promptTemplate: SENTINEL, category: SENTINEL, tags: [SENTINEL], creator: SENTINEL, ai_settings: { note: SENTINEL },
};

describe("exampleOf", () => {
  it("a default is the example", () => {
    expect(exampleOf({ name: "animal", label: "animal", type: "text", defaultValue: "a koi" })).toBe("a koi");
  });
  it("a default that is one of the options shows the option's name", () => {
    expect(exampleOf({ name: "lens", type: "single-select", defaultValue: "85mm f/1.4", options: [{ promptValue: "35mm", visibleName: "Wide" }, { promptValue: "85mm f/1.4", visibleName: "Portrait" }] })).toBe("Portrait");
  });
  it("a default that is no option stands as it is", () => {
    expect(exampleOf({ name: "lens", type: "single-select", defaultValue: "100mm", options: [{ promptValue: "35mm", visibleName: "Wide" }] })).toBe("100mm");
  });
  it("no default: the first option's name, then its value", () => {
    expect(exampleOf({ name: "lens", type: "single-select", defaultValue: null, options: [{ promptValue: "35mm", visibleName: "Wide" }, { promptValue: "85mm", visibleName: "Tele" }] })).toBe("Wide");
    expect(exampleOf({ name: "lens", type: "single-select", options: [{ promptValue: "35mm" }] })).toBe("35mm");
  });
  it("neither: the name stands alone", () => {
    expect(exampleOf({ name: "lens", type: "text", defaultValue: "", options: [] })).toBeNull();
    expect(exampleOf({ name: "lens", type: "text" })).toBeNull();
  });
  it("a default equal to the name or the label shows once (hunted prompts)", () => {
    expect(exampleOf({ name: "BRAND NAME", label: "BRAND NAME", type: "text", defaultValue: "BRAND NAME" })).toBeNull();
    expect(exampleOf({ name: "x", label: "Your colour", type: "text", defaultValue: "Your colour" })).toBeNull();
  });
  it("a checkbox shows what it sends: its description, else its label", () => {
    expect(exampleOf({ name: "grain", label: "with grain", description: "fine film grain", type: "checkbox", defaultValue: true })).toBe("fine film grain");
    expect(exampleOf({ name: "grain", label: "with grain", description: "", type: "checkbox", defaultValue: true })).toBe("with grain");
  });
  it("a non-string default is read as text; an image variable has none", () => {
    expect(exampleOf({ name: "steps", type: "number", defaultValue: 30 })).toBe("30");
    expect(exampleOf({ name: "ref", type: "image", defaultValue: "https://b/ref.png" })).toBeNull();
  });
});

describe("contentFrom", () => {
  it("no unknown field of the answer passes, on a premium prompt the words stay out", () => {
    const c = contentFrom(paidApi, "kiri", ORIGIN);
    expect(JSON.stringify(c)).not.toContain(SENTINEL);
    expect(c.words).toBeNull();
    expect(Object.keys(c).sort()).toEqual(["desc", "generator", "handle", "hashtags", "images", "link", "media", "poster", "setups", "title", "variables", "words"]);
  });

  it("a whole prompt is shown only where the answer holds it: by its absence a premium one, whatever the type says", () => {
    expect(contentFrom({ ...paidApi, publicPromptText: "a koi of light", prompt_type: "paid-prompt" }, null, ORIGIN).words).toBe("a koi of light");
    expect(contentFrom({ ...paidApi, prompt_type: "free-prompt" }, null, ORIGIN).words).toBeNull();
    expect(contentFrom({ ...paidApi, publicPromptText: "   " }, null, ORIGIN).words).toBeNull();
  });

  it("takes the small rendition to show and the original to export", () => {
    expect(contentFrom(paidApi, null, ORIGIN).images).toEqual([{ src: image.preview, full: image.url }]);
    expect(contentFrom({ ...paidApi, showcaseImages: [{ url: image.url }] }, null, ORIGIN).images).toEqual([{ src: image.url, full: image.url }]);
  });

  it("links the prompt's page, tags its medium and generator", () => {
    const c = contentFrom(paidApi, null, ORIGIN);
    expect(c.link).toBe("https://enki.gallery/generator/p1");
    expect(c.hashtags).toBe("#aiart #nanobananapro");
    expect(contentFrom({ ...paidApi, ai_model: "Flux (free)" }, null, ORIGIN).hashtags).toBe("#aiart #flux");
    expect(contentFrom({ ...paidApi, ai_model: null, mediaType: "video" }, null, ORIGIN).hashtags).toBe("#aivideo");
  });

  it("an import's note is no description", () => {
    expect(contentFrom({ ...paidApi, description: "Imported from x.com/a" }, null, ORIGIN).desc).toBeNull();
    expect(contentFrom({ ...paidApi, description: null }, null, ORIGIN).desc).toBeNull();
    expect(contentFrom(paidApi, null, ORIGIN).desc).toBe("A moody portrait");
  });

  it("orders variables by position, leaves out an image one, a checkbox goes by its name", () => {
    const c = contentFrom({ ...paidApi, promptData: { variables: [
      { name: "b", label: "Second", type: "text", defaultValue: "two", position: 2 },
      { name: "ref", type: "image", defaultValue: "https://b/r.png", position: 1 },
      { name: "grain", label: "fine grain", description: "fine grain", type: "checkbox", defaultValue: true, position: 0 },
    ] } }, null, ORIGIN);
    expect(c.variables).toEqual([{ name: "grain", example: "fine grain" }, { name: "Second", example: "two" }]);
  });

  it("a video shows its poster and no images", () => {
    const c = contentFrom({ ...paidApi, mediaType: "video", showcaseVideo: { poster: "https://b/p.jpg" } }, null, ORIGIN);
    expect(c.media).toBe("video");
    expect(c.poster).toBe("https://b/p.jpg");
    expect(c.images).toEqual([]);
    expect(contentFrom({ ...paidApi, mediaType: "video", showcaseVideo: null }, null, ORIGIN).poster).toBe(image.url);
    expect(contentFrom(paidApi, null, ORIGIN).poster).toBeNull();
  });

  describe("an image's own setup", () => {
    const two = { ...paidApi, showcaseImages: [image, { url: "https://b/2.png" }], promptData: { variables: [
      { name: "animal", type: "text", defaultValue: "a koi", position: 0 },
      { name: "ref", type: "image", defaultValue: "https://b/r.png", position: 1 },
      { name: "glow", type: "text", defaultValue: "teal", position: 2 },
    ] } };
    it("reads the values by variable name, an image variable asks for none", () => {
      const c = contentFrom(two, null, ORIGIN, [{ animal: "a koi", glow: "teal" }, { glow: "gold", animal: "a ray" }]);
      expect(c.setups[1]).toEqual([{ name: "animal", example: "a ray" }, { name: "glow", example: "gold" }]);
    });
    it("a value that is an option's shows the option's name, never what it sends", () => {
      const film = { ...paidApi, showcaseImages: [image], promptData: { variables: [{ name: "film", type: "single_select", defaultValue: "x", position: 0, options: [{ visibleName: "Film look", promptValue: "tri-x-400-pushed" }] }] } };
      expect(contentFrom(film, null, ORIGIN, [{ film: "tri-x-400-pushed" }]).setups[0]).toEqual([{ name: "film", example: "Film look" }]);
      expect(contentFrom(film, null, ORIGIN, [{ film: "typed by hand" }]).setups[0]).toEqual([{ name: "film", example: "typed by hand" }]);
    });
    it("a row from another text with as many values: the examples, not its values under these names", () => {
      const examples = [{ name: "animal", example: "a koi" }, { name: "glow", example: "teal" }];
      expect(contentFrom(two, null, ORIGIN, [{ animal: "x", glow: "y" }, { mood: "typed into another slot", tone: "z" }]).setups[1]).toEqual(examples);
    });
    it("no values, a row that does not line up, or another count of images: the examples", () => {
      const examples = [{ name: "animal", example: "a koi" }, { name: "glow", example: "teal" }];
      expect(contentFrom(two, null, ORIGIN).setups).toEqual([examples, examples]);
      expect(contentFrom(two, null, ORIGIN, [{ animal: "x", glow: "y" }, { animal: "only one" }]).setups[1]).toEqual(examples);
      expect(contentFrom(two, null, ORIGIN, [{ animal: "x", glow: "y" }]).setups).toEqual([examples, examples]);
    });
  });
});

describe("imageValues", () => {
  const job = (imageUrl: string | undefined, vars: Record<string, string>): Job<EditorSetup> =>
    ({ id: imageUrl ?? "x", imageUrl, setup: { prompt: `${SENTINEL} [animal] then [glow]`, vars: { ...vars, stale: SENTINEL } } }) as unknown as Job<EditorSetup>;

  it("gives the values by the text's own names and never the text", () => {
    const got = imageValues([job("https://b/1.png", { glow: "teal", animal: "koi" })]);
    expect(got).toEqual([{ animal: "koi", glow: "teal" }]);
    expect(JSON.stringify(got)).not.toContain(SENTINEL);
  });

  it("keeps what the server keeps: the first four rendered images", () => {
    const urls = ["data:image/png;base64,x", undefined, "https://b/1", "https://b/2", "https://b/3", "https://b/4", "https://b/5"];
    expect(imageValues(urls.map((u, i) => job(u, { animal: String(i), glow: "" }))).map((r) => r.animal)).toEqual(["2", "3", "4", "5"]);
  });

  it("through contentFrom the text still stays out", () => {
    const c = contentFrom(paidApi, null, ORIGIN, imageValues([job("https://b/1.png", { animal: "ray", glow: "gold" })]));
    expect(JSON.stringify(c)).not.toContain(SENTINEL);
  });
});

describe("the offer", () => {
  it("is held until dismissed and tells its listeners", () => {
    let told = 0;
    const off = subscribeShare(() => { told++; });
    offerShare("p1", [{ a: "a" }]);
    expect(shareOffer()).toEqual({ promptId: "p1", values: [{ a: "a" }] });
    dismissShare();
    expect(shareOffer()).toBeNull();
    dismissShare();
    expect(told).toBe(2);
    off();
    offerShare("p2", []);
    expect(told).toBe(2);
    dismissShare();
  });
});

describe("the card's text", () => {
  const c = contentFrom({ ...paidApi, promptData: { variables: [
    { name: "animal", type: "text", defaultValue: "a koi", position: 0 },
    { name: "BRAND", label: "BRAND", type: "text", defaultValue: "BRAND", position: 1 },
  ] } }, "kiri", ORIGIN, [{ animal: "a ray", BRAND: "acme" }]);

  it("variables list name over example; a name alone stands once", () => {
    const blocks = blocksFor({ k: "prompt" }, c, 0);
    expect(blocks.map((b) => [b.text, b.mark])).toEqual([["animal", "vn"], ["a koi", "vx"], ["BRAND", "vx"]]);
    expect(blocks[0].scale).toBe(0.76);
    expect(blocks[2].before).toBe(0.62);
  });

  it("a setup speaks of its slide's image", () => {
    expect(blocksFor({ k: "setup" }, c, 1).map((b) => b.text)).toEqual(["animal", "a ray", "BRAND", "acme"]);
  });

  it("a generator shows by its look; a handle takes its @", () => {
    const g = { k: "gen" as const };
    expect(blocksFor({ ...g, show: "both" }, c, 0)).toEqual([{ text: "Nano Banana Pro", lead: 1.7, lh: 1.3 }]);
    expect(blocksFor({ ...g, show: "name" }, c, 0)).toEqual([{ text: "Nano Banana Pro", lead: 0, lh: 1.1 }]);
    expect(blocksFor({ ...g, show: "logo" }, c, 0)).toEqual([{ text: "", lead: 1.3, lh: 1.3 }]);
    expect(blocksFor({ k: "handle" }, c, 0)[0].text).toBe("@kiri");
    expect(blocksFor({ k: "link" }, c, 0)[0].text).toBe("enki.gallery/generator/p1");
  });
});

describe("the caption", () => {
  const free = contentFrom({ ...paidApi, publicPromptText: "x".repeat(600) }, "kiri", ORIGIN);
  const premium = contentFrom(paidApi, "kiri", ORIGIN);

  it("a text on the card leaves the caption (Kev, 2026-11-03: one place only)", () => {
    const blocks = captionBlocks(premium, new Set(["title", "prompt"]), false);
    expect(caption(blocks)).toBe("A moody portrait\n\nhttps://enki.gallery/generator/p1\n\n#aiart #nanobananapro");
  });

  it("a premium prompt's caption holds its variables, one a line", () => {
    const c = { ...premium, variables: [{ name: "animal", example: "a koi" }, { name: "lens", example: null }] };
    expect(captionBlocks(c, new Set(), false).find((b) => b.key === "prompt")?.text).toBe("animal: a koi\nlens");
    expect(caption(captionBlocks(premium, new Set(), false))).not.toContain(SENTINEL);
  });

  it("a set's slides carry the setups, so its caption does not", () => {
    expect(captionBlocks(premium, new Set(), true).map((b) => b.key)).toEqual(["title", "desc", "link", "tags"]);
  });

  it("a destination's short text keeps the link apart and gives way past its limit", () => {
    const blocks = captionBlocks(free, new Set(), false);
    expect(shortText(blocks, 5000)).toContain("x".repeat(600));
    expect(shortText(blocks, 5000)).not.toContain("generator/p1");
    expect(shortText(blocks, 256)).toBe("Neon koi\n\nA moody portrait\n\n#aiart #nanobananapro");
    expect(shortText(blocks, 40)).toBe("Neon koi\n\n#aiart #nanobananapro");
    // Past every limit it is cut; never inside a character, or encodeURIComponent throws on the address.
    const emoji = shortText([{ key: "title", text: `a${"\u{1F525}".repeat(200)}` }], 256);
    expect(emoji).toHaveLength(255);
    expect(() => encodeURIComponent(emoji)).not.toThrow();
    expect(shortText(blocks, 5).length).toBe(5);
  });
});
