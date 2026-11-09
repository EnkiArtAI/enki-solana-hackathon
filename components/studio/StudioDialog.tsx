"use client";

import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/enki-shell/icons";
import "./studio.css";

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Studio's popups (Kev, 2026-10-30: "ein großes popup zum eingeben von daten wie: Name, Description, Link"): the shell's
 * dimmed scrim, a 640 px card, its head (step marks, the serif title, the round ×), a body that scrolls, a foot that
 * stays (a quiet button left, the primary right). Full screen on a phone. Focus goes to the field marked
 * data-autofocus (else the first), Tab stays inside, Esc closes it alone, and the focus goes back to what opened it.
 * Keys are heard on the document as they go down to their target: after a menu, sheet or confirm inside it took its
 * own (on the window, first), before any layer under it hears them (an image view on the document, a panel on the
 * window; review 2026-10-30: one Esc closed the wizard and the character sheet's view under it).
 * Drawn on the page itself, so its scrim greys the menu too (Kev, 2026-10-30: "when clicking \"new content\" dann soll
 * ruhig die linke sidebar auch ausgegraut sein"): inside a panel, the panel scrim's backdrop-filter made it the frame
 * of the fixed scrim, which then began right of the menu. React still hands its events and context through the panel.
 */
export default function StudioDialog({ title, marks, foot, onClose, step, children }: {
  title: string;
  /** "1 Details · 2 Assets": where a two-step dialog stands. */
  marks?: ReactNode;
  foot: ReactNode;
  onClose: () => void;
  /** A step of a dialog of several: each one starts at its own first field, in the same frame. */
  step?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const close = useEffectEvent(onClose);
  // Pressed down on the scrim itself: a text selection let go outside the card does not close it.
  const downOnScrim = useRef(false);

  // What opened it, read before the focus moves in.
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const el = box.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const all = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!all.length) return;
      const i = all.indexOf(document.activeElement as HTMLElement);
      const edge = e.shiftKey ? i <= 0 : i === all.length - 1 || i < 0;
      if (!edge) return;
      e.preventDefault();
      all[e.shiftKey ? all.length - 1 : 0].focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const el = box.current;
    (el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE))?.focus({ preventScroll: true });
  }, [step]);

  const dialog = (
    <div className="ek-modal-scrim st-scrim"
      onPointerDown={(e) => { downOnScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnScrim.current && e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="st-dialog kit-focus" role="dialog" aria-modal="true" aria-labelledby={labelId}>
        <header className="st-dialog-head">
          <div className="st-dialog-titles">
            {marks && <p className="kit-label st-marks">{marks}</p>}
            <h2 id={labelId} className="kit-title st-dialog-title">{title}</h2>
          </div>
          <button type="button" className="ek-modal-x kit-hit" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={17} stroke={2} />
          </button>
        </header>
        <div className="st-dialog-body">{children}</div>
        <footer className="st-dialog-foot">{foot}</footer>
      </div>
    </div>
  );
  // A popup opens on a press, so there is a page by then; without one (a test's document) it renders in place.
  return typeof document !== "undefined" && document.body ? createPortal(dialog, document.body) : dialog;
}
