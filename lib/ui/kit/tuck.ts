/**
 * The phone header tucks away while the page scrolls down and comes back when it scrolls up (Kev, 2026-10-26: "wenn
 * ich runter scrolle, sollte das menü verschwinden, bis ich wieder hoch scrolle"). Near the top it always shows; a
 * move counts once it is past TUCK_STEP px, so a finger's jitter does not flicker it.
 */
export const TUCK_TOP = 60;
export const TUCK_STEP = 8;

/** The next state for a scroll from `last` to `y`: tucked or shown (null: unchanged), and the position to measure from. */
export function tuckStep(last: number, y: number): { tucked: boolean | null; last: number } {
  if (y < TUCK_TOP) return { tucked: false, last: y };
  if (y - last > TUCK_STEP) return { tucked: true, last: y };
  if (last - y > TUCK_STEP) return { tucked: false, last: y };
  return { tucked: null, last };
}

/**
 * The next state for scroller `s`, measured from `last` (its previous offset; none yet: from where it is), `view` px of
 * it on screen. Inside the scroller only: an iOS bounce past either end read as a scroll back (review 2026-10-26). At
 * the end, nothing that does not leave it counts: a drop onto it is the scroller grown by a tuck (a panel takes the
 * header's place), which pulls the offset back, and a bounce there stays on it; counted, a panel just taller than the
 * screen tucked and showed in a loop (review 2026-10-27: also where its tucked end is short of TUCK_TOP).
 */
export function tuckScroll(s: Scroller, last: number | undefined, view = s.clientHeight): { tucked: boolean | null; last: number } {
  const end = Math.max(0, s.scrollHeight - view);
  const top = Math.min(Math.max(s.scrollTop, 0), end);
  if (last !== undefined && last >= top && top >= end - 1) return { tucked: null, last: top };
  return tuckStep(last ?? top, top);
}

/** What scrolls: the page (document.scrollingElement) or an element on it. */
export type Scroller = { scrollTop: number; scrollHeight: number; clientHeight: number };

/**
 * The scroll the header tucks on (Kev, 2026-10-27: "when scrolling through ANY menü, this goes also for profile"): the
 * page's while no panel is up, else one that runs up and down inside the open panel, never the page behind it (review
 * 2026-10-26). Null for anything else: a strip that scrolls only sideways, a list in a sheet over the feed.
 */
export function tuckScroller<T extends Scroller>(target: T | null, page: T, panel: { contains(n: T): boolean } | null): T | null {
  const el = target === page ? null : target;
  const s = panel ? (el && panel.contains(el) ? el : null) : el ? null : page;
  return s && s.scrollHeight > s.clientHeight ? s : null;
}
