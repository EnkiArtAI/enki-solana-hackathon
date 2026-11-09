/**
 * The one breakpoint table of the image UI. JS reads these through
 * useMediaQuery (or matchMedia in a handler); CSS repeats the same numbers.
 * The .98 edges keep a 768 / 1024 px window on the wide side.
 */

/** Phone layout: narrow, or a phone held sideways. */
export const PHONE = "(max-width: 767.98px), (pointer: coarse) and (max-height: 500px)";
/** Editor Craft/Verify tabs, sheet instead of popover, stacked Image View. */
export const TABS = "(max-width: 1023.98px)";
/** The Image View's phone layout: below 1024 px, tablets included (README §2), or a phone held sideways. */
export const IV_MOBILE = "(max-width: 1023.98px), (pointer: coarse) and (max-height: 500px)";
/** 44 px hit areas. */
export const COARSE = "(pointer: coarse)";
/** Card hover reveal. */
export const HOVER = "(hover: hover) and (pointer: fine)";

/** The widest a wall card gets up to five columns: a wider wall gets another column, not bigger cards
 *  (Kev, 2026-10-16: four columns of 485 px were "riesig", five wanted; 400 gives
 *  that 1952 px wall five). */
export const CARD_MAX = 400;
/** And never more than five: past them the cards grow instead (Kev, 2026-10-30, Explore's images and videos: "wenn ich
 *  das menü vollständig einfahre, so soll bitte keine neue column erstellt werden wenn platz da ist, sondern bitte bei 5
 *  bleiben, sodass alle bilder einfach ein bisschen größer werden"). */
export const MAX_COLUMNS = 5;

/** Masonry columns for a wall `width` px wide with `gap` between columns: the fewest
 *  that keep every card at most CARD_MAX wide, never fewer than two nor more than MAX_COLUMNS. */
export function columnsFor(width: number, gap: number): number {
  return Math.min(MAX_COLUMNS, Math.max(2, Math.ceil((width + gap) / (CARD_MAX + gap))));
}

/** A page scrollbar's width at most, and how soon after the wall shrank by one its growing back is that bar going. */
export const SCROLLBAR_BOUNCE_PX = 24;
export const SCROLLBAR_BOUNCE_MS = 1000;
export interface WallWidth { width: number; viewport: number; shrunkAt: number }

/**
 * The width a wall lays out at, or null to keep the last one. The page's own scrollbar comes and goes with the wall's
 * height (no reserved gutter, app/globals.css), and the height follows the width: near the window's height the wall
 * shrank and grew by a scrollbar's width many times a second (Kev, 2026-10-31: "springt meine home seite so stark, dass
 * alles aussieht als würde es vibrieren"). Growing back by up to a scrollbar's width right after such a shrink, the
 * window unchanged, is that bounce and is left out; a real resize (the window, the menu) lays out.
 */
export function nextWallWidth(last: WallWidth | null, width: number, viewport: number, now: number): WallWidth | null {
  if (!last || viewport !== last.viewport) return { width, viewport, shrunkAt: 0 };
  const d = width - last.width;
  if (d === 0) return null;
  if (d > 0 && d <= SCROLLBAR_BOUNCE_PX && now - last.shrunkAt < SCROLLBAR_BOUNCE_MS) return null;
  return { width, viewport, shrunkAt: d < 0 && -d <= SCROLLBAR_BOUNCE_PX ? now : 0 };
}

/** The shell menu, narrowest first: a 10 px strip, the 72 px icon rail, the 256 px column. */
export type NavState = "closed" | "icons" | "full";
const NAV_ORDER: readonly NavState[] = ["closed", "icons", "full"];
const isNav = (v: string | null): v is NavState => NAV_ORDER.includes(v as NavState);

/** The widest menu a window `width` px wide fits: the full column from 1360 px, the icon
 *  rail from 1180 px (README §2: derived from the grid's minimum widths). JS only: the
 *  shell sets a root class from it, so no CSS repeats these numbers. */
export function widestNav(width: number): NavState {
  return width >= 1360 ? "full" : width >= 1180 ? "icons" : "closed";
}

/** The menu shown: the user's `pick` while the window still fits it (a narrower pick
 *  always does), else the `widest` that fits. */
export function navFor(widest: NavState, pick: NavState | null): NavState {
  return pick && NAV_ORDER.indexOf(pick) <= NAV_ORDER.indexOf(widest) ? pick : widest;
}

/** The stored pick: the `ek-nav` value, else the old `ek-menu-collapsed` "1" as icons. */
export function readStoredNav(raw: string | null, legacyCollapsed: string | null): NavState | null {
  if (isNav(raw)) return raw;
  return legacyCollapsed === "1" ? "icons" : null;
}
