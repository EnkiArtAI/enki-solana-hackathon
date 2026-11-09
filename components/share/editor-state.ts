import type { ChangeEvent, MouseEvent as ReactMouse, PointerEvent as ReactPointer } from "react";
import { flushSync } from "react-dom";
import { readReference } from "@/hooks/useReferenceReads";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { failureSentence } from "@/lib/search/client";
import type { ShareStyle } from "@/lib/share/after-release";
import { postBlocks, type CaptionKey, type PostBlock, type ShareContent } from "@/lib/share/content";
import { FORMATS, keptOn, magnet, natural, newEl, pushAway, reflow, rn, room, settle, tidy, type Arrangement, type El, type ElKind, type Guide, type ShareDoc } from "@/lib/share/doc";
import { SHARE_FONTS, loadFonts } from "@/lib/share/fonts";
import type { NamedDoc } from "@/lib/share/templates";
import { inkOn, type Palette } from "@/lib/share/tokens";

export type Sheet = "bg" | "caption";
export type Menu = "format" | "font";
/** What the editor works on: one card, or a set's two designs on the slide it was opened at. */
export type EditorStart = { doc: NamedDoc; bk?: PostBlock[] } | { set: { ov: NamedDoc; per: NamedDoc }; slide: number; bk?: PostBlock[] };

export type State = {
  doc: ShareDoc;
  sd: { ov: ShareDoc; per: ShareDoc } | null;
  sh: { ov: string[]; per: string[] };
  slide: number;
  hist: string[];
  bk: PostBlock[];
  base: string;
  sel: number | null;
  sheet: Sheet | null;
  menu: Menu | null;
  /** The font under the pointer in the font menu. */
  pf: string | null;
  ask: boolean;
  drag: boolean;
  live: boolean;
  moving: boolean;
  pushing: boolean;
  hot: boolean;
  near: number;
  guides: Guide[];
  edge: boolean;
  toast: string;
  toastOn: boolean;
  /** What the other background mode last held. */
  mem: { c: string; a: string; b: string; dir: number | "radial" };
};

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
let uid = 1000;
/** A style's document with fresh element ids, no name and no caption on it. */
const plain = (d: NamedDoc): ShareDoc => ({ ratio: d.ratio, bg: clone(d.bg), ...(d.ov ? { ov: true } : null), els: d.els.map((e) => ({ ...clone(e), id: uid++ })) });

export const label = (k: ElKind, c: ShareContent) => {
  const n = c.images.length;
  const names: Partial<Record<ElKind, string>> = { title: "Title", desc: "Short description", prompt: c.words ? "Full prompt" : "Variables", setup: "Image setup", gen: "Generator", link: "Link", tags: "Hashtags", handle: "Your handle", one: "This image", clip: "Animation", up: "Your image", results: ["The image", "Two images", "Three images", "Four images"][n - 1] ?? `${n} images` };
  return names[k] ?? k;
};
export const blockLabel = (key: CaptionKey, c: ShareContent) => (key === "prompt" ? (c.words ? "Prompt" : "Variables") : label(key, c));
export const CHIP: Partial<Record<ElKind, string>> = { setup: "p2", one: "p7", title: "p0", desc: "p1", prompt: "p2", link: "p3", tags: "p4", handle: "p5", gen: "p6", results: "p7", clip: "p7", up: "p7" };
export const BLOCK: Record<CaptionKey, string> = { title: "p0", desc: "p1", prompt: "p2", link: "p3", tags: "p4" };
const SNAPS = [0, 45, 90, 135, 180, -45, -90, -135, -180, -270];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** share.css cuts its own durations; what moves by script asks here. */
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function opened(start: EditorStart): State {
  const inSet = "set" in start;
  const sd = inSet ? { ov: plain(start.set.ov), per: plain(start.set.per) } : null, slide = inSet ? start.slide : 0;
  const doc = sd ? (slide ? sd.per : sd.ov) : plain((start as { doc: NamedDoc }).doc);
  const bk = start.bk ? clone(start.bk) : postBlocks(new Set((sd ? [...sd.ov.els, ...sd.per.els] : doc.els).map((e) => e.k as string)), inSet);
  const whole = sd ?? doc, sh = { ov: [], per: [] };
  return {
    doc, sd, sh, slide, hist: slide ? sh.per : sh.ov, bk, base: JSON.stringify([whole, bk]), sel: null, sheet: null, menu: null, pf: null, ask: false, drag: false, live: false, moving: false, pushing: false, hot: false, near: 0, guides: [], edge: false, toast: "", toastOn: false,
    mem: doc.bg.mode === "solid" ? { c: doc.bg.c, a: "", b: "", dir: 135 } : { c: "", a: doc.bg.a, b: doc.bg.b, dir: doc.bg.dir },
  };
}

/** What the page last painted: the card's size and where it stands, and who to tell. */
export type EditorView = { desk: boolean; vw: number; vh: number; cw: number; ch: number; top: number; head: number; onBack: () => void; onDone: (part: ShareStyle, slide: number) => void };

/**
 * The editor without its paint (mock v15): one mutable state, the gestures that
 * change it and a tick that repaints, as the mock had it; every rule that needs
 * no pointer is pure in lib/share/doc. A style holds places, fonts, colours and
 * pictures, never a prompt's text.
 */
export function makeEditor(start: EditorStart, c: ShareContent, pal: Palette, tick: () => void) {
  const S = opened(start);
  const n = c.images.length, paid = !c.words, gestures = new Set<() => void>();
  let root: HTMLDivElement | null = null, view: EditorView, toastT: ReturnType<typeof setTimeout> | undefined, seen: Set<number> | null = null, picking: string | null = null, saving: AbortController | null = null;
  const wr = () => root?.querySelector<HTMLElement>(".wr");

  const cur = () => S.doc.els.find((e) => e.id === S.sel);
  const snap = () => JSON.stringify(S.doc);
  /** A step to undo, with the post as it stood; the history keeps sixty. */
  const keep = (step: string, bk = S.bk) => {
    S.hist.push(JSON.stringify({ ...(JSON.parse(step) as ShareDoc), _bk: bk }));
    if (S.hist.length > 60) S.hist.shift();
  };
  const push = () => keep(snap());
  const whole = () => (S.sd ? { ov: S.slide ? S.sd.ov : S.doc, per: S.slide ? S.doc : S.sd.per } : S.doc);
  /** A text stands in one place: on the card it is not to be had for the post. */
  const onCard = (key: string) => (S.sd ? [S.sd.ov, S.sd.per, S.doc] : [S.doc]).some((d) => d.els.some((e) => e.k === key));
  const dirty = () => !!saving || JSON.stringify([whole(), S.bk]) !== S.base;
  const undo = () => {
    const h = S.hist.pop();
    if (!h) return;
    const { _bk, ...d } = JSON.parse(h) as ShareDoc & { _bk: PostBlock[] };
    S.bk = _bk;
    S.doc = d;
    if (!cur()) {
      S.sel = null;
      if (S.menu === "font") S.menu = S.pf = null;
    }
    tick();
  };
  /** The question gone, the focus goes back to the Back that asked it. */
  const answered = () => {
    S.ask = false;
    root?.querySelector<HTMLElement>('[data-a="cancel"]')?.focus({ preventScroll: true });
  };
  const toast = (text: string, ms = 1600) => {
    S.toast = text;
    S.toastOn = true;
    clearTimeout(toastT);
    toastT = setTimeout(() => { S.toastOn = false; tick(); }, ms);
    tick();
  };
  const rc = () => wr()!.getBoundingClientRect();
  const node = (id: number) => wr()?.querySelector<HTMLElement>(`:scope > .cd > [data-id="${id}"]`);
  const opts = () => ({ ink: inkOn(S.doc.bg, pal), paid, n });

  /** The window's pointer events of one gesture; they end with it, or with the editor. A release ends it with up; one the system took back with gone, which changes nothing. */
  const track = (pid: number, mv: (p: PointerEvent) => void, up: (p: PointerEvent) => void, gone: () => void) => {
    // A move with no button held: its release went elsewhere, another window or a context menu.
    const move = (p: PointerEvent) => {
      if (p.pointerId !== pid) return;
      if (p.buttons) mv(p);
      else end(p);
    };
    const end = (p: PointerEvent) => {
      if (p.pointerId !== pid) return;
      stop();
      if (p.type === "pointerup") up(p);
      else gone();
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      gestures.delete(stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    gestures.add(stop);
  };

  /** The card as it was at the press. */
  const undone = (j: string) => {
    S.doc = JSON.parse(j) as ShareDoc;
    S.live = S.pushing = S.edge = false;
    tick();
  };

  function fallIn(el: HTMLElement, tc: [number, number]) {
    const a = el.getBoundingClientRect(), k = parseFloat(el.style.scale) || 1, g = el.cloneNode(true) as HTMLElement;
    g.className = "tgh";
    g.style.cssText = el.style.cssText;
    g.style.transformOrigin = "center";
    g.style.left = `${a.left + a.width / 2 - el.offsetWidth / 2}px`;
    g.style.top = `${a.top + a.height / 2 - el.offsetHeight / 2}px`;
    g.style.width = `${el.offsetWidth}px`;
    g.style.height = `${el.offsetHeight}px`;
    root!.append(g);
    g.animate([{ scale: k, translate: "0 0", opacity: 1 }, { scale: 0.04, translate: `${tc[0] - a.left - a.width / 2}px ${tc[1] - a.top - a.height / 2}px`, opacity: 0.2 }], { duration: 240, easing: "cubic-bezier(.32,.72,0,1)", fill: "forwards" }).onfinish = () => g.remove();
  }

  /** Lift and drag, with magnets; a second finger pinches and turns. */
  function drag(e: El, ev: PointerEvent) {
    const pid = ev.pointerId, before = snap();
    let r = rc(), moved = false, gx = ((ev.clientX - r.left) / r.width) * 100 - e.x, gy = ((ev.clientY - r.top) / r.height) * 100 - e.y, fx = ev.clientX, fy = ev.clientY;
    let second: { id: number; x: number; y: number } | null = null, base: { d: number; a: number; w: number; h: number; rot: number; cx: number; cy: number } | null = null, tc: [number, number] = [0, 0], near = 0, hot = false;
    const yb = S.doc.ov ? null : Object.fromEntries(S.doc.els.map((o) => [o.id, o.y]));
    const begin = () => {
      const t = root!.querySelector(".ts")!.getBoundingClientRect();
      tc = [t.left + t.width / 2, t.top + t.height / 2];
      S.live = S.moving = S.drag = true;
      S.pushing = !!yb;
      node(e.id)?.classList.add("lift");
    };
    const down2 = (p: PointerEvent) => {
      if (p.pointerId === pid || second || !(p.target as Element).closest?.(".wr")) return;
      second = { id: p.pointerId, x: p.clientX, y: p.clientY };
      base = null;
    };
    const mv = (p: PointerEvent) => {
      if (p.pointerId === pid && !p.buttons) return up(p);
      if (second && p.pointerId === second.id) {
        second.x = p.clientX;
        second.y = p.clientY;
      } else if (p.pointerId === pid) {
        fx = p.clientX;
        fy = p.clientY;
      } else return;
      if (!moved && Math.hypot(fx - ev.clientX, fy - ev.clientY) < 3 && !second) return;
      if (!moved) {
        moved = true;
        begin();
      }
      r = rc();
      if (second) {
        const d = Math.hypot(second.x - fx, second.y - fy), a = (Math.atan2(second.y - fy, second.x - fx) * 180) / Math.PI;
        base ??= { d, a, w: e.w, h: e.h, rot: e.rot || 0, cx: e.x + e.w / 2, cy: e.y + e.h / 2 };
        const k = d / base.d;
        e.w = Math.max(8, base.w * k);
        e.h = Math.max(4, base.h * k);
        e.x = base.cx - e.w / 2;
        e.y = base.cy - e.h / 2;
        e.rot = base.rot + a - base.a;
        S.guides = [];
      } else {
        if (yb) S.doc.els.forEach((o) => { if (o !== e) o.y = yb[o.id]; });
        e.x = ((fx - r.left) / r.width) * 100 - gx;
        e.y = ((fy - r.top) / r.height) * 100 - gy;
        const m = magnet(e, S.doc.els.filter((o) => o !== e));
        e.x = m.x;
        e.y = m.y;
        S.guides = m.guides;
      }
      const dist = second ? 1e9 : Math.hypot(fx - tc[0], fy - tc[1]);
      near = clamp01((110 - dist) / 60);
      hot = dist < 56;
      if (yb) {
        const ys = hot ? yb : pushAway(S.doc.els, e, yb);
        S.doc.els.forEach((o) => { if (o !== e) o.y = ys[o.id]; });
      }
      const nd = node(e.id);
      if (nd) {
        nd.style.transformOrigin = `${(gx / e.w) * 100}% ${(gy / e.h) * 100}%`;
        nd.style.scale = near ? String(1.035 - near * 0.75) : "";
      }
      S.near = near;
      S.hot = hot;
      tick();
    };
    const stop = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("pointerdown", down2, true);
      gestures.delete(stop);
    };
    const up = (p: PointerEvent) => {
      if (second && p.pointerId === second.id) {
        second = null;
        base = null;
        gx = ((fx - rc().left) / rc().width) * 100 - e.x;
        gy = ((fy - rc().top) / rc().height) * 100 - e.y;
        return;
      }
      if (p.pointerId !== pid) return;
      stop();
      const nd = node(e.id), real = p.type === "pointerup";
      if (hot && real && nd && !calm()) fallIn(nd, tc);
      if (nd) {
        nd.classList.remove("lift");
        nd.style.scale = "";
        nd.style.transformOrigin = "";
      }
      S.live = S.moving = S.pushing = S.drag = S.hot = false;
      S.near = 0;
      S.guides = [];
      if (!real) return undone(before);
      if (hot) {
        keep(before);
        S.doc.els = S.doc.els.filter((x) => x !== e);
        if (yb) S.doc.els.forEach((o) => { o.y = yb[o.id]; });
        S.sel = null;
      } else if (moved) {
        Object.assign(e, keptOn(e, !yb));
        if (yb) S.doc = settle(S.doc);
        if (snap() !== before) keep(before);
      }
      tick();
    };
    window.addEventListener("pointerdown", down2, true);
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    gestures.add(stop);
  }

  /** A corner moves, the text refits; in Make room what it reaches gives way. */
  function resize(h: string, ev: PointerEvent) {
    const e = cur()!, b4 = snap(), r = rc(), o = { x: e.x, y: e.y, w: e.w, h: e.h }, sx = ev.clientX, sy = ev.clientY;
    const yb = S.doc.ov ? null : Object.fromEntries(S.doc.els.map((x) => [x.id, x.y]));
    S.live = true;
    S.pushing = !!yb;
    tick();
    track(ev.pointerId, (p) => {
      const dx = ((p.clientX - sx) / r.width) * 100, dy = ((p.clientY - sy) / r.height) * 100;
      if (h.includes("l")) {
        e.w = Math.max(8, o.w - dx);
        e.x = o.x + o.w - e.w;
      } else e.w = Math.max(8, o.w + dx);
      if (h.includes("t")) {
        e.h = Math.max(3, o.h - dy);
        e.y = o.y + o.h - e.h;
      } else e.h = Math.max(3, o.h + dy);
      if (yb) {
        const ys = pushAway(S.doc.els, e, yb);
        S.doc.els.forEach((x) => { if (x !== e) x.y = ys[x.id]; });
      }
      tick();
    }, () => {
      S.live = S.pushing = false;
      if (snap() !== b4) keep(b4);
      if (yb) S.doc = settle(S.doc);
      tick();
    }, () => undone(b4));
  }

  function rotate(ev: PointerEvent) {
    const e = cur()!, b4 = snap(), r = rc(), mx = r.left + ((e.x + e.w / 2) / 100) * r.width, my = r.top + ((e.y + e.h / 2) / 100) * r.height;
    S.live = true;
    tick();
    track(ev.pointerId, (p) => {
      let a = (Math.atan2(p.clientY - my, p.clientX - mx) * 180) / Math.PI - 90;
      for (const s of SNAPS) if (Math.abs(a - s) < 3.5) a = s;
      e.rot = a;
      tick();
    }, () => {
      S.live = false;
      if (snap() !== b4) keep(b4);
      tick();
    }, () => undone(b4));
  }

  /** The tag on its way to the card: the card opens a place under it, undone if it leaves. */
  function tagDrag(k: ElKind) {
    const j = snap(), id = uid++, o = opts(), g = document.createElement("div");
    g.className = `tg1 ghost ${CHIP[k] ?? "p7"}`;
    g.textContent = label(k, c);
    root!.append(g);
    let key: string | null = null, lx = -99, ly = -99;
    const over = (p: PointerEvent) => {
      const r = rc();
      return p.clientX > r.left - 24 && p.clientX < r.right + 24 && p.clientY > r.top - 24 && p.clientY < r.bottom + 24 ? clamp01((p.clientY - r.top) / r.height) : null;
    };
    const mark = (on: boolean) => node(id)?.classList.toggle("slot", on);
    const restore = () => {
      S.doc = JSON.parse(j) as ShareDoc;
      tick();
    };
    return {
      move(p: PointerEvent) {
        g.style.left = `${p.clientX}px`;
        g.style.top = `${p.clientY}px`;
        if (Math.hypot(p.clientX - lx, p.clientY - ly) < 10) return;
        lx = p.clientX;
        ly = p.clientY;
        const py = over(p);
        if (py === null) {
          if (key !== null) {
            key = null;
            restore();
          }
          return;
        }
        const pv = room(JSON.parse(j) as ShareDoc, k, py, id, o);
        if (pv.key !== key) {
          key = pv.key;
          S.doc = pv.doc;
          flushSync(tick);
          mark(true);
        }
      },
      cancel() {
        g.remove();
        restore();
      },
      drop(bk?: PostBlock[]) {
        g.remove();
        if (key === null) {
          restore();
          return false;
        }
        keep(j, bk);
        mark(false);
        if (!S.sheet) S.sel = id;
        return true;
      },
      tap() {
        g.remove();
        S.doc = room(JSON.parse(j) as ShareDoc, k, 1, id, o).doc;
        keep(j);
        S.sel = id;
      },
    };
  }

  /** A tag that landed leaves the post, and undo gives it back: the post rides on the step it made. */
  const leavePost = (key: string) => {
    const b = S.bk.find((x) => x.key === key);
    if (b) b.on = false;
  };

  function fromTag(k: ElKind, ev: PointerEvent) {
    ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY;
    let t: ReturnType<typeof tagDrag> | null = null;
    track(ev.pointerId, (p) => {
      if (!t && Math.hypot(p.clientX - sx, p.clientY - sy) < 5) return;
      t ??= tagDrag(k);
      t.move(p);
    }, () => {
      let on = false;
      if (!t) {
        t = tagDrag(k);
        t.tap();
        on = true;
      } else on = t.drop();
      if (on) leavePost(k);
      tick();
    }, () => {
      t?.cancel();
      tick();
    });
  }

  function canvasDrag(side: string, ev: PointerEvent) {
    ev.preventDefault();
    const j = snap(), d0 = JSON.parse(j) as ShareDoc, r0 = rn(d0.ratio), h0 = 1 / r0, rect = rc(), pw = rect.width, ph = rect.height, sx = ev.clientX, sy = ev.clientY;
    const minH = Math.max(0.3, ...d0.els.map((e) => ((e.y + e.h) / 100) * h0)), minR = Math.max(0.35, ...d0.els.map((e) => ((e.x + e.w) / 100) * r0));
    S.live = S.edge = true;
    tick();
    track(ev.pointerId, (p) => {
      let w = side === "b" ? 1 / Math.max(minH, Math.min(2.4, h0 + (p.clientY - sy) / pw)) : Math.max(minR, Math.min(2.4, r0 + (p.clientX - sx) / ph));
      const f = FORMATS.find((x) => Math.abs(rn(x) - w) / w < 0.018 && (side === "b" ? 1 / rn(x) >= minH : rn(x) >= minR));
      w = f ? rn(f) : Number(w.toFixed(3));
      S.doc.ratio = f ?? `${w}:1`;
      S.doc.els = clone(d0.els).map((e) => {
        if (side === "b") {
          const q = h0 * w;
          e.y *= q;
          e.h *= q;
        } else {
          const q = r0 / w;
          e.x *= q;
          e.w *= q;
        }
        return e;
      });
      tick();
    }, () => {
      S.live = S.edge = false;
      if (snap() !== j) keep(j);
      tick();
    }, () => undone(j));
  }

  function dial(ev: PointerEvent, el: Element) {
    ev.preventDefault();
    const b4 = snap(), d = el.getBoundingClientRect(), mx = d.left + d.width / 2, my = d.top + d.height / 2, b = S.doc.bg;
    const set = (p: PointerEvent) => {
      let a = (((Math.atan2(p.clientY - my, p.clientX - mx) * 180) / Math.PI + 90) % 360 + 360) % 360;
      for (let s = 0; s <= 360; s += 45) if (Math.abs(a - s) < 5) a = s % 360;
      if (b.mode === "gradient") b.dir = Math.round(a);
      tick();
    };
    set(ev);
    track(ev.pointerId, set, () => {
      if (snap() !== b4) keep(b4);
      tick();
    }, () => undone(b4));
  }

  function flip(fn: () => void, skip?: string) {
    const blocks = () => [...(root?.querySelectorAll<HTMLElement>(".bk") ?? [])];
    const old = new Map(blocks().map((b) => [b.dataset.k, b.getBoundingClientRect().top]));
    flushSync(() => {
      fn();
      tick();
    });
    for (const b of blocks()) {
      const o = old.get(b.dataset.k);
      if (o === undefined || b.dataset.k === skip) continue;
      const dy = o - b.getBoundingClientRect().top;
      if (dy && !calm()) b.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(.32,.72,0,1)" });
    }
  }

  /** A block of the post: into order, onto the card, or a tap leaves it out. */
  function dragBk(i: number, ev: PointerEvent) {
    ev.preventDefault();
    let at = i, moved = false, tag: ReturnType<typeof tagDrag> | null = null;
    const sx = ev.clientX, sy = ev.clientY, key = S.bk[i].key, there = onCard(key), bk0 = clone(S.bk);
    const here = () => root!.querySelector<HTMLElement>(`[data-b="${at}"]`)!, off = sy - here().getBoundingClientRect().top;
    const reset = () => {
      const b = here();
      b.classList.remove("dg");
      b.style.translate = "";
      b.style.opacity = "";
    };
    track(ev.pointerId, (p) => {
      if (!moved && Math.hypot(p.clientX - sx, p.clientY - sy) < 5) return;
      moved = true;
      const out = view.desk ? p.clientX < root!.querySelector(".pn")!.getBoundingClientRect().left - 4 : p.clientY > root!.querySelector(".pb")!.getBoundingClientRect().bottom + 4;
      if (out && !there) {
        const b = here();
        b.style.translate = "";
        b.classList.remove("dg");
        b.style.opacity = ".35";
        tag ??= tagDrag(key);
        tag.move(p);
        return;
      }
      if (tag) {
        tag.cancel();
        tag = null;
      }
      for (const b of root!.querySelectorAll<HTMLElement>("[data-b]")) {
        const j = Number(b.dataset.b), r = b.getBoundingClientRect();
        if (j !== at && p.clientY > r.top + r.height * 0.25 && p.clientY < r.bottom - r.height * 0.25) {
          reset();
          flip(() => {
            const [x] = S.bk.splice(at, 1);
            S.bk.splice(j, 0, x);
            at = j;
          }, key);
          break;
        }
      }
      const b = here();
      b.style.opacity = "";
      b.style.translate = "";
      b.classList.add("dg");
      b.style.translate = `0 ${p.clientY - off - b.getBoundingClientRect().top}px`;
    }, () => {
      reset();
      if (tag) {
        const on = tag.drop(bk0);
        tag = null;
        flip(() => { if (on) leavePost(key); });
        return;
      }
      flip(() => {
        if (!moved) S.bk[at].on = false;
        if (JSON.stringify(S.bk) !== JSON.stringify(bk0)) keep(snap(), bk0);
      });
    }, () => {
      reset();
      tag?.cancel();
      S.bk = bk0;
      tick();
    });
  }

  function goSlide(next: number) {
    const was = S.slide ? "per" : "ov", to = next ? "per" : "ov";
    if (was !== to) {
      const o = S.doc;
      S.sd![was] = o;
      S.sh[was] = S.hist;
      S.doc = S.sd![to];
      S.hist = S.sh[to];
      if (S.doc.ratio !== o.ratio) {
        push();
        S.doc = reflow(S.doc, o.ratio, n, paid);
      }
    }
    S.slide = next;
    S.sel = null;
    tick();
  }

  /** A document as a style keeps it: its group knows how many images it was laid out for. */
  const kept = <T extends ShareDoc>(d: T): T => ({ ...clone(d), els: d.els.map((e) => (e.k === "results" ? { ...clone(e), of: n } : clone(e))) });
  const done = () => {
    if (saving) return toast("Still saving your image. Press Done when it is on your card.", 60_000);
    if (!S.sd) return view.onDone({ [c.media]: { ...kept(S.doc), bk: clone(S.bk) } }, 0);
    const other = S.sd[S.slide ? "ov" : "per"], fitted = other.ratio === S.doc.ratio ? other : reflow(other, S.doc.ratio, n, paid);
    view.onDone({ set: { ov: kept(S.slide ? fitted : S.doc), per: kept(S.slide ? S.doc : fitted), bk: clone(S.bk) } }, S.slide);
  };

  const onClick = (ev: ReactMouse) => {
    const target = ev.target as Element;
    if (target.matches("input[type=color]")) {
      picking = snap();
      return;
    }
    if (target.matches("input[type=file]")) return;
    const btn = target.closest<HTMLElement>("[data-a]"), inMenu = target.closest(".mn");
    if (S.ask) {
      if (btn?.dataset.a === "askno" || btn?.dataset.a === "askyes") {
        answered();
        tick();
        if (btn.dataset.a === "askyes") view.onBack();
      }
      return;
    }
    // A key's press on a tag; a pointer's goes through fromTag.
    const tagged = target.closest<HTMLElement>("[data-tag]");
    if (tagged && ev.detail === 0) {
      const t = tagDrag(tagged.dataset.tag as ElKind);
      t.tap();
      leavePost(tagged.dataset.tag!);
      return tick();
    }
    if (S.menu && !inMenu) {
      const same = btn?.dataset.a === "menu" && btn.dataset.v === S.menu;
      S.menu = null;
      S.pf = null;
      tick();
      if (same || !btn) return;
    }
    if (!btn) return;
    const a = btn.dataset.a, v = btn.dataset.v ?? "", e = cur(), bg = S.doc.bg, b4 = snap();
    if (a === "slide") return goSlide(Number(v));
    if (a === "cancel") {
      S.menu = null;
      if (dirty()) {
        S.ask = true;
        return tick();
      }
      return view.onBack();
    }
    if (a === "done") return done();
    if (a === "undo") return undo();
    if (a === "sheet") {
      S.sel = null;
      S.sheet = S.sheet === v ? null : (v as Sheet);
    }
    if (a === "closesheet") S.sheet = null;
    if (a === "menu") {
      S.menu = v as Menu;
      S.pf = null;
      if (v === "font") void loadFonts(SHARE_FONTS.map((f) => f[0])).then(tick);
    }
    if (a === "ratio") {
      S.menu = null;
      if (v !== S.doc.ratio) {
        S.doc = reflow(S.doc, v, n, paid);
        toast(`Arranged for ${v}`);
      }
    }
    if (a === "bgm") {
      Object.assign(S.mem, bg);
      S.doc.bg = v === "solid" ? { mode: "solid", c: S.mem.c || pal.solids[0] } : { mode: "gradient", a: S.mem.a || pal.grads[0][0], b: S.mem.b || pal.grads[0][1], dir: S.mem.dir };
    }
    if (a === "solid") {
      S.doc.bg = { mode: "solid", c: v };
    }
    if (a === "grad" && bg.mode === "gradient") {
      [bg.a, bg.b] = pal.grads[Number(v)];
    }
    if (a === "radial" && bg.mode === "gradient") {
      bg.dir = bg.dir === "radial" ? 135 : "radial";
    }
    if (a === "font" && e) {
      e.font = v;
      S.menu = null;
      S.pf = null;
    }
    if (a === "align" && e) {
      e.align = e.align === "left" ? "center" : e.align === "center" ? "right" : "left";
    }
    if (a === "arr" && e) {
      S.doc.els = S.doc.els.map((x) => (x === e ? natural(e, v as Arrangement, n, view.cw, view.ch) : x));
    }
    if (a === "show" && e) {
      if (v === "logo") {
        if (e.show !== "logo") {
          e._w = e.w;
          e._h = e.h;
        }
        e.w = 14;
        e.h = (14 * view.cw) / view.ch;
      } else if (e.show === "logo") {
        e.w = e._w ?? 60;
        e.h = e._h ?? 6;
      }
      e.show = v as El["show"];
    }
    if (a === "ov") {
      S.doc.ov = !S.doc.ov;
      if (S.doc.ov) toast("Elements can overlap");
      else {
        S.doc = tidy(S.doc);
        toast("Elements move out of the way");
      }
    }
    if (a === "bkon") return flip(() => {
      keep(snap());
      S.bk[Number(v)].on = true;
    });
    if (a === "gap" && e) {
      e.gap = e.gap ? 0 : 1;
    }
    if (a === "front" && e) {
      S.doc.els = S.doc.els.filter((x) => x !== e).concat(e);
    }
    if (a === "trash" && e) {
      S.doc.els = S.doc.els.filter((x) => x !== e);
      S.sel = null;
    }
    if (snap() !== b4) keep(b4);
    tick();
  };

  const setColour = (which: "text" | "c" | "a" | "b", value: string) => {
    const e = cur();
    // One step for a picker however long it is dragged, none for one left without a colour.
    if (picking !== null) {
      keep(picking);
      picking = null;
    }
    if (which === "text") {
      if (e) e.color = value;
    } else Object.assign(S.doc.bg, { [which]: value });
    tick();
  };

  const onFile = (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast("Only an image can go on your card");
    void keepPicture(file);
  };

  /** Made smaller and saved as a reference like any other (app/api/references): private to its owner, and a style holds its id. */
  const keepPicture = async (file: File) => {
    toast("Saving your image…", 60_000);
    const mine = (saving = new AbortController());
    const image = await readReference(file);
    const res = image && !mine.signal.aborted ? await fetch("/api/references", { method: "POST", signal: mine.signal, headers: { ...sessionAuthHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ image }) }).catch(() => null) : null;
    saving = null;
    // The editor went while it was on its way: the answer has nowhere to land.
    if (mine.signal.aborted) return;
    if (!image) return toast("Your image could not be read");
    if (!res?.ok) return toast(res ? await failureSentence(res, "Your image could not be saved") : "Your image could not be saved: no connection.", 5000);
    const saved = (await res.json()) as { id: string; url: string };
    push();
    const el = newEl("up", view.cw / view.ch, { ...opts(), id: uid++ });
    el.ref = saved.id;
    el.src = saved.url;
    S.doc.els.push(el);
    S.sel = el.id;
    S.sheet = null;
    toast("Your image is saved");
  };

  const onPointerDown = (ev: ReactPointer) => {
    const p = ev.nativeEvent;
    if (p.button || S.ask) return;
    const t = p.target as Element;
    const edge = t.closest<HTMLElement>("[data-cv]");
    if (edge) return canvasDrag(edge.dataset.cv!, p);
    const tg = t.closest<HTMLElement>("[data-tag]");
    if (tg) return fromTag(tg.dataset.tag as ElKind, p);
    const hd = t.closest<HTMLElement>("[data-h]");
    if (hd) {
      p.preventDefault();
      return hd.dataset.h === "rot" ? rotate(p) : resize(hd.dataset.h!, p);
    }
    const bk = t.closest<HTMLElement>("[data-b]");
    if (bk) return dragBk(Number(bk.dataset.b), p);
    const dl = t.closest(".dl");
    if (dl) return dial(p, dl);
    if (S.sheet && !t.closest(".sh") && !t.closest(".dk")) {
      S.sheet = null;
      return tick();
    }
    const el = t.closest<HTMLElement>(".wr > .cd > .el");
    if (el && !S.menu) {
      p.preventDefault();
      S.sel = Number(el.dataset.id);
      tick();
      return drag(cur()!, p);
    }
    if ((!S.menu && t.closest(".wr,.amb")) || t === root) {
      S.sel = null;
      tick();
    }
  };

  const onPointerOver = (ev: ReactPointer) => {
    if (S.menu !== "font" || ev.pointerType !== "mouse") return;
    const f = (ev.target as Element).closest<HTMLElement>("[data-pf]")?.dataset.pf ?? null;
    if (f !== S.pf) {
      S.pf = f;
      tick();
    }
  };

  /** Keys, in layers; nothing under the editor hears one. Answers how to stop. */
  const listen = () => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Tab") return;
      ev.stopPropagation();
      if (gestures.size) return ev.preventDefault();
      if (ev.key === "Escape") {
        ev.preventDefault();
        if (S.ask) answered();
        else if (S.menu) {
          S.menu = null;
          S.pf = null;
        } else if (S.sheet) S.sheet = null;
        else S.sel = null;
        return tick();
      }
      if (S.ask || (ev.target as HTMLElement).tagName === "INPUT") return;
      const block = (ev.target as HTMLElement).dataset?.b;
      if (block !== undefined && (ev.key === "Enter" || ev.key === " ")) {
        ev.preventDefault();
        return flip(() => {
          keep(snap());
          S.bk[Number(block)].on = false;
        });
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") {
        ev.preventDefault();
        return undo();
      }
      const e = cur();
      // An open menu stands over its element: Esc closes it first.
      if (!e || S.menu) return;
      if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        push();
        S.doc.els = S.doc.els.filter((x) => x !== e);
        S.sel = null;
        return tick();
      }
      const st = ev.shiftKey ? 2.5 : 0.5, mv = ({ ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] } as Record<string, number[]>)[ev.key];
      if (mv) {
        ev.preventDefault();
        push();
        Object.assign(e, keptOn({ ...e, x: e.x + mv[0], y: e.y + mv[1] }, true));
        tick();
      }
    };
    // A reload or a closed tab asks, as Back does (PromptEditor has the same guard).
    const guard = (ev: BeforeUnloadEvent) => {
      if (!dirty()) return;
      ev.preventDefault();
      ev.returnValue = "";
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("beforeunload", guard);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("beforeunload", guard);
      gestures.forEach((stop) => stop());
      saving?.abort();
    };
  };

  /** After a paint: what it cannot say before it has measured. The phone's card over its sheet, the bar over its element, the font menu under its button, and what just landed. */
  const place = (now: EditorView) => {
    view = now;
    const { desk, vw, vh, cw, ch, top, head } = now, w = wr()!;
    if (desk && S.sheet === "caption") {
      S.sheet = null;
      tick();
    }
    const sh = root!.querySelector<HTMLElement>(".sh.up"), pb = root!.querySelector<HTMLElement>(".pb");
    let tr = "none";
    if (!desk && S.sheet === "caption" && sh && pb) {
      const at = sh.offsetTop + pb.offsetTop, lo = root!.querySelector<HTMLElement>(".lo"), end = sh.offsetTop + sh.offsetHeight - (lo ? lo.offsetHeight + 24 : 14), room = end - at - 6;
      // The card keeps a place to be seen; the blocks scroll past it.
      pb.style.maxHeight = `${Math.max(0, room - Math.min(ch, Math.max(110, room * 0.4)))}px`;
      pb.classList.toggle("sc", pb.scrollHeight > pb.clientHeight + 1);
      const y = at + pb.offsetHeight + 6, s = Math.min(1, (end - y) / ch);
      tr = `translateY(${y - top}px) scale(${s})`;
    } else if (!desk && S.sheet === "bg" && sh) {
      const av = vh - head - sh.offsetHeight - 22, s = Math.min(1, av / ch), nt = head + (av - ch * s) / 2;
      tr = `translateY(${nt - top}px) scale(${s})`;
    }
    w.style.transform = tr;
    const e = cur(), bar = root!.querySelector<HTMLElement>(".br");
    if (e && bar) {
      const r = w.getBoundingClientRect(), y0 = r.top + (e.y / 100) * ch, bot = y0 + (e.h / 100) * ch, bw = bar.offsetWidth, bh = bar.offsetHeight;
      // A finger's corner reaches further up than a pointer's.
      let y = y0 - bh - (matchMedia("(pointer: coarse)").matches ? 44 : 32);
      if (y < 58) y = bot + 44;
      if (y > vh - 160) y = Math.max(58, y0 + 8);
      bar.style.top = `${y}px`;
      bar.style.left = `${Math.max(8, Math.min(r.left + ((e.x + e.w / 2) / 100) * cw - bw / 2, vw - bw - 8))}px`;
    }
    const menu = root!.querySelector<HTMLElement>(".mn.dwn"), fn = root!.querySelector(".fn");
    if (menu && fn) {
      const t = fn.getBoundingClientRect(), H = menu.offsetHeight, below = vh - t.bottom - 10;
      menu.style.top = `${below >= H ? t.bottom + 8 : Math.max(10, t.top - 8 - H)}px`;
      menu.style.left = `${Math.max(8, Math.min(t.left, vw - 238))}px`;
      menu.style.transformOrigin = below < H ? "bottom left" : "";
    }
    const ids = S.doc.els.map((x) => x.id);
    if (seen) for (const id of ids) {
      if (seen.has(id)) continue;
      const nd = node(id);
      nd?.classList.add("nw");
      nd?.addEventListener("animationend", () => nd.classList.remove("nw"), { once: true });
    }
    seen = new Set(ids);
    if (S.ask && !root!.querySelector(".al")?.contains(document.activeElement)) root!.querySelector<HTMLElement>('[data-a="askno"]')?.focus();
    // What held the focus went with its press, a Remove in the bar: it stays in the editor, for the next Tab.
    if (document.activeElement === document.body) root!.focus({ preventScroll: true });
  };

  /** The card opens from small to its place, with the fonts a style holds. */
  const open = (el: HTMLDivElement) => {
    root = el;
    void loadFonts([...new Set(("set" in start ? [...start.set.ov.els, ...start.set.per.els] : start.doc.els).flatMap((e) => (e.font ? [e.font] : [])))]).then(tick);
    if (!calm()) wr()?.animate([{ scale: 0.72, opacity: 0.2 }, { scale: 1, opacity: 1 }], { duration: 480, easing: "cubic-bezier(.32,.72,0,1)" });
    root.querySelector<HTMLElement>('[data-a="done"]')?.focus({ preventScroll: true });
  };

  return { S, cur, whole, onCard, onClick, onPointerDown, onPointerOver, onFile, setColour, listen, place, open };
}
