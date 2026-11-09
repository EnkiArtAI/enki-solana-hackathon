/**
 * The largest font size, in half pixels, whose text height fits `room`:
 * between `min` (also when nothing fits) and `max`. `height(px)` measures the
 * text at that size; it grows with the size, which a binary search needs.
 * A short prompt's words fill the room down to the agent row this way
 * (Kev, 2026-10-21).
 */
export function fitFont(height: (px: number) => number, room: number, min: number, max: number): number {
  if (height(min) >= room) return min;
  if (height(max) <= room) return max;
  // Counted in half pixels: lo fits, hi does not.
  let lo = min * 2, hi = max * 2;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (height(mid / 2) <= room) lo = mid;
    else hi = mid;
  }
  return lo / 2;
}
