import { describe, expect, it } from "vitest";
import { formatCopy } from "@/lib/ui/kit/option-copy";
import { captionOf, postBlocks, type ShareContent } from "../content";
import { FORMATS, TAG, keptOn, magnet, natural, newEl, pushAway, reflow, regroup, rn, room, settle, tidy, tileRects, xHit, type El, type ShareDoc } from "../doc";
import { railKinds, setFor, cardsFor } from "../templates";
import { contrast, inkOn, lum, type Tokens } from "../tokens";

const OPT = { ink: "#111111", paid: true, n: 4 };
const el = (id: number, k: El["k"], x: number, y: number, w: number, h: number): El => ({ id, k, x, y, w, h, rot: 0 });
const logical = (d: ShareDoc, e: El) => (e.h / 100) / rn(d.ratio);
const content = (over: Partial<ShareContent> = {}): ShareContent => ({ title: "T", desc: "D", words: null, variables: [{ name: "a", example: "b" }], images: [{ src: "s", full: "f" }, { src: "s", full: "f" }], media: "image", poster: null, generator: "G", handle: "h", link: "l", hashtags: "#t", setups: [], ...over });
const T: Tokens = { paper: "#ffffff", alt: "#f6f5f4", ink: "#111111", ink2: "#3d3c3a", ga: "#7d1d33", gb: "#c58f9c", on: "#ffffff" };

describe("the formats", () => {
  it("each has its line in the shared copy, name and use", () => {
    expect(FORMATS).toHaveLength(10);
    for (const f of FORMATS) expect(formatCopy(f)!.split(" · ")).toHaveLength(2);
  });
});

describe("room", () => {
  // The mock's "Only the images": a square, full of images.
  const images: ShareDoc = { ratio: "1:1", bg: { mode: "solid", c: "#fff" }, els: [el(1, "results", 0, 0, 100, 100)] };
  // Title on top, handle at the bottom, a real gap between.
  const gapped: ShareDoc = { ratio: "4:5", bg: { mode: "solid", c: "#fff" }, els: [el(1, "title", 6, 4, 88, 10), el(2, "handle", 6, 88, 50, 6)] };

  it("fits: into a gap that holds it, nothing else moves, the format stays", () => {
    const { doc } = room(gapped, "desc", 0.5, 9, OPT);
    expect(doc.ratio).toBe("4:5");
    doc.els.slice(0, 2).forEach((e, i) => {
      expect(e.y).toBeCloseTo(gapped.els[i].y, 9);
      expect(e.h).toBeCloseTo(gapped.els[i].h, 9);
    });
    const d = doc.els[2];
    expect(d).toMatchObject({ id: 9, k: "desc", x: 6, w: 88 });
    expect(d.y).toBeGreaterThanOrEqual(14);
    expect(d.y + d.h).toBeLessThanOrEqual(88);
    // In the middle of the card, where it is held.
    expect(d.y + d.h / 2).toBeCloseTo(50, 0);
  });

  it("grows: a title over a square of images makes it the next real format that holds it, the images keep their shape", () => {
    const { doc } = room(images, "title", 0.02, 9, OPT);
    expect(doc.ratio).toBe("4:5");
    const r = doc.els[0], t = doc.els[1];
    expect(logical(doc, r)).toBeCloseTo(logical(images, images.els[0]), 9);
    expect(t.y + t.h).toBeLessThanOrEqual(r.y + 0.01);
    expect(r.y + r.h).toBeCloseTo(100, 6);
  });

  it("grows downward too: a prompt below the images", () => {
    const { doc } = room(images, "prompt", 0.98, 9, OPT);
    const r = doc.els[0], p = doc.els[1];
    expect(p.y).toBeGreaterThanOrEqual(r.y + r.h - 0.01);
    expect(doc.els.every((e) => e.y >= -0.01 && e.y + e.h <= 100.01)).toBe(true);
    expect(FORMATS).toContain(doc.ratio);
  });

  it("past the tallest format everything shrinks to fit, the format stays the tallest", () => {
    const tall: ShareDoc = { ratio: "9:16", bg: { mode: "solid", c: "#fff" }, els: [el(1, "results", 0, 0, 100, 100)] };
    const { doc } = room(tall, "prompt", 0.5, 9, OPT);
    expect(doc.ratio).toBe("9:16");
    expect(doc.els[0].h).toBeLessThan(100);
    expect(doc.els.every((e) => e.y >= -0.01 && e.y + e.h <= 100.01)).toBe(true);
  });

  it("overlap: lands where it is held, nothing moves, the format stays", () => {
    const over: ShareDoc = { ...gapped, ov: true };
    const { doc, key } = room(over, "desc", 0.5, 9, OPT);
    expect(doc.ratio).toBe("4:5");
    expect(doc.els.slice(0, 2)).toEqual(over.els);
    expect(doc.els[2].y + doc.els[2].h / 2).toBeCloseTo(50, 6);
    expect(key).toBe("o20");
    expect(room(over, "desc", 0.75, 9, OPT).key).toBe("o30");
  });

  it("a key changes only when the place does", () => {
    const a = room(images, "title", 0.02, 9, OPT).key, b = room(images, "title", 0.03, 9, OPT).key, c = room(images, "title", 0.98, 9, OPT).key;
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("images dropped lie in a row with gaps; a row of n stays square", () => {
    for (const n of [1, 2, 4]) {
      const { doc } = room(gapped, "results", 0.5, 9, { ...OPT, n }), r = doc.els.at(-1)!;
      expect(r).toMatchObject({ arr: "row", gap: 1 });
      expect(TAG(true, n).results).toEqual([0.88, 0.88 / n]);
    }
  });

  it("a whole prompt lands taller than its variables", () => {
    expect(TAG(true, 4).prompt[1]).toBe(0.3);
    expect(TAG(false, 4).prompt[1]).toBe(0.42);
  });

  it("leaves what it is given as it is", () => {
    const before = JSON.stringify(images);
    room(images, "title", 0.02, 9, OPT);
    expect(JSON.stringify(images)).toBe(before);
  });
});

describe("settle", () => {
  const doc = (els: El[], ratio = "1:1"): ShareDoc => ({ ratio, bg: { mode: "solid", c: "#fff" }, els });

  it("a card that holds everything stays", () => {
    const d = doc([el(1, "title", 0, 0, 50, 100)]);
    expect(settle(d)).toEqual(d);
  });

  it("picks the next format up: 1.2 high is 4:5, not 2:3", () => {
    const d = settle(doc([el(1, "title", 0, 80, 50, 40)]));
    expect(d.ratio).toBe("4:5");
    const e = d.els[0];
    expect(e.y + e.h).toBeCloseTo(96, 6);
    expect((e.h / 100) * 1.25).toBeCloseTo(0.4, 9);
  });

  it("an element above the top moves everything down with the card", () => {
    const d = settle(doc([el(1, "title", 0, -20, 50, 30), el(2, "handle", 0, 90, 50, 10)]));
    expect(d.ratio).toBe("4:5");
    expect(d.els[0].y).toBeCloseTo(0, 6);
    expect(d.els[1].y + d.els[1].h).toBeCloseTo(96, 6);
  });

  it("past the tallest format, a ratio of its own", () => {
    const d = settle(doc([el(1, "title", 0, 0, 50, 300)]));
    expect(d.ratio).toBe("0.333:1");
    expect(d.els[0].h).toBeCloseTo(100, 6);
  });

  it("no elements, nothing to do", () => {
    expect(settle(doc([])).ratio).toBe("1:1");
  });

  it("a hair over the edge is no reason to grow", () => {
    const d = doc([el(1, "title", 0, -0.005, 50, 100.01)]);
    expect(settle(d)).toEqual(d);
  });
});

describe("tidy", () => {
  it("separates what overlaps, top to bottom, and the card grows to hold it", () => {
    const d = tidy({ ratio: "1:1", bg: { mode: "solid", c: "#fff" }, ov: true, els: [el(1, "title", 0, 10, 50, 50), el(2, "handle", 0, 30, 50, 60)] });
    const [a, b] = d.els;
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h);
    expect(d.ratio).toBe("4:5");
    expect(d.els.every((e) => e.y >= -0.01 && e.y + e.h <= 100.01)).toBe(true);
  });

  it("the gap it leaves is 1.2", () => {
    const d = tidy({ ratio: "1:1", bg: { mode: "solid", c: "#fff" }, els: [el(1, "title", 0, 0, 50, 20), el(2, "handle", 0, 10, 50, 20)] });
    expect(d.els[1].y).toBeCloseTo(21.2, 6);
  });

  it("columns apart do not touch", () => {
    const d = tidy({ ratio: "1:1", bg: { mode: "solid", c: "#fff" }, els: [el(1, "title", 0, 0, 40, 20), el(2, "handle", 60, 10, 40, 20)] });
    expect(d.els[1].y).toBe(10);
  });
});

describe("xHit", () => {
  it("a shared column past a hair", () => {
    expect(xHit({ x: 0, w: 50 }, { x: 40, w: 50 })).toBe(true);
    expect(xHit({ x: 0, w: 50 }, { x: 49.5, w: 50 })).toBe(false);
    expect(xHit({ x: 60, w: 10 }, { x: 0, w: 50 })).toBe(false);
  });
});

describe("pushAway", () => {
  const els = [el(1, "title", 0, 10, 100, 20), el(2, "results", 0, 40, 100, 20), el(3, "handle", 0, 70, 100, 10)];
  const yb = { 1: 10, 2: 40, 3: 70 };

  it("what is below gives way down, and pushes the next", () => {
    const ys = pushAway(els, el(1, "title", 0, 35, 100, 30), yb);
    expect(ys[2]).toBeCloseTo(66.2, 6);
    expect(ys[3]).toBeCloseTo(87.4, 6);
  });

  it("what is above gives way up", () => {
    const ys = pushAway(els, el(3, "handle", 0, 25, 100, 10), yb);
    expect(ys[1]).toBeCloseTo(25 - 20 - 1.2, 6);
    expect(ys[2]).toBe(40);
  });

  it("restores: moved away again, all stand where they stood", () => {
    pushAway(els, el(1, "title", 0, 35, 100, 30), yb);
    expect(pushAway(els, el(1, "title", 0, 10, 100, 20), yb)).toEqual({ 2: 40, 3: 70 });
  });

  it("another column is left alone", () => {
    expect(pushAway(els, { id: 9, x: 0, y: 35, w: 100, h: 30 }, { ...yb, 2: 40 })[2]).toBeCloseTo(66.2, 6);
    const beside = [el(1, "title", 0, 10, 40, 20), el(2, "results", 60, 15, 40, 20)];
    expect(pushAway(beside, el(1, "title", 0, 15, 40, 20), { 1: 10, 2: 15 })[2]).toBe(15);
  });

  it("leaves what it is given as it is", () => {
    const mine = [el(1, "title", 0, 10, 100, 20), el(2, "results", 0, 40, 100, 20), el(3, "handle", 0, 70, 100, 10)];
    const before = JSON.stringify(mine), from = { 1: 10, 2: 40, 3: 70 }, kept = JSON.stringify(from);
    pushAway(mine, el(1, "title", 0, 35, 100, 30), from);
    expect(JSON.stringify(mine)).toBe(before);
    expect(JSON.stringify(from)).toBe(kept);
  });
});

describe("magnet", () => {
  it("the card's middle pulls and draws a guide", () => {
    const m = magnet({ x: 39.5, y: 0.5, w: 20, h: 10 }, []);
    expect(m.x + 10).toBeCloseTo(50, 9);
    expect(m.guides).toContainEqual({ axis: "x", at: 50 });
  });

  it("another element's edge pulls and draws a guide", () => {
    const m = magnet({ x: 21, y: 34.5, w: 3, h: 3 }, [{ x: 0, y: 34, w: 20, h: 10 }]);
    expect(m.x).toBeCloseTo(20, 9);
    expect(m.guides).toContainEqual({ axis: "x", at: 20 });
  });

  it("the 10% grid pulls without a guide", () => {
    const m = magnet({ x: 29.5, y: 3, w: 4, h: 4 }, []);
    expect(m.x).toBeCloseTo(30, 9);
    expect(m.guides).toEqual([]);
  });

  it("a strong line wins over a nearer grid line", () => {
    const m = magnet({ x: 20.2, y: 3, w: 4, h: 4 }, [{ x: 0, y: 50, w: 19.5, h: 4 }]);
    expect(m.x).toBeCloseTo(19.5, 9);
  });

  it("out of reach, no pull: 1.1% and no more", () => {
    expect(magnet({ x: 33, y: 33, w: 3, h: 3 }, [])).toEqual({ x: 33, y: 33, guides: [] });
    expect(magnet({ x: 11.05, y: 33, w: 3, h: 3 }, []).x).toBeCloseTo(10, 9);
    expect(magnet({ x: 11.2, y: 33, w: 3, h: 3 }, []).x).toBe(11.2);
  });

  it("both axes at once", () => {
    const m = magnet({ x: 0.4, y: 99.5, w: 5, h: 5 }, []);
    expect(m.x).toBeCloseTo(0, 9);
    expect(m.y).toBeCloseTo(100, 9);
    expect(m.guides).toHaveLength(2);
  });
});

describe("natural", () => {
  const box = { x: 20, y: 30, w: 40, h: 40 };

  it.each(["row", "col", "grid", "hero"] as const)("%s keeps the group's centre, and the arrangement", (arr) => {
    const e = natural(box, arr, 4, 500, 500);
    expect(e.arr).toBe(arr);
    expect(e.x + e.w / 2).toBeCloseTo(40, 9);
    expect(e.y + e.h / 2).toBeCloseTo(50, 9);
  });

  it("four keep the mock's numbers: a row twice as wide, a quarter as high", () => {
    const e = natural(box, "row", 4, 500, 500), s = 200;
    expect((e.w / 100) * 500).toBeCloseTo(s * 2, 9);
    expect((e.h / 100) * 500).toBeCloseTo((s * 2) / 4, 9);
    const c = natural(box, "col", 4, 500, 500);
    expect((c.h / 100) * 500).toBeCloseTo(s * 2, 9);
    const g = natural(box, "grid", 4, 500, 500);
    expect((g.w / 100) * 500).toBeCloseTo(s, 9);
    const h = natural(box, "hero", 4, 500, 500);
    expect((h.h / h.w)).toBeCloseTo(0.72, 9);
  });

  it("any n: its tiles stay square in a row and a column", () => {
    for (const n of [2, 3, 4]) {
      const r = natural(box, "row", n, 500, 500);
      expect((r.w / 100) * 500 / n).toBeCloseTo((r.h / 100) * 500, 9);
      const c = natural(box, "col", n, 500, 500);
      expect((c.h / 100) * 500 / n).toBeCloseTo((c.w / 100) * 500, 9);
    }
  });

  it("three in a grid is square, two are one row", () => {
    const three = natural(box, "grid", 3, 500, 500);
    expect(three.w).toBeCloseTo(three.h, 9);
    const two = natural(box, "grid", 2, 500, 500);
    expect(two.w / two.h).toBeCloseTo(2, 9);
  });

  it("stays on the card", () => {
    const e = natural({ x: 80, y: 80, w: 20, h: 20 }, "row", 4, 500, 500);
    expect(e.x + e.w).toBeLessThanOrEqual(100 + 1e-9);
    expect(e.x).toBeGreaterThanOrEqual(0);
    const big = natural({ x: 0, y: 0, w: 100, h: 100 }, "row", 4, 500, 500);
    expect((big.w / 100) * 500).toBeCloseTo(460, 9);
  });

  it("leaves what it is given as it is, and keeps the rest", () => {
    const before = { ...box, id: 7 };
    const e = natural(before, "row", 4, 500, 500);
    expect(before.w).toBe(40);
    expect(e.id).toBe(7);
  });
});

describe("newEl", () => {
  const opts = { ink: "#abcdef", paid: false, id: 5 };
  it("text takes the ink and a face by kind; a premium prompt's is no mono", () => {
    expect(newEl("title", 1, opts)).toMatchObject({ id: 5, color: "#abcdef", font: "Playfair Display", align: "left", rot: 0 });
    expect(newEl("prompt", 1, opts).font).toBe("DM Mono");
    expect(newEl("prompt", 1, { ...opts, paid: true }).font).toBe("Space Grotesk");
    expect(newEl("gen", 1, opts).show).toBe("both");
  });
  it("a picture stands in the middle whatever the shape", () => {
    for (const v of [0.5, 1, 1.5]) {
      const e = newEl("up", v, opts);
      expect(e.y + e.h / 2).toBeCloseTo(50, 9);
      expect(e.color).toBeUndefined();
      expect((e.w / e.h) * v).toBeCloseTo(1, 9);
    }
  });
});

describe("the rail", () => {
  const doc = (kinds: El["k"][]) => ({ els: kinds.map((k, i) => el(i, k, 0, 0, 1, 1)) });
  it("offers only what the card has not got", () => {
    expect(railKinds(content(), doc(["title", "results", "handle"]), null)).toEqual(["desc", "prompt", "link", "tags", "gen"]);
  });
  it("no description: no tag", () => {
    expect(railKinds(content({ desc: null }), doc([]), null)).not.toContain("desc");
  });
  it("nothing to say: no handle, no generator, no variables", () => {
    expect(railKinds(content({ handle: null, generator: null, variables: [] }), doc([]), null)).toEqual(["title", "desc", "link", "tags", "results"]);
  });
  it("a video offers its animation, never the images", () => {
    expect(railKinds(content({ media: "video", images: [] }), doc([]), null).at(-1)).toBe("clip");
  });
  it("a set's image slide offers its own, slide 1 the card's", () => {
    expect(railKinds(content(), doc([]), 2)).toEqual(["title", "desc", "setup", "link", "tags", "handle", "gen", "one"]);
    expect(railKinds(content(), doc([]), 0)).toEqual(["title", "desc", "prompt", "link", "tags", "handle", "gen", "results"]);
  });
});

describe("a style in the popup", () => {
  const own = { ratio: "1:1", bg: { mode: "solid" as const, c: "#000000" }, bk: postBlocks(new Set(), false), els: [el(1, "desc", 0, 0, 100, 10), el(2, "results", 0, 20, 100, 80)] };
  it("stands first, as Your style, ahead of every template", () => {
    const d = cardsFor(T, content(), own);
    expect(d[0].name).toBe("Your style");
    expect(d[0].bk).toBe(own.bk);
    expect(d.slice(1).map((x) => x.name)).toEqual(cardsFor(T, content()).map((x) => x.name));
  });
  it("what the next prompt has nothing for is skipped", () => {
    expect(cardsFor(T, content({ desc: null }), own)[0].els.map((e) => e.k)).toEqual(["results"]);
  });
  it("a set from a style: its designs on every slide, the real count named", () => {
    const set = { ov: { ratio: "1:1", bg: own.bg, els: [el(1, "results", 0, 0, 100, 100)] }, per: { ratio: "1:1", bg: own.bg, els: [{ ...el(2, "up", 0, 0, 100, 100), src: "s" }] }, bk: own.bk };
    const d = setFor(T, content(), set);
    expect(d.map((x) => x.name)).toEqual(["Slide 1 of 3. All your images.", "Slide 2 of 3. Image 1 and its setup.", "Slide 3 of 3. Image 2 and its setup."]);
    expect(d.map((x) => x.els[0].k)).toEqual(["results", "up", "up"]);
    expect(d.every((x) => x.bk === set.bk)).toBe(true);
  });
});

describe("a title and the images on a square", () => {
  it("a title takes no room from them: over half the height, the mock's slide 1", () => {
    const d = reflow({ ratio: "4:5", bg: { mode: "solid", c: "#fff" }, els: [el(1, "title", 6, 4, 88, 11), { ...el(2, "results", 6, 17, 88, 70.4), arr: "grid", gap: 1 }, el(3, "handle", 6, 90, 50, 6.5)] }, "1:1", 4, true);
    expect(d.els.find((e) => e.k === "results")!.h).toBeGreaterThan(50);
  });
});

describe("the post's blocks", () => {
  it("what is on the card starts left out; a set's prompt always", () => {
    expect(postBlocks(new Set(["title"]), false).map((b) => b.on)).toEqual([false, true, true, true, true]);
    expect(postBlocks(new Set(), true).find((b) => b.key === "prompt")!.on).toBe(false);
  });
  it("the caption follows the style's order, leaves out, and skips what the prompt has nothing for", () => {
    const c = content({ desc: null });
    expect(captionOf(c, [{ key: "tags", on: true }, { key: "desc", on: true }, { key: "link", on: false }, { key: "title", on: true }])).toEqual([{ key: "tags", text: "#t" }, { key: "title", text: "T" }]);
  });
  it("a premium prompt's block is its variables, one per line", () => {
    expect(captionOf(content({ variables: [{ name: "a", example: "b" }, { name: "c", example: null }] }), [{ key: "prompt", on: true }])[0].text).toBe("a: b\nc");
    expect(captionOf(content({ words: "whole" }), [{ key: "prompt", on: true }])[0].text).toBe("whole");
  });
});

describe("the ink of a new text", () => {
  const p = { dark: "#111111", light: "#eeeeee" };
  it("dark on a light background, light on a dark one, by a gradient's first colour", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21);
    expect(contrast("#e07a4f", "#e4edf1")).toBeCloseTo(2.5, 1);
    // The dark theme's orange swatch: a rough brightness said light ink, at 2.50.
    const night = { dark: "#0a1825", light: "#e4edf1" };
    expect(inkOn({ mode: "solid", c: "#e07a4f" }, night)).toBe("#0a1825");
    expect(contrast("#e07a4f", inkOn({ mode: "solid", c: "#e07a4f" }, night))).toBeGreaterThan(4.5);
    expect(inkOn({ mode: "gradient", a: "#e07a4f", b: "#000000", dir: 135 }, night)).toBe("#0a1825");
    expect(inkOn({ mode: "solid", c: "#ffffff" }, p)).toBe("#111111");
    expect(inkOn({ mode: "solid", c: "#0a1825" }, p)).toBe("#eeeeee");
    expect(inkOn({ mode: "gradient", a: "#ffffff", b: "#000000", dir: 135 }, p)).toBe("#111111");
  });
  it("lum reads the channels in their order", () => {
    expect(lum("#ff0000")).toBeCloseTo(0.3, 9);
    expect(lum("#00ff00")).toBeCloseTo(0.59, 9);
  });
});

describe("keptOn", () => {
  const box = { x: 0, y: 0, w: 50, h: 10 };
  it("holds a fifth of a box on the card, on each side", () => {
    expect(keptOn({ ...box, x: -80 }, true).x).toBe(-40);
    expect(keptOn({ ...box, x: 95 }, true).x).toBe(90);
    expect(keptOn({ ...box, y: -30 }, true).y).toBe(-8);
    expect(keptOn({ ...box, y: 120 }, true).y).toBe(98);
  });
  it("leaves a box that is on the card where it is", () => {
    expect(keptOn({ ...box, x: -39, y: 97 }, true)).toEqual({ ...box, x: -39, y: 97 });
  });
  it("in Make room the card's own growth holds top and bottom", () => {
    expect(keptOn({ ...box, y: 300 }, false).y).toBe(300);
  });
});

describe("newEl up", () => {
  it.each([[2.333], [1], [0.8], [0.45]])("a picture stays whole on a card of %f, and square", (v) => {
    const e = newEl("up", v, { ink: "#111111", paid: false, id: 1 });
    expect(e.y).toBeGreaterThanOrEqual(0);
    expect(e.y + e.h).toBeLessThanOrEqual(100);
    expect(e.x).toBeGreaterThanOrEqual(0);
    expect(e.x + e.w).toBeLessThanOrEqual(100);
    expect(e.h / e.w).toBeCloseTo(v);
    expect(e.x + e.w / 2).toBeCloseTo(50);
    expect(e.y + e.h / 2).toBeCloseTo(50);
  });
  it("keeps the mock's size where it fits", () => {
    expect(newEl("up", 0.8, { ink: "#111111", paid: false, id: 1 })).toMatchObject({ x: 20, w: 60, h: 48 });
  });
});

describe("regroup", () => {
  const paper = { mode: "solid", c: "#ffffff" } as const;
  const row = (of?: number): El => ({ ...el(1, "results", 6, 58, 88, 17.6), arr: "row", gap: 1, ...(of ? { of } : null) });
  const card = (...els: El[]): ShareDoc => ({ ratio: "4:5", bg: paper, els });
  const tile = (e: El, n: number, d: ShareDoc) => { const t = tileRects({ ...e, gap: 0 }, n, 1000, 1000 / rn(d.ratio))[0]; return t.w / t.h; };
  const group = (d: ShareDoc) => d.els.find((e) => e.k === "results")!;

  it("the same number, or a style that does not say: as it was laid out", () => {
    const same = card(row(4)), plain = card(row());
    expect(regroup(same, 4)).toBe(same);
    expect(regroup(plain, 1)).toBe(plain);
  });
  it("a row of four on one image: no strip, the tile square, it says its new number", () => {
    const d = regroup(card(row(4)), 1);
    expect(tile(group(d), 1, d)).toBeCloseTo(1, 5);
    expect(group(d).of).toBe(1);
    expect(group(d).x + group(d).w / 2).toBeCloseTo(50);
  });
  it("one image's box on four: the tiles square again", () => {
    const one = { ...el(1, "results", 6, 48, 88, 38), arr: "row", of: 1 } as El, d = regroup(card(one), 4);
    expect(tile(group(d), 4, d)).toBeCloseTo(1, 5);
    expect(group(d).x).toBeGreaterThanOrEqual(0);
    expect(group(d).x + group(d).w).toBeLessThanOrEqual(100);
  });
  it("in Make room it stays between its neighbours, smaller if it must", () => {
    const above = el(2, "prompt", 6, 16, 88, 39), below = el(3, "handle", 6, 88, 50, 6.5), d = regroup(card(row(4), above, below), 1), g = group(d);
    expect(g.y).toBeGreaterThanOrEqual(above.y + above.h);
    expect(g.y + g.h).toBeLessThanOrEqual(below.y);
    expect(tile(g, 1, d)).toBeCloseTo(1, 5);
    expect(g.h).toBeGreaterThan(17.6);
    expect(g.x + g.w / 2).toBeCloseTo(50);
  });
  it("in Overlap it takes the size it wants and moves nothing", () => {
    const above = el(2, "prompt", 6, 16, 88, 39), d = regroup({ ...card(row(4), above), ov: true }, 1), g = group(d);
    expect(g.y).toBeLessThan(above.y + above.h);
    expect(d.els[1]).toEqual(above);
  });
  it("leaves the document it is given alone", () => {
    const d = card(row(4)), before = JSON.stringify(d);
    regroup(d, 1);
    expect(JSON.stringify(d)).toBe(before);
  });
});
