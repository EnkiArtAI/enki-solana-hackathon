"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/enki-shell/icons";
import { growFrom, zoomBox, type Rect } from "@/lib/ui/image-view/zoom";

/** The grow and the shrink, as the CSS transition runs them. */
const MOVE_MS = 340;

/**
 * One of the buyer's photos, grown from its tile to its own size and shape,
 * centred, at most what the screen holds (handoff §5.15, README §5.8; Kev,
 * 2026-10-29: "in der korrekten größe, also up to vollbild natürlich"): its
 * number top left, a close button once it has arrived, the backdrop dimmed.
 * A click on it, the backdrop or Esc shrinks
 * it back to its tile, then it is gone. Opened from the fullscreen viewer
 * (a public image's references, DEC-514) it lies above it and takes the
 * focus: the viewer keys on a focus inside it, so its Esc stays this one's.
 */
export default function Zoom({ src, n, from, phone, overViewer, onClose }: { src: string; n: number; from: Rect; phone: boolean; overViewer?: boolean; onClose: () => void }) {
  const [phase, setPhase] = useState<"in" | "open" | "out">("in");
  const img = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (overViewer) img.current?.focus({ preventScroll: true });
  }, [overViewer]);
  /* The photo's own pixels, once read. It opens at once as the square and takes its own size when they arrive, so a
     slow photo never leaves an unseen layer over the page (review 2026-10-29); one that cannot be read stays the square. */
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  useEffect(() => {
    const pic = new Image();
    pic.onload = () => { if (pic.naturalWidth > 0 && pic.naturalHeight > 0) setSize({ width: pic.naturalWidth, height: pic.naturalHeight }); };
    pic.src = src;
    return () => { pic.onload = null; };
  }, [src]);
  // Measured on every render, and a resize renders again: an open photo stays centred in a window that changes.
  const [, setResized] = useState(0);
  useEffect(() => {
    const again = () => setResized((k) => k + 1);
    window.addEventListener("resize", again);
    return () => window.removeEventListener("resize", again);
  }, []);
  const frame = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const box = zoomBox(frame, phone, size);
  const done = useEffectEvent(onClose);
  // Painted on its tile first, so the transition has somewhere to grow from.
  useEffect(() => {
    const t = setTimeout(() => setPhase("open"), 30);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (phase !== "out") return;
    const t = setTimeout(done, MOVE_MS);
    return () => clearTimeout(t);
  }, [phase]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPhase("out");
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  const close = () => setPhase("out");

  return createPortal(
    <div className="iv-zoom" data-phase={phase} data-over-viewer={overViewer || undefined} role="dialog" aria-modal="true" aria-label={`Photo ${n}`}>
      <div className="iv-zoom-backdrop" onClick={close} />
      <button ref={img} type="button" className="iv-zoom-img" aria-label="Close the photo" onClick={close}
        style={{ left: box.left, top: box.top, width: box.width, height: box.height, backgroundImage: `url("${src}")`,
          transform: phase === "open" ? "none" : growFrom(frame, from, box) }}>
        <span className="iv-zoom-n">{n}</span>
      </button>
      {phase === "open" && (
        <button type="button" className="iv-zoom-x kit-hit" aria-label="Close" onClick={close}>
          <Icon name="x" size={15} stroke={1.5} />
        </button>
      )}
    </div>,
    document.body,
  );
}
