/**
 * The hero's step for a key (Kev, 2026-10-21): ← the previous image, → the
 * next, as its arrows do; nothing while the key is typed into a field, held
 * with a modifier, meant for an open dialog, or the hero is not on screen.
 */
export function heroKey(key: string, o: { typing: boolean; modified: boolean; overlay: boolean; shown: boolean }): -1 | 0 | 1 {
  if (o.typing || o.modified || o.overlay || !o.shown) return 0;
  return key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
}
