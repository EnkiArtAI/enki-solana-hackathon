"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { columnsFor, nextWallWidth, type WallWidth } from "@/lib/ui/kit/breakpoints";
import { packMasonry } from "@/lib/ui/feed/masonry";

const GAP = 4;
/** Placeholder boxes only, never data: 4:5, 1:1, 3:4. */
const SKELETON_RATIOS = [0.8, 1, 0.75];

/**
 * The feed's wall: every item absolutely placed by packMasonry, in feed
 * order, so the DOM (and the tab order) is the reading order. `skeletons`
 * are packed after the items, where the next page will land. Columns follow
 * the wall's own width (columnsFor: no card wider than CARD_MAX, two at least, five at most);
 * a width change repacks once, an append never.
 */
export default function MasonryGrid<T extends { id: string; ratio: number }>({ items, skeletons = 0, renderItem }: {
  items: readonly T[];
  skeletons?: number;
  renderItem: (item: T) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; viewport: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The page scrollbar's coming and going is not a resize (nextWallWidth): it set the wall bouncing.
    let last: WallWidth | null = null;
    const measure = (width: number) => {
      const next = nextWallWidth(last, width, window.innerWidth, performance.now());
      if (!next) return;
      last = next;
      setSize({ width: next.width, viewport: next.viewport });
    };
    // Before the first paint: at height 0 the end of a wall coming back with its cards reads as reached, and asks for a page.
    const width = el.getBoundingClientRect().width;
    if (width > 0) measure(width);
    const ro = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ratios = useMemo(
    () => [...items.map((i) => i.ratio), ...Array.from({ length: skeletons }, (_, i) => SKELETON_RATIOS[i % SKELETON_RATIOS.length])],
    [items, skeletons],
  );
  const layout = useMemo(
    () => size && packMasonry(ratios, { width: size.width, cols: columnsFor(size.width, GAP), gap: GAP, spanWide: size.viewport < 640 }),
    [ratios, size],
  );

  return (
    <div ref={ref} className="feed-grid" style={{ height: layout?.height ?? 0 }}>
      {layout?.boxes.map((b, i) => (
        <div
          key={i < items.length ? items[i].id : `sk-${i}`}
          className={i < items.length ? "feed-cell" : "feed-cell feed-skel"}
          style={{ width: Math.round(b.w), height: Math.round(b.h), transform: `translate3d(${Math.round(b.x)}px, ${Math.round(b.y)}px, 0)` }}
        >
          {i < items.length && renderItem(items[i])}
        </div>
      ))}
    </div>
  );
}
