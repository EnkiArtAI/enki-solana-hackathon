import { tenths } from "./price";

/** What a remix takes: one MP4 or MOV clip of 4 to 15 s, at most 200 MB, and 1 to 8 PNG, JPEG or WebP photos. */
export const CLIP_TYPES: readonly string[] = ["video/mp4", "video/quicktime"];
export const CLIP_MAX_BYTES = 200 * 1024 * 1024;
export const PHOTO_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
export const MAX_PHOTOS = 8;
const MIN_TENTHS = 40;
const MAX_TENTHS = 150;

type Picked = { type: string; name: string; size: number };

/** The clip's length as shown on it: "7.4 s". */
export const lengthLabel = (seconds: number) => `${(tenths(seconds) / 10).toFixed(1)} s`;

/** Why a picked file cannot be the clip, before it is read; null when it can. A drop without a type goes by its name. */
export function clipFileRefusal(file: Picked): string | null {
  const known = file.type ? CLIP_TYPES.includes(file.type) : /\.(mp4|mov)$/i.test(file.name);
  if (!known) return "Pick an MP4 or MOV video.";
  if (file.size > CLIP_MAX_BYTES) return "This video is over 200 MB. Pick a smaller one.";
  return null;
}

/** Why a clip this long cannot be remixed; null from 4 to 15 s, counted in the tenths it shows. */
export function clipLengthRefusal(seconds: number): string | null {
  const t = tenths(seconds);
  return t < MIN_TENTHS || t > MAX_TENTHS ? `This clip is ${lengthLabel(seconds)} long. Pick one of 4 to 15 seconds.` : null;
}

/** The photos that fit beside the `have` already in, and what was left out, in a sentence. */
export function takePhotos<F extends Picked>(files: readonly F[], have: number): { take: F[]; why: string | null } {
  const typed = files.filter((f) => PHOTO_TYPES.includes(f.type));
  const take = typed.slice(0, Math.max(0, MAX_PHOTOS - have));
  const why = typed.length < files.length ? "Only PNG, JPEG or WebP photos."
    : take.length < typed.length ? `At most ${MAX_PHOTOS} photos: ${typed.length - take.length} left out.` : null;
  return { take, why };
}

/**
 * The clip's length from its metadata, read in the browser; rejects when it cannot be read as a video. A file whose
 * header carries no length (a fragmented MP4, a screen recording) reports Infinity until it is sought to its end;
 * one that never says gives up after 10 s.
 */
export function readSeconds(src: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    const done = () => {
      clearTimeout(late);
      v.onloadedmetadata = v.ondurationchange = v.onerror = null;
      const d = v.duration;
      v.removeAttribute("src");
      v.load();
      if (Number.isFinite(d) && d > 0) resolve(d);
      else reject(new Error("no length"));
    };
    const late = setTimeout(done, 10_000);
    v.preload = "metadata";
    v.muted = true;
    v.onerror = done;
    v.onloadedmetadata = () => {
      if (v.duration !== Infinity) return done();
      v.ondurationchange = () => { if (v.duration !== Infinity) done(); };
      v.currentTime = Number.MAX_SAFE_INTEGER;
    };
    v.src = src;
  });
}
