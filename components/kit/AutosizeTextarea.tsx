"use client";

import {
  useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref,
  type TextareaHTMLAttributes,
} from "react";
import { GRIP_STEP, dragHeight, gripMax, nextHeight, type GripEdge } from "@/lib/ui/kit/autosize";
import "./kit-media.css";

/**
 * A textarea that grows with its text between `min` and `max` px and then
 * scrolls inside (handoff §0 "Autosize-Regel"). While `growOnly` (values
 * loaded from an image, useGrowOnly) it never shrinks; typing reports
 * `onUserInput`, so the caller lets this field alone shrink again.
 *
 * Measured before paint on every change, again once the fonts have loaded,
 * and when its width changes (a narrower field needs more lines). 16 px on a
 * touch screen, so iOS does not zoom in on focus.
 *
 * With `grip` the buyer sizes it by an edge (Kev, 2026-10-30: "the prompt box inside image and video generator must be
 * flexible an der kante. bei videos unten rechts, bei images oben nach oben"): a corner grip at the foot or the top,
 * dragged, or moved by the arrow keys once focused, up to most of the window; that height holds until a double click
 * on the grip gives the box back to its text. `boxClassName` places the grip's box where the field stood.
 */
export default function AutosizeTextarea({ value, onChange, min, max, growOnly, onUserInput, ref, className, style, grip, boxClassName, ...rest }:
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
    value: string;
    onChange: (value: string) => void;
    min: number;
    max: number;
    growOnly: boolean;
    onUserInput?: () => void;
    ref?: Ref<HTMLTextAreaElement>;
    grip?: GripEdge;
    boxClassName?: string;
  }) {
  const el = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => el.current as HTMLTextAreaElement, []);
  // The height the buyer gave it by its grip; null while it follows its text.
  const [held, setHeld] = useState<number | null>(null);
  const drag = useRef<{ y: number; start: number; limit: number } | null>(null);

  // A width change measures afresh: held fields may shrink to the new width.
  const fit = useEffectEvent((widthChanged: boolean) => {
    const ta = el.current;
    if (!ta || held !== null) return;
    const prev = ta.offsetHeight;
    // Chrome counts a wrapped placeholder in scrollHeight: an empty value
    // field grew a line whenever "Example <name>" wrapped as the name was
    // typed, and the pane jumped with it (Kev, 2026-10-13). Measured without it.
    const placeholder = ta.placeholder;
    ta.placeholder = "";
    ta.style.height = "auto";
    const scrollHeight = ta.scrollHeight;
    ta.placeholder = placeholder;
    const next = nextHeight({ scrollHeight, prev, min, max, growOnly: growOnly && !widthChanged });
    ta.style.height = `${next.height}px`;
    ta.style.overflowY = next.overflowY;
  });

  useLayoutEffect(() => fit(false), [value, growOnly, min, max, held]);

  useEffect(() => {
    const ta = el.current;
    if (!ta) return;
    // Our own height changes resize it too; only a new width is a reason.
    let width = ta.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (ta.offsetWidth === width) return;
      width = ta.offsetWidth;
      fit(true);
    });
    ro.observe(ta);
    let live = true;
    void document.fonts.ready.then(() => live && fit(false));
    return () => {
      live = false;
      ro.disconnect();
    };
  }, []);

  const textarea = (
    <textarea ref={el} rows={1} {...rest} value={value}
      className={className ? `kit-autosize ${className}` : "kit-autosize"}
      style={held === null ? { minHeight: min, maxHeight: max, ...style } : { ...style, height: held, minHeight: min, maxHeight: "none", overflowY: "auto" }}
      onChange={(e) => {
        onUserInput?.();
        onChange(e.target.value);
      }} />
  );
  if (!grip) return textarea;

  const limit = () => gripMax(max, window.innerHeight);
  const start = (e: PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, start: el.current?.offsetHeight ?? min, limit: limit() };
  };
  const move = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (d) setHeld(dragHeight({ start: d.start, dy: e.clientY - d.y, edge: grip, min, max: d.limit }));
  };
  const end = () => { drag.current = null; };
  // The arrow pointing the way the edge grows makes it taller, the other one shorter.
  const key = (e: KeyboardEvent<HTMLSpanElement>) => {
    const taller = grip === "down" ? "ArrowDown" : "ArrowUp";
    const shorter = grip === "down" ? "ArrowUp" : "ArrowDown";
    if (e.key !== taller && e.key !== shorter) return;
    e.preventDefault();
    const now = held ?? el.current?.offsetHeight ?? min;
    setHeld(dragHeight({ start: now, dy: e.key === taller ? GRIP_STEP : -GRIP_STEP, edge: "down", min, max: limit() }));
  };
  return (
    <div className={`kit-grow kit-grow--${grip}${boxClassName ? ` ${boxClassName}` : ""}`}>
      {textarea}
      <span role="separator" aria-orientation="horizontal" aria-label="Resize the prompt" tabIndex={0} className="kit-grip"
        aria-valuemin={min} aria-valuenow={held ?? undefined} title="Drag to resize · double-click to fit the text"
        onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={key} onDoubleClick={() => setHeld(null)} />
    </div>
  );
}
