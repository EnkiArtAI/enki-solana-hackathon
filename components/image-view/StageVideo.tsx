"use client";

import { useEffect, useRef } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { holdSource, pickPlaying, playReader, startPlaying, stopPlaying } from "@/lib/ui/feed/visible-play";
import { STAGE_WIDE, stageSrc } from "@/lib/ui/image-view/video";
import type { VideoRenditions } from "@/lib/video/renditions";

/**
 * A video prompt's player where the picture is (Kev, 2026-11-03: "gleiches visualisierungprinzip wie bei den bildern"):
 * v720 on a phone, v1080 from 1024 px, its poster until it plays. It starts on opening, muted; Save-Data, reduced motion or a
 * refused play leave the poster and the control. Sound only through the control, the buyer's own press.
 */
export default function StageVideo({ files, label, onSeen }: { files: VideoRenditions; label: string; onSeen: () => void }) {
  const wide = useMediaQuery(STAGE_WIDE);
  const ref = useRef<HTMLVideoElement>(null);
  const src = stageSrc(files, wide);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    holdSource(el, src);
    // One card seen by nobody else: the same rule the feed's walls read.
    if (pickPlaying([{ key: el, visible: 1, distance: 0 }], playReader()).has(el)) startPlaying(el, () => {});
    return () => stopPlaying(el);
  }, [src]);
  // A shell panel over the view only hides it (EnkiDetailPanel), and a video the viewer unmuted went on sounding behind it. Back where it was, if it was playing.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let resume = false;
    const hide = () => {
      if (el.paused) return;
      resume = true;
      el.pause();
    };
    const show = () => {
      if (resume) void el.play()?.catch(() => {});
      resume = false;
    };
    window.addEventListener("enki:hide-detail", hide);
    window.addEventListener("enki:show-detail", show);
    return () => {
      window.removeEventListener("enki:hide-detail", hide);
      window.removeEventListener("enki:show-detail", show);
    };
  }, []);
  return <video ref={ref} className="iv-video" aria-label={label} src={src} poster={files.poster} muted playsInline loop preload="none" controls onLoadedMetadata={onSeen} />;
}
