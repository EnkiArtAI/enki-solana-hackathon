import { describe, it, expect } from "vitest";
import { growFrom, zoomBox, zoomSide } from "../zoom";

/** The photo zoom grows from the tile to the photo's own size; the square of side min(W − 40, H − 140, 350 | 560)
    (S:265-268) is where it starts before the size is known and the least it shows. */
describe("zoomSide", () => {
  it("is capped at 560 on the desktop and 350 on a phone", () => {
    expect(zoomSide(1440, 900, false)).toBe(560);
    expect(zoomSide(1440, 900, true)).toBe(350);
    expect(zoomSide(390, 844, true)).toBe(350);
  });

  it("keeps 40 px of the width and 140 px of the height clear, whichever is tighter", () => {
    expect(zoomSide(500, 900, false)).toBe(460); // width
    expect(zoomSide(1440, 600, false)).toBe(460); // height
    expect(zoomSide(375, 667, true)).toBe(335); // a small phone: width
    expect(zoomSide(844, 390, true)).toBe(250); // a phone held sideways: height
  });

  it("rounds a fractional frame to whole px", () => {
    expect(zoomSide(500.6, 900, false)).toBe(461);
    expect(zoomSide(500.4, 900, false)).toBe(460);
  });
});

describe("zoomBox", () => {
  it("centres the square in the frame, in the frame's own coordinates", () => {
    expect(zoomBox({ width: 1440, height: 900 }, false)).toEqual({ left: 440, top: 170, width: 560, height: 560 });
    expect(zoomBox({ width: 390, height: 844 }, true)).toEqual({ left: 20, top: 247, width: 350, height: 350 });
  });

  it("rounds the centred offsets", () => {
    expect(zoomBox({ width: 391, height: 845 }, true)).toEqual({ left: 21, top: 248, width: 350, height: 350 });
  });
});

describe("growFrom", () => {
  it("lays the square over its tile: offset from the box, scaled to the tile's width", () => {
    const frame = { left: 0, top: 0, width: 390, height: 844 };
    const box = zoomBox(frame, true);
    expect(growFrom(frame, { left: 16, top: 600, width: 72, height: 72 }, box)).toBe("translate(-4.0px, 353.0px) scale(0.206)");
  });

  it("measures the tile from the frame's corner, not the window's", () => {
    const frame = { left: 100, top: 50, width: 1440, height: 900 };
    const box = zoomBox(frame, false);
    expect(growFrom(frame, { left: 300.33, top: 400, width: 100, height: 100 }, box)).toBe("translate(-239.7px, 180.0px) scale(0.179)");
  });
});

// Kev, 2026-10-29: "i want to see the images in its correct size, und in der korrekten größe, also up to vollbild natürlich".
describe("zoomBox at the photo's own size", () => {
  it("shows a photo between the square and the screen at its own size and shape, centred", () => {
    expect(zoomBox({ width: 1440, height: 900 }, false, { width: 1000, height: 700 })).toEqual({ left: 220, top: 100, width: 1000, height: 700 });
    expect(zoomBox({ width: 1440, height: 900 }, false, { width: 800, height: 852 })).toEqual({ left: 320, top: 24, width: 800, height: 852 });
  });

  // Review 2026-10-29: a 24 px NFT shrank below its 132 px card.
  it("grows a photo smaller than the square up to the square's side, in its own shape", () => {
    expect(zoomBox({ width: 1440, height: 900 }, false, { width: 300, height: 200 })).toEqual({ left: 440, top: 264, width: 560, height: 373 });
    expect(zoomBox({ width: 1440, height: 900 }, false, { width: 24, height: 24 })).toEqual({ left: 440, top: 170, width: 560, height: 560 });
    expect(zoomBox({ width: 390, height: 844 }, true, { width: 100, height: 200 })).toEqual({ left: 108, top: 247, width: 175, height: 350 });
  });

  it("shrinks a larger photo to what the screen holds, 24 px clear (12 on a phone), keeping its shape", () => {
    // 4000 × 3000 in 1440 × 900: the height binds (852 / 3000), so 1136 × 852.
    expect(zoomBox({ width: 1440, height: 900 }, false, { width: 4000, height: 3000 })).toEqual({ left: 152, top: 24, width: 1136, height: 852 });
    // A wide one: the width binds (1392 / 3000).
    expect(zoomBox({ width: 1440, height: 900 }, false, { width: 3000, height: 1000 })).toEqual({ left: 24, top: 218, width: 1392, height: 464 });
    // A phone, a portrait photo: 366 / 3000 wide, 820 / 4000 high, the width binds.
    expect(zoomBox({ width: 390, height: 844 }, true, { width: 3000, height: 4000 })).toEqual({ left: 12, top: 178, width: 366, height: 488 });
  });
});

describe("growFrom a photo that is not square", () => {
  it("covers the square tile as the tile's own crop does, centre on centre", () => {
    const frame = { left: 0, top: 0, width: 1440, height: 900 };
    const box = { left: 152, top: 24, width: 1136, height: 852 };
    // 100 px tile at (300, 400): scale 100 / 852, so 133.3 × 100, its centre on the tile's (350, 450).
    expect(growFrom(frame, { left: 300, top: 400, width: 100, height: 100 }, box)).toBe("translate(131.3px, 376.0px) scale(0.117)");
  });
});
