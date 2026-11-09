import { describe, expect, it } from "vitest";
import { CARD_MAX, COARSE, HOVER, IV_MOBILE, MAX_COLUMNS, PHONE, TABS, columnsFor } from "../breakpoints";

/** Whether a window `width` px wide falls under the query's max-width clause. */
const under = (query: string, width: number) => {
  const max = /\(max-width: ([\d.]+)px\)/.exec(query);
  if (!max) throw new Error(`no max-width in ${query}`);
  return width <= Number(max[1]);
};

describe("the breakpoints", () => {
  it.each([
    ["PHONE", PHONE, 768],
    ["TABS", TABS, 1024],
    ["IV_MOBILE", IV_MOBILE, 1024],
  ])("%s holds below %ipx and lets that width go", (_name, query, edge) => {
    expect(under(query, edge - 1)).toBe(true);
    expect(under(query, edge - 0.5)).toBe(true);
    expect(under(query, edge)).toBe(false);
  });

  it("PHONE also takes a phone held sideways", () => {
    expect(PHONE).toBe("(max-width: 767.98px), (pointer: coarse) and (max-height: 500px)");
  });

  it("IV_MOBILE takes tablets and a phone held sideways", () => {
    expect(IV_MOBILE).toBe("(max-width: 1023.98px), (pointer: coarse) and (max-height: 500px)");
  });

  it("COARSE and HOVER ask the pointer, not the width", () => {
    expect(COARSE).toBe("(pointer: coarse)");
    expect(HOVER).toBe("(hover: hover) and (pointer: fine)");
  });
});

describe("columnsFor", () => {
  const GAP = 4;
  /** How wide each card is in a wall `width` px wide split into `cols`. */
  const card = (width: number, cols: number) => (width - (cols - 1) * GAP) / cols;

  it("keeps every card at most CARD_MAX wide with the fewest columns that do, up to five; past them the cards grow", () => {
    expect(MAX_COLUMNS).toBe(5);
    for (let width = 0; width <= 4000; width++) {
      const cols = columnsFor(width, GAP);
      if (cols > 2) expect(card(width, cols - 1)).toBeGreaterThan(CARD_MAX);
      if (cols < MAX_COLUMNS) expect(card(width, cols)).toBeLessThanOrEqual(CARD_MAX);
      else expect(cols).toBe(MAX_COLUMNS);
    }
  });

  it.each([
    [0, 2],
    [375, 2],
    [1264, 4],
    [1952, 5],
    // A wall six would fit (the menu fully in on a wide screen, Kev 2026-10-30): five stay and grow.
    [2412, 5],
    [3760, 5],
  ])("gives a %ipx wall %i columns", (width, cols) => {
    expect(columnsFor(width, GAP)).toBe(cols);
  });
});

describe("nextWallWidth (Kev, 2026-10-31: the home wall \"vibrierte\")", () => {
  it("lays out the first width, a real resize and a shrink, and leaves out the scrollbar's bounce back", async () => {
    const { nextWallWidth } = await import("../breakpoints");
    const first = nextWallWidth(null, 1600, 1920, 0)!;
    expect(first).toEqual({ width: 1600, viewport: 1920, shrunkAt: 0 });
    // The page bar appears: 17 px narrower, laid out.
    const shrunk = nextWallWidth(first, 1583, 1920, 100)!;
    expect(shrunk).toEqual({ width: 1583, viewport: 1920, shrunkAt: 100 });
    // The wall got shorter, the bar went: growing back is the bounce, kept out.
    expect(nextWallWidth(shrunk, 1600, 1920, 300)).toBeNull();
    // Long after, or more than a bar's width, or a resized window: laid out.
    expect(nextWallWidth(shrunk, 1600, 1920, 1200)).toEqual({ width: 1600, viewport: 1920, shrunkAt: 0 });
    expect(nextWallWidth(shrunk, 1840, 1920, 300)).toEqual({ width: 1840, viewport: 1920, shrunkAt: 0 });
    expect(nextWallWidth(shrunk, 1600, 1903, 300)).toEqual({ width: 1600, viewport: 1903, shrunkAt: 0 });
    // A menu folding in narrows by far more than a bar: no bounce guard follows it.
    expect(nextWallWidth(first, 1416, 1920, 100)).toEqual({ width: 1416, viewport: 1920, shrunkAt: 0 });
    expect(nextWallWidth(first, 1600, 1920, 100)).toBeNull();
  });
});
