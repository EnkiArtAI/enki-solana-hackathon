/**
 * What a finished picture on Create > Image's wall offers (Kev, 2026-10-30, after Higgsfield's rail, "bitte kupfer nicht
 * 1zu1 the things from the ref image, but apply the enki style to it"): a rail at its top right (Bookmark, Download,
 * Recreate, Make it a prompt, then ⋯), Reference and Animate at its bottom left, and under ⋯ Add to Studio, Share and
 * Delete. A touch screen has no hover: its tile carries ⋯ alone, which holds everything. What does not fit a small
 * tile goes under its ⋯ too.
 */
import { wallShot, type WallItem } from "./image";

export type TileAct = "bookmark" | "download" | "recreate" | "prompt" | "reference" | "animate" | "studio" | "communities" | "share" | "delete";
/** Top right, in this order (Kev: "oben rechts ... bookmark ... darunter ist download, dieses copy symbol ist dann recreate
 *  ... dann Create prompt auch so klein. und dann diese 3 dots"). */
export const RAIL: readonly TileAct[] = ["bookmark", "download", "recreate", "prompt"];
/** Bottom left (Kev: "ganz unten das bild und video, bedeuten: Reference ... und Animate"). */
export const PAIR: readonly TileAct[] = ["reference", "animate"];
/** Under ⋯ (Kev: "Add to Studio -> studio auswahl; Share -> Copy link -> share to platform ...; Delete"), Communities after
 *  Studio (the agreed shape, 2026-10-30: "the tile ⋯ menu / viewer of an own render ("Communities")"). */
export const MENU: readonly TileAct[] = ["studio", "communities", "share", "delete"];
/** Everything, in the order a touch screen's sheet lists it. */
export const ALL: readonly TileAct[] = [...RAIL, ...PAIR, ...MENU];

/** A rail button, the space between two and to the tile's edge (feed.css .ci-act, .ci-rail). */
const BTN = 28;
const GAP = 4;
const EDGE = 8;
/** The narrowest tile whose Reference and Animate stand clear of the rail: the pair (8 + 28 + 4 + 28) and the rail (28 + 8) with room between. */
export const PAIR_MIN_W = 120;

/** Which actions stand on a tile w x h px (a pointer that hovers) and which go under its ⋯: the rail keeps ⋯ and as
 *  many of its own as the height holds; the pair needs the width. */
export function tileLayout(w: number, h: number): { rail: TileAct[]; pair: TileAct[]; more: TileAct[] } {
  const slots = Math.max(1, Math.floor((h - 2 * EDGE + GAP) / (BTN + GAP)));
  const rail = RAIL.slice(0, slots - 1);
  const pair = w >= PAIR_MIN_W ? [...PAIR] : [];
  return { rail, pair, more: [...RAIL.slice(rail.length), ...PAIR.filter((a) => !pair.includes(a)), ...MENU] };
}

/** What the actions take from one picture. Null while it renders or after it failed (those tiles have none). */
export interface TileFacts {
  /** The stored original: what Download saves and Animate hands to Create > Video. */
  url: string;
  /** What the viewer shows: what Reference reads into the bar, as every reference travels. */
  src: string;
  /** The wall's small version. */
  thumb: string;
  /** The recorded row: Delete and Add to Studio need it; a render of this visit has none until it is saved. */
  rowId: string | null;
  /** The prompt it was made with: what a bookmark keeps (the route files prompts, not images). */
  promptId: string | null;
  /** The viewer's own words, for Make it a prompt; none on someone's listed prompt (they are its creator's). */
  words: string | null;
  /** Its page once public (/i/<id>, which unfurls as the picture with "Made with Enki"); else null. An 18+ render has
   *  none (that page refuses it, lib/share/public-image.ts): it shares the picture, as the profile's wall does. */
  page: string | null;
}

export function tileFacts(item: WallItem): TileFacts | null {
  const shot = wallShot(item);
  if (!shot?.src) return null;
  const row = item.kind === "row" ? item.row : null;
  const said = item.kind === "job" ? item.job.setup.prompt : item.row.prompt_kind === "market" ? null : item.row.prompt_text;
  return {
    url: shot.original ?? shot.src,
    src: shot.src,
    thumb: item.src ?? shot.src,
    rowId: row?.id ?? null,
    promptId: row?.prompt_id ?? item.job?.setup.promptId ?? null,
    words: said?.trim() ? said : null,
    page: row?.visibility === "public" && !row.isAdult ? `/i/${encodeURIComponent(row.id)}` : null,
  };
}

/** The link Copy link and the platforms carry: its page once public, else the picture's own address (as the viewer's
 *  Share image: anyone with it can open the picture); none for a picture not stored yet. */
export function shareLink(f: Pick<TileFacts, "page" | "url">, origin: string): string | null {
  if (f.page) return origin + f.page;
  return /^https?:\/\//i.test(f.url) ? f.url : null;
}

/** Where a link can go where the device has no share sheet of its own, each by its own share address. */
export function sharePlatforms(link: string, text: string): { key: string; label: string; href: string }[] {
  const u = encodeURIComponent(link);
  const t = encodeURIComponent(text);
  return [
    { key: "x", label: "X", href: `https://x.com/intent/tweet?url=${u}&text=${t}` },
    { key: "facebook", label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${u}` },
    { key: "reddit", label: "Reddit", href: `https://www.reddit.com/submit?url=${u}&title=${t}` },
    { key: "whatsapp", label: "WhatsApp", href: `https://wa.me/?text=${encodeURIComponent(`${text} ${link}`)}` },
    { key: "telegram", label: "Telegram", href: `https://t.me/share/url?url=${u}&text=${t}` },
    { key: "email", label: "Email", href: `mailto:?subject=${t}&body=${encodeURIComponent(`${text}\n${link}`)}` },
  ];
}

/** Why an action cannot run on this picture (its button stays, dimmed, and a press says this); null: it can. */
export function refusal(a: TileAct, f: Pick<TileFacts, "promptId" | "words" | "rowId">): string | null {
  // The bookmarks route files a prompt (bookmarks.prompt_id is not null, migrations/2026-08-22-bookmarks.sql).
  if (a === "bookmark" && !f.promptId) return "Bookmarks keep prompts. This image was made from your own words: Make it a prompt to keep it.";
  if (a === "prompt" && !f.words) return "Its words belong to the prompt's creator.";
  if (a === "delete" && !f.rowId) return "Saving your render… It can be deleted once it is saved.";
  if (a === "communities" && !f.rowId) return "Saving your render… It can join communities once it is saved.";
  return null;
}

/** Why Reference cannot put this picture into the bar (the generator's room, as "+" and the picker keep it); null: it can. */
export function referenceRefusal(
  bar: { cap: number; room: number; refs: ReadonlyArray<{ id: string }>; pending: readonly string[]; name: string },
  src: string,
): string | null {
  if (bar.cap === 0) return `${bar.name} takes no reference images`;
  if (bar.refs.some((r) => r.id === src) || bar.pending.some((p) => p.startsWith(`${src}#read-`))) return "It is already one of the references";
  if (bar.room <= 0) return `${bar.name} takes up to ${bar.cap} reference image${bar.cap === 1 ? "" : "s"}. Remove one first.`;
  return null;
}
