"use client";
import { useEffect, useRef } from "react";
import "./kit-dialog.css";

/**
 * "Are you sure?" before anything is deleted (Kev, 2026-10-15). The first
 * focus lands on Cancel, Escape and the backdrop cancel, Enter confirms.
 */
export default function ConfirmDialog({ title, text, confirmLabel = "Delete", onConfirm, onCancel }: {
  title: string;
  text?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
      if (e.key === "Enter") { e.stopPropagation(); onConfirm(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, onConfirm]);
  return (
    <div className="kit-confirm-scrim" onClick={onCancel}>
      <div className="kit-confirm kit-focus" role="alertdialog" aria-modal="true" aria-labelledby="kit-confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="kit-confirm-title" className="kit-confirm-title">{title}</h2>
        {text && <p className="kit-confirm-text">{text}</p>}
        <div className="kit-confirm-actions">
          <button ref={cancel} type="button" className="kit-confirm-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="kit-confirm-btn kit-confirm-btn--danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
