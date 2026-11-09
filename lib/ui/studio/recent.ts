import { MAX_PROJECTS } from "@/lib/studio/types";

/**
 * This browser's picks for the menu's Studio submenu: open or closed, and the projects opened last, first. Per viewer
 * conveniences only, so every read and write is in try/catch and an unreadable store means closed and no order.
 */
export const OPEN_KEY = "ek-studio-open";
export const RECENT_KEY = "ek-studio-recent";

export function readOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
}
export function writeOpen(open: boolean): void {
  try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch { /* this visit only */ }
}

export function readRecent(): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}
/** `id` first, each once, no more than an account can have. */
export function rememberRecent(id: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((r) => r !== id)].slice(0, MAX_PROJECTS))); } catch { /* none kept */ }
}

/** The projects opened last first, in that order, then the rest as the server sent them (newest first). */
export function byRecent<T extends { id: string }>(projects: readonly T[], recent: readonly string[]): T[] {
  const at = (p: T) => { const i = recent.indexOf(p.id); return i < 0 ? recent.length : i; };
  return projects.map((p, i) => ({ p, i })).sort((a, b) => at(a.p) - at(b.p) || a.i - b.i).map(({ p }) => p);
}
