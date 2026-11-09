"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeMenu } from "@/lib/ui/kit/controls";
import "@/components/kit/kit-controls.css";

/** The rows a menu can take the focus on; a dimmed row too, which says why on a press (ARIA keeps them focusable). */
const ROWS = "button:not(:disabled), input:not(:disabled), a[href]";

/**
 * A picture's ⋯ menu as a popover (a pointer, from 1024 px; below it the tile opens the kit's BottomSheet): the kit's
 * menu panel, portaled and fixed under what opened it, right-aligned to it and inside the window, placed again as its
 * page changes. Its first row takes the focus, and again on each new page; a press outside it, Esc, a scroll outside
 * it or a resize closes it (the kit's single-pick rule, panel-pos.ts), and the opener takes the focus back (TileActions).
 * A press on the opener is left to the opener, which toggles.
 */
export default function TileMenu({ anchor, label, page, onClose, children }: {
  anchor: DOMRect;
  label: string;
  /** What the menu shows now: a new page takes the focus to its first row. */
  page: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useEffectEvent(onClose);

  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const at = placeMenu(
      { left: anchor.right - el.offsetWidth, top: anchor.top, bottom: anchor.bottom },
      { width: el.offsetWidth, height: el.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    Object.assign(el.style, {
      left: `${at.left}px`,
      top: at.top === undefined ? "" : `${at.top}px`,
      bottom: at.bottom === undefined ? "" : `${at.bottom}px`,
      maxHeight: `${at.maxHeight}px`,
    });
  });

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(ROWS)?.focus({ preventScroll: true });
  }, [page]);

  useEffect(() => {
    const opener = (e: PointerEvent) => e.clientX >= anchor.left && e.clientX <= anchor.right && e.clientY >= anchor.top && e.clientY <= anchor.bottom;
    const down = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !opener(e)) close(); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    const scrolled = (e: Event) => { if (!panel.current?.contains(e.target as Node)) close(); };
    const resized = () => close();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", resized);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", resized);
    };
  }, [anchor]);

  return createPortal(
    <div ref={panel} className="kit-menu-panel kit-focus ci-menu" role="dialog" aria-label={label} style={{ position: "fixed", overflowY: "auto" }}>
      {children}
    </div>,
    document.body,
  );
}
