/**
 * Where the reviews panel opens (plan B13, handoff S:257-259): over the hero
 * on the desktop, over nearly the whole frame on a phone. It morphs out of the
 * rating button, so that button's centre is its transform-origin.
 */
import type { Rect } from "./zoom";

/**
 * The panel in the frame's own coordinates. Desktop: the hero's left, top and
 * width (the hero alone, not the History strip), reaching down to 24 px above
 * the frame's bottom and never under 320 high. Phone, or no hero measured:
 * inset 12 at the sides and bottom, 56 from the top.
 */
export function reviewsBox(frame: Rect, hero: Rect | null, phone: boolean): Rect {
  if (phone || !hero) return { left: 12, top: 56, width: frame.width - 24, height: frame.height - 68 };
  const top = hero.top - frame.top;
  return { left: hero.left - frame.left, top, width: hero.width, height: Math.max(320, frame.height - top - 24) };
}

/** The rating button's centre relative to the panel: its transform-origin in px. */
export function reviewsOrigin(frame: Rect, box: Rect, button: Rect): { x: number; y: number } {
  return {
    x: button.left + button.width / 2 - frame.left - box.left,
    y: button.top + button.height / 2 - frame.top - box.top,
  };
}
