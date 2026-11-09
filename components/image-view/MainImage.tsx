"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { parseRatio } from "@/lib/ui/kit/ratio";
import { knownRatio, ratioKey, rememberRatio } from "@/lib/ui/image-view/known-ratio";
import { metaOf, useAgain, type ImageViewModel, type Shot } from "./useImageViewModel";
import RefThumbs from "./RefThumbs";
import StageVideo from "./StageVideo";

/**
 * The image on the stage, as large as the area allows and never squashed:
 * its box is min(100cqh, 100cqw / ratio) of a size container (handoff §2).
 * A finished image opens the viewer; a render shows its spinner, a failed
 * one what happened and, when nothing can have been charged, Retry at its
 * own price. A video prompt's example plays here (StageVideo). The X leaves the
 * page. Someone's public image shows the references its owner shares above its
 * label (DEC-514). onRatio hears the picture's ratio, so the hero can take a
 * wide one's shape.
 */
export default function MainImage({ model: m, onOpen, onClose, phone = false, onRatio }: {
  model: ImageViewModel;
  onOpen: (shot: Shot) => void;
  onClose: () => void;
  phone?: boolean;
  onRatio?: (ratio: number) => void;
}) {
  // A picture's own ratio, once it has loaded, or once one of its tiles has (known-ratio); the asked one until then.
  const [natural, setNatural] = useState<Record<string, number>>({});
  const s = m.main;
  const job = s?.job;
  const src = s?.stage ?? s?.src;
  const ratio = (src && natural[src]) || (s && knownRatio(ratioKey(s))) || parseRatio(s ? s.ratio : m.ratio) || 1;
  const meta = s && metaOf(s, m.now);
  const retry = useAgain(m, job?.status === "failed" ? job : undefined);
  useEffect(() => { onRatio?.(ratio); }, [ratio, onRatio]);

  return (
    <div className="iv-stage">
      <div className="iv-box" data-state={job && job.status !== "ready" ? job.status : undefined} style={{ "--ar": ratio } as CSSProperties}>
        {!s ? (
          // The blank composer waits for its first render; a prompt without
          // any image (no creator example, nothing made with it) says so.
          m.blank ? <p className="iv-empty">Your image shows up here</p>
            : m.status === "ready" && <p className="iv-empty">This prompt has no images yet · generate the first one</p>
        ) : job?.status === "rendering" ? (
          <span className="iv-ring" role="status" aria-label="Rendering" />
        ) : job?.status === "failed" ? (
          <div className="iv-fail">
            <span className="iv-bang" aria-hidden>!</span>
            <span>{job.error?.message}</span>
            {retry && (
              <button type="button" className="iv-retry kit-hit" disabled={!retry.ready} onClick={retry.press}>
                ⟳ {retry.label}{retry.price && ` · ${retry.price}`}
              </button>
            )}
          </div>
        ) : s.video ? (
          <StageVideo files={s.video} label={`Video: ${m.title}`} onSeen={() => m.seen(s)} />
        ) : src && (
          <button type="button" className="iv-open" aria-label="Open fullscreen" onClick={() => onOpen(s)}>
            <img src={src} alt="" draggable={false}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                rememberRatio(ratioKey(s), w, h);
                if (w && h) setNatural((n) => (n[src] === w / h ? n : { ...n, [src]: w / h }));
                m.seen(s);
              }} />
          </button>
        )}
        {s?.references && <RefThumbs refs={s.references} phone={phone} className="iv-refs" />}
        {meta && <span className="iv-meta">{meta}</span>}
      </div>
      <button type="button" className="iv-x kit-hit" aria-label="Close" title="Close" onClick={onClose}>
        <X size={14} strokeWidth={2.2} aria-hidden />
      </button>
    </div>
  );
}
