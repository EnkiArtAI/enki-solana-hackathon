import { describe, expect, it } from "vitest";
import { deckHeight, stripWidth } from "../layout";

/** The History strip beside the hero, which the CSS adds to the square it fits to the window. */
describe("stripWidth", () => {
  it("is 78 while open, 40 while folded, 0 without a History", () => {
    expect([stripWidth(true, true), stripWidth(true, false), stripWidth(false, true), stripWidth(false, false)]).toEqual([78, 40, 0, 0]);
  });
});

/** The Easy photo area takes the height the variables leave free (handoff S:172). */
describe("deckHeight", () => {
  it("keeps the free height within 88-520 on desktop", () => {
    expect([-40, 0, 88, 300, 520, 900].map((f) => deckHeight(f, false))).toEqual([88, 88, 88, 300, 520, 520]);
  });

  it("keeps it within 72-460 on a phone", () => {
    expect([-40, 0, 72, 300, 460, 900].map((f) => deckHeight(f, true))).toEqual([72, 72, 72, 300, 460, 460]);
  });

  it("rounds to a whole pixel, as the prototype does", () => {
    expect(deckHeight(300.6, false)).toBe(301);
    expect(deckHeight(300.4, true)).toBe(300);
  });
});
