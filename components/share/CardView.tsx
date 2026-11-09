"use client";

import { memo, useMemo } from "react";
import { Play } from "lucide-react";
import GeneratorLogo from "@/components/generation/GeneratorLogo";
import Seal from "@/components/kit/Seal";
import { blocksFor, type ShareContent } from "@/lib/share/content";
import { bgCss, isText, tileRects, type El, type ShareDoc } from "@/lib/share/doc";
import { fontStack, fontWeight, fontsArrived, measurer } from "@/lib/share/fonts";
import { fitEl, lineX, type FitLine } from "@/lib/share/text-layout";

/** One text element: the lines text-layout broke, each in its place, so the export (render-canvas) draws the same ones. */
function TextEl({ e, ratio, c, slide, f }: { e: El; ratio: string; c: ShareContent; slide: number; f: number }) {
  // The editor paints on every pointer move; a box only refits when its size or words change, or a font comes in.
  const arrived = fontsArrived();
  const fit = useMemo(() => fitEl(e, ratio, blocksFor(e, c, slide), measurer(e.font)), [e.k, e.show, e.w, e.h, e.font, ratio, c, slide, arrived]); // eslint-disable-line react-hooks/exhaustive-deps
  const line = (l: FitLine, i: number) => {
    const x = lineX(l, fit.boxW, e.align) * f, icon = { left: x, top: l.top * f, width: 1.3 * l.size * f, height: 1.3 * l.size * f };
    return (
      <span key={i}>
        {e.k === "handle" && c.handle && <span className="av" style={icon}><Seal handle={c.handle} /></span>}
        {e.k === "gen" && e.show !== "name" && c.generator && <span className="lg" style={icon}><GeneratorLogo name={c.generator} /></span>}
        {l.text && (
          <span className={`ln${l.mark ? ` ${l.mark}` : ""}`} style={{ left: x + l.lead * f, top: l.top * f, height: l.height * f, lineHeight: `${l.height * f}px`, fontSize: l.size * f, opacity: l.opacity < 1 ? l.opacity : undefined }}>
            {l.text}
          </span>
        )}
      </span>
    );
  };
  const groups = [...new Set(fit.lines.map((l) => l.group))];
  return (
    <span className="fb">
      {groups.map((g) => {
        const own = fit.lines.filter((l) => l.group === g);
        return g === undefined ? own.map(line) : <span className="vw" key={g}>{own.map(line)}</span>;
      })}
    </span>
  );
}

function MediaEl({ e, c, slide, w, h }: { e: El; c: ShareContent; slide: number; w: number; h: number }) {
  if (e.k === "results") {
    return tileRects(e, c.images.length, w, h).map((t, i) => (
      <div className="tl" key={i} style={{ left: t.x, top: t.y, width: t.w, height: t.h, borderRadius: t.radius }}>
        <img src={c.images[i].src} alt="" draggable={false} />
      </div>
    ));
  }
  const src = e.k === "one" ? c.images[slide - 1]?.src : e.k === "clip" ? c.poster : e.src;
  return (
    <div className="m">
      {src && <img src={src} alt="" draggable={false} />}
      {e.k === "clip" && <span className="play" data-play=""><Play aria-hidden fill="currentColor" /></span>}
    </div>
  );
}

/**
 * A share card on the page (the mock's paint and setEl). w and h are its size in
 * pixels; `slide` is its place in an Instagram set, 0 outside one.
 */
export default memo(function CardView({ doc, c, w, h, slide = 0 }: { doc: ShareDoc; c: ShareContent; w: number; h: number; slide?: number }) {
  return (
    <div className="cd" style={{ background: bgCss(doc.bg) }}>
      {doc.els.map((e) => (
        <div key={e.id} className={`el${isText(e) ? " txb" : ""}`} data-id={e.id} data-k={e.k}
          style={{ left: `${e.x}%`, top: `${e.y}%`, width: `${e.w}%`, height: `${e.h}%`, rotate: `${e.rot ?? 0}deg`, ...(isText(e) ? { fontFamily: fontStack(e.font), fontWeight: fontWeight(e.font), color: e.color } : null) }}>
          {isText(e) ? <TextEl e={e} ratio={doc.ratio} c={c} slide={slide} f={w / 1000} /> : <MediaEl e={e} c={c} slide={slide} w={w} h={h} />}
        </div>
      ))}
    </div>
  );
});
