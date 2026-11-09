/**
 * What a running render shows while it paints (plan B6, B11). No provider
 * reports progress yet, so the bar is filled by the clock, and no "N s left"
 * goes with it until BE8 serves real numbers (plan §8 #6).
 */

/** The fill never passes this before the job resolves: a slow render waits near 90 %, never at a full bar that lies. */
const CAP = 0.9;

/** The render time assumed when none is given (0, negative, NaN, Infinity): 30 s, a guess until BE8 serves the median `generation_ms` per model. */
const EXPECTED_MS = 30_000;

/**
 * The bar's fill, 0..1, `elapsedMs` after the press: 0 at the press, rising
 * fast and then ever slower toward 90 % (78 % at `expectedMs`, 88 % at twice
 * it), and 1 once the job has resolved. It never falls as time passes, and a
 * clock behind the press reads 0.
 */
export function renderProgress(elapsedMs: number, expectedMs: number, resolved = false): number {
  if (resolved) return 1;
  const expected = expectedMs > 0 && Number.isFinite(expectedMs) ? expectedMs : EXPECTED_MS;
  const t = elapsedMs > 0 ? elapsedMs : 0;
  return CAP * (1 - Math.exp((-2 * t) / expected));
}

/** The Generate button's busy label and the wait screen's title (S:544): a batch is never told the singular (D32). */
export const paintingLabel = (count: number) => (count > 1 ? `Painting ${count} portraits…` : "Painting your portrait…");
