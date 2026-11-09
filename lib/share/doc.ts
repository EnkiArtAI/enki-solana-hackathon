import type { PostBlock } from "./content";

/**
 * A share card as data (Kev's mock v15, 2026-11-03): a canvas ratio, a
 * background and elements placed in percent of the card, so it holds slots and
 * no prompt: each new prompt fills itself. Everything here is pure; the page
 * (CardView) and the export (render-canvas) draw from the same numbers.
 */
export type Bg = { mode: "solid"; c: string } | { mode: "gradient"; a: string; b: string; dir: number | "radial" };
export type Align = "left" | "center" | "right";
export type Arrangement = "row" | "col" | "grid" | "hero";
export type ElKind = "title" | "desc" | "prompt" | "setup" | "link" | "tags" | "handle" | "gen" | "results" | "one" | "clip" | "up";
export interface El {
  id: number;
  k: ElKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  font?: string;
  color?: string;
  align?: Align;
  arr?: Arrangement;
  gap?: number;
  /** An image group's: how many images a style laid it out for; another number lays it out anew (regroup). */
  of?: number;
  /** A generator element's look: logo and name, the name, the logo. */
  show?: "both" | "name" | "logo";
  /** The creator's own picture (kind "up"): its saved reference, and the address it is read at now, which no account keeps. */
  ref?: string;
  src?: string;
  /** A generator's box while it shows only its logo: the size it goes back to. */
  _w?: number;
  _h?: number;
}
export interface ShareDoc {
  ratio: string;
  bg: Bg;
  /** Overlap: elements stay where they are put. */
  ov?: boolean;
  els: El[];
}

const TEXT = new Set<ElKind>(["title", "desc", "prompt", "setup", "link", "tags", "handle", "gen"]);
export const isText = (e: Pick<El, "k">) => TEXT.has(e.k);

/** "4:5" as width over height. */
export const rn = (r: string) => {
  const [a, b] = r.split(":").map(Number);
  return a / b;
};

/** The share of a stacked card's height each text takes; a whole prompt needs more than its variables. */
export const WT = (paid: boolean): Partial<Record<ElKind, number>> => ({ setup: 2.4, title: 1.5, desc: 1.1, prompt: paid ? 2.4 : 4.2, link: 0.5, tags: 0.5, handle: 0.75, gen: 0.65 });
export const SMALL: ElKind[] = ["handle", "gen", "link", "tags"];

/** Columns and rows of a grid of n: the last row holds what is left, stretched. */
const gridOf = (n: number) => {
  const c = Math.ceil(Math.sqrt(n));
  return { c, r: Math.ceil(n / c) };
};

/** Where n images lie in their group, as [x, y, w, h] of it. One image fills it in every arrangement. */
export function lay(arr: Arrangement, n: number): [number, number, number, number][] {
  const each = [...Array(n).keys()];
  if (arr === "row") return each.map((i) => [i / n, 0, 1 / n, 1]);
  if (arr === "col") return each.map((i) => [0, i / n, 1, 1 / n]);
  if (arr === "hero") return n === 1 ? [[0, 0, 1, 1]] : each.map((i) => (i === 0 ? [0, 0, 0.7, 1] : [0.7, (i - 1) / (n - 1), 0.3, 1 / (n - 1)]));
  const { c, r } = gridOf(n);
  return each.map((i) => {
    const row = Math.floor(i / c), inRow = row === r - 1 ? n - c * (r - 1) : c;
    return [(i - row * c) / inRow, row / r, 1 / inRow, 1 / r];
  });
}

/** Each image's box in pixels inside its element on a card cw x ch, gaps taken off, and its corner. */
export function tileRects(e: El, n: number, cw: number, ch: number) {
  const g = (e.gap ?? 0) * 0.01, wpx = (e.w / 100) * cw, hpx = (e.h / 100) * ch, gx = (g * cw) / 2;
  const radius = g ? Math.max(3, cw * 0.012) : 0;
  return lay(e.arr ?? "grid", n).map(([x, y, w, h]) => ({
    x: x * wpx + (x > 0 ? gx : 0),
    y: y * hpx + (y > 0 ? gx : 0),
    w: w * wpx - (x > 0 ? gx : 0) - (x + w < 0.999 ? gx : 0),
    h: h * hpx - (y > 0 ? gx : 0) - (y + h < 0.999 ? gx : 0),
    radius,
  }));
}

/** The arrangement of n images that keeps them largest in a box, the one it has if that stays near; one image fills the box. */
export function fitR(e: Pick<El, "arr">, bw: number, bh: number, n: number): { arr: Arrangement; w: number; h: number } {
  if (n <= 1) return { arr: e.arr ?? "row", w: bw, h: bh };
  const { c, r } = gridOf(n);
  const A: Record<Arrangement, number> = { row: n, col: 1 / n, grid: c / r, hero: 1 / 0.72 };
  const dim = (a: Arrangement) => {
    const w = Math.min(bw, bh * A[a]);
    return [w, w / A[a]];
  };
  const area = (a: Arrangement) => dim(a)[0] * dim(a)[1];
  let best: Arrangement = "row";
  for (const a of Object.keys(A) as Arrangement[]) if (area(a) > area(best)) best = a;
  const arr = e.arr && area(e.arr) >= area(best) * 0.6 ? e.arr : best;
  const [w, h] = dim(arr);
  return { arr, w, h };
}

/** The card arranged for another ratio, no stretching (the mock's reflow): a new document, the given one stays. */
export function reflow(doc: ShareDoc, ratio: string, n: number, paid: boolean): ShareDoc {
  const d: ShareDoc = structuredClone(doc);
  const r = rn(ratio), H = 1 / r, h0 = 1 / rn(d.ratio), m = 0.055, g = 0.018, wt = WT(paid);
  const put = (e: El, x: number, y: number, w: number, h: number) => {
    e.x = x * 100;
    e.y = (y / H) * 100;
    e.w = w * 100;
    e.h = (h / H) * 100;
    e.rot = 0;
  };
  d.ratio = ratio;
  if (d.ov) {
    const k = Math.min(1, H / h0);
    d.els.forEach((e) => {
      const Y = (e.y / 100) * h0, Z = (e.h / 100) * h0;
      e.x = 50 + (e.x - 50) * k;
      e.w *= k;
      e.y = ((H / 2 + (Y - h0 / 2) * k) / H) * 100;
      e.h = ((Z * k) / H) * 100;
    });
    return d;
  }
  const els = [...d.els].sort((a, b) => a.y - b.y || a.x - b.x);
  const T = els.filter(isText), M = els.filter((e) => !isText(e));
  const big = T.some((e) => !SMALL.includes(e.k)), share = (e: El) => (wt[e.k] ?? 1) * 0.078, tT = T.reduce((s, e) => s + share(e), 0);
  const stack = (x: number, w: number, y0: number, y1: number) => {
    const av = y1 - y0 - g * (T.length - 1), k = Math.min(1.8, av / tT);
    let y = y0 + Math.max(0, av - tT * k) / 2;
    T.forEach((e) => {
      const h = share(e) * k;
      put(e, x, y, SMALL.includes(e.k) ? Math.min(w, 0.62) : w, h);
      y += h + g;
    });
  };
  if (!T.length && M.length === 1) {
    const e = M[0];
    if (e.k === "results") {
      const { c, r: rows } = gridOf(n);
      const t: Partial<Record<Arrangement, number>> = { row: 1 / n / H, col: n / H, grid: rows / c / H };
      e.arr = (Object.keys(t) as Arrangement[]).reduce((a, b) => (Math.abs(Math.log(t[b]!)) < Math.abs(Math.log(t[a]!)) ? b : a));
    }
    put(e, 0, 0, 1, H);
    return d;
  }
  if (r >= 1.25 && M.length && big) {
    const mw = 0.5, x2 = mw + m * 0.5, each = (H - 2 * m - g * (M.length - 1)) / M.length;
    let y = m;
    M.forEach((e) => {
      if (e.k === "results") {
        const f = fitR(e, mw - m, each, n);
        e.arr = f.arr;
        put(e, m + (mw - m - f.w) / 2, y + (each - f.h) / 2, f.w, f.h);
      } else put(e, m, y, mw - m, each);
      y += each + g;
    });
    stack(x2, 1 - x2 - m, m, H - m);
    return d;
  }
  const cw = 1 - 2 * m;
  if (r >= 1.25 && M.length > 1) {
    const tH = T.length ? Math.min(0.12, tT + g * (T.length - 1)) : 0, mh = H - 2 * m - (tH ? tH + g : 0), w = (cw - g * (M.length - 1)) / M.length;
    M.forEach((e, i) => {
      if (e.k === "results") e.arr = "grid";
      put(e, m + i * (w + g), m, w, mh);
    });
    if (T.length) stack(m, cw, H - m - tH, H - m);
    return d;
  }
  const count = els.length, avail = H - 2 * m - g * (count - 1);
  const cap = T.some((e) => !SMALL.includes(e.k) && e.k !== "title") ? avail * 0.5 : avail - tT;
  const mMax = Math.max(0.1, Math.min(cap, avail - tT * 0.6)), each = mMax / Math.max(1, M.length), box = new Map<El, [number, number]>();
  M.forEach((e) => {
    if (e.k === "results") {
      const f = fitR(e, cw, each, n);
      e.arr = f.arr;
      box.set(e, [f.w, f.h]);
    } else box.set(e, [cw, Math.min(each, cw * 1.1)]);
  });
  const used = [...box.values()].reduce((s, b) => s + b[1], 0), tS = Math.max(0.01, avail - used), k = T.length ? Math.min(1.8, tS / tT) : 1;
  const extra = Math.max(0, tS - tT * k) / (count + 1);
  let y = m + extra;
  els.forEach((e) => {
    if (isText(e)) {
      const h = share(e) * k;
      put(e, m, y, SMALL.includes(e.k) ? 0.62 : cw, h);
      y += h + g + extra;
    } else {
      const [w, h] = box.get(e)!;
      put(e, m + (cw - w) / 2, y, w, h);
      y += h + g + extra;
    }
  });
  return d;
}

/** The background as CSS; render-canvas paints the same gradient by its own line. */
export const bgCss = (b: Bg) => (b.mode === "solid" ? b.c : b.dir === "radial" ? `radial-gradient(circle at center,${b.a},${b.b})` : `linear-gradient(${b.dir}deg,${b.a},${b.b})`);

/** A style: documents and the post, for images, for a video, for a set. No prompt's text in it. */
export type CardStyle = ShareDoc & { bk: PostBlock[] };
export type SetStyle = { ov: ShareDoc; per: ShareDoc; bk: PostBlock[] };
export type ShareStyle = { image?: CardStyle; video?: CardStyle; set?: SetStyle };

/** The real formats, in the order the Format menu lists them. */
export const FORMATS = ["1:1", "4:5", "3:4", "2:3", "16:9", "9:16", "3:2", "4:3", "5:4", "21:9"];
/** Each with its logical height (width 1), lowest first. */
const HEIGHTS = FORMATS.map((f) => [f, 1 / rn(f)] as const).sort((a, b) => a[1] - b[1]);

type Box = Pick<El, "x" | "y" | "w" | "h">;

/** The box a kind takes when it lands, [width, height] in logical units; a row of n stays square, as the mock's row of four. */
export const TAG = (paid: boolean, n: number): Record<Exclude<ElKind, "up">, [number, number]> => ({ setup: [0.88, 0.26], one: [0.88, 0.62], title: [0.88, 0.13], desc: [0.88, 0.1], prompt: [0.88, paid ? 0.3 : 0.42], link: [0.7, 0.05], tags: [0.7, 0.05], handle: [0.5, 0.07], gen: [0.55, 0.06], results: [0.88, 0.88 / Math.max(1, n)], clip: [0.88, 0.5] });

/** A new element of a kind, in the middle of a card of width over height v. */
export function newEl(k: ElKind, v: number, { ink, paid, id }: { ink: string; paid: boolean; id: number }): El {
  const md = (x: number, y: number, w: number, h: number, extra?: Partial<El>): El => ({ id, k, x, y, w, h, rot: 0, ...extra });
  const tx = (x: number, y: number, w: number, h: number, font = "Inter"): El => ({ id, k, x, y, w, h, rot: 0, font, color: ink, align: "left" });
  switch (k) {
    case "results": return md(14, 50 - 36 * v, 72, 72 * v, { arr: "grid", gap: 1 });
    case "clip": return md(20, 50 - 30 * v, 60, 60 * v);
    // Square on the card, whatever its shape, and all of it on it.
    case "up": {
      const w = Math.min(60, 90 / v);
      return md(50 - w / 2, 50 - (w * v) / 2, w, w * v);
    }
    case "one": return md(10, 50 - 40 * v, 80, 80 * v);
    case "setup": return tx(8, 30, 84, 30, "Space Grotesk");
    case "prompt": return tx(8, 30, 84, 40, paid ? "Space Grotesk" : "DM Mono");
    case "handle": return tx(10, 46, 55, 7, "Space Grotesk");
    case "title": return tx(10, 42, 80, 14, "Playfair Display");
    case "gen": return { ...tx(10, 46, 60, 6), show: "both" };
    default: return tx(10, 43, 80, 14);
  }
}

/** The image group in an arrangement, as large as it was, about its centre, kept on the card: four images keep the mock's numbers, any n its area. */
export function natural<T extends Box>(e: T, arr: Arrangement, n: number, cw: number, ch: number): T & { arr: Arrangement } {
  const s = Math.sqrt(((e.w / 100) * cw * e.h * ch) / 100), cx = e.x + e.w / 2, cy = e.y + e.h / 2;
  const { c, r } = gridOf(n), wide = c / r, q = Math.sqrt(n);
  let w = s, h = s;
  if (arr === "row") { w = Math.min(cw * 0.92, s * q); h = w / n; }
  if (arr === "col") { h = Math.min(ch * 0.92, s * q); w = h / n; }
  if (arr === "hero") { w = Math.min(cw * 0.94, s * 1.2); h = w * 0.72; }
  if (arr === "grid") { w = Math.min(s * Math.sqrt(wide), cw, ch * wide); h = w / wide; }
  const W = (w / cw) * 100, H = (h / ch) * 100;
  return { ...e, arr, w: W, h: H, x: Math.max(0, Math.min(100 - W, cx - W / 2)), y: Math.max(0, Math.min(100 - H, cy - H / 2)) };
}

/**
 * A style on a prompt with another number of images: its group as natural makes
 * it, tiles square, area and middle kept. In Make room it stays between what
 * stands above and below it, smaller if it must; the same number stays as laid out.
 */
export function regroup<T extends ShareDoc>(doc: T, n: number): T {
  const e = doc.els.find((x) => x.k === "results");
  if (!e?.of || e.of === n) return doc;
  const f = natural(e, e.arr ?? "grid", n, 1000, 1000 / rn(doc.ratio));
  const cy = f.y + f.h / 2, near = doc.ov ? [] : doc.els.filter((o) => o !== e && xHit(o, f));
  const top = Math.max(0, ...near.filter((o) => o.y + o.h / 2 < cy).map((o) => o.y + o.h + PAD));
  const bottom = Math.min(100, ...near.filter((o) => o.y + o.h / 2 >= cy).map((o) => o.y - PAD));
  const k = Math.min(1, (bottom - top) / f.h), w = f.w * k, h = f.h * k;
  const placed = { ...f, of: n, w, h, x: f.x + (f.w - w) / 2, y: Math.max(top, Math.min(bottom - h, cy - h / 2)) };
  return { ...doc, els: doc.els.map((x) => (x === e ? placed : x)) };
}

/** A guide on a card, in percent. */
export type Guide = { axis: "x" | "y"; at: number };

/** Where a moved element wants to stand: the card's edges and middle and the other elements pull first, the 10% grid after them, within 1.1%; only the strong ones draw a guide. */
export function magnet(e: Box, others: Box[]): { x: number; y: number; guides: Guide[] } {
  const xs: [number, boolean][] = [[0, true], [50, true], [100, true]], ys: [number, boolean][] = [[0, true], [50, true], [100, true]];
  others.forEach((o) => {
    xs.push([o.x, true], [o.x + o.w / 2, true], [o.x + o.w, true]);
    ys.push([o.y, true], [o.y + o.h / 2, true], [o.y + o.h, true]);
  });
  for (let i = 0; i <= 10; i++) {
    xs.push([i * 10, false]);
    ys.push([i * 10, false]);
  }
  const best = (lines: [number, boolean][], pts: number[]) => {
    let b: { d: number; at: number; strong: boolean } | null = null;
    for (const [at, strong] of lines) for (const p of pts) {
      const d = at - p;
      if (Math.abs(d) <= 1.1 && (!b || (strong && !b.strong) || (strong === b.strong && Math.abs(d) < Math.abs(b.d)))) b = { d, at, strong };
    }
    return b;
  };
  const bx = best(xs, [e.x, e.x + e.w / 2, e.x + e.w]), by = best(ys, [e.y, e.y + e.h / 2, e.y + e.h]);
  const guides: Guide[] = [];
  if (bx?.strong) guides.push({ axis: "x", at: bx.at });
  if (by?.strong) guides.push({ axis: "y", at: by.at });
  return { x: e.x + (bx?.d ?? 0), y: e.y + (by?.d ?? 0), guides };
}

/** Where a box may be left: a fifth of it stays on the card, or it is gone from sight and from the rail. Make room grows the card for what leaves its top or bottom, so only Overlap and the keys hold those. */
export function keptOn<T extends Box>(e: T, tall: boolean): T {
  const on = (at: number, size: number) => Math.max(-size * 0.8, Math.min(100 - size * 0.2, at));
  return { ...e, x: on(e.x, e.w), y: tall ? on(e.y, e.h) : e.y };
}

/** Two boxes share a column, past a hair. */
export const xHit = (a: Pick<El, "x" | "w">, b: Pick<El, "x" | "w">) => a.x < b.x + b.w - 1 && a.x + a.w > b.x + 1;

const PAD = 1.2;
const hits = (o: Box, p: Box) => xHit(o, p) && o.y < p.y + p.h && o.y + o.h > p.y;

/**
 * Make room while one element moves: from the places they had (yb), the others
 * below its middle give way down and those above it up, each pushing the next.
 * Answers their new places; what it is given stays as it is.
 */
export function pushAway(els: El[], e: Box & { id: number }, yb: Record<number, number>): Record<number, number> {
  const others = els.filter((o) => o.id !== e.id).map((o) => ({ ...o, y: yb[o.id] })), cy = e.y + e.h / 2;
  const give = (list: Box[], place: (o: Box, p: Box) => number) => {
    const on: Box[] = [e];
    for (const o of list) {
      let hit = false;
      for (const p of on) if (hits(o, p)) { o.y = place(o, p); hit = true; }
      if (hit) on.push(o);
    }
  };
  give(others.filter((o) => o.y + o.h / 2 >= cy).sort((a, b) => a.y - b.y), (_, p) => p.y + p.h + PAD);
  give(others.filter((o) => o.y + o.h / 2 < cy).sort((a, b) => b.y + b.h - a.y - a.h), (o, p) => p.y - o.h - PAD);
  return Object.fromEntries(others.map((o) => [o.id, o.y]));
}

/** A card whose elements left its top or bottom grows to the next real format that holds them, and they keep their shape; past the tallest, a ratio of its own. */
export function settle(doc: ShareDoc): ShareDoc {
  const d: ShareDoc = structuredClone(doc);
  if (!d.els.length) return d;
  const h0 = 1 / rn(d.ratio), t = Math.min(0, ...d.els.map((e) => e.y)), b = Math.max(100, ...d.els.map((e) => e.y + e.h));
  if (t >= -0.01 && b <= 100.01) return d;
  const need = ((b - t) / 100) * h0, f = HEIGHTS.find((x) => x[1] >= need - 0.001), Hn = f ? f[1] : need;
  d.els.forEach((e) => {
    e.y = ((e.y - t) * h0) / Hn;
    e.h = (e.h * h0) / Hn;
  });
  d.ratio = f ? f[0] : `${(1 / need).toFixed(3)}:1`;
  return d;
}

/** Back to Make room: top to bottom, whatever overlaps moves below it, then the card settles. */
export function tidy(doc: ShareDoc): ShareDoc {
  const d: ShareDoc = structuredClone(doc), on: El[] = [];
  [...d.els].sort((a, b) => a.y - b.y).forEach((o) => {
    on.forEach((p) => { if (hits(o, p)) o.y = p.y + p.h + PAD; });
    on.push(o);
  });
  return settle(d);
}

/**
 * A tag held over the card at py (0 top, 1 bottom). Make room opens a place for
 * it, in the gap when that fits, else the card grows to the next real format and
 * what stands there keeps its shape; past the tallest format everything shrinks.
 * Overlap leaves all where it is. `key` changes only when the place does.
 */
export function room(doc: ShareDoc, k: ElKind, py: number, id: number, opts: { ink: string; paid: boolean; n: number }): { doc: ShareDoc; key: string } {
  const d: ShareDoc = structuredClone(doc), h0 = 1 / rn(d.ratio), [tw, th] = TAG(opts.paid, opts.n)[k as Exclude<ElKind, "up">];
  const landed = newEl(k, 1, { ...opts, id });
  landed.x = 6;
  landed.w = tw * 100;
  if (k === "results") {
    landed.arr = "row";
    landed.gap = 1;
  }
  if (d.ov) {
    landed.h = (th / h0) * 100;
    landed.y = Math.max(0, Math.min(100 - landed.h, py * 100 - landed.h / 2));
    d.els.push(landed);
    return { doc: d, key: `o${Math.round(py * 40)}` };
  }
  const m = 0.035, L = d.els.map((x) => ({ x, Y: (x.y / 100) * h0, H: (x.h / 100) * h0 })), P = py * h0;
  const A = L.filter((o) => o.Y + o.H / 2 < P), Z = L.filter((o) => o.Y + o.H / 2 >= P);
  const aB = A.length ? Math.max(...A.map((o) => o.Y + o.H)) : 0, bT = Z.length ? Math.min(...Z.map((o) => o.Y)) : h0;
  const gap = bT - aB, need = th + 2 * m, fits = gap >= need;
  let Hn = h0, ratio = d.ratio, q = 1;
  if (!fits) {
    const req = h0 + need - gap, f = HEIGHTS.find((s) => s[1] >= req - 0.001), tallest = HEIGHTS[HEIGHTS.length - 1];
    [ratio, Hn] = f ?? tallest;
    if (!f) q = Math.min(1, (Hn - need) / Math.max(0.01, h0 - gap));
  }
  const top = aB * q, zTop = fits ? bT : Hn - (h0 - bT) * q;
  A.forEach((o) => {
    o.Y *= q;
    o.H *= q;
  });
  Z.forEach((o) => {
    o.Y = fits ? o.Y : zTop + (o.Y - bT) * q;
    o.H *= q;
  });
  const free = zTop - top - 2 * m, text = k === "title" || k === "desc" || k === "prompt";
  const tagH = fits ? th : text ? Math.min(th * 1.7, free) : Math.min(th, free);
  const tagY = fits ? Math.max(top + m, Math.min(zTop - m - th, P - th / 2)) : top + m + (free - tagH) / 2;
  L.forEach((o) => {
    o.x.y = (o.Y / Hn) * 100;
    o.x.h = (o.H / Hn) * 100;
  });
  d.ratio = ratio;
  landed.y = (tagY / Hn) * 100;
  landed.h = (tagH / Hn) * 100;
  d.els.push(landed);
  return { doc: d, key: `${A.length}:${fits ? Math.round(py * 20) : ""}` };
}
