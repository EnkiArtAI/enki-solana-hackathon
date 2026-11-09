"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { readReference, type NftPick } from "@/hooks/useReferenceReads";
import { readSeconds } from "@/lib/remix/inputs";
import { takeForVideo } from "@/lib/ui/create/handoff";
import { freePlace, frameRefusal, overRefs, takeRefs, type RefKind } from "@/lib/video/media";
import { DEFAULT_MODEL, fitSettings, modelOf, startSettings, type VideoSettings } from "@/lib/video/models";

/** A held picture or clip: `src` is what the tile shows; `saved` the account's saved reference it is, if any, and `url`
 *  its full picture, what the route reads (a saved one's `src` is only its tile). */
export interface VideoMedia { id: string; src: string; kind: RefKind; seconds?: number; saved?: string; url?: string }
export type FrameEnd = "start" | "end";

const UNREADABLE = "This file could not be read. Try another.";
const NO_REFS = { images: 0, clips: 0, clipSeconds: 0 };
/** Beside the media when the picture from Animate finds no free place. */
export const NO_FREE_PLACE = "No free place for the picture from Animate: take one out, then animate it again.";
/** A picture already read (a saved one, an NFT, one taken out and back), as the cap counts it. */
const PICTURE = { type: "image/webp", name: "picture", size: 0 };
/** A clip already held once (taken out and back from the picker's Uploads), as the cap counts it. */
const CLIP = { type: "video/mp4", name: "clip", size: 0 };

/** What the draft keeps of itself for the composer's return. */
interface Kept {
  modelId: string; wanted: VideoSettings; frames: Partial<Record<FrameEnd, VideoMedia>>; refs: VideoMedia[]; prompt: string; uploads: VideoMedia[];
}
/* The draft as Create > Video last left it, in this page's memory: Image or Remix and back finds it, and so does Animate
   (Kev, 2026-10-30: "in den letzten video editor eingefügt wird, in den wo noch was frei ist"; review 2026-10-30: the
   view mounts anew on every tool switch, so Animate always met a fresh Seedance 2.5). A reload starts afresh, and so
   does the next account: Log off reloads the page (EnkiHome doLogoff). */
let kept: Kept | null = null;
/** The next composer opens on a fresh draft (each test case starts from one). */
export const forgetVideoDraft = () => { kept = null; };

/**
 * What the video composer holds: the model, its settings, the start and end frames, the reference media, the words,
 * and each refusal as a sentence beside the zone it belongs to. A model switch keeps every picture and clip (a switch
 * back finds them) and the buyer's settings as picked: each model reads them into its own ranges, so a look at another
 * model never changes them (review 2026-10-30: through Kling 4.0 a silent Kling 3.0 came back with sound). Pictures are
 * read into data as every reference travels (hooks/useReferenceReads); a clip is shown from an object URL, let go once
 * it is out. The draft outlives the composer (`kept`). What goes out is the composer's press (`run`).
 */
export function useVideoDraft() {
  const [modelId, setModelId] = useState(() => kept?.modelId ?? DEFAULT_MODEL.id);
  const model = modelOf(modelId);
  const [wanted, setWanted] = useState<VideoSettings>(() => kept?.wanted ?? startSettings(DEFAULT_MODEL));
  const [frames, setFrames] = useState<Partial<Record<FrameEnd, VideoMedia>>>(() => kept?.frames ?? {});
  const [framesWhy, setFramesWhy] = useState<string | null>(null);
  const [refs, setRefs] = useState<VideoMedia[]>(() => kept?.refs ?? []);
  const [refsWhy, setRefsWhy] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(() => kept?.prompt ?? "");
  // This visit's pictures and clips, for the picker's Uploads: they stay there when taken out (RefPicker, as in the
  // image view; Kev, 2026-10-30: "bei videos, instead of images, mach da Uploads, and also show videos there").
  const [uploads, setUploads] = useState<VideoMedia[]>(() => kept?.uploads ?? []);
  const fitted = fitSettings(model, wanted);
  const settings = model.framesMute && (frames.start || frames.end) ? { ...fitted, audio: false } : fitted;
  useEffect(() => { kept = { modelId, wanted, frames, refs, prompt, uploads }; }, [modelId, wanted, frames, refs, prompt, uploads]);

  // The references as of the last change, what every handler counts against: a pick still being read is checked
  // again as it lands (review 2026-10-30: 9 + 1 quick pictures under Seedance 2.0 held 10).
  const live = useRef<VideoMedia[]>(refs);
  const put = (next: (r: VideoMedia[]) => VideoMedia[]) => {
    live.current = next(live.current);
    setRefs(live.current);
  };

  /* A clip's object URL lives as long as the page: the clip stays in the picker's Uploads once it is out, as a picture
     does, and the kept draft holds it for the composer's return. It points at the file the buyer picked, no copy. */

  /* Animate (Kev, 2026-10-30: "Animate, wodurch es als reference image in den letzten video editor eingefügt wird, in
     den wo noch was frei ist"): the picture Create > Image left goes, once, into the first free place the model takes
     (freePlace); with none free it stays out and says so. takeForVideo empties the hand-off as it reads it, so a reload,
     or the effect's second run in development, finds none. Its tile shows; its full picture is what the route reads, as
     a saved reference's. */
  const animate = useEffectEvent(() => {
    const picture = takeForVideo();
    if (!picture) return;
    const pic: VideoMedia = { id: crypto.randomUUID(), src: picture.thumb ?? picture.url, url: picture.url, kind: "image" };
    const place = freePlace(model, frames, live.current);
    if (place === "refs") put((r) => [...r, pic]);
    else if (place) setFrames((f) => ({ ...f, [place]: pic }));
    else (model.slots.includes("frames") ? setFramesWhy : setRefsWhy)(NO_FREE_PLACE);
  });
  useEffect(() => animate(), []);

  const addFrame = async (end: FrameEnd, file: File) => {
    const why = frameRefusal(file);
    if (why) return setFramesWhy(why);
    const src = await readReference(file);
    if (!src) return setFramesWhy(UNREADABLE);
    setFrames((f) => ({ ...f, [end]: { id: crypto.randomUUID(), src, kind: "image" } }));
    setFramesWhy(null);
  };

  /** Pictures go in once read (made smaller first) and still inside the model's cap; a clip once its length is read and
   *  still fits the model's seconds. Each picture let in is also handed to `keep` (the saved library), and its tile
   *  becomes the saved one once it is kept. */
  const addRefs = async (files: readonly File[], keep?: (src: string) => Promise<{ id: string; url: string } | null>) => {
    const caps = model.refs ?? NO_REFS;
    const { take, why } = takeRefs(files, live.current, caps);
    setRefsWhy(why);
    for (const { file, kind } of take) {
      if (kind === "image") {
        const src = await readReference(file);
        if (!src) { setRefsWhy(UNREADABLE); continue; }
        const room = takeRefs([file], live.current, caps);
        if (!room.take.length) { setRefsWhy(room.why); continue; }
        const id = crypto.randomUUID();
        put((r) => [...r, { id, src, kind }]);
        setUploads((u) => [...u, { id, src, kind }]);
        void keep?.(src).then((saved) => {
          if (!saved) return;
          const mark = (x: VideoMedia) => (x.id === id ? { ...x, saved: saved.id, url: saved.url } : x);
          put((r) => r.map(mark));
          setUploads((u) => u.map(mark));
        });
        continue;
      }
      const src = URL.createObjectURL(file);
      const seconds = await readSeconds(src).catch(() => null);
      const clip: VideoMedia = { id: crypto.randomUUID(), src, kind, seconds: seconds ?? 0 };
      const held = live.current;
      if (seconds === null || overRefs(model, [...held, clip], false).over.includes(held.length)) {
        URL.revokeObjectURL(src);
        setRefsWhy(seconds === null ? UNREADABLE : `Clips here add up to ${model.refs?.clipSeconds} s at most.`);
        continue;
      }
      put((r) => [...r, clip]);
      setUploads((u) => [...u, clip]);
    }
  };

  /** A clip from the picker's Uploads back in, where the model takes one more and its seconds still fit. */
  const putClip = (clip: VideoMedia) => {
    const { take, why } = takeRefs([CLIP], live.current, model.refs ?? NO_REFS);
    if (!take.length) return setRefsWhy(why);
    const held = live.current;
    if (overRefs(model, [...held, clip], false).over.includes(held.length)) return setRefsWhy(`Clips here add up to ${model.refs?.clipSeconds} s at most.`);
    setRefsWhy(null);
    put((r) => [...r, clip]);
  };

  /** One more picture in, where the model's cap still has room; the cap's sentence where it has none. */
  const putPicture = (pic: VideoMedia) => {
    const { take, why } = takeRefs([PICTURE], live.current, model.refs ?? NO_REFS);
    setRefsWhy(why);
    if (take.length) put((r) => [...r, pic]);
  };

  return {
    /** `settings` as the model takes them (Wan 3.0 silent while a frame is held); `wanted` as the buyer picked them. */
    model, settings, wanted, frames, framesWhy, refs, refsWhy, prompt, setPrompt, uploads,
    /** Pictures the model still takes. */
    room: (model.refs?.images ?? 0) - refs.filter((r) => r.kind === "image").length,
    setModel: (id: string) => {
      setModelId(id);
      setFramesWhy(null);
      setRefsWhy(null);
    },
    set: (next: Partial<VideoSettings>) => setWanted((s) => ({ ...s, ...next })),
    addFrame,
    removeFrame: (end: FrameEnd) => { setFrames((f) => ({ ...f, [end]: undefined })); setFramesWhy(null); },
    /** The start and the end frame change places; one alone moves to the other end (Kev, 2026-10-30: "wo ich start und
     *  end image responsively miteinander switchen kann"). Held is held: Wan 3.0 stays silent. */
    swapFrames: () => setFrames((f) => ({ start: f.end, end: f.start })),
    addRefs,
    /** A saved reference in or out of the references, by its saved id (the library's tiles are switches). */
    toggleSaved: (saved: { id: string; src: string; url: string }) => {
      const held = live.current.find((r) => r.saved === saved.id);
      if (held) {
        setRefsWhy(null);
        return put((r) => r.filter((x) => x !== held));
      }
      putPicture({ id: saved.id, src: saved.src, url: saved.url, kind: "image", saved: saved.id });
    },
    /** This visit's picture or clip in or out of the references, by its id (the picker's tiles are switches). */
    toggleUpload: (id: string) => {
      const held = live.current.find((r) => r.id === id);
      if (held) {
        setRefsWhy(null);
        return put((r) => r.filter((x) => x !== held));
      }
      const up = uploads.find((u) => u.id === id);
      if (up) (up.kind === "clip" ? putClip : putPicture)(up);
    },
    /** NFTs from the picker's NFT tab, each read into a picture as every reference travels. */
    addNfts: async (picks: readonly NftPick[]) => {
      for (const p of picks) {
        const src = await readReference(p);
        if (src) putPicture({ id: crypto.randomUUID(), src, kind: "image" });
        else setRefsWhy("That NFT's image could not be read.");
      }
    },
    /** A saved reference deleted: out of the references and the picker. */
    dropSaved: (id: string) => {
      put((r) => r.filter((x) => x.saved !== id));
      setUploads((u) => u.filter((x) => x.saved !== id));
    },
    removeRef: (id: string) => {
      put((r) => r.filter((x) => x.id !== id));
      setRefsWhy(null);
    },
  };
}

export type VideoDraft = ReturnType<typeof useVideoDraft>;
