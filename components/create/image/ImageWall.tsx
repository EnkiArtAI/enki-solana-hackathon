"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Copy, Loader2 } from "lucide-react";
import JobTile from "@/components/kit/JobTile";
import { justifyRows, ROW_GAP, rowTarget } from "@/components/gallery/justify";
import { tileState, type WallItem } from "@/lib/ui/create/image";
import type { ImageSetup } from "@/lib/ui/image-view/setups";
import type { Job } from "@/lib/ui/kit/render-queue";
import TileActions, { type TileActs } from "./TileActions";

const LABEL = { waiting: "Your render, waiting to be sent", running: "Your render, rendering", failed: "Your render, failed" } as const;

/**
 * The wall above the bar: the viewer's images in the profile's rows (Kev, 2026-10-30: "wo die die gleiche höhe bekommen
 * und sich halt anpassen"; justifyRows, as GalleryWall), from the top left, newest first (Kev, 2026-11-09: "das sollte ganz oben links gezeigt werden"). A job
 * still in line is a grey spinner with its X, one sent the lit spinner, a failed one red with Copy prompt; a finished
 * one carries its actions (TileActions) and opens in the viewer on a click, as the profile's pictures do. A short last row starts at the
 * left. The next page loads as the end comes into view.
 */
export default function ImageWall({ root: wall, items, state, onOpen, acts, onCancel, onCopy }: {
  /** The wall itself: where a notice's render is looked for while it can be seen (useOpenRender). */
  root: RefObject<HTMLDivElement | null>;
  items: WallItem[];
  state: { loading: boolean; failed: boolean; retry: () => void; more: boolean; loadingOlder: boolean; loadOlder: () => void };
  onOpen: (item: WallItem) => void;
  acts: TileActs;
  onCancel: (job: Job<ImageSetup>) => void;
  onCopy: (job: Job<ImageSetup>) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Each picture's own ratio once it has loaded; the one it asked for until then.
  const [ratios, setRatios] = useState<Record<string, number>>({});
  useEffect(() => {
    const el = wall.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [wall]);
  const { more, loadingOlder, loadOlder } = state;
  useEffect(() => {
    const el = end.current;
    if (!el || !more || loadingOlder) return;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      loadOlder();
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, loadingOlder, loadOlder]);

  const rows = useMemo(
    () => justifyRows(items.map((it) => ({ it, ratio: ratios[it.key] ?? it.ratio ?? 1 })), width, rowTarget(width), ROW_GAP),
    [items, ratios, width],
  );
  const measured = (key: string) => (e: { currentTarget: HTMLImageElement }) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    if (h && ratios[key] !== w / h) setRatios((r) => ({ ...r, [key]: w / h }));
  };

  return (
    <div ref={wall} className="ci-wall">
      {items.length === 0 ? (
        <div className="ci-empty">
          {state.loading ? <Loader2 size={22} className="ci-spin" aria-label="Loading your images" />
            : state.failed ? <><p>Your images could not load.</p><button type="button" className="ci-retry kit-hit" onClick={state.retry}>Try again</button></>
            : <><p className="kit-title">What will you make?</p><p>Describe an image below. It appears here as it renders.</p></>}
        </div>
      ) : (
        <div className="ci-rows">
          {rows.map((row, i) => (
            <div key={i} className="ci-row" style={{ height: row.height }}>
              {row.items.map(({ it, ratio }) => {
                const job = it.job;
                const look = it.kind === "job" ? tileState(it.job) : "ready";
                if (look !== "ready" && job) {
                  return (
                    <JobTile key={it.key} status={job.status} sent={job.sent} ratio={job.setup.aspectRatio} height={row.height} seen
                      label={LABEL[look]} onCancel={look === "waiting" ? () => onCancel(job) : undefined}>
                      {look === "failed" && (
                        <button type="button" className="ci-copy kit-hit" aria-label="Copy prompt" title={job.error?.message ?? "Render failed"} onClick={() => onCopy(job)}>
                          <Copy size={13} aria-hidden /><span>Copy prompt</span>
                        </button>
                      )}
                    </JobTile>
                  );
                }
                return (
                  <div key={it.key} className="ci-shot" style={{ width: row.height * ratio }}>
                    <button type="button" className="ci-open" aria-label="Open" onClick={() => onOpen(it)}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- our own image, any size */}
                      <img src={it.src} alt="Your image" loading="lazy" decoding="async" draggable={false} onLoad={measured(it.key)} />
                    </button>
                    <TileActions item={it} width={row.height * ratio} height={row.height} acts={acts} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div ref={end} className="ci-more">{state.loadingOlder && <Loader2 size={18} className="ci-spin" aria-hidden />}</div>
    </div>
  );
}
