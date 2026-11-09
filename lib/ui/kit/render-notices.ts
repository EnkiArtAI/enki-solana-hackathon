/**
 * Finished renders to announce wherever the reader is on the site (Kev,
 * 2026-10-26: "die benachrichtigung soll bitte immer kommen, wenn ein bild
 * fertig generiert wurde und ich iwo anders auf der seite bin"). A render's
 * request outlives the Image View that sent it, so its outcome lands here and
 * the shell's RenderNotices shows it. Newest first, three at most.
 */
export type RenderNotice = {
  /** The job's key in its Image View (`job:<id>`). */
  key: string;
  /** The image as the render returned it. */
  src: string;
  /** Its prompt; null for the blank composer. */
  promptId: string | null;
  /** The prompt's title, or the blank composer's. */
  title: string;
};

const MAX = 3;
let notices: RenderNotice[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function announceRender(n: RenderNotice): void {
  notices = [n, ...notices.filter((x) => x.key !== n.key)].slice(0, MAX);
  emit();
}

export function dismissRender(key: string): void {
  const next = notices.filter((x) => x.key !== key);
  if (next.length === notices.length) return;
  notices = next;
  emit();
}

/** The notices go with the page that shows them: a sign-out's wall never shows the account's renders. */
export function clearRenders(): void {
  notices = [];
  wanted = null;
  emit();
}

export function subscribeRenders(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const renderNotices = (): RenderNotice[] => notices;

/**
 * How long a notice stays in sight before it goes by itself, as the reader
 * set it in Settings → Profile (Kev, 2026-10-26: "lass es nach 5s
 * verschwinden. brauchen in Profil die Einstellung für den Sekundentimer");
 * 0 keeps it until it is closed. This device's choice, as the theme is.
 */
export const NOTICE_SECONDS = [3, 5, 10, 0] as const;
export type NoticeSeconds = (typeof NOTICE_SECONDS)[number];
export const DEFAULT_NOTICE_SECONDS: NoticeSeconds = 5;
const SECONDS_KEY = "enki:notice-seconds";
// What this visit chose: a browser that refuses the storage (a private window) still keeps it until the reload.
let chosen: NoticeSeconds | null = null;
const secondsListeners = new Set<() => void>();

export function noticeSeconds(): NoticeSeconds {
  if (chosen !== null) return chosen;
  try {
    const stored = localStorage.getItem(SECONDS_KEY);
    const n = NOTICE_SECONDS.find((s) => String(s) === stored);
    return n ?? DEFAULT_NOTICE_SECONDS;
  } catch {
    return DEFAULT_NOTICE_SECONDS;
  }
}

export function setNoticeSeconds(s: NoticeSeconds): void {
  chosen = s;
  try { localStorage.setItem(SECONDS_KEY, String(s)); } catch { /* kept for this visit only */ }
  secondsListeners.forEach((l) => l());
}

export function subscribeNoticeSeconds(listener: () => void): () => void {
  secondsListeners.add(listener);
  return () => { secondsListeners.delete(listener); };
}

/**
 * A click on a notice asks the Image View that shows its prompt to open the
 * render in its viewer; a view that takes it calls preventDefault. Nobody
 * took it: the prompt's page opens, and its view opens the render once it
 * stands in its History (wantedRender, cleared when it opens).
 */
export const OPEN_RENDER_EVENT = "enki:open-render";
export type OpenRender = { promptId: string | null; src: string };

/** How long a page waits for the render a notice opened it for; past that a later visit is never hijacked. */
export const WANT_MS = 60_000;
let wanted: { promptId: string; src: string; at: number } | null = null;

export function wantRender(promptId: string, src: string): void {
  wanted = { promptId, src, at: Date.now() };
}

/** The render a notice opened this prompt's page for, while it waits (a minute at most). */
export const wantedRender = (promptId: string | null): string | null =>
  promptId && wanted?.promptId === promptId && Date.now() - wanted.at < WANT_MS ? wanted.src : null;

export function clearWantedRender(): void {
  wanted = null;
}
