"use client";

import { useEffect, useRef, useState } from "react";
import { clipFileRefusal, clipLengthRefusal, readSeconds, takePhotos } from "@/lib/remix/inputs";
import type { RemixCardData } from "@/lib/remix/library";
import type { RemixMode } from "@/lib/remix/modes";
import { DEFAULT_RESOLUTION, type RemixResolution } from "@/lib/remix/price";

export interface RemixClip {
  src: string;
  seconds: number;
  /** The picked file; none for a clip Recreate put in. */
  file?: File;
}
export interface RemixPhoto { src: string; file: File }

const UNREADABLE = "This video could not be read. Try an MP4 or MOV file.";

/**
 * What the Remix composer holds: the mode, the clip, the photos, the prompt and the resolution, each refusal as a
 * sentence beside the zone it belongs to. A picked file is shown from an object URL, let go once it is removed,
 * replaced or the composer leaves. Nothing is sent anywhere: the remix backend does not exist yet.
 */
export function useRemixDraft() {
  const [mode, setMode] = useState<RemixMode>("motion");
  const [clip, setClip] = useState<RemixClip | null>(null);
  const [clipWhy, setClipWhy] = useState<string | null>(null);
  const [photos, setPhotos] = useState<RemixPhoto[]>([]);
  const [photoWhy, setPhotoWhy] = useState<string | null>(null);
  const [promptOn, setPromptOn] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [resolution, setResolution] = useState<RemixResolution>(DEFAULT_RESOLUTION);

  const urls = useRef(new Set<string>());
  const own = (file: File) => {
    const src = URL.createObjectURL(file);
    urls.current.add(src);
    return src;
  };
  const release = (src: string) => { if (urls.current.delete(src)) URL.revokeObjectURL(src); };
  // The clip's URL lives as long as it is the clip; whatever is still held goes with the composer.
  useEffect(() => { if (clip) { const { src } = clip; return () => release(src); } }, [clip]);
  useEffect(() => () => { for (const src of urls.current) URL.revokeObjectURL(src); urls.current.clear(); }, []);

  /** Checked before it is read (type, size), then by the length its metadata says (4 to 15 s). */
  const addClip = async (file: File) => {
    const early = clipFileRefusal(file);
    if (early) return setClipWhy(early);
    const src = own(file);
    const seconds = await readSeconds(src).catch(() => null);
    const why = seconds === null ? UNREADABLE : clipLengthRefusal(seconds);
    if (seconds === null || why) {
      release(src);
      return setClipWhy(why);
    }
    setClip({ src, seconds, file });
    setClipWhy(null);
  };
  const addPhotos = (files: readonly File[]) => {
    const { take, why } = takePhotos(files, photos.length);
    setPhotoWhy(why);
    if (take.length) setPhotos([...photos, ...take.map((file) => ({ src: own(file), file }))]);
  };
  const removePhoto = (src: string) => {
    release(src);
    setPhotos(photos.filter((p) => p.src !== src));
    setPhotoWhy(null);
  };

  return {
    mode, setMode, clip, clipWhy, photos, photoWhy, promptOn, setPromptOn, prompt, setPrompt, resolution, setResolution,
    addClip, addPhotos, removePhoto,
    removeClip: () => { setClip(null); setClipWhy(null); },
    /** A card's clip and its way into the composer; the photos stay the buyer's. */
    recreate: (card: RemixCardData) => {
      setMode(card.mode);
      setClip({ src: card.clip, seconds: card.seconds });
      setClipWhy(null);
    },
  };
}

export type RemixDraft = ReturnType<typeof useRemixDraft>;
