import { describe, expect, it } from "vitest";
import { cutAt, fitEl, fitText, LINE, lineX, type Measure } from "../text-layout";
import type { El } from "../doc";

/** Every character half its size wide: a font whose numbers can be read off by hand. */
const half: Measure = (text, size) => (text.length * size) / 2;

describe("fitText", () => {
  it("returns the largest size that fits, its lines explicit", () => {
    const fit = fitText([{ text: "aaaa bbbb" }], 200, 200, half);
    // One line of 9 characters: wide 4.5 em. Two lines of 4: wide 2 em, high 2.32 em. Height allows 86, width 100 at most on two lines.
    expect(fit.lines.map((l) => l.text)).toEqual(["aaaa", "bbbb"]);
    expect(fit.size).toBeGreaterThan(83);
    expect(fit.size * 2 * LINE).toBeLessThanOrEqual(200.5);
  });

  it("gets no larger than the box lets it, in height and in width", () => {
    const tall = fitText([{ text: "ab" }], 1000, 40, half);
    expect(tall.size * LINE).toBeLessThanOrEqual(40.5);
    expect(tall.size * LINE).toBeGreaterThan(38);
    const wide = fitText([{ text: "abcdefghij" }], 50, 500, half);
    for (const l of wide.lines) expect(l.width).toBeLessThanOrEqual(50.5);
  });

  it("stacks its lines at the line height", () => {
    const fit = fitText([{ text: "aaaa bbbb cccc dddd" }], 100, 200, half);
    expect(fit.lines.length).toBeGreaterThan(1);
    expect(fit.lines[1].top - fit.lines[0].top).toBeCloseTo(fit.size * LINE, 6);
    expect(fit.lines[0].height).toBeCloseTo(fit.size * LINE, 6);
  });

  it("breaks a word wider than the box where it must, losing nothing", () => {
    // At the smallest size (4) it is 160 wide: only breaking fits it, and the box has height to spare.
    const word = "x".repeat(80);
    const fit = fitText([{ text: word }], 100, 300, half);
    expect(fit.lines.length).toBeGreaterThan(1);
    expect(fit.lines.map((l) => l.text).join("")).toBe(word);
    for (const l of fit.lines) expect(l.width).toBeLessThanOrEqual(100.5);
  });

  it("a block's scale, opacity and space above reach its lines", () => {
    const fit = fitText([{ text: "name", scale: 0.76, opacity: 0.8, lh: 1.22, group: 0, mark: "vn" }, { text: "value", lh: 1.22, group: 0, mark: "vx" }, { text: "next", lh: 1.22, before: 0.62, group: 1, mark: "vx" }], 400, 100, half);
    const [n, v, x] = fit.lines;
    expect(n.size).toBeCloseTo(fit.size * 0.76, 6);
    expect(n.opacity).toBe(0.8);
    expect(v.opacity).toBe(1);
    expect(v.top).toBeCloseTo(n.size * 1.22, 6);
    expect(x.top).toBeCloseTo(v.top + v.height + 0.62 * fit.size, 6);
    expect(x.group).toBe(1);
  });

  it("a line with an icon never wraps, counts the icon's width and stands centred in its box", () => {
    const fit = fitText([{ text: "@a long handle", lead: 1.7, lh: 1.3 }], 300, 60, half);
    expect(fit.lines).toHaveLength(1);
    const [l] = fit.lines;
    expect(l.text).toBe("@a long handle");
    expect(l.lead).toBeCloseTo(1.7 * fit.size, 6);
    expect(l.width).toBeCloseTo(1.7 * fit.size + half(l.text, fit.size), 6);
    expect(l.width).toBeLessThanOrEqual(300.5);
    expect(l.top).toBeCloseTo((60 - l.height) / 2, 6);
  });

  it("an icon alone is a line without text", () => {
    const fit = fitText([{ text: "", lead: 1.3, lh: 1.3 }], 100, 100, half);
    expect(fit.lines).toHaveLength(1);
    expect(fit.lines[0].width).toBeCloseTo(1.3 * fit.size, 6);
  });
});

describe("fitEl and lineX", () => {
  it("an element's box is logical: 1000 wide, its height by the card's ratio", () => {
    const e = { x: 0, y: 0, w: 50, h: 10 } as El;
    const fit = fitEl(e, "4:5", [{ text: "a" }], half);
    expect(fit.boxW).toBe(500);
    expect(fit.boxH).toBeCloseTo(125, 6);
  });

  it("a line starts by its alignment", () => {
    expect(lineX({ width: 40 }, 100)).toBe(0);
    expect(lineX({ width: 40 }, 100, "center")).toBe(30);
    expect(lineX({ width: 40 }, 100, "right")).toBe(60);
  });
});

describe("a word wider than its box", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
  it("never breaks inside a character", () => {
    for (const text of ["\u{1F525}".repeat(90), `a${"\u{1F525}".repeat(90)}`, `ab${"\u{1F41F}\u{1F525}".repeat(40)}`]) {
      const fit = fitText([{ text }], 100, 400, half);
      expect(fit.lines.length).toBeGreaterThan(1);
      for (const l of fit.lines) expect(l.text).not.toMatch(lone);
      expect(fit.lines.map((l) => l.text).join("")).toBe(text);
    }
  });
  it("a character alone wider than the box stands whole, and the loop ends", () => {
    const fit = fitText([{ text: "\u{1F525}\u{1F525}" }], 1, 400, half);
    for (const l of fit.lines) expect(l.text).not.toMatch(lone);
  });
  it("cutAt: inside a pair it goes back, or on when back is nothing", () => {
    const s = "\u{1F525}\u{1F525}";
    expect(cutAt(s, 2)).toBe(2);
    expect(cutAt(s, 3)).toBe(2);
    expect(cutAt(s, 1)).toBe(2);
    expect(cutAt("abc", 2)).toBe(2);
  });
});
