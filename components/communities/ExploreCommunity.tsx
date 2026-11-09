"use client";

import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { openCommunity } from "@/lib/ui/communities/links";
import { CommunityPill } from "./CommunityPicker";
import "./communities.css";

/**
 * Explore's Community filter (Kev, 2026-10-30: "i want at one point to filter for a community and then see all images and
 * videos with it created"): a pill in the filter row with the picker for one community; set, it reads "c/apu" with its ×,
 * and its popover leads to the community's page, where all its images and videos are (Works).
 */
export default function ExploreCommunity({ handle, onPick }: { handle: string | null; onPick: (handle: string | null) => void }) {
  const router = useRouter();
  return (
    <span className="enki-fltr-group">
      <CommunityPill mode="single" pill="feed-pill cm-explore-pill" direction="down" title="Community"
        value={handle ? [{ id: handle, handle, name: handle }] : []} onChange={(next) => onPick(next[0]?.handle ?? null)}
        ariaLabel={handle ? `Community: c/${handle}` : "Filter by community"}
        face={handle ? `c/${handle}` : "Community"}
        foot={(close) => handle && <button type="button" className="cm-link" onClick={() => { close(); openCommunity(handle, router); }}>Open c/{handle} →</button>} />
      {handle && (
        <button type="button" className="feed-pill kit-hit cm-explore-x" aria-label={`Show every community, not only c/${handle}`} title="Clear" onClick={() => onPick(null)}>
          <X size={12} strokeWidth={2.4} />
        </button>
      )}
    </span>
  );
}
