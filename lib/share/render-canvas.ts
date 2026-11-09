import { sealOf } from "@/lib/ui/kit/seal";
import { blocksFor, type ShareContent } from "./content";
import { isText, rn, tileRects, type Bg, type El, type ShareDoc } from "./doc";
import { fontStack, fontWeight, measurer } from "./fonts";
import { fitEl, lineX } from "./text-layout";

/**
 * A card as an image, drawn by plain Canvas 2D from the same numbers as the page
 * (CardView). No library and no proxy: images come by a CORS fetch (Vercel Blob
 * and Supabase public answer ACAO *, measured 2026-11-04), so the canvas never
 * taints, and a read that fails rejects the whole card instead of leaving a hole.
 */

const SHORT = 1080, LONG = 2400;

/** The export's size: short side 1080, long side at most 2400. */
export function outputSize(ratio: string): { w: number; h: number } {
  const r = rn(ratio), long = Math.min(LONG, SHORT * Math.max(r, 1 / r)), short = long / Math.max(r, 1 / r);
  return r >= 1 ? { w: Math.round(long), h: Math.round(short) } : { w: Math.round(short), h: Math.round(long) };
}

/** A CSS linear-gradient's line on a box: through its centre at the angle, ending where the corners' perpendiculars meet it. */
export function gradientLine(deg: number, W: number, H: number) {
  const a = (deg * Math.PI) / 180, sin = Math.sin(a), cos = Math.cos(a), half = (Math.abs(W * sin) + Math.abs(H * cos)) / 2;
  return { x0: W / 2 - sin * half, y0: H / 2 + cos * half, x1: W / 2 + sin * half, y1: H / 2 - cos * half };
}

/** The part of an image object-fit: cover shows in a box. */
export function coverRect(iw: number, ih: number, w: number, h: number) {
  const k = Math.max(w / iw, h / ih), sw = w / k, sh = h / k;
  return { sx: (iw - sw) / 2, sy: (ih - sh) / 2, sw, sh };
}

const bitmaps = new Map<string, Promise<ImageBitmap>>();

function bitmap(url: string): Promise<ImageBitmap> {
  let known = bitmaps.get(url);
  if (!known) {
    known = fetch(url, { mode: "cors" })
      .then((res) => {
        if (!res.ok) throw new Error(`image read ${res.status}`);
        return res.blob();
      })
      .then((blob) => createImageBitmap(blob));
    // A failed read is not kept: a retry reads again.
    known.catch(() => bitmaps.delete(url));
    bitmaps.set(url, known);
  }
  return known;
}

/** Lets the images go, when the popup closes. */
export function closeBitmaps(): void {
  bitmaps.forEach((b) => void b.then((im) => im.close(), () => {}));
  bitmaps.clear();
}

function paintBg(ctx: CanvasRenderingContext2D, bg: Bg, W: number, H: number) {
  if (bg.mode === "solid") ctx.fillStyle = bg.c;
  else {
    let g: CanvasGradient;
    if (bg.dir === "radial") g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2);
    else {
      const l = gradientLine(bg.dir, W, H);
      g = ctx.createLinearGradient(l.x0, l.y0, l.x1, l.y1);
    }
    g.addColorStop(0, bg.a);
    g.addColorStop(1, bg.b);
    ctx.fillStyle = g;
  }
  ctx.fillRect(0, 0, W, H);
}

function drawCover(ctx: CanvasRenderingContext2D, im: ImageBitmap, x: number, y: number, w: number, h: number, radius = 0) {
  const c = coverRect(im.width, im.height, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.clip();
  ctx.drawImage(im, c.sx, c.sy, c.sw, c.sh, x, y, w, h);
  ctx.restore();
}

/** components/kit/Seal in a round frame: its parts as paths; an SVG drawn to a canvas cannot see the page's fonts, so the initial is text here. */
function drawSeal(ctx: CanvasRenderingContext2D, handle: string, x: number, y: number, size: number) {
  const s = sealOf(handle);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 96, size / 96);
  ctx.beginPath();
  ctx.arc(48, 48, 48, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = s.bg;
  ctx.fillRect(0, 0, 96, 96);
  for (const p of s.parts) {
    if (p.kind === "circle") {
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.fill;
      ctx.fill();
    } else if (p.kind === "line") {
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y1);
      ctx.lineTo(p.x2, p.y2);
      ctx.strokeStyle = p.stroke;
      ctx.lineWidth = p.width;
      ctx.lineCap = "round";
      ctx.stroke();
    } else {
      const path = new Path2D(p.d);
      ctx.globalAlpha = p.opacity ?? 1;
      if (p.fill !== "none") {
        ctx.fillStyle = p.fill;
        ctx.fill(path);
      }
      if (p.stroke) {
        ctx.strokeStyle = p.stroke;
        ctx.lineWidth = p.width ?? 1;
        ctx.lineCap = "round";
        ctx.stroke(path);
      }
      ctx.globalAlpha = 1;
    }
  }
  ctx.beginPath();
  ctx.arc(48, 48, 21, 0, Math.PI * 2);
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = s.bg;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.font = `italic 30px ${getComputedStyle(document.documentElement).getPropertyValue("--font-serif") || "serif"}`;
  ctx.textAlign = "center";
  ctx.fillStyle = s.fg;
  ctx.fillText(s.initial, 48, 58);
  ctx.restore();
}

/** The generator's own svg (paths only) as an image, `color` set for its currentColor. */
function logoImage(svg: SVGElement, color: string): Promise<HTMLImageElement> {
  const copy = svg.cloneNode(true) as SVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", "256");
  copy.setAttribute("height", "256");
  copy.style.color = color;
  const im = new Image();
  im.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
  return im.decode().then(() => im);
}

async function drawText(ctx: CanvasRenderingContext2D, e: El, doc: ShareDoc, c: ShareContent, slide: number, W: number, logo: SVGElement | null | undefined) {
  const f = W / 1000, fit = fitEl(e, doc.ratio, blocksFor(e, c, slide), measurer(e.font));
  const icon = e.k === "gen" && e.show !== "name" && logo ? await logoImage(logo, e.color ?? "") : null;
  for (const l of fit.lines) {
    const x = lineX(l, fit.boxW, e.align) * f, top = l.top * f, px = l.size * f;
    if (e.k === "handle" && c.handle) drawSeal(ctx, c.handle, x, top, 1.3 * px);
    if (icon) ctx.drawImage(icon, x, top, 1.3 * px, 1.3 * px);
    if (!l.text) continue;
    ctx.font = `${fontWeight(e.font)} ${px}px ${fontStack(e.font)}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.textRendering = "geometricPrecision";
    ctx.fillStyle = e.color ?? "";
    ctx.globalAlpha = l.opacity;
    const m = ctx.measureText(l.text), a = Math.round(m.fontBoundingBoxAscent), d = Math.round(m.fontBoundingBoxDescent);
    // The baseline as CSS sets it: ascent and descent centred in the line box, on a whole pixel.
    ctx.fillText(l.text, x + l.lead * f, Math.round(top + Math.floor((l.height * f - (a + d)) / 2) + a));
    ctx.globalAlpha = 1;
  }
}

/** The image an element shows (a set's slide 2 shows image 0); the group draws its own. */
const mediaOf = (e: El, c: ShareContent, slide: number): string | null | undefined =>
  e.k === "one" ? c.images[slide - 1]?.full : e.k === "clip" ? c.poster : e.k === "up" ? e.src : null;

/** Draws one card at W x H. Rejects when an image cannot be read. `logo`: the card's own generator svg, for a generator element. */
export async function renderCard(doc: ShareDoc, c: ShareContent, slide: number, W: number, H: number, logo?: SVGElement | null): Promise<HTMLCanvasElement> {
  const urls = doc.els.flatMap((e) => (e.k === "results" ? c.images.map((im) => im.full) : [mediaOf(e, c, slide) ?? ""])).filter(Boolean);
  const read = new Map(await Promise.all(urls.map(async (u) => [u, await bitmap(u)] as const)));
  const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.imageSmoothingQuality = "high";
  paintBg(ctx, doc.bg, W, H);
  for (const e of doc.els) {
    const x = (e.x / 100) * W, y = (e.y / 100) * H, w = (e.w / 100) * W, h = (e.h / 100) * H;
    ctx.save();
    // About the element's centre, as CSS rotate does.
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(((e.rot ?? 0) * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
    if (isText(e)) await drawText(ctx, e, doc, c, slide, W, logo);
    else if (e.k === "results") {
      tileRects(e, c.images.length, W, H).forEach((t, i) => drawCover(ctx, read.get(c.images[i].full)!, t.x, t.y, t.w, t.h, t.radius));
    } else {
      const src = mediaOf(e, c, slide), im = src && read.get(src);
      if (im) drawCover(ctx, im, 0, 0, w, h);
    }
    ctx.restore();
  }
  return canvas;
}

/** The file a destination gets. */
export const cardBlob = (canvas: HTMLCanvasElement, type = "image/jpeg") =>
  new Promise<Blob>((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error("card not encoded"))), type, 0.92));
