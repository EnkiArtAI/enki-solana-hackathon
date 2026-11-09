import { varNames } from "@/lib/editor/prompt-tokens";
import type { EditorSetup } from "@/lib/editor/generate-checks";
import { sessionAuthHeaders } from "@/lib/session-headers";
import type { Job } from "@/lib/ui/kit/render-queue";
import type { ShareStyle } from "./doc";
import { parseStyle, styleRefs, withPictures } from "./style";

/**
 * The share a release offers. A release opens the prompt's page (Kev, 2026-10-13)
 * and clears its editor; the offer outlives both here, and the shell's ShareHost
 * shows it over that page.
 */
export type ShareOffer = { promptId: string; values: Record<string, string>[]; styleOnly?: boolean };

let offer: ShareOffer | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function offerShare(promptId: string, values: Record<string, string>[]): void {
  offer = { promptId, values };
  emit();
}

/** Edit profile's way in: the editor alone, for the style itself, with no share at its end. */
export function offerStyleEditor(): void {
  offer = { promptId: "", values: [], styleOnly: true };
  emit();
}

export function dismissShare(): void {
  if (!offer) return;
  offer = null;
  emit();
}

export function subscribeShare(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const shareOffer = (): ShareOffer | null => offer;

export type { ShareStyle };

/** The creator's own style, for this tab: first in the popup, for every prompt until the tab closes. */
let style: ShareStyle = {}, owner: string | null | undefined, told = false;

export const yourStyle = (): ShareStyle => style;

export function keepStyle(part: ShareStyle): void {
  style = { ...style, ...part };
}

// A read that hangs holds the popup: its templates are never to wait long for a style.
const READ_MS = 5_000;
const readJson = (url: string) =>
  fetch(url, { headers: sessionAuthHeaders(), signal: AbortSignal.timeout(READ_MS) }).then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))));

/**
 * The style a popup opens with: the account's, what this tab kept standing over
 * it (SQL 71 not run, or a save that failed), each picture at the address it has
 * now. Never rejects, and a failure means less style, never less Share. Another
 * account in this tab starts empty.
 */
export async function loadStyle(me: string | null | undefined): Promise<ShareStyle> {
  if (me !== owner) {
    owner = me;
    style = {};
    told = false;
  }
  const kept = await readJson("/api/users/share-style").then((body: { style?: unknown }) => parseStyle(body.style), () => null);
  style = { ...kept, ...style };
  if (!styleRefs(style).length) return style;
  try {
    const { references } = (await readJson("/api/references")) as { references: { id: string; url: string }[] };
    style = withPictures(style, new Map(references.map((r) => [r.id, r.url])));
    return style;
  } catch {
    return {};
  }
}

/** Done's part on the account, which keeps the other parts. An address stays home: it is good for an hour. Whether the account took it. */
export const saveStyle = (part: ShareStyle): Promise<boolean> =>
  fetch("/api/users/share-style", {
    method: "PUT",
    keepalive: true,
    headers: { ...sessionAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(part, (key, value) => (key === "src" ? undefined : value)),
  }).then((res) => res.ok, () => false);

/** True the first time this tab could not save a style: the page says so once. */
export const firstMiss = (): boolean => !told && (told = true);

/**
 * Per image the release keeps (its first four rendered ones, as the server
 * does), the values it was made with by variable name: an image made from an
 * older text may hold other names at the same places. Never the text itself.
 */
export function imageValues(jobs: Job<EditorSetup>[]): Record<string, string>[] {
  return jobs
    .filter((j) => (j.imageUrl ?? "").startsWith("https://"))
    .slice(0, 4)
    .map((j) => Object.fromEntries(varNames(j.setup.prompt).map((name) => [name, j.setup.vars[name] ?? ""])));
}
