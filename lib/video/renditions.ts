/**
 * The files of one video, as prompts.showcase_video and generated_images.video hold them (SQL 52). `preview` is the silent
 * feed loop; `v720` and `v1080` are the only files with sound, and the feed never loads them; `poster` is what every
 * picture surface shows (a video prompt's showcase_images holds it). Measured 2026-11-03: 386,402 and 405,495 B for 6 s at
 * 480 px, crf 32, against 208,608 and 258,607 B a second for v720 (DEC-2026-11-03-66). v1080 is null where the source has none.
 */
export interface VideoRenditions {
  preview: string;
  v720: string;
  v1080: string | null;
  poster: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

type Rec = Record<string, unknown>;
const https = (v: unknown) => (typeof v === "string" && /^https:\/\/\S+$/i.test(v.trim()) ? v.trim() : null);
const positive = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** The stored object as a card may use it: https addresses only, and null without the three files a card needs. */
export function videoRenditions(raw: unknown): VideoRenditions | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Rec;
  const [preview, v720, poster] = [https(r.preview), https(r.v720), https(r.poster)];
  if (!preview || !v720 || !poster) return null;
  return { preview, v720, v1080: https(r.v1080), poster, width: positive(r.width), height: positive(r.height), durationMs: positive(r.durationMs) };
}
