/**
 * The desktop Image View's History strip and the Easy photo area's height, in
 * px, as the v2 prototype sets them (handoff "Enki Prompt Studio v2", S:597,
 * S:172). The hooks measure; these only decide.
 */

/** The History strip and its 14 px gap beside the hero: 78 while open, 40 while folded, 0 without one. */
export const stripWidth = (hasHistory: boolean, historyOpen: boolean) => (hasHistory ? (historyOpen ? 78 : 40) : 0);

/** What the variables leave free, kept within 88-520 on desktop and 72-460 on a phone, in whole px. */
export const deckHeight = (free: number, mobile: boolean) =>
  Math.round(Math.max(mobile ? 72 : 88, Math.min(mobile ? 460 : 520, free)));
