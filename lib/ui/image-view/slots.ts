/**
 * The buyer's photos on a prompt page (handoff README §5.1, §6; prototype
 * S:306-320, S:387-416): `imgs`, one slot per photo, numbered by its place,
 * and `stash`, the buyer's own photos a smaller slot count pushed out.
 *
 * The prototype keeps its own doc[] of text, {key} and {#} tokens. Here the
 * document is the prompt's text itself, read with the editor's grammar
 * (lib/editor/prompt-tokens, references bare as a saved text writes them),
 * and slot k is "Reference image k" in it: the k-th reference a render sends
 * (setups.ts). Its Token fits; a second token list would need a converter
 * both ways and its own numbering on send. Its rewrite does not fit: it is
 * private, and it takes one space where a slot takes " and ".
 */
import { insertToken, parseTokens, type Token } from "@/lib/editor/prompt-tokens";

/** The most photos one prompt takes (S:125). */
export const MAX_SLOTS = 14;

/** "Add N photos" asks the photo area to open its file picker (window event, one Image View at a time). */
export const ADD_PHOTOS_EVENT = "iv:add-photos";

/** One photo place; `ex`: its photo is the chosen example's, not the buyer's own. */
export interface Slot {
  id: number;
  photo: string | null;
  ex: boolean;
}

export interface Slots {
  /** The prompt's text, its references in step with the slots; null on a premium prompt, whose text never reaches the client. */
  text: string | null;
  imgs: Slot[];
  /** The buyer's own photos a smaller slot count pushed out. They fill the next free slot first. */
  stash: string[];
  /** The fewest slots: 1 where the prompt names an image (its last slot is emptied, never deleted), 0 where it names none. */
  min: number;
}

type Ref = Extract<Token, { kind: "ref" }>;
const AND = " and ";

const refsIn = (text: string) => parseTokens(text, { refs: "plain" }).filter((t): t is Ref => t.kind === "ref");
/** Empty, or holding the example's photo: only the buyer's own photo fills a slot. */
const free = (x: Slot) => x.photo === null || x.ex;
const nextId = (imgs: Slot[]) => Math.max(0, ...imgs.map((x) => x.id)) + 1;

/**
 * What goes with reference `t` when it leaves the text: ONE adjacent " and "
 * (the one after it, else the one before; S:410-411), else one adjacent space
 * as prompt-tokens does, so a reference put in at the cursor leaves no double
 * space. Nothing before `from` is taken (the previous reference's end).
 */
function cut(text: string, t: Ref, from: number): [number, number] {
  if (text.startsWith(AND, t.end)) return [t.start, t.end + AND.length];
  if (t.start - AND.length >= from && text.startsWith(AND, t.start - AND.length)) return [t.start - AND.length, t.end];
  if (t.start > from && text[t.start - 1] === " ") return [t.start - 1, t.end];
  return [t.start, text[t.end] === " " ? t.end + 1 : t.end];
}

/**
 * The text with each reference through `edit`: a number renumbers it, null
 * removes it with what goes with it (cut); undefined keeps it.
 */
function editRefs(text: string, edit: (n: number) => number | null | undefined): string {
  let out = "";
  let at = 0;
  for (const t of refsIn(text)) {
    const r = edit(t.n);
    if (r === undefined) continue;
    const [start, end] = r === null ? cut(text, t, at) : [t.start, t.end];
    out += text.slice(at, start) + (r === null ? "" : t.name.replace(/\d+$/, String(r)));
    at = end;
  }
  return out + text.slice(at);
}

/** Reference n after the text's last reference, " and " between (S:399-400); after the text where it names none (assemble.ts). */
function appendRef(text: string, n: number): string {
  const last = refsIn(text).at(-1);
  const ref = `Reference image ${n}`;
  return last ? text.slice(0, last.end) + AND + ref + text.slice(last.end) : insertToken(text, text.length, ref).text;
}

/** The stash fills the free slots, first to last, while it lasts. */
function settle(s: Slots): Slots {
  let k = 0;
  const imgs = s.imgs.map((x) => (free(x) && k < s.stash.length ? { ...x, photo: s.stash[k++], ex: false } : x));
  return { ...s, imgs, stash: s.stash.slice(k) };
}

/** How many slots a prompt's text asks for (README §5.1): its highest reference, so each one has a slot; at most 14. */
export const slotCount = (text: string) => Math.min(MAX_SLOTS, Math.max(0, ...refsIn(text).map((t) => t.n)));

/** The slots a prompt page opens with: `count` empty ones, by default what the text asks for (none on a premium prompt). */
export function initialSlots(text: string | null, count = text === null ? 0 : slotCount(text)): Slots {
  const n = Math.min(MAX_SLOTS, Math.max(0, count));
  return { text, imgs: Array.from({ length: n }, (_, i) => ({ id: i + 1, photo: null, ex: false })), stash: [], min: Math.min(1, n) };
}

/**
 * A photo the buyer picked (README §5.1, S:391-403). It fills the first free
 * slot; else it arrives, filled, in a new slot whose reference goes after the
 * last one (Easy) or at the cursor `at` (Expert, an index between words). At
 * 14 slots with none free it is refused: `s` comes back as it was.
 */
export function addPhoto(s: Slots, photo: string, at?: number): Slots {
  const open = s.imgs.find(free);
  if (open) return putPhoto(s, open.id, photo);
  if (s.imgs.length >= MAX_SLOTS) return s;
  const n = s.imgs.length + 1;
  const text = s.text === null ? null : at === undefined ? appendRef(s.text, n) : insertToken(s.text, at, `Reference image ${n}`).text;
  return { ...s, text, imgs: [...s.imgs, { id: nextId(s.imgs), photo, ex: false }] };
}

/**
 * The references for slots past the text's own up to `total`, put in at the
 * cursor `at` (Expert's "Ref image at cursor", S:391-403), " and " between
 * them; the text as it was when it already names that many.
 */
export function refsAt(text: string, total: number, at: number): string {
  const from = slotCount(text);
  const refs = Array.from({ length: Math.max(0, Math.min(MAX_SLOTS, total) - from) }, (_, k) => `Reference image ${from + k + 1}`);
  return refs.length ? insertToken(text, at, refs.join(AND)).text : text;
}

/** Slot `id` takes the buyer's photo: a tap on an empty or example slot, or Replace (S:241, S:388). */
export const putPhoto = (s: Slots, id: number, photo: string): Slots => ({
  ...s,
  imgs: s.imgs.map((x) => (x.id === id ? { ...x, photo, ex: false } : x)),
});

/**
 * Slot `id` gone with its reference and ONE adjacent " and "; the slots after
 * it move up one, their references with them (S:404-416). The last slot is
 * emptied instead, never deleted, and the stash fills it.
 */
export function removeSlot(s: Slots, id: number): Slots {
  const i = s.imgs.findIndex((x) => x.id === id);
  if (i < 0) return s;
  if (s.imgs.length <= s.min) return settle({ ...s, imgs: s.imgs.map((x) => (x.id === id ? { ...x, photo: null, ex: false } : x)) });
  const n = i + 1;
  const text = s.text === null ? null : editRefs(s.text, (k) => (k < n ? undefined : k === n ? null : k - 1));
  return { ...s, text, imgs: s.imgs.filter((x) => x.id !== id) };
}

/**
 * The reference that starts at `start` dragged to `to`, an index into the text as it is (Kev, 2026-10-26: "i want to
 * move the images too ... dann sollte das dazugehörige 'and' gelöst werden, sofern keine weiteren bilder dort dran
 * liegen"): it leaves with what goes with it (cut: its " and ", so "R1 and R2 and R3" without R2 is "R1 and R3",
 * the two left still joined), and goes in at `to` with insertToken's spacing. Its number stays, so slot n keeps
 * photo n. Null when nothing moves: no reference starts there, a drop on itself, or the same text back.
 */
export function moveRef(text: string, start: number, to: number): { text: string; caret: number } | null {
  const t = refsIn(text).find((k) => k.start === start);
  if (!t) return null;
  const [a, b] = cut(text, t, 0);
  // A drop where it already is (on itself, its own " and ", or across nothing but spaces) moves nothing: it would only
  // lose the " and " that joins it (review 2026-10-26).
  if ((to >= a && to <= b) || !text.slice(Math.min(to, t.start), Math.max(to, t.end)).replace(t.name, "").trim()) return null;
  const r = insertToken(text.slice(0, a) + text.slice(b), to <= a ? to : to >= b ? to - (b - a) : a, t.name);
  return r.text === text ? null : r;
}

/**
 * `n` slots, never fewer than `min` nor more than 14 (S:306-320). The last
 * ones go, each with its reference, and the buyer's own photos in them into
 * the stash; new ones arrive empty, their references after the last. The
 * stash then fills the free slots.
 */
export function resize(s: Slots, n: number): Slots {
  const want = Math.min(MAX_SLOTS, Math.max(s.min, n));
  const imgs = s.imgs.slice(0, want);
  for (let id = nextId(s.imgs); imgs.length < want; id++) imgs.push({ id, photo: null, ex: false });
  let text = s.text;
  for (let k = s.imgs.length; text !== null && k > want; k--) text = editRefs(text, (m) => (m === k ? null : undefined));
  for (let k = s.imgs.length + 1; text !== null && k <= want; k++) text = appendRef(text, k);
  const pushed = s.imgs.slice(want).flatMap((x) => (x.photo !== null && !x.ex ? [x.photo] : []));
  return settle({ ...s, text, imgs, stash: [...s.stash, ...pushed] });
}

/**
 * An example tapped (README §5.4, plan D13): the slots follow the count of its
 * photos, and slot k takes its photo k where the buyer has not filled it. The
 * buyer's own photos stay; only those a smaller count pushes out go to the
 * stash, which fills free slots before the example does.
 */
export function pickExample(s: Slots, photos: string[]): Slots {
  const r = resize(s, photos.length);
  return { ...r, imgs: r.imgs.map((x, k) => (free(x) ? { ...x, photo: photos[k] ?? null, ex: k < photos.length } : x)) };
}

/** How many photos Generate waits for ("Add N photos", README §5.6): each slot without the buyer's own photo; an example's does not count. */
export const photosMissing = (imgs: Slot[]) => imgs.filter(free).length;
