"use client";

import { useRef, type PointerEvent, type RefObject } from "react";
import { sheetDragCloses } from "@/lib/ui/kit/controls";

/**
 * The phone's grab bar at the very top of the editor (Kev, 2026-10-26: "a super tiny little bar at the very top of the
 * UI so that i can just pull it down to close it"): pulled down, the editor follows the finger; past the sheets' own
 * threshold it closes as Back does (the draft stays in this browser), short of it it springs back. While renders run,
 * Back asks first, so the editor springs back under the question. BottomSheet's handle, moving the editor instead.
 */
export default function PullBar({ target, asks, onClose }: {
  target: RefObject<HTMLElement | null>;
  /** Back asks before leaving (renders still running): spring back for the question. */
  asks: boolean;
  onClose: () => void;
}) {
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const grab = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { y: e.clientY, dy: 0 };
  };
  const pull = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !target.current) return;
    d.dy = Math.max(0, e.clientY - d.y);
    target.current.style.translate = `0 ${d.dy}px`;
  };
  // A touch the browser took away was never let go: the editor springs back (review 2026-10-26).
  const back = () => {
    drag.current = null;
    target.current?.style.removeProperty("translate");
  };
  const letGo = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const close = sheetDragCloses(d.dy);
    // Closing at once leaves it where the finger let go until Home replaces it, as a sheet goes.
    if (!close || asks) target.current?.style.removeProperty("translate");
    if (close) onClose();
  };
  return <div className="pe-pull" aria-hidden onPointerDown={grab} onPointerMove={pull} onPointerUp={letGo} onPointerCancel={back} />;
}
