"use client";

import { useState } from "react";
import { useCommunitiesApi, useItemCommunities } from "@/hooks/useCommunities";
import type { CommunityChip } from "@/lib/communities/types";
import { CommunityPill } from "./CommunityPicker";

/**
 * The prompt editor's Communities (Kev, 2026-10-30: "when creating prompts, i also wanna add own tags next to categories.
 * and optionally select a Community"): a pill beside the category, the picks kept in the editor (not in its draft), a
 * released prompt's own communities read in, and `save` once the release answered with its id. The prompt route is not
 * touched (it carries payout wallets, step-up and moderation): a release can go through while its communities do not,
 * which `save` answers with the reason, for the editor to say.
 */
export function useReleaseCommunities(promptId: string | null, text: string) {
  const api = useCommunitiesApi();
  const read = useItemCommunities("prompt", promptId);
  const linked = read.data;
  const [picks, setPicks] = useState<CommunityChip[] | null>(null);
  const shown = picks ?? linked?.communities ?? [];
  // A released prompt's own communities are read before anything is picked: picks made on an empty pill would replace
  // the list and unlink the ones it was in (review 2026-10-30). Until then the pill waits, and says why if the read failed.
  const waiting = !!promptId && !linked && !read.notReady;

  /** Sets the released prompt's communities; null once they are set (or nothing was changed), else why they are not. */
  const save = async (id: string): Promise<string | null> => {
    if (picks === null || waiting) return null;
    try {
      await api.setLinks({ kind: "prompt", ids: [id], communityIds: shown.map((c) => c.id) });
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  const pill = (
    <CommunityPill value={shown} onChange={setPicks} text={text} direction="down" disabled={waiting}
      ariaLabel={waiting ? `Communities: ${read.error ?? "reading its communities…"}` : shown.length ? `Communities: ${shown.map((c) => `c/${c.handle}`).join(", ")}` : "Communities · optional"}
      face={shown.length ? <><span>Communities</span><span className="cm-pill-n">{shown.length}</span></> : <span className="pe-unset">Communities</span>} />
  );
  return { picks: shown, pill, save };
}
