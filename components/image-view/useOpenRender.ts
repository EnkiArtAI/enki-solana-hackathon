"use client";

import { useEffect, useEffectEvent, type RefObject } from "react";
import { clearWantedRender, OPEN_RENDER_EVENT, wantedRender, type OpenRender } from "@/lib/ui/kit/render-notices";
import { pollWhile } from "./useOwnRenders";
import type { ImageViewModel, Shot } from "./useImageViewModel";

/** A render as its notice names it: the address the render returned, the stage's preview or the stored original. */
const same = (s: Shot, src: string) => s.src === src || s.original === src;

/**
 * A finished render's notice (RenderNotices) opens it here (Kev, 2026-10-26):
 * a click while this view shows its prompt, or the render a notice opened
 * this prompt's page for, as soon as it stands among the finished images.
 * Only while the view can be seen (not behind a shell panel). The stage's
 * Open takes the focus first, so the viewer gives it back there, where the
 * render then stands.
 */
export function useOpenRender(m: ImageViewModel, open: (s: Shot) => void, root: RefObject<HTMLElement | null>) {
  const shown = () => !!root.current && getComputedStyle(root.current).visibility !== "hidden";
  const show = (s: Shot) => {
    // An open viewer keeps the focus inside it (it only turns to this render), or its Esc would close the whole view.
    const inViewer = document.querySelector<HTMLElement>(".kit-viewer .kit-viewer-x");
    (inViewer ?? root.current?.querySelector<HTMLElement>(".iv-open"))?.focus({ preventScroll: true });
    open(s);
  };
  const take = useEffectEvent((e: Event) => {
    // One view takes it: another visible view of the same prompt (a feed and a profile) leaves it be.
    if (e.defaultPrevented) return;
    const { promptId, src } = (e as CustomEvent<OpenRender>).detail;
    const s = promptId === m.promptId && shown() ? m.finished.find((x) => same(x, src)) : undefined;
    if (!s) return;
    e.preventDefault();
    show(s);
  });
  useEffect(() => {
    const listen = (e: Event) => take(e);
    window.addEventListener(OPEN_RENDER_EVENT, listen);
    return () => window.removeEventListener(OPEN_RENDER_EVENT, listen);
  }, []);
  // The render a notice opened this page for: read, and cleared only when it opens, so a double effect never loses it.
  const wanted = wantedRender(m.promptId);
  const found = wanted ? m.finished.find((x) => same(x, wanted)) : undefined;
  useEffect(() => {
    // Still wanted now: a second run of this effect (React runs effects twice in development) opens nothing more.
    if (!found || !shown() || !wantedRender(m.promptId)) return;
    clearWantedRender();
    show(found);
  });
  // Not in the History yet (its row may be written a moment after the image came back): ask again every 3 s.
  const reread = useEffectEvent(() => m.historyState.retry());
  const missing = !!wanted && !found;
  useEffect(() => (missing ? pollWhile(() => reread()) : undefined), [missing]);
}
