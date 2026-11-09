"use client";

import { useEffect, useRef, type UIEvent } from "react";
import JobTile from "@/components/kit/JobTile";
import { jobSaid } from "@/lib/ui/image-view/setups";
import { formatAgo } from "@/lib/ui/kit/format";
import type { ImageViewModel, Shot } from "./useImageViewModel";

/** This tab's renders lead from the moment they start; a recorded one is already among the history under the same key. */
export function railItems(queue: Shot[], history: Shot[]): Shot[] {
  const listed = new Set(history.map((s) => s.key));
  return [...queue.filter((s) => !listed.has(s.key)), ...history];
}

/** How far from the end a scroll asks for older renders (S:362-366). */
const NEAR_END_PX = 160;

/** A render's line: how long ago it was made, or where a render of this tab stands. */
export const renderWhen = (s: Shot, now: number) =>
  s.createdAt ? formatAgo(s.createdAt, now)
    : s.job?.status === "rendering" ? "Rendering…" : s.job?.status === "failed" ? "Failed" : "Just now";

/**
 * The viewer's own renders of this prompt beside the hero (handoff §5.10):
 * 64 px of 60 px squares, newest first, this tab's renders leading from the
 * moment they start (Kev, 2026-10-13), older ones loading as it nears its end;
 * folded, a 26 px "History · N" that opens it again. With none yet it stands
 * open and says so (DEC-504): it only folds once it holds renders.
 */
export default function HistoryStrip({ model: m, open, onToggle }: { model: ImageViewModel; open: boolean; onToggle: () => void }) {
  const st = m.historyState;
  const items = railItems(m.queue, m.history);
  const list = useRef<HTMLDivElement>(null);
  // A new render starts at the top: it comes back into view.
  const count = m.jobs.length;
  useEffect(() => {
    list.current?.scrollTo({ top: 0 });
  }, [count]);
  const newest = m.jobs[0];
  const near = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (st.more && !st.loadingOlder && el.scrollTop + el.clientHeight > el.scrollHeight - NEAR_END_PX) st.loadOlder();
  };

  return (
    <aside className="iv-hstrip" data-open={open} aria-label="History">
      {open ? (
        <div ref={list} className="iv-hstrip-list kit-noscroll" onScroll={near}>
          {items.map((s) => (
            s.job ? (
              <JobTile key={s.key} status={s.job.status} sent={s.job.sent} src={s.thumb ?? s.src} ratio="1:1" height={60}
                seen={s.job.seen} selected={m.main?.key === s.key} label={`Your render, ${jobSaid(s.job)}`}
                onClick={() => m.select(s)} onCancel={() => m.cancel(s)} />
            ) : (
              <button key={s.key} type="button" className="iv-hstrip-pick" aria-pressed={m.main?.key === s.key}
                aria-label={`Your render · ${renderWhen(s, m.now)}`} title={`Your render · ${renderWhen(s, m.now)}`} onClick={() => m.select(s)}>
                <img src={s.thumb} alt="" loading="lazy" decoding="async" draggable={false} />
              </button>
            )
          ))}
          {st.loadingOlder && <span className="iv-hstrip-note" role="status">…</span>}
          {st.failed && <button type="button" className="iv-link iv-hstrip-note" onClick={st.retry}>Retry</button>}
          {/* Only once it is known: not while the first read runs, nor while older rows are still unread. */}
          {!items.length && !st.failed && !st.loading && !st.more && (
            <>
              <span className="iv-hstrip-ghost" aria-hidden />
              <span className="iv-hstrip-note iv-hstrip-hint">Your renders land here</span>
            </>
          )}
        </div>
      ) : (
        <button type="button" className="iv-hstrip-fold" aria-label="Open history" onClick={onToggle}>History{items.length ? ` · ${items.length}` : ""}</button>
      )}
      <span className="iv-sr" role="status">{!newest ? "" : newest.status === "rendering" ? "Rendering…" : `Render ${jobSaid(newest)}`}</span>
    </aside>
  );
}
