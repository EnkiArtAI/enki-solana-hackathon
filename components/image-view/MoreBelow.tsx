"use client";

import { useEffect, useRef, useState } from "react";
import { emptyRoom, laidOut, moreBelow, morePill, moreStep } from "@/lib/ui/image-view/more-below";

/**
 * "↓ N more settings" at the foot of the composer's scroller (handoff §5.9):
 * the variable rows still under its fold, "More below" when only other
 * content is; a tap scrolls on by most of a screen. Hidden while a field is
 * being edited. The rule is lib/ui/image-view/more-below.ts.
 */
export default function MoreBelow() {
  const self = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(0);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const scroller = self.current?.closest<HTMLElement>("[data-scroll]");
    if (!scroller) return;
    // The phone composer's room under its last row (its min-height, DEC-471) is nothing more below.
    const compose = scroller.querySelector(".iv-mobile-compose");
    const room = () => compose ? emptyRoom(compose.getBoundingClientRect().bottom,
      laidOut(compose).map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.bottom)) : 0;
    const measure = () => setMore(moreBelow({
      rowTops: [...scroller.querySelectorAll("[data-iv-field]")].map((r) => r.getBoundingClientRect().top),
      bottom: scroller.getBoundingClientRect().bottom,
      scrollHeight: scroller.scrollHeight - room(),
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
    }));
    const focus = (e: FocusEvent) => setActive(e.type === "focusin" && !!(e.target as Element | null)?.closest("[data-iv-field]"));
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    scroller.addEventListener("focusin", focus);
    scroller.addEventListener("focusout", focus);
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    for (const child of scroller.children) ro.observe(child);
    // Inside its min-height the composer keeps its size while its rows grow, or change with the mode: those are watched.
    const watch = () => { if (compose) for (const c of laidOut(compose)) ro.observe(c); };
    watch();
    const mo = new MutationObserver(() => { watch(); measure(); });
    if (compose) mo.observe(compose, { childList: true });
    return () => {
      scroller.removeEventListener("scroll", measure);
      scroller.removeEventListener("focusin", focus);
      scroller.removeEventListener("focusout", focus);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  const label = morePill(more, active);
  const step = () => {
    const scroller = self.current?.closest<HTMLElement>("[data-scroll]");
    scroller?.scrollBy({ top: moreStep(scroller.clientHeight), behavior: "smooth" });
  };
  return (
    <div ref={self} className="iv-more" hidden={!label}>
      {label && <button type="button" className="iv-more-pill" onClick={step}>{label}</button>}
    </div>
  );
}
