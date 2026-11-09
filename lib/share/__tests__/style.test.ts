import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { postBlocks, type ShareContent } from "../content";
import { natural, reflow, settle, type CardStyle, type El, type ShareDoc, type ShareStyle } from "../doc";
import { SHARE_FONTS } from "../fonts";
import { parseStyle, styleFonts, styleRefs, withPictures } from "../style";
import { cardsFor, present, setFor, type NamedDoc } from "../templates";
import type { Tokens } from "../tokens";

/**
 * What an account may keep (SQL 71): everything the editor can write goes through and comes back the same, anything else is
 * refused whole or dropped. Every template in all three themes, read from the app's own tokens. Blind spot: the browser's
 * readTokens is not run here (drive-share-style.mjs runs it); here the token's text is read from globals.css.
 */
const CSS = readFileSync(join(__dirname, "..", "..", "..", "app", "globals.css"), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
const block = (head: string) => Object.fromEntries([...new RegExp(`(?:^|\\n)${head}\\s*\\{([^}]*)\\}`).exec(CSS)![1].matchAll(/--enki-([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const THEMES: Record<string, Tokens> = (() => {
  const light = block(":root"), dark = { ...light, ...block("\\.dark") }, purple = { ...dark, ...block("\\.dark\\.theme-purple") };
  const of = (t: Record<string, string>, night: boolean): Tokens => ({ paper: t.paper, alt: t["paper-2"], ink: t.ink, ink2: t["ink-2"], ga: night ? t["paper-3"] : t.ember, gb: night ? t.ember : t["photo-ring"], on: t["on-stage"] });
  return { light: of(light, false), dark: of(dark, true), purple: of(purple, true) };
})();
const REF = "6f9d2c1e-3b4a-4c5d-8e7f-0a1b2c3d4e5f";
const content = (n: number, over: Partial<ShareContent> = {}): ShareContent => ({
  title: "T", desc: "D", words: null, variables: [{ name: "a", example: "b" }], media: "image", poster: "p", generator: "G", handle: "h", link: "l", hashtags: "#t",
  images: [...Array(n).keys()].map((i) => ({ src: `s${i}`, full: `f${i}` })), setups: [...Array(n)].map(() => [{ name: "a", example: "b" }]), ...over,
});
const bk = postBlocks(new Set(), false);
const stored = (d: NamedDoc): CardStyle => ({ ratio: d.ratio, bg: d.bg, ...(d.ov ? { ov: true } : null), els: d.els, bk });
const up = (over: Partial<El> = {}): El => ({ id: 9, k: "up", x: 20, y: 20, w: 60, h: 40, rot: 0, ref: REF, ...over });
const card = (els: unknown[], over: Record<string, unknown> = {}) => ({ image: { ratio: "4:5", bg: { mode: "solid", c: "#ffffff" }, els, bk, ...over } });
const text = (over: Record<string, unknown> = {}) => ({ id: 1, k: "title", x: 6, y: 4, w: 88, h: 10, rot: 0, font: "Inter", color: "#111111", align: "left", ...over });

describe("parseStyle: what the editor writes comes back the same", () => {
  it.each(Object.keys(THEMES))("every template in %s, image and video, free and premium, one to four images", (theme) => {
    const t = THEMES[theme];
    let count = 0;
    for (const n of [1, 2, 3, 4]) for (const words of [null, "w"]) {
      for (const c of [content(n, { words }), content(0, { words, media: "video" })]) for (const d of cardsFor(t, c)) {
        const style = c.media === "image" ? { image: stored(d) } : { video: stored(d) };
        expect(parseStyle(JSON.parse(JSON.stringify(style)))).toEqual(style);
        count++;
      }
      const [ov, per] = setFor(t, content(n, { words }));
      const set = { set: { ov: { ratio: ov.ratio, bg: ov.bg, els: ov.els }, per: { ratio: per.ratio, bg: per.bg, els: per.els }, bk } };
      expect(parseStyle(JSON.parse(JSON.stringify(set)))).toEqual(set);
    }
    expect(count).toBe(4 * 2 * 4 + 4 * 2 * 2);
  });

  it("every template on every format, after the editor's reflow", () => {
    for (const d of cardsFor(THEMES.purple, content(3))) for (const f of ["1:1", "4:5", "3:4", "2:3", "16:9", "9:16", "3:2", "4:3", "5:4", "21:9"]) {
      const style = { image: { ...reflow(stored(d), f, 3, true), bk } };
      expect(parseStyle(JSON.parse(JSON.stringify(style)))).toEqual(style);
    }
  });

  it("a card that grew past the tallest format keeps the ratio settle wrote", () => {
    const doc: ShareDoc = { ratio: "9:16", bg: { mode: "solid", c: "#000000" }, els: [{ ...text(), y: 0, h: 150 } as El] };
    const grown = settle(doc);
    expect(grown.ratio).toMatch(/^0\.\d{3}:1$/);
    expect(parseStyle({ image: { ...grown, bk } })?.image?.ratio).toBe(grown.ratio);
  });

  it("the ratio a pulled edge writes, and the gestures' numbers", () => {
    const g = natural({ x: 0, y: 0, w: 50, h: 50 }, "hero", 4, 400, 500);
    for (const ratio of ["0.5:1", "1.234:1", "2.4:1", "2:1", "0.417:1"]) expect(parseStyle(card([text(g)], { ratio }))?.image?.ratio).toBe(ratio);
    expect(parseStyle(card([text({ x: -300.5, y: 640, rot: -270.25, _w: 60, _h: 6, show: "logo", k: "gen" })]))).not.toBeNull();
  });

  it("an overlap card stays one, a make-room card has no flag", () => {
    expect(parseStyle(card([], { ov: true }))?.image?.ov).toBe(true);
    expect(parseStyle(card([], { ov: false }))?.image).not.toHaveProperty("ov");
    expect(parseStyle(card([]))?.image).not.toHaveProperty("ov");
  });

  it("a gradient, by angle and radial", () => {
    expect(parseStyle(card([], { bg: { mode: "gradient", a: "#111111", b: "#222222", dir: 135 } }))?.image?.bg).toEqual({ mode: "gradient", a: "#111111", b: "#222222", dir: 135 });
    expect(parseStyle(card([], { bg: { mode: "gradient", a: "#111111", b: "#222222", dir: "radial" } }))?.image?.bg).toEqual({ mode: "gradient", a: "#111111", b: "#222222", dir: "radial" });
  });

  it("each of the twelve fonts, and all at a doc's limit of 24 elements", () => {
    const els = [...Array(24).keys()].map((i) => text({ id: i + 1, font: SHARE_FONTS[i % 12][0] }));
    expect(parseStyle(card(els))?.image?.els).toHaveLength(24);
  });

  it("no parts, and each part alone", () => {
    expect(parseStyle({})).toEqual({});
    expect(parseStyle({ video: card([]).image })).toEqual({ video: card([]).image });
  });
});

describe("parseStyle: anything else is refused, whole", () => {
  const good = text();
  it.each<[string, unknown]>([
    ["nothing", null],
    ["undefined", undefined],
    ["a string", "style"],
    ["a number", 7],
    ["an array", [card([])]],
    ["a part that is no object", { image: "x" }],
    ["a set without its second design", { set: { ov: card([]).image, bk } }],
    ["a set without a post", { set: { ov: card([]).image, per: card([]).image } }],
    ["a card without a post", { image: { ratio: "4:5", bg: { mode: "solid", c: "#ffffff" }, els: [] } }],
    ["a card without elements", { image: { ratio: "4:5", bg: { mode: "solid", c: "#ffffff" }, bk } }],
    ["an unknown kind", card([{ ...good, k: "words" }])],
    ["a font outside the table", card([{ ...good, font: "Comic Sans" }])],
    ["a colour that is no hex", card([{ ...good, color: "rgb(0,0,0)" }])],
    ["a short hex", card([{ ...good, color: "#fff" }])],
    ["a colour with text after it", card([{ ...good, color: "#ffffff the words" }])],
    ["an unknown alignment", card([{ ...good, align: "justify" }])],
    ["an unknown arrangement", card([{ ...good, arr: "pile" }])],
    ["an unknown look", card([{ ...good, show: "all" }])],
    ["a number as text", card([{ ...good, x: "6" }])],
    ["a place past the bound", card([{ ...good, x: 1000.5 }])],
    ["a place before the bound", card([{ ...good, y: -1000.5 }])],
    ["a width of nothing", card([{ ...good, w: 0 }])],
    ["a negative height", card([{ ...good, h: -1 }])],
    ["an endless number", card([{ ...good, h: 1e999 }])],
    ["no place at all", card([{ id: 1, k: "title" }])],
    ["a turn past the bound", card([{ ...good, rot: 36001 }])],
    ["a gap past 1", card([{ ...good, gap: 2 }])],
    ["a group's number as a string", card([{ ...good, of: "4" }])],
    ["a group's number of none", card([{ ...good, of: 0 }])],
    ["a saved width of nothing", card([{ ...good, _w: 0 }])],
    ["an id that is text", card([{ ...good, id: "1" }])],
    ["two elements with one id", card([good, good])],
    ["25 elements", card([...Array(25).keys()].map((i) => text({ id: i + 1 })))],
    ["a picture without its reference", card([up({ ref: undefined })])],
    ["a picture by its address", card([up({ ref: "https://x.test/a.png" })])],
    ["a reference with text after it", card([up({ ref: `${REF} the words` })])],
    ["a ratio of words", card([], { ratio: "the words" })],
    ["a ratio with no height", card([], { ratio: "4:0" })],
    ["a ratio of nothing", card([], { ratio: "0:5" })],
    ["a custom ratio of nothing", card([], { ratio: "0.000:1" })],
    ["a ratio past the tallest", card([], { ratio: "1:99" })],
    ["a ratio with text after it", card([], { ratio: "4:5 the words" })],
    ["a ratio with a space after it", card([], { ratio: "4:5 " })],
    ["a ratio of four decimals", card([], { ratio: "0.4171:1" })],
    ["an overlap flag of text", card([], { ov: "the words" })],
    ["an unknown background", card([], { bg: { mode: "image", c: "#ffffff" } })],
    ["an unknown background holding a gradient's values", card([], { bg: { mode: "image", a: "#111111", b: "#222222", dir: 1 } })],
    ["a background of text", card([], { bg: { mode: "solid", c: "the words" } })],
    ["a gradient of text", card([], { bg: { mode: "gradient", a: "#111111", b: "the words", dir: 1 } })],
    ["a gradient angle past the circle", card([], { bg: { mode: "gradient", a: "#111111", b: "#222222", dir: 361 } })],
    ["a gradient angle of text", card([], { bg: { mode: "gradient", a: "#111111", b: "#222222", dir: "the words" } })],
    ["a post block of text", card([], { bk: [{ key: "the words", on: true }] })],
    ["a post block without its switch", card([], { bk: [{ key: "title" }] })],
    ["a post with one block twice", card([], { bk: [{ key: "title", on: true }, { key: "title", on: false }] })],
    ["a post that is no list", card([], { bk: "title" })],
  ])("%s", (_name, raw) => {
    expect(parseStyle(raw)).toBeNull();
  });

  it("a good part beside a bad one is refused too", () => {
    expect(parseStyle({ ...card([good]), video: { nonsense: true } })).toBeNull();
  });

  it("the size is measured in bytes: at the cap in, one byte past it out", () => {
    const fill = (bytes: number) => ({ ...card([]), pad: "é".repeat(bytes) });
    const base = new TextEncoder().encode(JSON.stringify(fill(0))).length;
    expect(parseStyle(fill(Math.floor((64 * 1024 - base) / 2)))).not.toBeNull();
    expect(parseStyle(fill(Math.floor((64 * 1024 - base) / 2) + 1))).toBeNull();
  });
});

describe("parseStyle: unknown keys are gone", () => {
  const SECRET = "ZZ-the-artists-secret-words-ZZ";

  it("no string of a smuggled field survives, at any level", () => {
    const raw = {
      secret: SECRET,
      image: { ...card([{ ...text(), text: SECRET, words: [SECRET], src: `https://x.test/${SECRET}`, html: SECRET }, { ...up(), src: `https://x.test/${SECRET}` }]).image, title: SECRET, name: SECRET, bg: { mode: "solid", c: "#ffffff", note: SECRET } },
      set: { ov: { ...card([]).image, name: SECRET }, per: { ...card([]).image, prompt: SECRET }, bk: [{ key: "title", on: true, text: SECRET }], words: SECRET },
    };
    expect(JSON.stringify(parseStyle(raw))).not.toContain(SECRET);
    expect(parseStyle(raw)?.image?.els).toHaveLength(2);
  });

  it("a kept picture holds its reference and no address", () => {
    expect(parseStyle(card([{ ...up(), src: "https://x.test/a.png" }]))?.image?.els[0]).toEqual(up());
  });

  it("a reference only stands on a picture", () => {
    expect(parseStyle(card([{ ...text(), ref: REF }]))?.image?.els[0]).not.toHaveProperty("ref");
  });
});

describe("what a style asks for", () => {
  const style = (): ShareStyle => ({
    image: { ...card([text({ font: "Lora" }), up()]).image } as CardStyle,
    set: { ov: card([text({ font: "Anton" }), up({ ref: "aaaaaaaa-0000-4000-8000-000000000000" })]).image as ShareDoc, per: card([text({ font: "Lora" }), up({ id: 10 })]).image as ShareDoc, bk },
  });

  it("its fonts and references, each once, over all its designs", () => {
    expect(styleFonts(style()).sort()).toEqual(["Anton", "Lora"]);
    expect(styleRefs(style()).sort()).toEqual([REF, "aaaaaaaa-0000-4000-8000-000000000000"].sort());
    expect(styleFonts({})).toEqual([]);
  });

  it("withPictures: each picture at the address it has now, in every design; others untouched", () => {
    const got = withPictures(style(), new Map([[REF, "https://signed.test/new"]]));
    expect(got.image!.els[1].src).toBe("https://signed.test/new");
    expect(got.set!.per.els[1].src).toBe("https://signed.test/new");
    expect(got.image!.els[0]).toStrictEqual(text({ font: "Lora" }));
    expect(got.set!.bk).toEqual(bk);
  });

  it("a reference that is gone leaves no old address, and the element is skipped on the card and the set", () => {
    const old = style();
    old.image!.els[1].src = "https://signed.test/old";
    const got = withPictures(old, new Map());
    expect(got.image!.els[1].src).toBeUndefined();
    const named = cardsFor(THEMES.light, content(1), got.image)[0];
    expect(named.name).toBe("Your style");
    expect(named.els.map((e) => e.k)).toEqual(["title"]);
    expect(setFor(THEMES.light, content(1), got.set)[1].els.map((e) => e.k)).toEqual(["title"]);
    expect(present(content(1))({ k: "up", src: "https://signed.test/new" })).toBe(true);
    expect(present(content(1))({ k: "up" })).toBe(false);
  });

  it("no part stays no part", () => {
    expect(withPictures({}, new Map())).toEqual({});
    expect(Object.keys(withPictures({ image: style().image }, new Map()))).toEqual(["image"]);
  });
});
