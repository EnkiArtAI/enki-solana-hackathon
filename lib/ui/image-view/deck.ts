/**
 * Where the reference photos sit in the Easy photo area, as the v2 prototype
 * places them (handoff "Enki Prompt Studio v2", deckVals, S:186-244). Photos
 * are always square. Every number is px from the deckbox's top-left: tiles
 * start 8 px down, the room their 8 px hover lift takes, and 4 px in from
 * either side.
 */

/** The deckbox as measured, and what goes into it. */
export interface DeckArea {
  /** The deckbox's width. */
  width: number;
  /** The height the variables leave free, already clamped (layout.ts deckHeight). */
  height: number;
  /** Photo slots, at least one (the last slot is emptied, never removed). */
  count: number;
  /** Between photos: 8 on a phone, 10 on desktop. */
  gap: number;
  /** Whether the "+" shows: the generator takes another photo (PhotoDeck, DEC-529). */
  canAdd: boolean;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Tile {
  left: number;
  top: number;
  size: number;
  radius: number;
}

export interface PhotoLayout {
  /** One square per slot, in slot order. */
  tiles: Tile[];
  /** The "+": the strip after the photos; null when no photo can be added. */
  add: (Box & { radius: number }) | null;
  /** Deck tiles overlap like cards. */
  overlap: boolean;
  /** The deckbox's height. */
  height: number;
}

/* A fifth of the side, at most 18. */
const radius = (size: number) => Math.min(18, Math.round(size / 5));

/* A desktop card stops at 132 px (plan B7; S:209). */
export const CARD_MAX = 132;

/**
 * The photos in one row at the full height, at most `max` px. When they do
 * not fit they overlap like cards, each still showing a quarter of itself
 * (the cards shrink once that would fail). The "+" strip, `addWidth` wide
 * and as tall as the photos, follows one gap after the last. The phone's
 * deck, and the desktop's since Kev, 2026-10-29: "pack die reference images
 * alle in einer line and ordne die dann wie ein kartendeck nebeneinander an".
 */
export function deckLayout({ width, height, count, gap, canAdd, addWidth, max = Infinity }: DeckArea & { addWidth: number; max?: number }): PhotoLayout {
  const room = width - (canAdd ? addWidth + gap : 0) - 8;
  let size = Math.floor(Math.min(height - 8, room, max));
  let step = size + gap;
  if (count > 1 && count * size + (count - 1) * gap > room) {
    step = (room - size) / (count - 1);
    if (step < size * 0.25) {
      size = Math.floor(room / (1 + 0.25 * (count - 1)));
      step = size * 0.25;
    }
  }
  const usedW = (count - 1) * step + size;
  return {
    tiles: Array.from({ length: count }, (_, i) => ({ left: Math.round(i * step + 4), top: 8, size, radius: radius(size) })),
    add: canAdd ? { left: Math.round(usedW + gap + 4), top: 8, width: addWidth, height: size, radius: radius(size) } : null,
    overlap: count > 1 && step < size,
    height: size + 8,
  };
}

/**
 * The card under a finger `x` px from the deckbox's left: the last tile that starts at or before it, since an
 * overlapping card shows from its own left edge to the next one's (a finger sliding along the deck, Kev 2026-10-26).
 */
export function deckAt(tiles: readonly Tile[], x: number): number {
  let at = 0;
  tiles.forEach((t, i) => { if (t.left <= x) at = i; });
  return at;
}
