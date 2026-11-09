/**
 * An image opened large counts once per browser and UTC day (Kev, 2026-10-29: views by day for posts). The ids go
 * out batched, one call every few seconds, with keepalive so a tab closed right after still reports. The day's ids
 * sit in localStorage; a browser that refuses it keeps them for the page's life. The server counts only public
 * renders that are not the viewer's own (count_image_opens, 2026-10-29-view-days.sql) and dedupes again per viewer.
 */
const KEY = "enki:opened-images";
const FLUSH_MS = 3_000;

let memory: { day: string; ids: string[] } | null = null;
const queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

const today = () => new Date().toISOString().slice(0, 10);

function load(): { day: string; ids: string[] } {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as { day?: unknown; ids?: unknown }) : null;
    if (parsed && typeof parsed.day === "string" && Array.isArray(parsed.ids)) return { day: parsed.day, ids: parsed.ids.filter((x): x is string => typeof x === "string") };
  } catch { /* no storage: the memory copy below */ }
  return memory ?? { day: today(), ids: [] };
}

function save(seen: { day: string; ids: string[] }): void {
  memory = seen;
  try { localStorage.setItem(KEY, JSON.stringify(seen)); } catch { /* kept in memory only */ }
}

/** Sends what is queued now; called by the timer, exported for tests and page hides. */
export function flushImageOpens(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (queue.size === 0) return;
  const ids = [...queue];
  queue.clear();
  void fetch("/api/images/views", {
    method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }),
  }).catch(() => {});
}

/** Marks a public image as opened large by this browser; the first time today counts. */
export function countImageOpen(id: string | null | undefined): void {
  if (!id) return;
  let seen = load();
  if (seen.day !== today()) seen = { day: today(), ids: [] };
  if (seen.ids.includes(id)) return;
  save({ day: seen.day, ids: [...seen.ids, id] });
  queue.add(id);
  if (!timer) timer = setTimeout(flushImageOpens, FLUSH_MS);
}
