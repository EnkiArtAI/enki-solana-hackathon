import { PHOTO_TYPES, clipFileRefusal } from "@/lib/remix/inputs";
import { tenths } from "@/lib/remix/price";
import type { RefCaps, VideoModel } from "./models";

/** A picked file as the rules read it: the same shape lib/remix/inputs reads. */
type Picked = { type: string; name: string; size: number };
/** A reference as the composer holds it: a picture or a clip (its seconds read from it). */
export type RefKind = "image" | "clip";
export interface HeldRef { kind: RefKind; seconds?: number }

/** Why a picked file cannot be a frame; null when it can. */
export const frameRefusal = (file: Picked) => (PHOTO_TYPES.includes(file.type) ? null : "Pick a PNG, JPEG or WebP image.");

/** A reference file's kind: a picture by its type, otherwise a clip as Remix takes one (MP4 or MOV, 200 MB at most). */
export const refKind = (file: Picked): RefKind | null =>
  PHOTO_TYPES.includes(file.type) ? "image" : clipFileRefusal(file) === null ? "clip" : null;

const capLine = (c: RefCaps) => `At most ${c.images} images and ${c.clips} clips here.`;

/** The reference files that fit beside those `held`, in the order picked, and what was left out, in a sentence. */
export function takeRefs<F extends Picked>(files: readonly F[], held: readonly HeldRef[], caps: RefCaps): { take: Array<{ file: F; kind: RefKind }>; why: string | null } {
  const count = { image: held.filter((r) => r.kind === "image").length, clip: held.filter((r) => r.kind === "clip").length };
  const take: Array<{ file: F; kind: RefKind }> = [];
  let why: string | null = null;
  for (const file of files) {
    const kind = refKind(file);
    if (!kind) why = "Only PNG, JPEG or WebP images and MP4 or MOV clips of up to 200 MB.";
    else if (count[kind] >= (kind === "image" ? caps.images : caps.clips)) why ??= capLine(caps);
    else {
      count[kind]++;
      take.push({ file, kind });
    }
  }
  return { take, why };
}

/**
 * Where a picture sent by Animate goes under model `m` (Kev, 2026-10-30: "in den letzten video editor eingefügt wird, in
 * den wo noch was frei ist"): the start frame, else the end frame, where the model takes frames and they are free; else
 * the references, where it takes pictures there and has room. Wan 3.0's one-or-the-other closes the frames while
 * references are held and the references while a frame is. Null: nothing is free.
 */
export function freePlace(m: VideoModel, frames: { start?: unknown; end?: unknown }, refs: readonly HeldRef[]): "start" | "end" | "refs" | null {
  if (m.slots.includes("frames") && !(m.oneSlot && refs.length)) {
    if (!frames.start) return "start";
    if (!frames.end) return "end";
  }
  const shut = m.oneSlot && (frames.start || frames.end);
  const images = refs.filter((r) => r.kind === "image").length;
  return m.refs && !shut && images < m.refs.images ? "refs" : null;
}

/**
 * Which held references model `m` cannot take, by place, and why, in a sentence: the pictures past its image cap, the
 * clips past its clip cap or past its seconds in all (counted in the tenths a clip shows). They stay in the composer,
 * marked, for a switch back; frames and references both held under a model that takes one or the other are said too.
 * `clipTenths`: the seconds of the clips it does take, in tenths, which the price counts.
 */
export function overRefs(m: VideoModel, refs: readonly HeldRef[], framesHeld: boolean): { over: number[]; why: string | null; clipTenths: number } {
  if (!m.refs || !m.slots.includes("refs")) return { over: [], why: null, clipTenths: 0 };
  const caps = m.refs;
  const over: number[] = [];
  let images = 0, clips = 0, t = 0;
  refs.forEach((r, i) => {
    if (r.kind === "image") {
      if (++images > caps.images) over.push(i);
      return;
    }
    const next = t + tenths(r.seconds ?? 0);
    if (++clips > caps.clips || next > caps.clipSeconds * 10) over.push(i);
    else t = next;
  });
  if (over.length) return { over, clipTenths: t, why: `${m.label} takes ${caps.images} images and ${caps.clips} clips of ${caps.clipSeconds} s in all: take ${over.length} out.` };
  if (m.oneSlot && framesHeld && refs.length) return { over, clipTenths: t, why: `${m.label} takes frames or references, not both: take one out.` };
  return { over, why: null, clipTenths: t };
}
