"use client";

import { useEffect, type ReactNode } from "react";
import { Icon } from "./icons";

/**
 * Standalone right-side menu panel. It appears (fades in — no slide) over the
 * main area, leaving the left menu fully usable, and closes with the X or Esc.
 * Hosts the existing page/components so every menu item shows on the right.
 */
export default function EnkiPanel({ title, onClose, children, full, hideClose }: { title: string; onClose: () => void; children: ReactNode; full?: boolean; hideClose?: boolean }) {
  useEffect(() => {
    // The bottom layer: an Esc a dialog on top already used (Radix marks it) stays that dialog's (Kev, 2026-11-02: only the top layer closes).
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className={"ek-panel-scrim" + (full ? " ek-panel-scrim--full" : "")} onClick={onClose}>
      <aside className={"ek-panel" + (full ? " ek-panel--full" : "")} onClick={(e) => e.stopPropagation()}>
        {/* No title bar — each panel brings its own serif headline; an arrow at
            its top left, above the headline, closes the panel (Kev, 2026-10-27:
            "statt X auf der rechten seite, pack doch einfach nen pfeil oben links
            rein"; DEC-468). It takes its own line, so it covers nothing, also on
            the desktop's Hall of Fame, where the X did (Kev, 2026-08-24).
            hideClose drops it where the panel has its own Back — ESC, scrim
            click and the menu still close the panel. */}
        <div className="ek-panel-body">
          {!hideClose && (
            <button type="button" className="ek-panel-back kit-hit ek-tuck-hide" onClick={onClose} aria-label={`Close ${title}`} title="Back">
              <Icon name="chevronLeft" size={20} stroke={2} />
            </button>
          )}
          {children}
        </div>
      </aside>
    </div>
  );
}
