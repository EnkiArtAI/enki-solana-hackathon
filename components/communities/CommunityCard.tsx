"use client";

import Seal from "@/components/kit/Seal";
import type { CommunityCard as Card } from "@/lib/communities/types";
import { cardLabel, countsLine } from "@/lib/ui/communities/links";
import "./communities.css";

/** A community's cover: its picture (the cover rule, SQL 54's community_cards), else its handle's seal on the paper. */
export function Cover({ card }: { card: Pick<Card, "handle" | "cover"> }) {
  // eslint-disable-next-line @next/next/no-img-element -- a stored render
  return card.cover ? <img className="cm-card-cover" src={card.cover} alt="" loading="lazy" draggable={false} />
    : <span className="cm-card-seal" aria-hidden><span><Seal handle={card.handle} /></span></span>;
}

/**
 * A community in the directory (Kev, 2026-10-30: "in der community section müssen alle communities gleich große
 * senkrechte karten haben, von denen jeder ein bild bekommt, am beste das mit den meisten generierungen"): one button,
 * the grid's width at 3:4, its cover, then its name, c/handle and counts over a gradient at its foot. One that is not
 * listed yet (a search found it) says "New".
 */
export default function CommunityCard({ card, onOpen }: { card: Card; onOpen: (handle: string) => void }) {
  return (
    <button type="button" className="cm-card" aria-label={cardLabel(card)} onClick={() => onOpen(card.handle)}>
      <Cover card={card} />
      {!card.listed && <span className="cm-new" aria-hidden>New</span>}
      <span className="cm-card-foot" aria-hidden>
        <span className="cm-card-name">{card.name}</span>
        <span className="cm-card-handle">c/{card.handle}</span>
        <span className="cm-card-meta">{countsLine(card)}</span>
      </span>
    </button>
  );
}
