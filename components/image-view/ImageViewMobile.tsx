"use client";

import { useRef, useState, type UIEvent } from "react";
import { Icon } from "@/components/enki-shell/icons";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import JobTile from "@/components/kit/JobTile";
import { clampIndex } from "@/lib/ui/kit/viewer";
import { ratioKey, rememberRatio } from "@/lib/ui/image-view/known-ratio";
import { jobSaid } from "@/lib/ui/image-view/setups";
import { countLabel } from "@/lib/ui/image-view/discussion";
import AgentRow from "./AgentRow";
import ComposeFoot from "./ComposeFoot";
import Composer from "./Composer";
import HeroNav from "./HeroNav";
import { railItems, renderWhen } from "./HistoryStrip";
import IvHeader from "./IvHeader";
import MainImage from "./MainImage";
import MoreBelow from "./MoreBelow";
import PreviewStrip from "./PreviewStrip";
import ReviewsPanel from "./ReviewsPanel";
import type { Rect } from "@/lib/ui/image-view/zoom";
import ViewerPanel from "./ViewerPanel";
import { useOpenRender } from "./useOpenRender";
import type { ImageViewModel, Shot } from "./useImageViewModel";
import { reachTitle } from "./useImageViewModel";
import "./image-view-mobile.css";

/**
 * The phone layout below 1024 px (image UI v2, handoff §4): a 52 px header,
 * then one scroller (the title, who made it, the hero at its picture's shape
 * with the History on its right, the public images made with it, the
 * composer) over a fixed foot with the settings and Generate (Kev,
 * 2026-10-26). Same model as the desktop; only the arrangement changes.
 */
export default function ImageViewMobile({ model: m, onClose }: { model: ImageViewModel; onClose: () => void }) {
  const [viewer, setViewer] = useState<{ keys: string[]; at: number } | null>(null);
  // The reviews panel over nearly the whole frame, morphing out of the hero's chip (handoff §5.16).
  const [reviews, setReviews] = useState<Rect | null>(null);
  // Failed jobs can be inspected and retried too. Rendering jobs stay on the stage.
  const shots = [...new Map([...m.queue.filter((s) => s.job?.status !== "rendering"), ...m.finished].map((s) => [s.key, s])).values()];
  const byKey = new Map(shots.map((s) => [s.key, s]));
  const items = viewer ? viewer.keys.flatMap((key) => byKey.get(key) ?? []) : [];
  const at = viewer ? clampIndex(viewer.at, items.length) : 0;
  const open = (shot: Shot) => {
    if (shot.job?.status === "rendering") { m.select(shot); return; }
    const keys = shots.map((s) => s.key);
    if (!keys.includes(shot.key)) return;
    m.seen(shot);
    setViewer({ keys, at: keys.indexOf(shot.key) });
  };
  // A finished render's notice opens it here (RenderNotices).
  const root = useRef<HTMLDivElement>(null);
  useOpenRender(m, open, root);
  const history = m.historyState;
  const examples = m.examples.length + m.community.length;
  const talk = m.discussion.data;
  const yours = !m.blank && !m.guest;
  const mine = yours ? railItems(m.queue, m.history) : [];
  // Older renders load as the column nears its end (S:362-366).
  const near = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (history.more && !history.loadingOlder && el.scrollTop + el.clientHeight > el.scrollHeight - 160) history.loadOlder();
  };

  return (
    <div ref={root} className="iv-root iv-mobile kit-focus" data-tier="phone">
      <IvHeader model={m} onBack={onClose} phone />
      <div className="iv-mbody">
        <div className="iv-mscroll" data-scroll>
          {/* The prompt's name heads the page, above its image (Kev, 2026-10-26), a small Back beside it to the menu
              the image came from (Kev, 2026-10-27: "ein kleiner zurück button ... next to the title subtil"; DEC-460). */}
          <div className="iv-mtitle-row">
            <button type="button" className="iv-mback kit-hit" aria-label="Back" title="Back" onClick={onClose}>
              <Icon name="chevronLeft" size={16} stroke={1.75} />
            </button>
            <h1 className="iv-mtitle">{m.title}</h1>
          </div>
          {/* Who made it and the reviews at the top left, Premium at the right, in a row above the image as on the
              desktop (Kev, 2026-10-26: "the by @artist sollte eher oben links stehen ... coherent"). */}
          {((!m.blank && (m.artist || talk)) || m.premium) && (
            <div className="iv-mmeta">
              {!m.blank && (m.artist || talk) && (
                <button type="button" className="iv-mchip" title="Read the reviews" onClick={(e) => setReviews(e.currentTarget.getBoundingClientRect())}>
                  {m.artist && <>by {m.artist.handle ? `@${m.artist.handle}` : m.artist.name}</>}
                  {m.artist && talk && " · "}
                  {talk && (talk.avgRating != null ? <>★ {talk.avgRating.toFixed(1)} ({countLabel(talk.reviews.length, talk.capped)})</> : "No reviews yet")}
                  {m.reach && <span title={reachTitle(m.reach)}> · 𝕏 ♥ {m.reach.core.likes} ↻ {m.reach.core.reposts} ❝ {m.reach.core.quotes}</span>}
                </button>
              )}
              {m.premium && (
                <span className="iv-premium iv-mpremium" title="Premium prompt · price per image, everything included">
                  Premium{!m.guest && m.perImage && <b>{m.perImage}</b>}
                </span>
              )}
            </div>
          )}
          <div className="iv-mhero-row">
            <div className="iv-mhero">
              <HeroNav model={m}><MainImage model={m} onOpen={open} onClose={onClose} phone /></HeroNav>
            </div>
            {/* At the image's right, always the History: the viewer's own renders, this tab's first as they paint, a
                narrow empty rail while there are none, nothing written on it (Kev, 2026-10-26: "rechts neben dem bild
                ist IMMER history", then "strange ... 'history' when there is no history ... just nothing, but kinda
                smaller"). Guests and the blank composer have none, as on the desktop. */}
            {yours && (
              <div className="iv-mthumbs kit-noscroll" aria-label="History" data-empty={mine.length || history.failed ? undefined : ""} onScroll={near}>
                {(!!mine.length || history.failed) && <span className="iv-mthumbs-yours">History</span>}
                {mine.map((s) => s.job ? (
                  <JobTile key={s.key} status={s.job.status} sent={s.job.sent} src={s.thumb ?? s.src} ratio="1:1" height={48}
                    seen={s.job.seen} selected={m.main?.key === s.key} label={`Your render, ${jobSaid(s.job)}`} onClick={() => open(s)} onCancel={() => m.cancel(s)} />
                ) : (
                  <button key={s.key} type="button" className="iv-mthumb" aria-pressed={m.main?.key === s.key}
                    aria-label={`Your render · ${renderWhen(s, m.now)}`} onClick={() => m.select(s)}>
                    <img src={s.thumb} alt="" loading="lazy" draggable={false}
                      onLoad={(e) => rememberRatio(ratioKey(s), e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
                  </button>
                ))}
                {history.failed && <button type="button" className="iv-link iv-mthumbs-note" onClick={history.retry}>Retry</button>}
              </div>
            )}
          </div>
          {/* Under it the public images made with the prompt, the creator's first, as the desktop's Examples row
              ("darunter sind die images die public sind die damit erstellt wurden"); without a History, this tab's
              renders lead it there too. The hero's arrows walk the same list. */}
          {(!!examples || (!yours && !!m.queue.length)) && (
            <div className="iv-examples">
              {!!examples && <span className="iv-examples-label">Examples</span>}
              <PreviewStrip model={m} queue={!yours} />
            </div>
          )}
          <div className="iv-mobile-compose">
            <Composer model={m} phone />
            {/* x402 stays, folded, at the end of the composer (plan Q3). */}
            {yours && !m.video && <AgentRow model={m} />}
          </div>
          <MoreBelow />
        </div>
        <ComposeFoot model={m} phone />
      </div>
      {viewer && items[at] && <FullscreenViewer items={items.map((s) => ({ key: s.key, src: s.src, ratio: s.ratio,
        failed: s.job?.status === "failed" ? { message: "This image could not be generated. You can retry it." } : undefined }))}
        index={at} layout="stacked" nav="dots" onIndex={(i) => { m.seen(items[i]); setViewer({ ...viewer, at: i }); }}
        onClose={(last) => { setViewer(null); m.select(items[last]); }}
        panel={<ViewerPanel model={m} shot={items[at]} onAgain={() => setViewer(null)} phone />} />}
      {reviews && <ReviewsPanel model={m} from={reviews} hero={null} phone onClose={() => setReviews(null)} />}
    </div>
  );
}
