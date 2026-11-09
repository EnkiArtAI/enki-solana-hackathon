/**
 * The photo zoom (plan B12, handoff S:265-268): an own photo grows out of its
 * tile to its own size over the Image View, and shrinks back on close.
 */

/** A rect as getBoundingClientRect() gives it; a DOMRect fits. */
export interface Rect { left: number; top: number; width: number; height: number }

/** The square's side in a frame w × h: 40 px clear of the sides, 140 px of the height, at most 350 (phone) or 560. */
export const zoomSide = (w: number, h: number, phone: boolean) =>
  Math.round(Math.min(w - 40, h - 140, phone ? 350 : 560));

/** How far a photo shown at its own size stays clear of the frame's edges. */
export const ZOOM_MARGIN = { phone: 12, desktop: 24 };

/**
 * The photo, centred, in the frame's own coordinates, in its own shape (Kev, 2026-10-29: "i want to see the images in
 * its correct size ... up to vollbild natürlich"): at its own size, never larger than the frame holds, and never smaller
 * than the square it opened as before (a 24 px NFT would shrink below its card, review 2026-10-29). Before its size is
 * known, or when it cannot be read, the square.
 */
export function zoomBox(frame: Pick<Rect, "width" | "height">, phone: boolean, size?: { width: number; height: number }): Rect {
  const m = 2 * (phone ? ZOOM_MARGIN.phone : ZOOM_MARGIN.desktop);
  const side = zoomSide(frame.width, frame.height, phone);
  const fit = size ? Math.min((frame.width - m) / size.width, (frame.height - m) / size.height) : 0;
  const s = size ? Math.min(fit, Math.max(1, side / Math.max(size.width, size.height))) : 0;
  const [width, height] = size ? [Math.round(size.width * s), Math.round(size.height * s)] : [side, side];
  return { left: Math.round((frame.width - width) / 2), top: Math.round((frame.height - height) / 2), width, height };
}

/**
 * The transform (origin 0 0) that lays the photo over the tile it grows from, covering it as the tile's own crop does,
 * centre on centre; the open state is `none`. Both rects are on screen, as measured.
 */
export function growFrom(frame: Rect, tile: Rect, box: Rect): string {
  const s = Math.max(tile.width / box.width, tile.height / box.height);
  const x = tile.left + tile.width / 2 - frame.left - box.left - (box.width * s) / 2;
  const y = tile.top + tile.height / 2 - frame.top - box.top - (box.height * s) / 2;
  return `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${s.toFixed(3)})`;
}
