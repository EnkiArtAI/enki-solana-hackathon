"use client";

import { REMIX_MODES } from "@/lib/remix/modes";
import type { RemixCardData } from "@/lib/remix/library";

/** One remix in History or Examples: the clip at 16:9, muted and looping, its mode, its title, and Recreate, which puts
    its clip into the composer. */
export default function RemixCard({ card, onRecreate }: { card: RemixCardData; onRecreate: (card: RemixCardData) => void }) {
  return (
    <article className="rx-card">
      <video className="rx-card-clip" src={card.clip} poster={card.poster} muted loop playsInline autoPlay preload="metadata" />
      <div className="rx-card-foot">
        <span className="kit-label">{REMIX_MODES[card.mode].label}</span>
        <h3 className="rx-card-title">{card.title}</h3>
        <button type="button" className="rx-recreate kit-hit" onClick={() => onRecreate(card)}>Recreate</button>
      </div>
    </article>
  );
}
