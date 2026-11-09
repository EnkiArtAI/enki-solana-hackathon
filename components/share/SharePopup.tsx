"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointer, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { siInstagram, siPinterest, siThreads, siTiktok, siX } from "simple-icons";
import { useBetaAccess } from "@/components/BetaGate";
import GeneratorLogo from "@/components/generation/GeneratorLogo";
import { notify } from "@/components/kit/notify";
import { dismissShare, firstMiss, keepStyle, loadStyle, saveStyle, yourStyle, type ShareOffer, type ShareStyle } from "@/lib/share/after-release";
import { caption, captionBlocks, captionOf, contentFrom, sampleContent, type ShareContent } from "@/lib/share/content";
import { DEST, deliver, wantsPng, type Dest } from "@/lib/share/destinations";
import { bgCss, reflow, rn } from "@/lib/share/doc";
import { loadFonts } from "@/lib/share/fonts";
import { cardBlob, closeBitmaps, outputSize, renderCard } from "@/lib/share/render-canvas";
import { cardsFor, setFor, TEMPLATE_FONTS } from "@/lib/share/templates";
import { styleFonts } from "@/lib/share/style";
import { readTokens } from "@/lib/share/tokens";
import { sessionAuthHeaders, viewerHeaders } from "@/lib/session-headers";
import { lockScroll, trapStep } from "@/lib/ui/kit/controls";
import { downloadName, fileId } from "@/lib/ui/kit/format";
import CardView from "./CardView";
import type { EditorStart } from "./editor-state";
import ShareEditor from "./ShareEditor";
import "./share.css";

const brand = (path: string) => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d={path} /></svg>;
const ICON: Record<Dest, ReactNode> = { X: brand(siX.path), Instagram: brand(siInstagram.path), Pinterest: brand(siPinterest.path), Threads: brand(siThreads.path), TikTok: brand(siTiktok.path) };
const ALL_DESTS: Dest[] = ["X", "Instagram", "Pinterest", "Threads", "TikTok"];
const SET_DESTS: Dest[] = ["Instagram"];
const UNREADABLE = "Your images could not be read, so this card cannot be made.";
const NOT_SAVED = "Your style stays for this tab only: it could not be saved to your account.";

/** A format's images, and the PNG the clipboard takes where one is wanted. */
type Made = { files: File[]; png?: Blob } | "failed";

/** A prompt's public answer as a card's content. */
async function promptContent(id: string, handle: string | null | undefined, values?: Record<string, string>[]): Promise<ShareContent> {
  const res = await fetch(`/api/prompts/${id}`, { headers: sessionAuthHeaders() });
  if (!res.ok) throw new Error(String(res.status));
  const content = contentFrom(((await res.json()) as { prompt: Record<string, unknown> }).prompt, handle, location.origin, values);
  if (!content.images.length && !content.poster) throw new Error("no media");
  return content;
}

/** Edit profile's content: the creator's newest released prompt, with its examples; none, or no answer: the labelled sample. */
async function ownContent(handle: string | null | undefined): Promise<ShareContent> {
  try {
    if (handle) {
      const params = new URLSearchParams({ limit: "1", sortBy: "newest", creator: handle, cursor: "0" });
      const res = await fetch(`/api/marketplace/prompts?${params.toString()}`, { headers: viewerHeaders(), credentials: "include" });
      const id = res.ok ? ((await res.json()) as { prompts?: { id?: string }[] }).prompts?.[0]?.id : null;
      if (id) return await promptContent(id, handle);
    }
  } catch { /* the sample stands in */ }
  return sampleContent(handle, location.origin);
}

const onResize = (l: () => void) => { addEventListener("resize", l); return () => removeEventListener("resize", l); };

/** Click, hold and slide the cards with a mouse; a touch scrolls them natively. A flick moves on by its speed; the drag's click never lands (mock v15). */
function swipe(tp: HTMLElement): () => void {
  let end: (() => void) | null = null;
  const down = (ev: PointerEvent) => {
    if (ev.pointerType !== "mouse" || ev.button) return;
    const sx = ev.clientX, sl = tp.scrollLeft;
    let lx = sx, lt = ev.timeStamp, vel = 0, go = false;
    const mv = (p: PointerEvent) => {
      if (!p.buttons) return up(p);
      if (!go) {
        if (Math.abs(p.clientX - sx) < 4) return;
        go = true;
        end?.();
        tp.classList.add("drag");
        tp.setPointerCapture(p.pointerId);
      }
      tp.scrollLeft = sl - (p.clientX - sx);
      const dt = p.timeStamp - lt;
      if (dt > 0) {
        vel = (0.7 * (p.clientX - lx)) / dt + 0.3 * vel;
        lx = p.clientX;
        lt = p.timeStamp;
      }
    };
    const up = (p: PointerEvent) => {
      removeEventListener("pointermove", mv);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      if (!go) return;
      const stop = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
      addEventListener("click", stop, true);
      setTimeout(() => removeEventListener("click", stop, true));
      const t = tp.getBoundingClientRect(), mid = t.left + t.width / 2, fl = p.timeStamp - lt > 80 ? 0 : -vel * 220;
      const dx = [...tp.children].map((c) => { const r = c.getBoundingClientRect(); return r.left + r.width / 2 - mid; });
      const d = dx.reduce((a, b) => (Math.abs(b - fl) < Math.abs(a - fl) ? b : a));
      tp.scrollTo({ left: tp.scrollLeft + d, behavior: "smooth" });
      const finish = () => {
        clearTimeout(q);
        tp.removeEventListener("scrollend", finish);
        tp.classList.remove("drag");
        end = null;
      };
      const q = setTimeout(finish, 800);
      tp.addEventListener("scrollend", finish);
      end = finish;
    };
    addEventListener("pointermove", mv);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };
  tp.addEventListener("pointerdown", down);
  return () => tp.removeEventListener("pointerdown", down);
}

/**
 * The congratulation after a release (mock v15): the prompt's cards to swipe,
 * then "Where to?". Its content comes from the prompt's public answer alone, so
 * a premium prompt's words are not on this page to leak.
 */
export default function SharePopup({ offer }: { offer: ShareOffer }) {
  const { handle, userId } = useBetaAccess();
  const only = !!offer.styleOnly;
  const root = useRef<HTMLDivElement>(null), logo = useRef<HTMLSpanElement>(null), tps = useRef<HTMLDivElement>(null);
  const [c, setC] = useState<ShareContent | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, again] = useReducer((n: number) => n + 1, 0);
  const [screen, setScreen] = useState<"pop" | "share" | "edit">("pop");
  const [yours, setYours] = useState(yourStyle);
  const [isSet, setIsSet] = useState(false);
  const [tpl, setTpl] = useState(0);
  const [dest, setDest] = useState<Dest | null>(null);
  const [sent, setSent] = useState("");
  const [manual, setManual] = useState<string | null>(null);
  const [retry, retried] = useReducer((n: number) => n + 1, 0);
  // The images made so far, by template and format: the effect below keeps its own count, the page reads this copy.
  const files = useRef(new Map<string, Made>());
  const [made, setMade] = useState<ReadonlyMap<string, Made>>(() => new Map());
  const tokens = useMemo(() => readTokens(), []);
  const size = useSyncExternalStore(onResize, () => `${innerWidth} ${innerHeight}`, () => "0 0");
  const [vw, vh] = size.split(" ").map(Number);
  const desk = vw >= 900;

  useEffect(() => {
    let live = true;
    Promise.all([only ? ownContent(handle) : promptContent(offer.promptId, handle, offer.values), loadStyle(userId)])
      .then(async ([content, own]) => {
        await loadFonts([...TEMPLATE_FONTS, ...styleFonts(own)]);
        if (!live) return;
        setYours(own);
        setC(content);
        // From Edit profile a card goes straight to the editor; where a set can be laid out too, the popup asks which.
        if (only && (content.words || content.media !== "image")) setScreen("edit");
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
    // Once per offer; the handle stands by the time a release has gone through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer, attempt]);

  // The editor has its own Esc, in layers.
  const editing = useEffectEvent(() => screen === "edit");
  useEffect(() => {
    const release = lockScroll(document.documentElement, window.innerWidth);
    const before = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editing()) return;
        e.preventDefault();
        e.stopPropagation();
        dismissShare();
        return;
      }
      if (e.key !== "Tab" || !root.current) return;
      // The editor's question holds the keys while it stands.
      const stops = [...(root.current.querySelector(".al") ?? root.current).querySelectorAll<HTMLElement>('button,[role="button"],textarea,input')].filter((n) => !n.closest("[inert]") && n.getClientRects().length);
      if (!stops.length) return;
      e.preventDefault();
      stops[trapStep(stops.indexOf(document.activeElement as HTMLElement), stops.length, e.shiftKey)].focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      release();
      closeBitmaps();
      if (before?.isConnected) before.focus();
    };
  }, []);

  const paid = !c?.words;
  const canSet = !!c && paid && c.media === "image";
  const cards = useMemo(() => (c ? cardsFor(tokens, c, yours[c.media]) : []), [c, tokens, yours]);
  const slides = useMemo(() => (canSet ? setFor(tokens, c, yours.set) : []), [c, tokens, canSet, yours]);
  const list = isSet && canSet ? slides : cards;
  const asSet = isSet && canSet;
  const current = list[Math.min(tpl, list.length - 1)];
  const dests = asSet ? SET_DESTS : ALL_DESTS;
  const keyOf = (ratio: string) => `${asSet ? "set" : tpl}|${ratio}`;
  const blocks = useMemo(() => {
    if (!c || !current) return [];
    return current.bk ? captionOf(c, current.bk) : captionBlocks(c, new Set((asSet ? slides : [current]).flatMap((d) => d.els.map((e) => e.k as string))), asSet);
  }, [c, current, asSet, slides]);

  // Every fitted image is made when "Where to?" opens, one after another: sharing must happen in the press itself.
  useEffect(() => {
    if (screen !== "share" || !c || !current) return;
    let live = true;
    const docs = asSet ? slides : [current];
    void (async () => {
      for (const ratio of [...new Set(dests.map((d) => DEST[d]))]) {
        const key = keyOf(ratio);
        if (files.current.has(key)) continue;
        try {
          const made: File[] = [];
          let png: Blob | undefined;
          for (const [i, d] of docs.entries()) {
            const { w, h } = outputSize(ratio);
            const canvas = await renderCard(d.ratio === ratio ? d : reflow(d, ratio, c.images.length, paid), c, asSet ? i : 0, w, h, logo.current?.querySelector("svg"));
            const blob = await cardBlob(canvas);
            const id = `${fileId(c.images[0]?.full ?? c.poster ?? "")}${docs.length > 1 ? `-${i + 1}` : ""}`;
            made.push(new File([blob], downloadName(c.title, id, blob.type), { type: blob.type }));
            // A PNG that fails leaves the card as it is, and the press says it was not copied.
            if (!asSet && wantsPng(ratio, made)) png = await cardBlob(canvas, "image/png").catch(() => undefined);
            canvas.width = 0;
            if (!live) return;
          }
          files.current.set(key, { files: made, png });
        } catch {
          if (!live) return;
          files.current.set(key, "failed");
        }
        setMade(new Map(files.current));
      }
    })();
    return () => { live = false; };
    // keyOf reads these same values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, c, current, asSet, slides, retry]);

  // The cards: scaled by their distance from the middle, the middle one named, a card chosen stays in the middle.
  const startAt = useEffectEvent(() => tpl);
  useLayoutEffect(() => {
    const tp = tps.current;
    if (!tp) return;
    const row = [...tp.children] as HTMLElement[];
    const on = () => {
      const mid = tp.scrollLeft + tp.clientWidth / 2;
      let best = 0, bd = 1e9;
      row.forEach((n, i) => {
        const d = Math.abs(n.offsetLeft + n.offsetWidth / 2 - mid);
        n.style.scale = String(1 - 0.16 * Math.min(1, d / 200));
        if (d < bd) { bd = d; best = i; }
      });
      setTpl(best);
    };
    tp.addEventListener("scroll", on, { passive: true });
    const n = row[Math.min(startAt(), row.length - 1)];
    if (n) tp.scrollLeft = n.offsetLeft + n.offsetWidth / 2 - tp.clientWidth / 2;
    on();
    const stop = swipe(tp);
    return () => { tp.removeEventListener("scroll", on); stop(); };
  }, [screen, asSet, c, size]);

  // The focus goes in with each screen.
  const opened = !!c;
  useEffect(() => {
    root.current?.querySelector<HTMLElement>(`${only ? '[data-a="pers"],' : ""}[data-a="share"],[data-a="dest"],[data-a="retry"],[data-a="close"]`)?.focus({ preventScroll: true });
  }, [screen, opened, failed, only]);

  const reserve = (desk ? 295 : 298) + (canSet ? 46 : 0);
  const popSize = (v: number) => {
    const h = Math.max(90, Math.min(desk ? 320 : 250, vh - reserve)), w = Math.min(desk ? 250 : 190, h * v);
    return [w, w / v];
  };
  // The card gives way, so a text to copy by hand does not push Back out of the popup.
  const shareBox = (v: number) => {
    const h = Math.min(desk ? 260 : 190, Math.max(90, vh - (desk ? 48 : 16) - (manual ? 347 : 267)));
    const w = Math.min(desk ? 420 : 300, h * v);
    return [w, w / v];
  };
  const stripSize = (v: number, count: number) => {
    const w = Math.min(((desk ? 600 : vw - 40) - 24) / count, (desk ? 150 : 100) * v);
    return [w, w / v];
  };

  const centre = (i: number) => {
    const tp = tps.current, n = tp?.children[i] as HTMLElement | undefined;
    if (tp && n) tp.scrollTo({ left: n.offsetLeft + n.offsetWidth / 2 - tp.clientWidth / 2, behavior: "smooth" });
  };
  const press = (d: Dest) => {
    setDest(d);
    setManual(null);
    const got = made.get(keyOf(DEST[d]));
    if (got === "failed") return setSent(UNREADABLE);
    if (!got) return setSent("Still making your card. Press again in a moment.");
    void deliver(d, got.files, blocks, c!.link, setSent, got.png).then(({ byHand }) => setManual(byHand ? caption(blocks) : null));
  };
  const tryAgain = () => {
    [...files.current].forEach(([k, v]) => { if (v === "failed") files.current.delete(k); });
    setMade(new Map(files.current));
    setSent("");
    retried();
  };
  const readAgain = () => {
    setFailed(false);
    again();
  };
  // What Done kept stands first; what was made from the cards before it no longer says which card it was.
  const kept = (part: ShareStyle, slide: number) => {
    keepStyle(part);
    void saveStyle(part).then((saved) => {
      if (!saved && firstMiss()) notify(NOT_SAVED, { tone: "error" });
      if (saved && only) notify("Your share style is saved.");
    });
    if (only) return dismissShare();
    setYours(yourStyle());
    files.current.clear();
    setMade(new Map());
    setTpl(slide);
    setScreen("pop");
  };
  const toEdit = (): EditorStart => (asSet ? { set: { ov: slides[0], per: slides[1] }, slide: Math.min(tpl, slides.length - 1), bk: slides[0].bk } : { doc: current, bk: current.bk });
  const down = useRef(false);
  const fromBackdrop = (e: ReactPointer) => { down.current = e.target === e.currentTarget; };

  let body: ReactNode;
  if (!c) {
    body = (
      <>
        <div className="h1" id="share-title">{only ? "Your share style" : "Your prompt is live"}</div>
        <div className="p" role="status">{failed ? "Its card could not be made: the prompt did not load." : "Making your card…"}</div>
        {failed && <div className="ac"><button className="pr" type="button" data-a="retry" onClick={readAgain}>Try again</button></div>}
        <button className="bl" type="button" data-a="close" onClick={dismissShare}>Not now</button>
      </>
    );
  } else if (screen === "pop") {
    body = (
      <>
        <div className="h1" id="share-title">{only ? "Your share style" : "Your prompt is live"}</div>
        <div className="p">{only ? `Lay out one card or an Instagram set; every prompt you share fills itself.${c.sample ? " This is sample content." : ""}` : asSet ? (c.images.length > 1 ? "One image with all of them, then one for each image with its setup." : "Your image, then the same image with its setup.") : paid ? (c.variables.length ? "Choose how your post looks. Only your variables and their examples show, the rest stays secret." : "Choose how your post looks. Your prompt's words stay secret.") : "Choose how your post looks, make it yours, then share it anywhere."}</div>
        {canSet && (
          <div className="sg kd">
            <button type="button" className={isSet ? "" : "on"} data-a="kind" data-v="card" onClick={() => { setIsSet(false); setTpl(0); }}>One card</button>
            <button type="button" className={isSet ? "on" : ""} data-a="kind" data-v="set" onClick={() => { setIsSet(true); setTpl(0); }}>Instagram set</button>
          </div>
        )}
        <div className="tps" id="tps" ref={tps}>
          {list.map((d, i) => {
            const [w, h] = popSize(rn(d.ratio));
            return (
              <div className="tc" key={`${asSet}${i}`} role="button" tabIndex={0} aria-label={d.name} data-a="tpl" data-v={i} style={{ width: w, height: h }}
                onClick={() => centre(i)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); centre(i); } }}>
                <CardView doc={d} c={c} w={w} h={h} slide={asSet ? i : 0} />
              </div>
            );
          })}
        </div>
        <div className="cap" id="cap">{current.name}</div>
        <div className="ac">
          <button className={only ? "pr" : ""} type="button" data-a="pers" onClick={() => setScreen("edit")}>Personalize</button>
          {!only && <button className="pr" type="button" data-a="share" onClick={() => { setScreen("share"); setSent(""); setDest(null); setManual(null); }}>Share</button>}
        </div>
        <button className="bl" type="button" data-a="close" onClick={dismissShare}>{only ? "Back" : "Not now"}</button>
      </>
    );
  } else {
    const ratio = dest ? DEST[dest] : current.ratio;
    const fitted = (d: typeof current) => (d.ratio === ratio ? d : reflow(d, ratio, c.images.length, paid));
    const unreadable = [...made.values()].includes("failed");
    const [bw, bh] = shareBox(rn(ratio));
    body = (
      <>
        <div className="h1" id="share-title">Where to?</div>
        <div className="p">{asSet ? `Choose where your ${slides.length} images and your text go.` : "Choose where your card and your text go."}</div>
        {asSet ? (
          <div className="st5" id="st5">
            {slides.map((d, i) => {
              const [w, h] = stripSize(rn(ratio), slides.length);
              return <div className="tc" key={i} style={{ width: w, height: h }}><CardView doc={fitted(d)} c={c} w={w} h={h} slide={i} /></div>;
            })}
          </div>
        ) : (
          <div className="one"><div className="tc" id="stc" style={{ width: bw, height: bh }}><CardView doc={fitted(current)} c={c} w={bw} h={bh} /></div></div>
        )}
        <div className="ds">
          {dests.map((d) => {
            const got = made.get(keyOf(DEST[d]));
            return (
              <button key={d} type="button" className={dest === d ? "on" : ""} data-a="dest" data-v={d} aria-busy={!got} aria-disabled={got === "failed"} onClick={() => press(d)}>
                {ICON[d]}{d}
              </button>
            );
          })}
        </div>
        <div className="sn" role="status">{sent || (unreadable ? UNREADABLE : "")}</div>
        {manual && <textarea className="mt" readOnly value={manual} aria-label="Your text" onFocus={(e) => e.currentTarget.select()} />}
        {unreadable && <button className="bl" type="button" data-a="retry" onClick={tryAgain}>Try again</button>}
        <button className="bl" type="button" data-a="back" onClick={() => { setScreen("pop"); setSent(""); setDest(null); setManual(null); }}>Back</button>
      </>
    );
  }

  return createPortal(
    <div className={`share-fr${desk ? " desk" : ""}`} ref={root}>
      {screen === "edit" && c ? (
        <ShareEditor start={toEdit()} c={c} desk={desk} vw={vw} vh={vh} onBack={() => { if (only && !canSet) dismissShare(); else setScreen("pop"); }} onDone={kept} />
      ) : (
        <>
          <div className="amb" style={{ background: current ? bgCss(current.bg) : undefined }} />
          <div className="dm" onPointerDown={fromBackdrop} onClick={(e) => { if (e.target === e.currentTarget && down.current) dismissShare(); }}>
            <div className="po gl" role="dialog" aria-modal="true" aria-labelledby="share-title">{body}</div>
          </div>
        </>
      )}
      {c?.generator && <span hidden ref={logo}><GeneratorLogo name={c.generator} /></span>}
    </div>,
    document.body,
  );
}
