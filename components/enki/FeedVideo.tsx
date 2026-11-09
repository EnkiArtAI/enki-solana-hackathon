"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { COVER_SWEEP_MS, DWELL_MS, MIN_VISIBLE, holdSource, pickPlaying, playReader, startPlaying, stopPlaying } from "@/lib/ui/feed/visible-play";

/* One observer and one pick for every card on the page, so the cap holds across a whole wall. */
const watched = new Map<Element, (on: boolean) => void>();
const visible = new Map<Element, number>();
let observer: IntersectionObserver | null = null;
let sweep: ReturnType<typeof setInterval> | null = null;
let moving: ReturnType<typeof setTimeout> | null = null;

/** An observer does not see what lies over a card: an Image View, a panel, the composer. A card counts only if it is what a press in its middle would meet. */
function onTop(el: Element, r: DOMRect) {
  const top = document.elementFromPoint((Math.max(r.left, 0) + Math.min(r.right, innerWidth)) / 2, (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2);
  return Boolean(top && el.closest(".feed-card")?.contains(top));
}

function repick() {
  moving = null;
  const seen = [...visible].flatMap(([key, ratio]) => {
    const r = key.getBoundingClientRect();
    return onTop(key, r) ? [{ key, visible: ratio, distance: Math.hypot(r.left + r.width / 2 - innerWidth / 2, r.top + r.height / 2 - innerHeight / 2) }] : [];
  });
  const picked = pickPlaying(seen, playReader());
  watched.forEach((set, el) => set(picked.has(el)));
}

/** A card plays only once the wall has held still this long: a flick past a hundred cards starts no video and no download for any of them. */
function settle() {
  if (moving) clearTimeout(moving);
  moving = setTimeout(repick, DWELL_MS);
}

/** The silent loop itself: fades in on `playing`, over the card's poster. */
export function FeedPlayer({ src, onRefused }: { src: string; onRefused: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    holdSource(el, src);
    startPlaying(el, onRefused);
    return () => stopPlaying(el);
  }, [src, onRefused]);
  return (
    <video ref={ref} className={playing ? "is-playing" : undefined} src={src} muted playsInline loop preload="none"
      onPlaying={() => setPlaying(true)} onError={onRefused} />
  );
}

/**
 * A video card's picture in motion: mounted only while its card is picked (lib/ui/feed/visible-play), so the page never
 * holds more than 6 video elements, and nothing is fetched for a card off screen or under something else. Lies over the
 * poster and under the card's button; without it, refused or not picked, the card is its poster.
 */
export default function FeedVideo({ src }: { src: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const [refused, setRefused] = useState(false);
  const refuse = useCallback(() => setRefused(true), []);
  useEffect(() => {
    const el = box.current;
    if (!el || refused) return;
    observer ??= new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.intersectionRatio >= MIN_VISIBLE) visible.set(e.target, e.intersectionRatio);
        else {
          visible.delete(e.target);
          // Gone from the screen, its decoder is given back at once.
          watched.get(e.target)?.(false);
        }
      }
      settle();
    }, { threshold: [MIN_VISIBLE] });
    watched.set(el, setOn);
    observer.observe(el);
    // Nothing tells a wall that something opened over it, or went: asked again, as long as a wall is there.
    sweep ??= setInterval(() => { if (!moving) repick(); }, COVER_SWEEP_MS);
    return () => {
      observer?.unobserve(el);
      watched.delete(el);
      visible.delete(el);
      if (!watched.size && sweep) {
        clearInterval(sweep);
        sweep = null;
      }
      // Its place goes to the next card.
      settle();
    };
  }, [refused]);
  return <div ref={box} className="feed-card-video" aria-hidden>{on && !refused && <FeedPlayer src={src} onRefused={refuse} />}</div>;
}
