import { describe, it, expect } from "vitest";
import { CARD_MAX, deckAt, deckLayout, type PhotoLayout } from "../deck";

/* A phone's deckbox at 390 (350 after the 20 px padding) at the prototype's default height (S:188). */
const phone = (count: number, over: { canAdd?: boolean; height?: number } = {}) =>
  deckLayout({ width: 350, height: 110, count, gap: 8, canAdd: true, addWidth: 48, ...over });
const lefts = (l: PhotoLayout) => l.tiles.map((t) => t.left);

describe("deckLayout (the phone, and the desktop with its 132 px cap)", () => {
  it("sets the photos side by side at the full height, the + strip one gap after the last", () => {
    expect(phone(2)).toEqual({
      tiles: [{ left: 4, top: 8, size: 102, radius: 18 }, { left: 114, top: 8, size: 102, radius: 18 }],
      add: { left: 224, top: 8, width: 48, height: 102, radius: 18 },
      overlap: false,
      height: 110,
    });
  });

  it("overlaps them like cards when they do not fit, the last ending where the strip's gap begins", () => {
    const d = phone(6);
    expect(lefts(d)).toEqual([4, 41, 78, 114, 151, 188]);
    expect(d.tiles.every((t) => t.size === 102)).toBe(true);
    expect(d.overlap).toBe(true);
    expect(d.add).toEqual({ left: 298, top: 8, width: 48, height: 102, radius: 18 });
    expect(d.add!.left + d.add!.width).toBe(350 - 4);
  });

  it("keeps the cards at full height while each still shows a quarter of itself, and shrinks them after", () => {
    // 8 cards step 26.3 px, more than a quarter of 102; 9 would step 23, so they shrink to 95 and step 23.75.
    expect(phone(8).tiles[0].size).toBe(102);
    const nine = phone(9);
    expect(nine.tiles[0].size).toBe(95);
    expect(lefts(nine)).toEqual([4, 28, 52, 75, 99, 123, 147, 170, 194]);
    expect(nine.add).toEqual({ left: 297, top: 8, width: 48, height: 95, radius: 18 });
    expect(nine.height).toBe(103);
  });

  it("gives the strip's room to the photos once no photo can be added", () => {
    expect(phone(3).overlap).toBe(true);
    const full = phone(3, { canAdd: false });
    expect(lefts(full)).toEqual([4, 114, 224]);
    expect(full.overlap).toBe(false);
    expect(full.add).toBeNull();
    const fourteen = phone(14, { canAdd: false });
    expect(fourteen.tiles[13]).toEqual({ left: 264, top: 8, size: 80, radius: 16 });
    expect(fourteen.height).toBe(88);
  });

  it("is as tall as the photos and rounds the corners to a fifth of the side, at most 18", () => {
    const low = phone(1, { height: 72 });
    expect(low.tiles).toEqual([{ left: 4, top: 8, size: 64, radius: 13 }]);
    expect(low.add).toEqual({ left: 76, top: 8, width: 48, height: 64, radius: 13 });
    expect(low.height).toBe(72);
  });

  it("stops a desktop card at 132 px however tall the free area, the box as tall as the cards", () => {
    const desk = deckLayout({ width: 520, height: 520, count: 2, gap: 10, canAdd: true, addWidth: 48, max: CARD_MAX });
    expect(desk.tiles).toEqual([{ left: 4, top: 8, size: 132, radius: 18 }, { left: 146, top: 8, size: 132, radius: 18 }]);
    expect(desk.add).toEqual({ left: 288, top: 8, width: 48, height: 132, radius: 18 });
    expect(desk.height).toBe(140);
  });
});

describe("deckAt (a finger sliding along the phone's deck, Kev 2026-10-26)", () => {
  const tiles = deckLayout({ width: 300, height: 110, count: 6, gap: 8, canAdd: false, addWidth: 48 }).tiles;
  it("is the card whose visible part is under the finger: from its left edge to the next card's", () => {
    expect(tiles[1].left).toBeLessThan(tiles[0].left + tiles[0].size);
    expect(deckAt(tiles, 0)).toBe(0);
    expect(deckAt(tiles, tiles[1].left - 1)).toBe(0);
    expect(deckAt(tiles, tiles[1].left)).toBe(1);
    expect(deckAt(tiles, tiles[3].left + 2)).toBe(3);
  });
  it("is the last card past its left edge, the first before the deck", () => {
    expect(deckAt(tiles, 299)).toBe(5);
    expect(deckAt(tiles, -20)).toBe(0);
  });
});
