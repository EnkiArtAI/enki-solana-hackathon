/**
 * The "↓ N more settings" pill (plan B8, handoff S:176-180, S:594-595): it
 * counts the variable rows still under the scroller's fold, and a tap scrolls
 * on by most of a screen.
 */

/** One measure of the settings scroller, all in screen px. */
export interface MoreMeasure {
  /** getBoundingClientRect().top of each variable row. */
  rowTops: readonly number[];
  /** The scroller's getBoundingClientRect().bottom. */
  bottom: number;
  /** With the photo deck at its target height, so a deck still resizing does not flash the pill. */
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/**
 * 0 when at most 16 px are left to scroll; else the rows whose top 28 px are
 * not yet in view 6 px above the bottom edge, or -1 when more is below but no
 * row is (the pill then says "More below").
 */
export function moreBelow({ rowTops, bottom, scrollHeight, scrollTop, clientHeight }: MoreMeasure): number {
  if (scrollHeight - scrollTop - clientHeight <= 16) return 0;
  return rowTops.filter((top) => top + 28 > bottom - 6).length || -1;
}

/** The pill's text, or null while it is hidden: nothing below, or an element (variable or photo) is active. */
export function morePill(more: number, active: boolean): string | null {
  if (!more || active) return null;
  return more > 0 ? `↓ ${more} more setting${more > 1 ? "s" : ""}` : "↓ More below";
}

/** A tap scrolls by 70 % of the scroller's visible height. */
export const moreStep = (clientHeight: number) => clientHeight * 0.7;

/** A box's children as laid out: a `display: contents` child has no box of its own, its children stand in for it. */
export function laidOut(box: Element, display = (e: Element) => getComputedStyle(e).display): Element[] {
  return [...box.children].flatMap((c) => display(c) === "contents" ? laidOut(c, display) : [c]);
}

/** A box's room under its last shown child (what its min-height adds, not content); 0 with no child shown. */
export function emptyRoom(boxBottom: number, childBottoms: readonly number[]): number {
  return childBottoms.length ? Math.max(0, boxBottom - Math.max(...childBottoms)) : 0;
}
