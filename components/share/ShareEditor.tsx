"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import { AlignCenter, AlignLeft, AlignRight, AlignVerticalDistributeCenter, ArrowUpToLine, Captions, Check, ChevronDown, ChevronLeft, Layers2, MoveVertical, Palette, Plus, Proportions, RotateCw, Trash2, Undo2, Upload } from "lucide-react";
import RatioRect from "@/components/generation/RatioRect";
import Seal from "@/components/kit/Seal";
import type { ShareStyle } from "@/lib/share/after-release";
import { blockText, type ShareContent } from "@/lib/share/content";
import { FORMATS, bgCss, isText, lay, rn, type Arrangement, type ShareDoc } from "@/lib/share/doc";
import { SHARE_FONTS, fontStack } from "@/lib/share/fonts";
import { railKinds } from "@/lib/share/templates";
import { readPalette } from "@/lib/share/tokens";
import { formatCopy } from "@/lib/ui/kit/option-copy";
import CardView from "./CardView";
import { BLOCK, CHIP, blockLabel, label, makeEditor, type EditorStart } from "./editor-state";

const LOOKS = [["both", "Logo + generator"], ["name", "Generator"], ["logo", "Just logo"]] as const;
const ALIGN = { left: AlignLeft, center: AlignCenter, right: AlignRight };
const knob = (a: number) => {
  const t = ((a - 90) * Math.PI) / 180;
  return `translate(${Math.cos(t) * 40}px,${Math.sin(t) * 40}px)`;
};
const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/** Personalize (mock v15): the card to lay out by hand, the live post beside it. Its state and gestures are in editor-state; this is their paint. */
export default function ShareEditor({ start, c, desk, vw, vh, onBack, onDone }: { start: EditorStart; c: ShareContent; desk: boolean; vw: number; vh: number; onBack: () => void; onDone: (part: ShareStyle, slide: number) => void }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const [pal] = useState(readPalette);
  const [ed] = useState(() => makeEditor(start, c, pal, tick));
  const root = useRef<HTMLDivElement>(null);
  const { S } = ed;
  const n = c.images.length, paid = !c.words;

  const v = rn(S.doc.ratio);
  // On a phone a set's thumbnails stand between the top bar and the card.
  const head = !desk && S.sd ? 96 : 64;
  // A finger's rows of tags stand higher, and the card's lower edge has to be reached over them.
  const [aw, ah] = desk ? [vw - 620, vh - 144] : [vw - 36, vh - (matchMedia("(pointer: coarse)").matches ? 202 : 170) - head];
  const cw = Math.min(aw, ah * v), ch = cw / v;
  const left = desk ? 264 + (aw - cw) / 2 : (vw - cw) / 2, top = desk ? 60 + (ah - ch) / 2 : head + (ah - ch) / 2;

  useLayoutEffect(() => { if (root.current) ed.open(root.current); }, [ed]);
  useLayoutEffect(() => ed.place({ desk, vw, vh, cw, ch, top, head, onBack, onDone }));
  useEffect(() => ed.listen(), [ed]);

  const e = ed.cur();
  const shown = S.menu === "font" && S.pf && e ? { ...S.doc, els: S.doc.els.map((x) => (x === e ? { ...x, font: S.pf! } : x)) } : { ...S.doc };
  const { bg } = S.doc;
  const capm = !desk && S.sheet === "caption";
  // On a phone a sheet or a held element stands in the place of the dock and the tags.
  const shut = !desk && (S.drag || !!S.sheet);
  const sets = ed.whole() as { ov: ShareDoc; per: ShareDoc };
  const rail = railKinds(c, S.doc, S.sd ? S.slide : null);

  const post = (close: boolean) => {
    const on = S.bk.map((b, i) => ({ b, i })).filter(({ b }) => blockText(c, b.key));
    const off = on.filter(({ b }) => !b.on && !ed.onCard(b.key));
    return (
      <>
        <div className="ph">
          {c.handle && <span className="av"><Seal handle={c.handle} /></span>}
          {c.handle && `@${c.handle}`}
          {close && <button type="button" data-a="closesheet">Done</button>}
        </div>
        <div className="pz">{S.sd ? `One caption for all ${n + 1} slides. ` : ""}Drag text into order or onto your card. Tap to remove.{paid && c.variables.length ? " Your prompt shows only its variables and examples." : ""}</div>
        <div className="pb">
          {on.filter(({ b }) => b.on).map(({ b, i }) => (
            <div key={b.key} className={cx("bk", BLOCK[b.key], b.key === "prompt" && paid && "vp")} role="button" tabIndex={0} data-b={i} data-k={b.key}>{blockText(c, b.key)}</div>
          ))}
        </div>
        {off.length > 0 && (
          <div className="lo">
            {off.map(({ b, i }) => <button type="button" key={b.key} className={BLOCK[b.key]} data-a="bkon" data-v={i}><Plus aria-hidden />{blockLabel(b.key, c)}</button>)}
          </div>
        )}
      </>
    );
  };

  const AlignIcon = ALIGN[e?.align ?? "left"];
  const swatch = (x: string) => S.doc.bg.mode === "solid" && S.doc.bg.c === x;
  const angle = bg.mode === "gradient" && bg.dir !== "radial" ? bg.dir : 135;
  const mini = Math.min(288, 300 * v);

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label="Your style" tabIndex={-1} className={cx("ed", S.live && "live", S.moving && "moving", S.pushing && "pushing", capm && "capm")} onClick={ed.onClick} onPointerDown={ed.onPointerDown} onPointerOver={ed.onPointerOver}>
      <div className="amb" style={{ background: bgCss(bg) }} />
      <div className="tp">
        <button type="button" className="tb gl bk0" data-a="cancel"><ChevronLeft aria-hidden />Back</button>
        <div className="ttl">{S.sd ? `Slide ${S.slide + 1} of ${n + 1}` : "Your style"}</div>
        <div className="sp">{c.sample && <span className="smp gl">Sample content</span>}</div>
        <button type="button" className="tb ic gl" data-a="undo" aria-label="Undo" aria-disabled={!S.hist.length}><Undo2 aria-hidden /></button>
        <button type="button" className="tb dn" data-a="done">Done</button>
      </div>

      <div className="wr" style={{ left, top, width: cw, height: ch }}>
        <CardView doc={shown} c={c} w={cw} h={ch} slide={S.slide} />
        <div className={cx("gr", S.drag && "on")} />
        {S.guides.map((g) => <div key={g.axis + g.at} className="gu" style={g.axis === "x" ? { left: `${g.at}%`, top: 0, bottom: 0, width: 1 } : { top: `${g.at}%`, left: 0, right: 0, height: 1 }} />)}
        {e && (
          <div className="sb" style={{ left: `${e.x}%`, top: `${e.y}%`, width: `${e.w}%`, height: `${e.h}%`, rotate: `${e.rot || 0}deg` }}>
            <div className={cx("sbt", CHIP[e.k] ?? "p7")}>{label(e.k, c)}</div>
            {["tl", "tr", "bl", "br"].map((h) => <div key={h} className="hd" data-h={h} style={{ left: h[1] === "l" ? 0 : "100%", top: h[0] === "t" ? 0 : "100%" }} />)}
            <div className="rk" data-h="rot"><RotateCw aria-hidden /></div>
          </div>
        )}
        {!e && !S.sheet && <><div className="cv b" data-cv="b" aria-label="Canvas height" /><div className="cv r" data-cv="r" aria-label="Canvas width" /></>}
        <div className={cx("cvl gl", S.edge && "on")}>{FORMATS.includes(S.doc.ratio) ? `${S.doc.ratio} ${formatCopy(S.doc.ratio)!.split(" · ")[0]}` : "Custom"}</div>
      </div>

      {e && !S.sheet && !S.live && (
        <div className="br gl" style={e.k === "gen" ? { flexWrap: "wrap", justifyContent: "center", width: 310 } : undefined}>
          {e.k === "gen" && <div className="gs3">{LOOKS.map(([k, name]) => <button type="button" key={k} className={(e.show ?? "both") === k ? "on" : ""} data-a="show" data-v={k}>{name}</button>)}</div>}
          {isText(e) && e.show !== "logo" && (
            <>
              <button type="button" className="bb fn" data-a="menu" data-v="font" style={{ fontFamily: fontStack(e.font) }}>{e.font}<ChevronDown aria-hidden /></button>
              <div className="bb"><span className="dot" style={{ background: e.color }} /><input type="color" value={e.color} aria-label="Text colour" onChange={(ev) => ed.setColour("text", ev.target.value)} /></div>
              <button type="button" className="bb" data-a="align" aria-label="Align"><AlignIcon aria-hidden /></button>
            </>
          )}
          {e.k === "results" && n > 1 && (["row", "col", "grid", "hero"] as Arrangement[]).map((a) => (
            <button type="button" key={a} className={cx("bb", (e.arr ?? "grid") === a && "on")} data-a="arr" data-v={a} aria-label={a}>
              <span className="ar">{lay(a, n).map((p, i) => <b key={i} style={{ left: `${p[0] * 100 + 2}%`, top: `${p[1] * 100 + 2}%`, width: `${p[2] * 100 - 4}%`, height: `${p[3] * 100 - 4}%` }} />)}</span>
            </button>
          ))}
          {e.k === "results" && <button type="button" className={cx("bb", !!e.gap && "on")} data-a="gap" aria-label="Gaps"><AlignVerticalDistributeCenter aria-hidden /></button>}
          <button type="button" className="bb" data-a="front" aria-label="Bring to front"><ArrowUpToLine aria-hidden /></button>
          <button type="button" className="bb" data-a="trash" aria-label="Remove"><Trash2 aria-hidden /></button>
        </div>
      )}

      <div className={cx("dk gl", shut && "off")} inert={shut}>
        <button type="button" className={cx("db", S.menu === "format" && "on")} data-a="menu" data-v="format"><Proportions aria-hidden />Format</button>
        <button type="button" className={cx("db", S.sheet === "bg" && "on")} data-a="sheet" data-v="bg"><Palette aria-hidden />Background</button>
        <button type="button" className={cx("db cp", S.sheet === "caption" && "on")} data-a="sheet" data-v="caption"><Captions aria-hidden />Caption</button>
        <button type="button" className="db" data-a="ov">{S.doc.ov ? <Layers2 aria-hidden /> : <MoveVertical aria-hidden />}{S.doc.ov ? "Overlap" : "Make room"}</button>
      </div>
      <div className={cx("tst gl", S.toastOn && "on")} role="status">{S.toast}</div>

      <div className={cx("tg", shut && "off")} inert={shut}>
        <div className="rh">Drag onto your card</div>
        {rail.map((k) => <button type="button" key={k} className={`tg1 ${CHIP[k] ?? "p7"}`} data-tag={k}>{label(k, c)}</button>)}
        <label className="tg1 nu"><Upload aria-hidden />Your image<input type="file" accept="image/*" aria-label="Upload your image" onChange={ed.onFile} /></label>
      </div>

      {desk && (
        <div className="pn gl">
          <div>{post(false)}</div>
          <div className="tc pm" style={{ width: mini, height: mini / v }}><CardView doc={shown} c={c} w={mini} h={mini / v} slide={S.slide} /></div>
        </div>
      )}

      {S.sd && (
        <div className={cx("sl", S.drag && "off")} style={desk ? { left: 264 + aw / 2 } : undefined}>
          {[...Array(n + 1).keys()].map((i) => {
            const d = i ? sets.per : sets.ov, tv = rn(d.ratio), tw = Math.min(desk ? 40 : 24, (desk ? 50 : 30) * tv);
            return <button type="button" key={i} className={cx("s1", i === S.slide && "on")} data-a="slide" data-v={i} aria-label={`Slide ${i + 1}`} style={{ width: tw, height: tw / tv, ...(desk ? null : { marginInline: (44 - tw) / 2 - 2 }) }}><CardView doc={{ ...d }} c={c} w={tw} h={tw / tv} slide={i} /></button>;
          })}
        </div>
      )}

      {S.ask && (
        <div className="al">
          <div className="ab gl" role="alertdialog" aria-modal="true" aria-labelledby="share-ask">
            <div className="h" id="share-ask">Go back without saving?</div>
            <div className="t">Your latest changes to this card will be lost.</div>
            <div className="r"><button type="button" data-a="askno">Keep editing</button><button type="button" className="red" data-a="askyes">Go back</button></div>
          </div>
        </div>
      )}

      <div className={cx("ts gl", S.drag && "on", S.hot && "hot")} style={{ ...(desk ? { left: 264 + aw / 2 } : null), "--n": S.near } as CSSProperties}><Trash2 aria-hidden /></div>

      <div className={cx("sh gl", S.sheet === "bg" && "up")} inert={S.sheet !== "bg"}>
        <div className="gb" />
        <div className="st">Background<button type="button" data-a="closesheet">Done</button></div>
        <div className="sg">
          <button type="button" className={bg.mode === "solid" ? "on" : ""} data-a="bgm" data-v="solid">Solid</button>
          <button type="button" className={bg.mode === "gradient" ? "on" : ""} data-a="bgm" data-v="gradient">Gradient</button>
        </div>
        {bg.mode === "solid" ? (
          <div className="sw">
            {pal.solids.map((x) => <button type="button" key={x} className={swatch(x) ? "on" : ""} style={{ background: x }} data-a="solid" data-v={x} aria-label={x} />)}
            <div className="rb"><input type="color" value={bg.c} aria-label="Your colour" onChange={(ev) => ed.setColour("c", ev.target.value)} /></div>
          </div>
        ) : (
          <>
            <div className="sw">
              {pal.grads.map((g, i) => <button type="button" key={i} className={g[0] === bg.a && g[1] === bg.b ? "on" : ""} style={{ background: `linear-gradient(135deg,${g[0]},${g[1]})` }} data-a="grad" data-v={i} aria-label={`Gradient ${i + 1}`} />)}
            </div>
            <div className="gw">
              <div className="dl" style={{ background: bgCss(bg) }}><div className="kn" style={{ transform: knob(angle), opacity: bg.dir === "radial" ? 0.25 : undefined }} /></div>
              <div className="gs">
                <div className="sr"><span className="dot" style={{ background: bg.a }} />From<input type="color" value={bg.a} aria-label="From colour" onChange={(ev) => ed.setColour("a", ev.target.value)} /></div>
                <div className="sr"><span className="dot" style={{ background: bg.b }} />To<input type="color" value={bg.b} aria-label="To colour" onChange={(ev) => ed.setColour("b", ev.target.value)} /></div>
                <button type="button" className={cx("rd", bg.dir === "radial" && "on")} data-a="radial">Radial</button>
              </div>
            </div>
          </>
        )}
      </div>
      {!desk && <div className={cx("sh gl capt", capm && "up")} inert={!capm}>{post(true)}</div>}

      {S.menu === "format" && (
        <div className="mn gl fm">
          <div className="mh">Format. Your card rearranges itself.</div>
          {FORMATS.map((f) => {
            const [name, use] = formatCopy(f)!.split(" · ");
            return (
              <button type="button" key={f} className="mr" data-a="ratio" data-v={f}>
                <span className="bx"><RatioRect ratio={f} size={22} /></span>
                <span><span className="n">{f} {name}</span><span className="d">{use}</span></span>
                {S.doc.ratio === f && <Check className="ck" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
      {S.menu === "font" && e && (
        <div className="mn gl dwn">
          <div className="mh">Font</div>
          {SHARE_FONTS.map(([f]) => <button type="button" key={f} className="mr fnt" data-a="font" data-v={f} data-pf={f} style={{ fontFamily: fontStack(f) }}>{f}{e.font === f && <Check className="ck" aria-hidden />}</button>)}
        </div>
      )}
    </div>
  );
}
