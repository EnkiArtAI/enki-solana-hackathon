import sharp from "sharp";

/**
 * Preview and thumbnail renditions for a generated or uploaded image.
 *
 * The gallery was serving originals into every grid cell. Measured
 * 2026-08-06 against the real providers: a 2K image is 3.0 MB (Gemini, JPEG)
 * or 7.0 MB (WaveSpeed, PNG), and 4K reaches 8.8 MB and 21.1 MB. A grid of
 * twenty of those is a quarter-gigabyte for pictures shown at 300px.
 *
 * So one upload becomes three objects, the way Higgsfield and everyone else
 * does it:
 *   original   untouched, what the download button hands over
 *   preview    WebP ~2048px — what every surface shows, and what a
 *              right-click actually saves
 *   thumb      WebP ~384px — the grid
 *
 * ── Why 2048 at q90, and why effort 2 ───────────────────────────────────
 * The preview is what every surface shows; the original is for Download
 * alone (Kev, 2026-10-16: WebP everywhere, no quality loss). Measured on our
 * own 2K originals: 2048/q90 is 810-930 KB where the JPEG original is 2.9 MB
 * and the PNG 7.1 MB, encoded in 220-420 ms; 1280/q80 was 170-260 KB but
 * soft in fullscreen. Encode — not decode, not resize — is about 70% of the
 * CPU here, and sharp's default effort of 4 buys ~5% smaller files for ~40%
 * more CPU. On a 1-vCPU serverless function that trade is wrong, so effort
 * is pinned at 2.
 */

// One vCPU on Vercel, and concurrent invocations share it. libvips' cache is
// dead weight in a process that handles one image and exits.
sharp.concurrency(1);
sharp.cache(false);

export interface Derivative {
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
  contentType: "image/webp";
}

export interface Derivatives {
  preview: Derivative;
  thumb: Derivative;
  /** Dimensions of the ORIGINAL, measured while decoding it anyway. */
  width: number;
  height: number;
}

const PREVIEW_EDGE = 2048;
const THUMB_EDGE = 384;

async function encode(input: sharp.Sharp, edge: number, quality: number): Promise<Derivative> {
  const { data, info } = await input
    // `withoutEnlargement` so a small original is never upscaled into a
    // "preview" heavier than the thing it previews.
    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
    .webp({ quality, effort: 2 })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    width: info.width,
    height: info.height,
    bytes: data.length,
    contentType: "image/webp",
  };
}

/**
 * Decode once, branch twice. Two independent sharp pipelines would decode the
 * same multi-megabyte image twice for no reason.
 */
export async function makeDerivatives(original: Buffer): Promise<Derivatives> {
  const base = sharp(original, { failOn: "none" });
  const meta = await base.metadata();

  const [preview, thumb] = await Promise.all([
    encode(base.clone(), PREVIEW_EDGE, 90),
    encode(base.clone(), THUMB_EDGE, 75),
  ]);

  return { preview, thumb, width: meta.width ?? 0, height: meta.height ?? 0 };
}

/**
 * Same thing, but never throws. Derivatives are an optimisation: a corrupt or
 * exotic input must cost us the smaller renditions, not the upload itself.
 */
/** What an example image's stage shows, and its tile: 64 px tall, so 192 px holds three times that (Kev, 2026-11-02). */
const VIEW_EDGE = 1280;
const TINY_EDGE = 192;

export async function makeSmallRenditions(source: Buffer): Promise<{ view: Derivative; tiny: Derivative }> {
  const base = sharp(source, { failOn: "none" });
  const [view, tiny] = await Promise.all([encode(base.clone(), VIEW_EDGE, 80), encode(base.clone(), TINY_EDGE, 60)]);
  return { view, tiny };
}

export async function tryMakeDerivatives(original: Buffer): Promise<Derivatives | null> {
  try {
    return await makeDerivatives(original);
  } catch {
    return null;
  }
}
