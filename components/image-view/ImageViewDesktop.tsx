"use client";

import { useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { Icon } from "@/components/enki-shell/icons";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import { openCreator } from "@/lib/openCreator";
import { countLabel } from "@/lib/ui/image-view/discussion";
import { stripWidth } from "@/lib/ui/image-view/layout";
import { clampIndex } from "@/lib/ui/kit/viewer";
import AgentRow from "./AgentRow";
import ComposeFoot from "./ComposeFoot";
import Composer from "./Composer";
import HistoryStrip, { railItems, renderWhen } from "./HistoryStrip";
import HeroNav from "./HeroNav";
import IvHeader from "./IvHeader";
import MainImage from "./MainImage";
import MoreBelow from "./MoreBelow";
import PreviewStrip from "./PreviewStrip";
import PromptActions from "./PromptActions";
import ReviewsPanel from "./ReviewsPanel";
import type { Rect } from "@/lib/ui/image-view/zoom";
import ViewerPanel from "./ViewerPanel";
import { useOpenRender } from "./useOpenRender";
import type { ImageViewModel, Shot } from "./useImageViewModel";
import { reachTitle } from "./useImageViewModel";

/** The History strip's open state, kept across visits (plan B10). */
const HISTORY_KEY = "enki:iv-history";
const readOpen = () => {
  try { return localStorage.getItem(HISTORY_KEY) !== "0"; } catch { return true; }
};

/**
 * The Image View from 1024 px up (image UI v2, handoff §3): the page's own
 * header, then the composer (title, a scroller, the settings and Generate at
 * its foot) beside the picture column (who made it, the hero, the examples).
 * The viewer's own renders run in a strip beside the hero.
 */
export default function ImageViewDesktop({ model: m, onClose }: { model: ImageViewModel; onClose: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(readOpen);
  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    try { localStorage.setItem(HISTORY_KEY, next ? "1" : "0"); } catch { /* private mode */ }
  };
  const [viewer, setViewer] = useState<{ keys: string[]; at: number } | null>(null);
  // The reviews panel, morphing out of what opened it, over the hero (handoff §5.16).
  const [reviews, setReviews] = useState<{ from: Rect; hero: Rect | null; compose: boolean } | null>(null);
  // The picture's ratio: a wide one gives the hero its own shape, so no empty band sits above and below it (Kev,
  // 2026-10-29); a portrait or a square keeps the square.
  const [heroRatio, setHeroRatio] = useState(1);
  const hero = useRef<HTMLDivElement>(null);
  const openReviews = (e: MouseEvent<HTMLElement>, compose: boolean) =>
    setReviews({ from: e.currentTarget.getBoundingClientRect(), hero: hero.current?.getBoundingClientRect() ?? null, compose });

  const byKey = new Map(m.finished.map((x) => [x.key, x]));
  const items = viewer ? viewer.keys.flatMap((k) => byKey.get(k) ?? []) : [];
  const at = viewer ? clampIndex(viewer.at, items.length) : 0;
  const open = (s: Shot) => {
    const keys = m.finished.map((x) => x.key);
    if (!keys.includes(s.key)) return;
    m.seen(s);
    setViewer({ keys, at: keys.indexOf(s.key) });
  };
  // A finished render's notice opens it here (RenderNotices).
  const root = useRef<HTMLDivElement>(null);
  useOpenRender(m, open, root);
  const talk = m.discussion.data;
  // The History strip holds this tab's renders; without one (blank, guest) they lead the examples row. Signed in, the
  // column is always there (Kev, 2026-10-21). Before the first render it stands open, its name above it and a
  // placeholder in it, so it never reads as a button (Kev, 2026-10-29: "'history' sieht clickable aus"; DEC-504).
  const railed = !m.blank && !m.guest;
  const held = railed && railItems(m.queue, m.history).length > 0;
  // While the first read runs a folded column stays folded: it opens only once it is known to be empty (review 2026-10-29).
  const shown = railed && (historyOpen || (!held && !m.historyState.loading));
  const onHistory = m.main?.kind === "history";

  return (
    <div ref={root} className="iv-root iv-v2 kit-focus">
      <div className="iv-main">
        <IvHeader model={m} onBack={onClose} />
        <div className="iv-grid" style={{ "--iv-strip": `${stripWidth(railed, shown)}px` } as CSSProperties}>
          <section className="iv-lcol">
            <div className="iv-titles">
              <div className="iv-titles-text">
                {/* The template's own name in the heading's type; "Make it yours" stood on every page (Kev, 2026-10-21). */}
                <h1 className="iv-make">{m.title}</h1>
              </div>
              {!m.blank && <PromptActions model={m} />}
            </div>
            <div className="iv-left-scroll" data-scroll>
              <Composer model={m} />
              <MoreBelow />
            </div>
            {/* x402, folded (plan Q3), right above the generator and Generate, never scrolled away with the prompt
                (Kev, 2026-10-21). */}
            {!m.blank && !m.guest && !m.video && <AgentRow model={m} />}
            <ComposeFoot model={m} />
          </section>
          <section className="iv-rcol">
            {!m.blank && (
              <div className="iv-metarow">
                {onHistory && m.main ? (
                  <span className="iv-yours">Yours · {renderWhen(m.main, m.now)}</span>
                ) : (
                <div className="iv-meta-by">
                  {m.artist?.handle ? (
                    <span>by <button type="button" className="iv-by-link" onClick={() => openCreator(m.artist?.handle as string)}>@{m.artist.handle}</button></span>
                  ) : m.artist?.name && <span>by {m.artist.name}</span>}
                  {m.artist && talk && <span className="iv-meta-dot" aria-hidden>·</span>}
                  {talk && (talk.avgRating != null ? (
                    <button type="button" className="iv-rating" title={`Average of ${countLabel(talk.reviews.length, talk.capped)} ratings · read the reviews`}
                      onClick={(e) => openReviews(e, false)}>
                      <span aria-hidden>★</span>{talk.avgRating.toFixed(1)} <span>({countLabel(talk.reviews.length, talk.capped)})</span>
                    </button>
                  ) : <button type="button" className="iv-meta-none" onClick={(e) => openReviews(e, false)}>No reviews yet</button>)}
                  {/* Its social performance on X, beside the rating (Kev, 2026-10-31). */}
                  {m.reach && (
                    <span className="iv-reach" title={reachTitle(m.reach)}>
                      <span className="iv-meta-dot" aria-hidden>·</span>𝕏 ♥ {m.reach.core.likes} · ↻ {m.reach.core.reposts} · ❝ {m.reach.core.quotes}
                    </span>
                  )}
                  {/* Only once the viewer has made an image with this prompt (README §5.9). */}
                  {talk && m.canPost && (
                    <button type="button" className="iv-review-plus kit-hit" aria-label="Write a review"
                      title="Write a review · you've made images with this prompt" onClick={(e) => openReviews(e, true)}>
                      <Icon name="plus" size={12} stroke={1.5} />
                    </button>
                  )}
                </div>
                )}
                {/* A guest has no quote, so the badge says Premium without a price (plan Q5). */}
                {m.premium && (
                  <span className="iv-premium" title="Premium prompt · price per image, everything included">
                    Premium{!m.guest && m.perImage && <b>{m.perImage}</b>}
                  </span>
                )}
                {/* Above the History column whenever it shows, so the row ends where the hero does; a toggle once it holds renders. */}
                {railed && (
                  <span className="iv-meta-hist" data-open={shown}>
                    {held ? (
                      <button type="button" className="iv-meta-hist-btn" aria-expanded={historyOpen}
                        aria-label={historyOpen ? "Fold history" : "Open history"} onClick={toggleHistory}>
                        {historyOpen ? "History ›" : "‹"}
                      </button>
                    ) : <span className="iv-meta-hist-label">History</span>}
                  </span>
                )}
              </div>
            )}
            <div className="iv-herorow">
              <div className="iv-hero" ref={hero} style={{ "--hero-ar": Math.max(1, heroRatio) } as CSSProperties}>
                <HeroNav model={m}><MainImage model={m} onOpen={open} onClose={onClose} onRatio={setHeroRatio} /></HeroNav>
              </div>
              {railed && <HistoryStrip model={m} open={shown} onToggle={toggleHistory} />}
            </div>
            <div className="iv-examples" data-history={!railed ? undefined : shown ? "open" : "folded"}>
              {(m.examples.length > 0 || m.community.length > 0) && <span className="iv-examples-label">Examples</span>}
              <PreviewStrip model={m} queue={!railed} />
            </div>
          </section>
        </div>
      </div>
      {viewer && items[at] && (
        <FullscreenViewer items={items.map((x) => ({ key: x.key, src: x.src, thumb: x.thumb, ratio: x.ratio }))} index={at}
          onIndex={(i) => {
            m.seen(items[i]);
            setViewer({ ...viewer, at: i });
          }}
          onClose={(last) => {
            setViewer(null);
            m.select(items[last]);
          }}
          layout="side" nav="thumbs"
          panel={
            <ViewerPanel model={m} shot={items[at]} onAgain={() => setViewer(null)} />
          } />
      )}
      {reviews && (
        <ReviewsPanel model={m} from={reviews.from} hero={reviews.hero} phone={false} compose={reviews.compose} onClose={() => setReviews(null)} />
      )}
    </div>
  );
}
