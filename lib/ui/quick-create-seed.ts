/**
 * Recreate from the gallery (Kev, 2026-10-15): a render made in Quick Create
 * comes back there as it was made. The gallery leaves the seed here and raises
 * the event; the launcher takes it once, on the event or on its next mount
 * (the profile panel closes to Home, where the launcher lives).
 */
export const QUICK_CREATE_EVENT = "enki:quick-create";
const KEY = "enki:quick-create-seed";

export interface QuickCreateSeed {
  prompt: string;
  modelId?: string | null;
  aspectRatio?: string | null;
  resolution?: string | null;
  references?: string[];
}

export function leaveQuickCreateSeed(seed: QuickCreateSeed): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(seed)); } catch { /* no storage: the event alone has to do */ }
  window.dispatchEvent(new CustomEvent(QUICK_CREATE_EVENT, { detail: seed }));
}

/** The seed left for the launcher, taken once; null when there is none. */
export function takeQuickCreateSeed(): QuickCreateSeed | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const seed = JSON.parse(raw) as QuickCreateSeed;
    return typeof seed?.prompt === "string" ? seed : null;
  } catch {
    return null;
  }
}
