"use client";

/**
 * NFT picker for quick create (Kev, 2026-08-22): a popup listing every NFT
 * in the signed-in account's wallets; clicking marks/unmarks, "Use N"
 * hands the marked images back as reference images. Its body is NftGrid.
 */
import { useEffect } from "react";
import { X } from "lucide-react";
import type { NftPick } from "@/hooks/useReferenceReads";
import NftGrid from "@/components/enki/NftGrid";
// Shared popup chrome (spinner, CTA button) + its own styles live here.
import "@/components/enki/bookmarks.css";

export default function NftPickerModal({ max, onPick, onClose }: {
  /** How many the caller can still take (free reference slots). */
  max: number;
  /** The marked NFTs, each read through our own route (useReferenceReads). */
  onPick: (picks: NftPick[]) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="enki-nftp-scrim" onClick={onClose}>
      <div className="enki-nftp" onClick={(e) => e.stopPropagation()}>
        <div className="enki-nftp-head">
          <span>Your NFTs</span>
          <button type="button" className="enki-nftp-x" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <NftGrid max={max} onPick={onPick} onDone={onClose} />
      </div>
    </div>
  );
}
