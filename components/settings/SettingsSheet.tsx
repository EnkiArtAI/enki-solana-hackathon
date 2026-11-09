"use client";

import { useEffect, useEffectEvent, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CARD, PILL } from "@/components/enki-window";
import { Icon } from "@/components/enki-shell/icons";
import { lockScroll, trapStep } from "@/lib/ui/kit/controls";
import "@/components/enki-shell/enki-shell.css";
import "./areas.css";

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Settings' sheet (the mock v64's SHEETS frame, Main.dc.html:447-558; DEC-2026-11-08-43): the shell's veil, a window's
 * frame at the sheet's width (480 Safety, 500 Account, 520 the rest, 560 the profile, 640 the top-up), its title in the
 * windows' title, the round corner, a scroller inside; the form, or once it is done the done step. The mock's "check"
 * step is the app's step-up dialog ("Confirm it's you", StepUpProvider), which opens over the sheet: so the sheet hears
 * Esc on the document as it bubbles, after that dialog took its own, and keeps it from the panel under it
 * (lib/__tests__/esc-top-layer.test.ts). Tab stays inside; the focus starts on [data-autofocus], else the first control,
 * on each step, and goes back to what opened the sheet. The page behind does not scroll. A caller that must not be
 * closed mid-call guards its own onClose.
 */
export default function SettingsSheet({ title, width = 520, done = null, onClose, children }: {
  title: string;
  width?: number;
  /** The done step (Main.dc.html:548-555): its title and lines, in place of the form. */
  done?: { title: string; lines: string[] } | null;
  onClose: () => void;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Pressed down on the veil itself: a text selection let go outside the card does not close it.
  const downOnVeil = useRef(false);
  const titleId = useId();
  const close = useEffectEvent(onClose);
  const step = done ? "done" : "form";

  // What opened it, read before the focus moves in.
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const release = lockScroll(document.documentElement, window.innerWidth);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      release();
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const el = box.current;
    (el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE) ?? el)?.focus({ preventScroll: true });
  }, [step]);

  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (all.length) all[trapStep(all.indexOf(document.activeElement as HTMLElement), all.length, e.shiftKey)].focus();
  };

  const sheet = (
    <div className="ek-modal-scrim"
      onPointerDown={(e) => { downOnVeil.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnVeil.current && e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="sa-sheet kit-focus" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        style={{ ...CARD, borderWidth: 1, borderStyle: "solid", maxWidth: width, maxHeight: "calc(100vh - 48px)", overflowY: "hidden" }}
        onKeyDown={trap}>
        <div className="sa-sheet-body">
          <div className="sa-sheet-head">
            <h2 id={titleId} className="ek-modal-title">{title}</h2>
            <button type="button" className="ek-modal-x kit-hit" aria-label="Close" onClick={onClose}>
              <Icon name="x" size={17} stroke={2} />
            </button>
          </div>
          {done ? (
            <div className="sa-done" role="status">
              <span className="sa-done-mark" aria-hidden><Icon name="check" size={30} stroke={2.4} /></span>
              <span className="kit-title sa-done-title">{done.title}</span>
              <span className="sa-done-lines">{done.lines.map((line) => <span key={line}>{line}</span>)}</span>
              <button type="button" data-autofocus style={{ ...PILL, width: "auto", padding: "0 24px" }} onClick={onClose}>Done</button>
            </div>
          ) : children}
        </div>
      </div>
    </div>
  );
  // A sheet opens on a press, so there is a page by then; without one (a test's document) it renders in place.
  return typeof document !== "undefined" && document.body ? createPortal(sheet, document.body) : sheet;
}
