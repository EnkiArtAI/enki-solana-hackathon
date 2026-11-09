"use client";

import { useState } from "react";
import Segmented from "@/components/kit/Segmented";
import { MY_REMIXES, REMIX_EXAMPLES, type RemixCardData } from "@/lib/remix/library";
import RemixCard from "./RemixCard";
import RemixComposer from "./RemixComposer";
import { useRemixDraft } from "./useRemixDraft";
import "./remix.css";

type Tab = "history" | "examples";
const TABS: Array<{ key: Tab; label: string }> = [{ key: "history", label: "History" }, { key: "examples", label: "Examples" }];
const EMPTY: Record<Tab, [string, string]> = {
  history: ["No remixes yet.", "The remixes you make show up here."],
  examples: ["No examples yet.", "Short looping clips of each mode arrive here soon."],
};

/**
 * The Remix world of the home feed: the composer on the left, History | Examples on its right (no Styles tab: Kev,
 * 2026-10-30, "ok erstmal keine styles"; Examples in Library's place: "Anstelle von Library bei Remix, soll "Examples"
 * stehen, wo dann lauter webm animationen drin sein werden später"), gliding as Create's row does; on a phone one
 * column, the composer first. Both lists are empty until the remix backend exists; a card's Recreate puts its clip into
 * the composer and brings the composer into view.
 */
export default function RemixView({ guest }: { guest: boolean }) {
  const d = useRemixDraft();
  const [tab, setTab] = useState<Tab>("history");
  const cards = tab === "history" ? MY_REMIXES : REMIX_EXAMPLES;
  const recreate = (card: RemixCardData) => {
    d.recreate(card);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return (
    <section className="rx" aria-label="Remix">
      <RemixComposer d={d} guest={guest} />
      <div className="rx-lib">
        <Segmented slide role="tablist" ariaLabel="Your remixes or examples" value={tab} onChange={setTab} options={TABS} />
        {cards.length > 0 ? (
          <div className="rx-cards">
            {cards.map((card) => <RemixCard key={card.id} card={card} onRecreate={recreate} />)}
          </div>
        ) : (
          <section className="rx-empty">
            <h3 className="kit-title">{EMPTY[tab][0]}</h3>
            <p>{EMPTY[tab][1]}</p>
          </section>
        )}
      </div>
    </section>
  );
}
