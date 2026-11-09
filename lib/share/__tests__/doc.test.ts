import { describe, expect, it } from "vitest";
import { formatCopy } from "@/lib/ui/kit/option-copy";
import { bgCss, fitR, isText, lay, reflow, rn, tileRects, type Arrangement, type El, type ShareDoc } from "../doc";
import type { ShareContent } from "../content";
import { coverRect, gradientLine, outputSize } from "../render-canvas";
import { cardsFor, setFor } from "../templates";
import type { Tokens } from "../tokens";

const T: Tokens = { paper: "#ffffff", alt: "#f6f5f4", ink: "#111111", ink2: "#3d3c3a", ga: "#7d1d33", gb: "#c58f9c", on: "#ffffff" };
const RATIOS = ["1:1", "4:5", "3:4", "2:3", "16:9", "9:16", "3:2", "4:3", "5:4", "21:9"];
const ARR: Arrangement[] = ["row", "col", "grid", "hero"];
const content = (n: number, over: Partial<ShareContent> = {}): ShareContent => ({
  title: "T", desc: null, words: null, variables: [{ name: "a", example: "b" }], media: "image", poster: null, generator: "G", handle: "h", link: "l", hashtags: "#t",
  images: [...Array(n).keys()].map((i) => ({ src: `s${i}`, full: `f${i}` })), setups: [...Array(n)].map(() => [{ name: "a", example: "b" }]), ...over,
});

describe("lay", () => {
  it.each([1, 2, 3, 4])("%i images tile their group whole, without overlap", (n) => {
    for (const arr of ARR) {
      const tiles = lay(arr, n);
      expect(tiles).toHaveLength(n);
      expect(tiles.reduce((s, [, , w, h]) => s + w * h, 0)).toBeCloseTo(1, 9);
      for (const [x, y, w, h] of tiles) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + w).toBeLessThanOrEqual(1 + 1e-9);
        expect(y + h).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("one image fills its group in every arrangement", () => {
    for (const arr of ARR) expect(lay(arr, 1)).toEqual([[0, 0, 1, 1]]);
  });

  it("three in a grid: two above, the third stretched below", () => {
    expect(lay("grid", 3)).toEqual([[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 1, 0.5]]);
  });

  it("the hero first and large, the rest stacked beside it", () => {
    expect(lay("hero", 3)).toEqual([[0, 0, 0.7, 1], [0.7, 0, 0.3, 0.5], [0.7, 0.5, 0.3, 0.5]]);
  });

  it("four stay the mock's own", () => {
    expect(lay("grid", 4)).toEqual([[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]);
    expect(lay("row", 4)[3]).toEqual([0.75, 0, 0.25, 1]);
  });
});

describe("tileRects", () => {
  const e = { x: 0, y: 0, w: 50, h: 50, arr: "row", gap: 1 } as El;
  it("takes the gap off between tiles, not at the outer edges", () => {
    const [a, b] = tileRects(e, 2, 1000, 1000);
    expect(a.x).toBe(0);
    expect(a.w).toBeCloseTo(245, 6);
    expect(b.x).toBeCloseTo(255, 6);
    expect(b.x + b.w).toBeCloseTo(500, 6);
    expect(a.h).toBeCloseTo(500, 6);
    expect(a.radius).toBeCloseTo(12, 6);
  });
  it("without a gap the tiles meet, square-cornered", () => {
    const [a, b] = tileRects({ ...e, gap: 0 }, 2, 1000, 1000);
    expect(a.x + a.w).toBeCloseTo(b.x, 6);
    expect(a.radius).toBe(0);
  });
});

describe("fitR", () => {
  it("one image fills the box", () => {
    expect(fitR({}, 80, 30, 1)).toMatchObject({ w: 80, h: 30 });
  });
  it("in a wide box four lie in a row, in a tall box a column", () => {
    expect(fitR({}, 400, 100, 4).arr).toBe("row");
    expect(fitR({}, 100, 400, 4).arr).toBe("col");
  });
  it("keeps the group's arrangement while it stays near the best, gives it up when not", () => {
    expect(fitR({ arr: "grid" }, 100, 100, 4).arr).toBe("grid");
    expect(fitR({ arr: "hero" }, 100, 100, 4).arr).toBe("hero");
    expect(fitR({ arr: "col" }, 400, 100, 4).arr).toBe("row");
  });
  it("never leaves the box", () => {
    for (const n of [2, 3, 4]) for (const [bw, bh] of [[100, 30], [30, 100], [80, 80]]) {
      const f = fitR({}, bw, bh, n);
      expect(f.w).toBeLessThanOrEqual(bw + 1e-9);
      expect(f.h).toBeLessThanOrEqual(bh + 1e-9);
    }
  });
});

describe("reflow", () => {
  it("the list of ratios is the format list's", () => {
    for (const r of RATIOS) expect(formatCopy(r)).not.toBeNull();
  });

  const docs = (n: number): [string, ShareDoc][] => {
    const free = content(n, { words: "some words", desc: "a description" }), paid = content(n);
    return [
      ...cardsFor(T, free).map((d): [string, ShareDoc] => [`free ${d.name}`, d]),
      ...cardsFor(T, paid).map((d): [string, ShareDoc] => [`paid ${d.name}`, d]),
      ...setFor(T, paid).map((d): [string, ShareDoc] => [`set ${d.name}`, d]),
    ];
  };
  const cases = [1, 2, 3, 4].flatMap((n) => docs(n).flatMap(([name, d]) => RATIOS.map((r) => ({ n, name, d, r }))));

  it("covers every template at every ratio", () => {
    expect(cases.length).toBeGreaterThan(300);
  });

  it.each(cases)("$n images, $name at $r: everything on the card, nothing over anything, nothing tilted", ({ n, d, r }) => {
    const out = reflow(d, r, n, !d.els.some((e) => e.font === "DM Mono"));
    expect(out.ratio).toBe(r);
    expect(out.els).toHaveLength(d.els.length);
    for (const e of out.els) {
      expect(e.w).toBeGreaterThan(0);
      expect(e.h).toBeGreaterThan(0);
      expect(e.x).toBeGreaterThanOrEqual(-1e-6);
      expect(e.y).toBeGreaterThanOrEqual(-1e-6);
      expect(e.x + e.w).toBeLessThanOrEqual(100 + 1e-6);
      expect(e.y + e.h).toBeLessThanOrEqual(100 + 1e-6);
      expect(e.rot).toBe(0);
    }
    for (const a of out.els) for (const b of out.els) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6;
      expect(apart).toBe(true);
    }
  });

  it("images keep their shape: a group fits its arrangement's own proportion (no stretching)", () => {
    const d = cardsFor(T, content(4, { words: "w" }))[0];
    const out = reflow(d, "9:16", 4, false);
    const e = out.els.find((x) => x.k === "results")!;
    const H = 1 / rn("9:16"), w = e.w / 100, h = (e.h / 100) * H;
    expect({ row: 4, col: 0.25, grid: 1, hero: 1 / 0.72 }[e.arr!]).toBeCloseTo(w / h, 6);
  });

  it("a tilted element stands straight in the new format", () => {
    const d = cardsFor(T, content(4))[0];
    const tilted = { ...d, els: d.els.map((e) => ({ ...e, rot: 12 })) };
    for (const e of reflow(tilted, "16:9", 4, true).els) expect(e.rot).toBe(0);
  });

  it("leaves the given card as it was", () => {
    const d = cardsFor(T, content(4))[1], before = JSON.stringify(d);
    reflow(d, "16:9", 4, true);
    expect(JSON.stringify(d)).toBe(before);
  });

  it("a card of only images fills the new format whole", () => {
    const d = cardsFor(T, content(4)).find((x) => x.els.every((e) => !isText(e)))!;
    expect(reflow(d, "16:9", 4, true).els[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 100 });
  });

  it("an overlap card keeps its places, scaled into the new format", () => {
    const d: ShareDoc = { ratio: "1:1", bg: { mode: "solid", c: "#fff" }, ov: true, els: [{ id: 1, k: "title", x: 40, y: 40, w: 20, h: 20, rot: 7 }] };
    const out = reflow(d, "1:1", 1, false);
    expect(out.els[0]).toMatchObject({ x: 40, y: 40, w: 20, h: 20, rot: 7 });
  });

  it("a paid card gives its variables less room than a free card its whole prompt", () => {
    const d = cardsFor(T, content(1, { words: "w" }))[0];
    const h = (paid: boolean) => reflow(d, "4:5", 1, paid).els.find((x) => x.k === "prompt")!.h;
    expect(h(false)).toBeGreaterThan(h(true));
  });
});

describe("templates", () => {
  it("no variables on a premium prompt: the name does not claim them, and the card closes up", () => {
    const [first] = cardsFor(T, content(4, { variables: [] }));
    expect(first.name).toBe("Title, your images, your handle");
    const title = first.els.find((e) => e.k === "title")!, images = first.els.find((e) => e.k === "results")!;
    expect(images.y - (title.y + title.h)).toBeLessThan(4);
    expect(images.h).toBeCloseTo(70.4);
  });
  it("no handle: no name claims it", () => {
    const names = cardsFor(T, content(4, { handle: null })).map((d) => d.name);
    expect(names.slice(0, 2)).toEqual(["Title, the variables, your images", "Your images"]);
  });
  it("a video with no variables on a premium prompt: the same", () => {
    const [first] = cardsFor(T, content(0, { media: "video", poster: "p", variables: [] }));
    expect(first.name).toBe("Title above the animation");
    expect(first.els.find((e) => e.k === "clip")!.y).toBe(14);
  });
  it("name the images by their count, never four", () => {
    for (const n of [1, 2, 4]) {
      for (const d of [...cardsFor(T, content(n)), ...setFor(T, content(n))]) expect(d.name.toLowerCase()).not.toContain("four");
    }
    expect(cardsFor(T, content(1))[1].name).toBe("Your image, your handle");
    expect(cardsFor(T, content(1))[0].name).toBe("Title, the variables, your image, your handle");
    expect(cardsFor(T, content(4))[1].name).toBe("Your images, your handle");
  });

  it("a premium prompt's first card speaks of variables, a free one's of the whole prompt", () => {
    expect(cardsFor(T, content(4))[0].name).toBe("Title, the variables, your images, your handle");
    expect(cardsFor(T, content(4, { words: "w" }))[0].name).toBe("Title, the whole prompt, your images, your handle");
  });

  it("four images keep the mock's places", () => {
    const d = cardsFor(T, content(4))[0];
    expect(d.els.find((e) => e.k === "results")).toMatchObject({ y: 58, h: 17.6, arr: "row" });
    expect(d.els.find((e) => e.k === "prompt")).toMatchObject({ y: 16, h: 39 });
  });

  it("one image takes room from the text and nothing runs into anything", () => {
    const d = cardsFor(T, content(1))[0], img = d.els.find((e) => e.k === "results")!, text = d.els.find((e) => e.k === "prompt")!;
    expect(img.h).toBe(38);
    expect(text.y + text.h).toBeLessThan(img.y);
    expect(img.y + img.h).toBeLessThanOrEqual(88);
  });

  it("no description: its element is gone and the images close up", () => {
    const without = cardsFor(T, content(4))[3], withIt = cardsFor(T, content(4, { desc: "d" }))[3];
    expect(without.els.some((e) => e.k === "desc")).toBe(false);
    expect(withIt.els.some((e) => e.k === "desc")).toBe(true);
    expect(without.els.find((e) => e.k === "results")).toMatchObject({ y: 24, h: 64 });
    expect(withIt.els.find((e) => e.k === "results")).toMatchObject({ y: 36, h: 52 });
  });

  it("no handle: no handle element", () => {
    for (const d of cardsFor(T, content(4, { handle: null }))) expect(d.els.some((e) => e.k === "handle")).toBe(false);
  });

  it("colours come from the tokens", () => {
    const [first, , , grad] = cardsFor(T, content(4));
    expect(first.bg).toEqual({ mode: "solid", c: T.paper });
    expect(grad.bg).toEqual({ mode: "gradient", a: T.ga, b: T.gb, dir: 135 });
    expect(grad.els.find((e) => e.k === "title")!.color).toBe(T.on);
    expect(cardsFor(T, content(4, { words: "w" }))[0].els.find((e) => e.k === "prompt")).toMatchObject({ font: "DM Mono", color: T.ink2 });
  });

  it("video has its two cards and no character sheet", () => {
    const docs = cardsFor(T, content(0, { media: "video", poster: "p" }));
    expect(docs.map((d) => d.name)).toEqual(["Title and the variables above the animation", "Only the animation"]);
    expect(docs.flatMap((d) => d.els.map((e) => e.k))).not.toContain("results");
  });

  it("a set has one slide with all, one per image, one ratio", () => {
    const docs = setFor(T, content(3));
    expect(docs.map((d) => d.name)).toEqual(["Slide 1 of 4. All your images.", "Slide 2 of 4. Image 1 and its setup.", "Slide 3 of 4. Image 2 and its setup.", "Slide 4 of 4. Image 3 and its setup."]);
    expect(new Set(docs.map((d) => d.ratio))).toEqual(new Set(["4:5"]));
    expect(docs[0].els.some((e) => e.k === "results")).toBe(true);
    expect(docs[1].els.map((e) => e.k).sort()).toEqual(["handle", "one", "setup"]);
  });
});

describe("the background", () => {
  it("as CSS", () => {
    expect(bgCss({ mode: "solid", c: "#123456" })).toBe("#123456");
    expect(bgCss({ mode: "gradient", a: "#111", b: "#222", dir: 135 })).toBe("linear-gradient(135deg,#111,#222)");
    expect(bgCss({ mode: "gradient", a: "#111", b: "#222", dir: "radial" })).toBe("radial-gradient(circle at center,#111,#222)");
  });

  // The CSS definition itself: the line runs through the centre at the angle (0 up, 90 right), and the perpendicular at each end passes through the nearest corner.
  it.each([[0, 200, 100], [45, 200, 100], [90, 200, 100], [135, 200, 100], [180, 100, 300], [217, 100, 300], [300, 640, 360]])("%i deg on %i x %i ends where CSS ends it", (deg, W, H) => {
    const l = gradientLine(deg, W, H);
    const a = (deg * Math.PI) / 180, dir = { x: Math.sin(a), y: -Math.cos(a) };
    expect((l.x0 + l.x1) / 2).toBeCloseTo(W / 2, 9);
    expect((l.y0 + l.y1) / 2).toBeCloseTo(H / 2, 9);
    const along = { x: l.x1 - l.x0, y: l.y1 - l.y0 }, len = Math.hypot(along.x, along.y);
    expect(along.x / len).toBeCloseTo(dir.x, 9);
    expect(along.y / len).toBeCloseTo(dir.y, 9);
    const corners = [[0, 0], [W, 0], [0, H], [W, H]];
    const onLine = corners.map(([x, y]) => (x - l.x0) * dir.x + (y - l.y0) * dir.y);
    expect(Math.min(...onLine)).toBeCloseTo(0, 9);
    expect(Math.max(...onLine)).toBeCloseTo(len, 9);
  });

  it("135 deg on a square runs corner to corner, top left to bottom right", () => {
    const l = gradientLine(135, 100, 100);
    expect(l.x0).toBeCloseTo(0, 9);
    expect(l.y0).toBeCloseTo(0, 9);
    expect(l.x1).toBeCloseTo(100, 9);
    expect(l.y1).toBeCloseTo(100, 9);
  });
});

describe("coverRect", () => {
  it("a wide image in a square loses its sides, centred", () => {
    expect(coverRect(400, 100, 50, 50)).toEqual({ sx: 150, sy: 0, sw: 100, sh: 100 });
  });
  it("a tall image in a wide box loses top and bottom, centred", () => {
    expect(coverRect(100, 400, 100, 50)).toEqual({ sx: 0, sy: 175, sw: 100, sh: 50 });
  });
  it("the same shape shows whole", () => {
    expect(coverRect(1080, 1350, 400, 500)).toEqual({ sx: 0, sy: 0, sw: 1080, sh: 1350 });
  });
});

describe("outputSize", () => {
  it.each([["1:1", 1080, 1080], ["4:5", 1080, 1350], ["2:3", 1080, 1620], ["9:16", 1080, 1920], ["16:9", 1920, 1080]])("%s is %i x %i", (r, w, h) => {
    expect(outputSize(r)).toEqual({ w, h });
  });
  it("past 2400 the long side stops and the short one gives way", () => {
    expect(outputSize("21:9")).toEqual({ w: 2400, h: 1029 });
  });
});
