/**
 * The open Image View is in the address as ?prompt=<id>, so a reload stays on
 * the image instead of dropping the reader on the feed (Kev, 2026-10-13). The
 * view writes it while it is open and takes it away when it closes; the feed
 * opens it again on arrival.
 */
const PARAM = "prompt";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The prompt an address asks to open, or null: only an id, never anything else a link could carry. */
export function linkedPrompt(search: string | { get(name: string): string | null }): string | null {
  const id = (typeof search === "string" ? new URLSearchParams(search) : search).get(PARAM);
  return id && UUID.test(id) ? id : null;
}

/** Where a prompt opens: the feed with its view over it, beside the shell's menu. Every link to a prompt goes here. */
export const promptPage = (id: string) => `/home?${PARAM}=${encodeURIComponent(id)}`;

/* The prompts a mounted view shows, counted. A view opened over a panel (a profile's Released, Likes, Bookmarks) writes
   its prompt into the address too, and the feed under the panel opened a second view of it, which stayed when the
   first one's Back closed it (DEC-461). */
const shown = new Map<string, number>();

/** A mounted view shows this prompt: the feed opens no copy of it. */
export const showing = (id: string) => (shown.get(id) ?? 0) > 0;

/** Counts a view as showing `id` until the returned release. */
export function holdShown(id: string): () => void {
  shown.set(id, (shown.get(id) ?? 0) + 1);
  return () => {
    const left = (shown.get(id) ?? 1) - 1;
    if (left > 0) shown.set(id, left);
    else shown.delete(id);
  };
}

/** The same address with the open prompt set, or taken away; every other part of it stays. */
export function promptLink(href: string, id: string | null): string {
  const url = new URL(href);
  if (id) url.searchParams.set(PARAM, id);
  else url.searchParams.delete(PARAM);
  return url.pathname + url.search + url.hash;
}
