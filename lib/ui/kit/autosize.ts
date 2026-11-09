/**
 * The height an autosizing textarea takes (handoff §0 "Autosize-Regel"): it
 * grows with its content between `min` and `max`, then scrolls inside. While
 * `growOnly` (values loaded from an image) it never shrinks, so the UI does
 * not jump; typing in the field clears that, and it may shrink again.
 *
 * `scrollHeight` is read with the height set to auto; `prev` is the height
 * before. Below 10 px the field is not laid out yet, and `prev` stays.
 */
export function nextHeight({ scrollHeight, prev, min, max, growOnly }: {
  scrollHeight: number;
  prev: number;
  min: number;
  max: number;
  growOnly: boolean;
}): { height: number; overflowY: "auto" | "hidden" } {
  if (scrollHeight < 10) return { height: prev, overflowY: "hidden" };
  const fit = Math.min(max, Math.max(min, scrollHeight + 2));
  const height = growOnly ? Math.max(prev, fit) : fit;
  return { height, overflowY: scrollHeight + 2 > height ? "auto" : "hidden" };
}

/** Which edge a prompt box is sized by: its foot, growing down (Create > Video's column), or its top, growing up
 *  (Create > Image's bar at the window's foot). */
export type GripEdge = "down" | "up";
/** Each arrow key moves the edge this far. */
export const GRIP_STEP = 24;

/**
 * The height a prompt box takes while its edge is dragged `dy` px (Kev, 2026-10-30: "the prompt box inside image and
 * video generator must be flexible an der kante. bei videos unten rechts, bei images oben nach oben"): from `start`, the
 * way the edge moves, never below `min` nor above `max`, in whole pixels.
 */
export function dragHeight({ start, dy, edge, min, max }: { start: number; dy: number; edge: GripEdge; min: number; max: number }): number {
  return Math.round(Math.min(max, Math.max(min, start + (edge === "down" ? dy : -dy))));
}

/** The tallest a dragged box gets: its own max, or most of the window where that is more. */
export const gripMax = (max: number, windowHeight: number) => Math.max(max, Math.round(windowHeight * 0.6));
