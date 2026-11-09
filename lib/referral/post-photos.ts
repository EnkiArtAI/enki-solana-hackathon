import { createHash } from "node:crypto";
import { putDurably } from "@/lib/generation/derivative-store";
import { tryMakeDerivatives } from "@/lib/imageDerivatives";

/**
 * The pictures of a referred post: read from X's CDN, judged on their bytes
 * at the preview, and stored as the prompt's showcase when it is published,
 * bound by their hash to the bytes that were judged (Kev, 2026-10-14: the
 * post's images are "pulled into Image UI", not references).
 */

/** The most bytes one picture may weigh; X serves originals up to about 5 MB. */
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
export const USER_AGENT = "Enki/1.0 (+https://enki.gallery)";

export const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

export const photoExt = (contentType: string): string =>
  contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";

/** A picture as bytes, or null: not an image, too big, gone, or slow. */
export async function downloadPhoto(url: string, fetchFn: typeof fetch = fetch): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    const res = await fetchFn(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) return null;
    if (Number(res.headers.get("content-length") ?? 0) > PHOTO_MAX_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > PHOTO_MAX_BYTES) return null;
    return { buf, contentType };
  } catch {
    return null;
  }
}

/** A judged picture as stored: the original, its WebP renditions (null when they could not be made), and its facts. */
export interface StoredPhoto {
  url: string;
  previewUrl: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  mimeType: string;
  bytes: number;
}

/**
 * The judged pictures stored under the account, in order, each with its preview and thumb WebP (Kev, 2026-08-23:
 * "webp auf allen images die angezeigt werden"; 2026-10-30: imported pictures become Enki images). null when one
 * cannot be read again, is not the bytes that were judged, or cannot be stored; then nothing is published. The
 * renditions are optional, as at a render (lib/generation/derivative-store storeGeneratedImage): within the same 20 s.
 */
export async function storeImportedPhotoSet(
  photos: { url: string; sha256: string }[],
  userId: string,
  fetchFn: typeof fetch = fetch,
): Promise<StoredPhoto[] | null> {
  const deadline = Date.now() + 20_000;
  const stored = await Promise.all(photos.map(async (photo, i): Promise<StoredPhoto | null> => {
    const got = await downloadPhoto(photo.url, fetchFn);
    if (!got || sha256(got.buf) !== photo.sha256) return null;
    const base = `showcase/${userId}/imported_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 9)}`;
    const [url, derived] = await Promise.all([putDurably(`${base}.${photoExt(got.contentType)}`, got.buf, got.contentType, deadline), tryMakeDerivatives(got.buf)]);
    if (!url) return null;
    const [previewUrl, thumbnailUrl] = derived
      ? await Promise.all([
          putDurably(`${base}.preview.webp`, derived.preview.buffer, "image/webp", deadline),
          putDurably(`${base}.thumb.webp`, derived.thumb.buffer, "image/webp", deadline),
        ])
      : [null, null];
    return { url, previewUrl, thumbnailUrl, width: derived?.width ?? null, height: derived?.height ?? null, mimeType: got.contentType, bytes: got.buf.length };
  }));
  return stored.every((p): p is StoredPhoto => p !== null) ? stored : null;
}
