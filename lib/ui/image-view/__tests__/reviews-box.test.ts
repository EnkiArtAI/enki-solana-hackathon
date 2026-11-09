import { describe, it, expect } from "vitest";
import { reviewsBox, reviewsOrigin } from "../reviews-box";

/** The reviews panel: the hero rect on the desktop, at least 320 high, ending 24 px above the bottom; inset 12, top 56 on a phone (S:257-258). */
describe("reviewsBox", () => {
  const frame = { left: 0, top: 0, width: 1440, height: 900 };
  const hero = { left: 760, top: 96, width: 520, height: 600 };

  it("takes the hero's left, top and width on the desktop, and reaches to 24 px above the bottom, whatever the hero's own height", () => {
    expect(reviewsBox(frame, hero, false)).toEqual({ left: 760, top: 96, width: 520, height: 780 });
  });

  it("is never under 320 high", () => {
    expect(reviewsBox({ ...frame, height: 500 }, { ...hero, top: 200 }, false)).toEqual({ left: 760, top: 200, width: 520, height: 320 });
    expect(reviewsBox({ ...frame, height: 500 }, { ...hero, top: 156 }, false).height).toBe(320); // 500 − 156 − 24 = 320
    expect(reviewsBox({ ...frame, height: 500 }, { ...hero, top: 150 }, false).height).toBe(326);
  });

  it("measures the hero from the frame's corner, not the window's", () => {
    const shifted = { left: 256, top: 64, width: 1184, height: 836 };
    expect(reviewsBox(shifted, { ...hero, left: 1016, top: 160 }, false)).toEqual({ left: 760, top: 96, width: 520, height: 716 });
  });

  it("insets 12 at the sides and bottom and 56 from the top on a phone, the hero ignored", () => {
    const phone = { left: 0, top: 0, width: 390, height: 844 };
    expect(reviewsBox(phone, hero, true)).toEqual({ left: 12, top: 56, width: 366, height: 776 });
    expect(reviewsBox(phone, null, true)).toEqual({ left: 12, top: 56, width: 366, height: 776 });
  });

  it("falls back to the inset box on the desktop when no hero is measured", () => {
    expect(reviewsBox(frame, null, false)).toEqual({ left: 12, top: 56, width: 1416, height: 832 });
  });
});

describe("reviewsOrigin", () => {
  it("is the rating button's centre, relative to the panel", () => {
    const box = { left: 760, top: 96, width: 520, height: 780 };
    expect(reviewsOrigin({ left: 0, top: 0, width: 1440, height: 900 }, box, { left: 1100, top: 700, width: 80, height: 30 })).toEqual({ x: 380, y: 619 });
    expect(reviewsOrigin({ left: 256, top: 64, width: 1184, height: 836 }, box, { left: 1356, top: 764, width: 80, height: 30 })).toEqual({ x: 380, y: 619 });
  });
});
