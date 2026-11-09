"use client";

import type { ReactNode } from "react";
import PillMenu from "@/components/kit/PillMenu";
import Segmented from "@/components/kit/Segmented";
import { ENKI_CATEGORIES } from "@/lib/categories";
import { mediaOf, starsNeeded, type Listing } from "@/lib/editor/release";
import PriceStepper from "./PriceStepper";

/** What each mode means; the hover text, and a toast on a touch screen, where nothing hovers. "Open" is the word for a public text (Kev, 2026-10-13: "swap Free prompt to Open"). */
const MODE_WORDS: Record<Listing["mode"], string> = {
  free: "Open: your prompt text is public; people pay only the generator.",
  premium: "Your text stays private; people pay your price on top of the generator.",
};
export const modeTitle = (l: Pick<Listing, "mode" | "media">) => {
  const n = starsNeeded(l);
  return `${MODE_WORDS[l.mode]} Release with ${n} ${mediaOf(l)}${n === 1 ? "" : "s"}.`;
};

/** Open | Premium, the price (Premium only) and the category, from the live list (plan §5 item 10); then `extra`, the
 *  Communities pill beside the category (Kev, 2026-10-30: "when creating prompts, i also wanna add own tags next to
 *  categories. and optionally select a Community"). Premium also says whether buyers may add reference images (Kev,
 *  2026-11-01: "bei premium images das eingestellt werden kann"); a prompt that names one needs them, so it stays on. */
export default function ListingRow({ listing, onMode, onPrice, onCategory, onReferences, referencesNamed, extra }: {
  listing: Listing;
  onMode: (mode: Listing["mode"]) => void;
  onPrice: (price: number) => void;
  onCategory: (category: string) => void;
  onReferences: (on: boolean) => void;
  referencesNamed: boolean;
  extra?: ReactNode;
}) {
  return (
    <div className="pe-row pe-listing">
      <Segmented slide role="radiogroup" ariaLabel="Listing" value={listing.mode} onChange={onMode} options={[
        { key: "free", label: "Open", title: modeTitle({ ...listing, mode: "free" }) },
        { key: "premium", label: <><span className="pe-diamond" aria-hidden />Premium</>, title: modeTitle({ ...listing, mode: "premium" }) },
      ]} />
      {/* The price slides out of the switch on Premium and back in on Open, the category following (Kev, 2026-10-13). Inert while in: not in the tab order. */}
      <span className="pe-price-slot" data-open={listing.mode === "premium" || undefined} inert={listing.mode !== "premium" || undefined}>
        <span className="pe-price-slot-in"><PriceStepper price={listing.price} onPrice={onPrice} /></span>
      </span>
      <span className="pe-category">
        <PillMenu
          trigger={listing.category ?? <span className="pe-unset">Category</span>}
          ariaLabel={listing.category ? `Category: ${listing.category}` : "Category · where your prompt shows up in the feed"}
          title="Category"
          hint="Where your prompt shows up"
          columns={2}
          direction="down"
          options={ENKI_CATEGORIES.map((c) => ({ key: c, label: c }))}
          value={listing.category}
          onPick={onCategory}
        />
      </span>
      {extra}
      {/* A video prompt takes no buyer's references yet: nothing to switch. */}
      {listing.mode === "premium" && mediaOf(listing) === "image" && (
        <label className="kit-field-check pe-refs-allow">
          Buyers can add reference images
          <input type="checkbox" role="switch" checked={referencesNamed || listing.allowReferences !== false} disabled={referencesNamed}
            onChange={(e) => onReferences(e.target.checked)} />
          <span className="kit-switch" aria-hidden />
        </label>
      )}
      {listing.mode === "premium" && mediaOf(listing) === "image" && referencesNamed && <span className="pe-note">Your prompt names a reference image, so buyers always add theirs.</span>}
    </div>
  );
}
