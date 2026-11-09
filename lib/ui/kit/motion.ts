/**
 * Less motion (Kev, 2026-11-08: the Settings mock v64's App area, "Less motion · Fewer slides and fades."). This device's
 * choice, as the theme and the notices' seconds are (render-notices). On, <html> carries LESS_MOTION_CLASS and
 * app/globals.css cuts every transition and animation to an instant; the system's reduce-motion setting keeps its own rules.
 */
export const LESS_MOTION_CLASS = "ek-less-motion";
const KEY = "enki:less-motion";
// What this visit chose: a browser that refuses the storage (a private window) still keeps it until the reload.
let chosen: boolean | null = null;
const listeners = new Set<() => void>();

export function lessMotion(): boolean {
  if (chosen !== null) return chosen;
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** The page as the choice stands; the providers run it once at boot. */
export function applyLessMotion(): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(LESS_MOTION_CLASS, lessMotion());
}

export function setLessMotion(on: boolean): void {
  chosen = on;
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* kept for this visit only */ }
  applyLessMotion();
  listeners.forEach((l) => l());
}

export function subscribeLessMotion(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
