import type { CaptionKey, PostBlock } from "./content";
import { rn, type Align, type Arrangement, type Bg, type El, type ElKind, type ShareDoc, type ShareStyle } from "./doc";
import { SHARE_FONTS } from "./fonts";

/**
 * A saved style as the account keeps it (SQL 71): places, fonts, colours, ratios
 * and reference ids. parseStyle is the only way in and the only way out, on the
 * server and in the page: every value is checked and built anew, so an unknown
 * key is gone and no string can carry a prompt's words.
 */
const KINDS = new Set<ElKind>(["title", "desc", "prompt", "setup", "link", "tags", "handle", "gen", "results", "one", "clip", "up"]);
const FONTS = new Set<string>(SHARE_FONTS.map((f) => f[0]));
const ALIGNS = new Set<Align>(["left", "center", "right"]);
const ARRANGEMENTS = new Set<Arrangement>(["row", "col", "grid", "hero"]);
const LOOKS = new Set<NonNullable<El["show"]>>(["both", "name", "logo"]);
const BLOCKS = new Set<CaptionKey>(["title", "desc", "prompt", "link", "tags"]);
const HEX = /^#[0-9a-fA-F]{6}$/;
const RATIO = /^[0-9]{1,2}([.][0-9]{1,2})?:[0-9]{1,2}([.][0-9]{1,2})?$/;
// A pulled edge or a settled card writes its own ("0.417:1").
const CUSTOM_RATIO = /^[0-9][.][0-9]{3}:1$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ELS = 24;
export const MAX_STYLE_BYTES = 64 * 1024;
// An element can be held far off a small card and turned more than once: these bound nonsense, not gestures.
const REACH = 1000, TURNS = 36000;

const no = (): never => { throw new Error("refused"); };
const rec = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : no());
const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : no());
const size = (v: unknown) => (num(v, 0, REACH) > 0 ? (v as number) : no());
const hex = (v: unknown) => (typeof v === "string" && HEX.test(v) ? v : no());
const member = <T,>(set: Set<T>, v: unknown) => (set.has(v as T) ? (v as T) : no());

function el(v: unknown): El {
  const r = rec(v), k = member(KINDS, r.k);
  const e: El = { id: num(r.id, 0, Number.MAX_SAFE_INTEGER), k, x: num(r.x, -REACH, REACH), y: num(r.y, -REACH, REACH), w: size(r.w), h: size(r.h), rot: num(r.rot, -TURNS, TURNS) };
  if (r.font !== undefined) e.font = member(FONTS, r.font);
  if (r.color !== undefined) e.color = hex(r.color);
  if (r.align !== undefined) e.align = member(ALIGNS, r.align);
  if (r.arr !== undefined) e.arr = member(ARRANGEMENTS, r.arr);
  if (r.gap !== undefined) e.gap = num(r.gap, 0, 1);
  if (r.of !== undefined) e.of = num(r.of, 1, MAX_ELS);
  if (r.show !== undefined) e.show = member(LOOKS, r.show);
  if (r._w !== undefined) e._w = size(r._w);
  if (r._h !== undefined) e._h = size(r._h);
  // A picture is its saved reference or nothing: an address expires and a data URL is no place to keep one.
  if (k === "up") e.ref = typeof r.ref === "string" && UUID.test(r.ref) ? r.ref : no();
  return e;
}

function bg(v: unknown): Bg {
  const r = rec(v);
  if (r.mode === "solid") return { mode: "solid", c: hex(r.c) };
  if (r.mode !== "gradient") no();
  return { mode: "gradient", a: hex(r.a), b: hex(r.b), dir: r.dir === "radial" ? "radial" : num(r.dir, 0, 360) };
}

function ratio(v: unknown): string {
  if (typeof v !== "string" || !(RATIO.test(v) || CUSTOM_RATIO.test(v))) no();
  return rn(v as string) >= 0.05 && rn(v as string) <= 20 ? (v as string) : no();
}

function doc(v: unknown): ShareDoc {
  const r = rec(v);
  if (!Array.isArray(r.els) || r.els.length > MAX_ELS) no();
  const els = (r.els as unknown[]).map(el);
  if (new Set(els.map((e) => e.id)).size !== els.length) no();
  if (r.ov !== undefined && typeof r.ov !== "boolean") no();
  return { ratio: ratio(r.ratio), bg: bg(r.bg), ...(r.ov ? { ov: true } : null), els };
}

function blocks(v: unknown): PostBlock[] {
  if (!Array.isArray(v)) no();
  const list = (v as unknown[]).map((b): PostBlock => {
    const r = rec(b);
    return { key: member(BLOCKS, r.key), on: typeof r.on === "boolean" ? r.on : no() };
  });
  return new Set(list.map((b) => b.key)).size === list.length ? list : no();
}

/** A style as it may be kept and drawn; null for anything else, whole: half a style is not the creator's. */
export function parseStyle(raw: unknown): ShareStyle | null {
  try {
    if (raw === null || raw === undefined || new TextEncoder().encode(JSON.stringify(raw)).length > MAX_STYLE_BYTES) return null;
    const r = rec(raw), style: ShareStyle = {};
    if (r.image !== undefined) style.image = { ...doc(r.image), bk: blocks(rec(r.image).bk) };
    if (r.video !== undefined) style.video = { ...doc(r.video), bk: blocks(rec(r.video).bk) };
    if (r.set !== undefined) {
      const s = rec(r.set);
      style.set = { ov: doc(s.ov), per: doc(s.per), bk: blocks(s.bk) };
    }
    return style;
  } catch {
    return null;
  }
}

const docsOf = (s: ShareStyle): ShareDoc[] => [s.image, s.video, s.set?.ov, s.set?.per].filter((d): d is ShareDoc => !!d);

export const styleFonts = (s: ShareStyle) => [...new Set(docsOf(s).flatMap((d) => d.els.flatMap((e) => (e.font ? [e.font] : []))))];
export const styleRefs = (s: ShareStyle) => [...new Set(docsOf(s).flatMap((d) => d.els.flatMap((e) => (e.ref ? [e.ref] : []))))];

/** The style with each picture at its address now; a reference that is gone has none, and the templates' `present` skips its element. */
export function withPictures(s: ShareStyle, urls: ReadonlyMap<string, string>): ShareStyle {
  const on = <T extends ShareDoc>(d: T): T => ({ ...d, els: d.els.map((e) => (e.k === "up" ? { ...e, src: (e.ref && urls.get(e.ref)) || undefined } : e)) });
  return {
    ...(s.image ? { image: on(s.image) } : null),
    ...(s.video ? { video: on(s.video) } : null),
    ...(s.set ? { set: { ...s.set, ov: on(s.set.ov), per: on(s.set.per) } } : null),
  };
}
