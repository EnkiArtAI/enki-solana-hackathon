"use client";

import { useEffect, useRef } from "react";
import { notify } from "@/components/kit/notify";
import { useCommunitiesApi } from "@/hooks/useCommunities";
import { PRIVATE_RENDERS_LINE, type CommunityChip } from "@/lib/communities/types";
import type { GenerationRow } from "@/lib/ui/image-view/history";
import type { Job } from "@/lib/ui/kit/render-queue";
import { idsOfKey, pickKey } from "@/lib/ui/communities/picker";
import { fileKey, noteJobs, toFile, type StartedIn } from "@/lib/ui/studio/filing";
import { CommunityPill } from "./CommunityPicker";

/**
 * Links Create > Image's renders to the communities picked in its bar while they were started (the agreed shape,
 * 2026-10-30: "Create > Image's bar"), once each, as their rows come in. Studio's filing, as it is (lib/ui/studio/filing):
 * a job's "content piece" here is the picks' key, so a job started under c/apu + c/pepe is linked to both, one started
 * with none to none, and the jobs already there when Create opened to none. A failure is said once; the render can be
 * linked by hand from its ⋯ menu.
 */
export function CommunityLinking({ jobs, rows, picks }: { jobs: ReadonlyArray<Job<unknown>>; rows: GenerationRow[]; picks: CommunityChip[] }) {
  const api = useCommunitiesApi();
  const startedIn = useRef<StartedIn | null>(null);
  const sent = useRef(new Set<string>());
  const told = useRef(false);
  const key = pickKey(picks.map((p) => p.id));

  useEffect(() => {
    startedIn.current = noteJobs(startedIn.current, jobs, key || null);
    for (const { content, imageIds } of toFile(jobs, rows, startedIn.current, sent.current)) {
      for (const id of imageIds) sent.current.add(fileKey(content, id));
      api.setLinks({ kind: "image", ids: imageIds, communityIds: idsOfKey(content) }).catch((e: Error) => {
        if (told.current) return;
        told.current = true;
        notify(`Couldn't link that render to its communities: ${e.message}`, { tone: "error" });
      });
    }
    // api is new each render; the jobs, their rows and the picks decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, rows, key]);
  return null;
}

/** The bar's pill right after "+": "c/" and the word, "c/ 2" once picks are set; on a phone the word gives way. */
export function BarCommunities({ picks, onPicks, text }: { picks: CommunityChip[]; onPicks: (next: CommunityChip[]) => void; text: string }) {
  return (
    <CommunityPill value={picks} onChange={onPicks} text={text} direction="up" note={PRIVATE_RENDERS_LINE} disabled title="Communities are coming soon"
      ariaLabel={picks.length ? `Communities for the next renders: ${picks.map((c) => `c/${c.handle}`).join(", ")}` : "Communities for the next renders"}
      face={<><span aria-hidden>c/</span>{picks.length ? <span className="cm-pill-n">{picks.length}</span> : <span className="kit-pill-name">Communities</span>}</>} />
  );
}
