"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/enki-shell/icons";
import { heroKey } from "@/lib/ui/image-view/hero-keys";
import { swipeStep } from "@/lib/ui/kit/viewer";
import type { ImageViewModel } from "./useImageViewModel";

/**
 * The hero's arrows and swipe (handoff §5.10, S:328-329, S:627): the previous
 * or next of the creator's examples and the public images made with the
 * prompt, stopping at both ends. The picture it arrives at slides in from
 * that side; a swipe never also opens the viewer. ← and → step too, outside
 * a field (Kev, 2026-10-21); the open viewer takes them itself.
 */
export default function HeroNav({ model: m, children }: { model: ImageViewModel; children: ReactNode }) {
  const list = [...m.examples, ...m.community];
  const at = m.main ? list.findIndex((s) => s.key === m.main?.key) : -1;
  const [slide, setSlide] = useState<{ key: string; dir: "l" | "r" } | null>(null);
  const down = useRef<number | null>(null);
  const swiped = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const go = (step: -1 | 1) => {
    const next = list[at + step];
    if (!next) return;
    setSlide({ key: next.key, dir: step > 0 ? "r" : "l" });
    m.select(next);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const step = heroKey(e.key, {
        typing: !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|VIDEO)$/.test(t.tagName)),
        modified: e.altKey || e.ctrlKey || e.metaKey || e.shiftKey,
        overlay: !!document.querySelector('[role="dialog"]'),
        // The Image View stays mounted while hidden behind the feed (no box) or a shell panel (visibility).
        shown: !!box.current && box.current.getClientRects().length > 0 && getComputedStyle(box.current).visibility !== "hidden",
      });
      if (!step || at < 0 || e.defaultPrevented) return;
      e.preventDefault();
      go(step);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  return (
    <div ref={box} className="iv-heronav"
      // A drag on the player is its timeline, never a swipe to the next example.
      onPointerDown={(e) => { down.current = (e.target as Element | null)?.closest?.("video") ? null : e.clientX; swiped.current = false; }}
      onPointerUp={(e) => {
        if (down.current === null) return;
        const step = swipeStep(e.clientX - down.current);
        down.current = null;
        if (step && at >= 0) {
          swiped.current = true;
          go(step);
        }
      }}
      onClickCapture={(e) => {
        if (!swiped.current) return;
        swiped.current = false;
        e.stopPropagation();
        e.preventDefault();
      }}>
      <div key={m.main?.key ?? "none"} className="iv-hero-slide" data-dir={slide && slide.key === m.main?.key ? slide.dir : undefined}>
        {children}
      </div>
      {at >= 0 && list.length > 1 && (
        <>
          <button type="button" className="iv-hero-arrow kit-hit" data-side="left" aria-label="Previous example" disabled={at <= 0}
            onClick={() => go(-1)}>
            <Icon name="chevronLeft" size={14} stroke={1.5} />
          </button>
          <button type="button" className="iv-hero-arrow kit-hit" data-side="right" aria-label="Next example" disabled={at >= list.length - 1}
            onClick={() => go(1)}>
            <Icon name="chevronRight" size={14} stroke={1.5} />
          </button>
        </>
      )}
    </div>
  );
}
