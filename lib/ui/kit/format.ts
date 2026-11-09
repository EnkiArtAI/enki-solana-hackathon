/** Small text helpers of the Image View: times, file names, avatar letters. */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * How long ago `at` was, against an injected `now` (never read in render).
 *   short (comments): now · 5m · 2h · 1d · 3w
 *   long (history):   just now · 5m ago · 2h ago · yesterday · 3d ago · 3w ago
 * From five weeks on, both give the date ("Aug 9"), with the year when it is not this year.
 */
export function formatAgo(at: string | number, now: number, style: "short" | "long" = "long"): string {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return "";
  const ms = now - t;
  const short = style === "short";
  if (ms >= 5 * WEEK) {
    const d = new Date(t);
    const year = d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year });
  }
  const ago = (unit: number, mark: string) => `${Math.floor(ms / unit)}${mark}${short ? "" : " ago"}`;
  if (ms < MIN) return short ? "now" : "just now";
  if (ms < HOUR) return ago(MIN, "m");
  if (ms < DAY) return ago(HOUR, "h");
  if (ms < 2 * DAY && !short) return "yesterday";
  if (ms < WEEK) return ago(DAY, "d");
  return ago(WEEK, "w");
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** "enki-misty-harbor-1792100285989_r22xj00.webp": our prefix, the title's
 *  slug, the file's own id and the extension its type names (webp otherwise).
 *  Two downloads share a name only when they are the same file (Kev,
 *  2026-10-16: saving images must never collide). A title that already starts
 *  with "enki" ("enki-k7q2xm3a", a prompt made on the side) gives the prefix once. */
export function downloadName(title: string, id: string, mime: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^enki(-|$)/, "");
  return `enki-${slug ? `${slug}-` : ""}${id}.${EXT[mime] ?? "webp"}`;
}

/** What names a stored file: the blob's own name ("1792100285989_r22xj00", unique per file; derivative-store), else a stamp of this moment. */
export function fileId(url: string): string {
  const name = /^https?:/i.test(url) ? (url.split(/[?#]/)[0].split("/").pop() ?? "").split(".")[0].replace(/[^a-z0-9_-]/gi, "") : "";
  return name.length >= 8 ? name : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
