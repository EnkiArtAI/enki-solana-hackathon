"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import Segmented from "@/components/kit/Segmented";
import { notify } from "@/components/kit/notify";
import { Icon } from "@/components/enki-shell/icons";
import { useCommunitiesApi, useCommunityWorks } from "@/hooks/useCommunities";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { WORK_SORTS, type Work, type WorkSort } from "@/lib/communities/types";
import { openCreator } from "@/lib/openCreator";
import { promptPage } from "@/lib/ui/image-view/open-link";
import "@/components/studio/studio.css";
import "./communities.css";

const SORT_LABEL: Record<WorkSort, string> = { new: "New", top: "Top" };

/** The open work's panel in the viewer: who made it, its prompt while that is listed, a moderator's Hide. */
export function WorkPanel({ work, onPrompt, onHide }: { work: Work; onPrompt?: () => void; onHide?: () => void }) {
  const router = useRouter();
  return (
    <div className="cm-vpanel">
      {work.owner.handle && (
        <button type="button" className="st-vact kit-hit" onClick={() => openCreator(work.owner.handle!, router)}>
          <Icon name="user" size={18} stroke={1.8} />by @{work.owner.handle}
        </button>
      )}
      <div className="st-vpanel">
        {work.promptId && onPrompt && (
          <button type="button" className="st-vact kit-hit" onClick={onPrompt}><Icon name="sparkles" size={18} stroke={1.8} />Open its prompt</button>
        )}
        {onHide && <button type="button" className="st-vact kit-hit" onClick={onHide}><Icon name="eye" size={18} stroke={1.8} />Hide here</button>}
      </div>
    </div>
  );
}

/**
 * Every image and video linked to the community (Kev, 2026-10-30: "i want at one point to filter for a community and
 * then see all images and videos with it created"), newest first or most liked, as a wall; a press opens the kit's
 * viewer with who made it and its prompt. Staff can take one out of the community.
 */
export default function WorksGrid({ handle, staff }: { handle: string; staff: boolean }) {
  const [sort, setSort] = useState<WorkSort>("new");
  const { items, loading, error, more, loadMore, loadingMore } = useCommunityWorks(handle, sort);
  const api = useCommunitiesApi();
  const router = useRouter();
  const phone = useMediaQuery("(max-width: 767.98px)");
  const [viewing, setViewing] = useState<number | null>(null);
  const shown = viewing !== null ? items[viewing] : undefined;
  const hide = (w: Work) => {
    setViewing(null);
    api.hide(handle, { kind: "image", id: w.imageId, hidden: true }).then(() => notify(`Taken out of c/${handle}`), (e: Error) => notify(e.message, { tone: "error" }));
  };

  return (
    <div className="cm-tab">
      <div className="cm-tab-bar">
        <Segmented role="radiogroup" ariaLabel="Order of the works" value={sort} onChange={setSort}
          options={WORK_SORTS.map((key) => ({ key, label: SORT_LABEL[key] }))} />
      </div>
      {error ? <p className="cm-err" role="alert">{error}</p>
        : !loading && !items.length ? <p className="cm-note">Nothing here yet. Link a render from its ⋯ menu in Create.</p>
        : (
          <div className="cm-works">
            {items.map((w, i) => (
              <button key={w.imageId} type="button" className="cm-work" aria-label={`A ${w.kind} by ${w.owner.handle ? `@${w.owner.handle}` : "someone"}`} onClick={() => setViewing(i)}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a stored render */}
                <img src={w.thumb} alt="" loading="lazy" draggable={false} width={w.width ?? undefined} height={w.height ?? undefined} />
                {w.kind === "video" && <span className="cm-play" aria-hidden><Icon name="play" size={12} /></span>}
              </button>
            ))}
          </div>
        )}
      {more && <div className="cm-more"><button type="button" className="st-btn" disabled={loadingMore} onClick={loadMore}>{loadingMore ? "Loading…" : "Show more"}</button></div>}
      {shown && (
        <FullscreenViewer items={items.map((w) => ({ key: w.imageId, src: w.url }))} index={viewing!} onIndex={setViewing} onClose={() => setViewing(null)}
          layout={phone ? "stacked" : "side"} nav={phone ? "dots" : "thumbs"}
          panel={<WorkPanel work={shown} onPrompt={() => router.push(promptPage(shown.promptId!))} onHide={staff ? () => hide(shown) : undefined} />} />
      )}
    </div>
  );
}
