"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/enki-shell/icons";
import { openCreator } from "@/lib/openCreator";
import { openLogin } from "@/lib/openLogin";
import { countLabel, type CommentRow } from "@/lib/ui/image-view/discussion";
import { reviewsBox, reviewsOrigin } from "@/lib/ui/image-view/reviews-box";
import type { Rect } from "@/lib/ui/image-view/zoom";
import { formatAgo } from "@/lib/ui/kit/format";
import Seal from "@/components/kit/Seal";
import type { ImageViewModel } from "./useImageViewModel";

/** The morph out, as the CSS runs it. */
const OUT_MS = 240;
/** The own renders a review may show: the newest twelve (S:278). */
const PICKS = 12;

const plural = (n: number, capped: boolean, word: string) => `${countLabel(n, capped)} ${word}${n === 1 && !capped ? "" : "s"}`;

/**
 * Reviews and comments in one panel (handoff §5.16, README §5.9), morphing out
 * of the rating that opened it: over the hero on desktop, over nearly the whole
 * frame on a phone. Writing takes two steps, stars and words, then one of the
 * viewer's renders of this prompt or None; it opens only once they have made
 * one (README §5.9). A review is a row with an image (Kev, 2026-10-13), a
 * comment one without.
 */
export default function ReviewsPanel({ model: m, from, hero, phone, compose = false, onClose }: {
  model: ImageViewModel;
  /** The rating button's rect: the morph's origin. */
  from: Rect;
  /** The hero's rect on desktop, where the panel lies. */
  hero: Rect | null;
  phone: boolean;
  /** Open straight into the composer (the "+"). */
  compose?: boolean;
  onClose: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const [step, setStep] = useState<"write" | "pick" | null>(compose && m.canPost ? "write" : null);
  const [stars, setStars] = useState(0);
  const [text, setText] = useState("");
  // The render the review shows; undefined is the newest, null is None.
  const [pick, setPick] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const done = useEffectEvent(onClose);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(done, OUT_MS);
    return () => clearTimeout(t);
  }, [leaving]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setLeaving(true);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const frame = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const box = reviewsBox(frame, hero, phone);
  const origin = reviewsOrigin(frame, box, from);
  const { data, error, retry } = m.discussion;
  const rows = data ? [...data.reviews, ...data.comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  const own = m.reviewable.slice(0, PICKS);
  const chosen = pick === undefined ? own[0] ?? null : own.find((x) => x.record?.id === pick) ?? null;
  const close = () => setLeaving(true);
  const reset = () => { setStep(null); setStars(0); setText(""); setPick(undefined); };
  const send = async () => {
    const body = text.trim();
    if (busy || (!chosen && !body)) return;
    setBusy(true);
    const ok = await m.post(chosen?.record
      ? { imageId: chosen.record.id, ...(stars ? { rating: stars } : {}), ...(body ? { body } : {}) }
      : { body });
    setBusy(false);
    if (ok) reset();
  };

  return createPortal(
    <div className="iv-rv" data-leaving={leaving || undefined}>
      <div className="iv-rv-backdrop" onClick={close} />
      <section className="iv-rv-panel" data-phone={phone || undefined} role="dialog" aria-modal="true" aria-label="Reviews"
        style={{ left: box.left, top: box.top, width: box.width, height: box.height, transformOrigin: `${origin.x}px ${origin.y}px` }}>
        <header className="iv-rv-head">
          {data?.avgRating != null ? (
            <>
              <span className="iv-rv-star" aria-hidden>★</span>
              <b className="iv-rv-avg">{data.avgRating.toFixed(1)}</b>
              <span className="iv-rv-counts">{plural(data.reviews.length, data.capped, "review")} · {plural(data.comments.length, data.capped, "comment")}</span>
            </>
          ) : <b className="iv-rv-avg">Reviews</b>}
          <span className="iv-rv-space" />
          {m.canPost && !step && (
            <button type="button" className="iv-rv-write" onClick={() => setStep("write")}>
              <Icon name="plus" size={13} stroke={1.5} />Write a review
            </button>
          )}
          <button type="button" className="iv-rv-close kit-hit" aria-label="Close" onClick={close}>
            <Icon name="x" size={14} stroke={1.5} />
          </button>
        </header>
        <div className="iv-rv-body">
          {step === "write" && (
            <div className="iv-rv-card">
              <span className="iv-rv-card-title">Your review</span>
              <span className="iv-rv-stars" role="radiogroup" aria-label="Your rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={`${n} star${n === 1 ? "" : "s"}`}
                    className="iv-star" data-on={n <= stars || undefined} onClick={() => setStars(stars === n ? 0 : n)}>★</button>
                ))}
              </span>
              <textarea className="iv-rv-text" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)}
                aria-label="Your review" placeholder="How did it turn out? Any tips for others?" />
              <div className="iv-rv-acts">
                <button type="button" className="iv-rv-btn" onClick={reset}>Cancel</button>
                <button type="button" className="iv-rv-btn" data-primary disabled={!text.trim() && !stars} onClick={() => setStep("pick")}>Send</button>
              </div>
            </div>
          )}
          {step === "pick" && (
            <div className="iv-rv-card">
              <span className="iv-rv-card-title">Add one of your images</span>
              <span className="iv-rv-hint">Only images you made with this prompt.</span>
              <div className="iv-rv-picks" role="radiogroup" aria-label="The image your review shows">
                {own.map((x) => (
                  <button key={x.key} type="button" role="radio" aria-checked={chosen === x} className="iv-rv-pick"
                    onClick={() => setPick(x.record?.id ?? null)}>
                    <img src={x.thumb} alt="" draggable={false} />
                  </button>
                ))}
                <button type="button" role="radio" aria-checked={chosen === null} className="iv-rv-pick iv-rv-none" onClick={() => setPick(null)}>None</button>
              </div>
              <div className="iv-rv-acts iv-rv-acts--split">
                <button type="button" className="iv-rv-btn" onClick={() => setStep("write")}>Back</button>
                <button type="button" className="iv-rv-btn" data-primary disabled={busy || (!chosen && !text.trim())} onClick={() => void send()}>
                  {chosen ? "Post review" : "Post comment"}
                </button>
              </div>
            </div>
          )}
          {error && <p className="iv-rv-note">{error} <button type="button" className="iv-link" onClick={retry}>Try again</button></p>}
          {!data && !error && <p className="iv-rv-note">Loading…</p>}
          {rows.map((r) => <Entry key={r.id} row={r} now={m.now} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />)}
          {data && !rows.length && !step && (
            <div className="iv-rv-empty">
              <span className="iv-rv-empty-title">No reviews yet</span>
              {m.canPost ? (
                <>
                  <span className="iv-rv-hint">You&apos;ve made images with this prompt. Be the first to say how it went.</span>
                  <button type="button" className="iv-rv-btn" data-primary onClick={() => setStep("write")}>Write the first review</button>
                </>
              ) : m.guest ? (
                <button type="button" className="iv-rv-btn" data-primary onClick={() => openLogin()}>Sign in to review</button>
              ) : (
                <span className="iv-rv-hint">Make an image with this prompt first. Then you can leave a review.</span>
              )}
            </div>
          )}
          {data?.capped && <p className="iv-rv-note">Showing the newest 100</p>}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function Entry({ row, now, open, onToggle }: { row: CommentRow; now: number; open: boolean; onToggle: () => void }) {
  return (
    <article className="iv-rv-entry" data-open={open || undefined} onClick={onToggle}>
      <span className="iv-av" aria-hidden><Seal handle={row.handle} /></span>
      <div className="iv-rv-main">
        <div className="iv-rv-line">
          {row.handle === "anonymous" ? <span className="iv-rv-who">{row.handle}</span> : (
            <button type="button" className="iv-rv-who" onClick={(e) => { e.stopPropagation(); openCreator(row.handle); }}>{row.handle}</button>
          )}
          {typeof row.rating === "number" && <span className="iv-rv-rated" aria-label={`${row.rating} of 5`}>{"★".repeat(row.rating)}</span>}
          <span className="iv-rv-when">{formatAgo(row.createdAt, now, "short")}</span>
        </div>
        {row.body && <p className="iv-rv-say">{row.body}</p>}
        {row.imageUrl && <img className="iv-rv-img" src={row.imageUrl} alt="" draggable={false} />}
      </div>
    </article>
  );
}
