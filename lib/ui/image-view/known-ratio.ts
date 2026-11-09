/**
 * A picture's own ratio once any image of it has loaded (the hero's, or a
 * tile's of the strip or the History), by shot key. The phone's hero takes
 * its picture's shape (DEC-384) and its slide remounts on every pick, so a
 * pick of a picture already seen as a tile draws at its shape at once instead
 * of square first (review 2026-10-26). Module level: it outlives the slide.
 */
const ratios = new Map<string, number>();

/** A picture's key: its address, so prompts whose shots share a key (example:0) never share a shape (review 2026-10-26). */
export const ratioKey = (s: { key: string; src?: string | null }) => s.src || s.key;

export function rememberRatio(key: string, width: number, height: number): void {
  if (width > 0 && height > 0) ratios.set(key, width / height);
}

export const knownRatio = (key: string): number | undefined => ratios.get(key);
