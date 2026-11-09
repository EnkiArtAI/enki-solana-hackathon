/**
 * A video prompt in the Image View (Kev, 2026-11-03: "gleiches visualisierungprinzip wie bei den bildern für image UI"): what
 * the stage plays and what the settings row opens on.
 */
import { microToUsd, type GenerationQuote } from "@/lib/generation-checkout";
import { VIDEO_MODELS, fitSettings, startSettings, type Aspect, type Resolution, type VideoModel, type VideoSettings } from "@/lib/video/models";
import type { VideoRenditions } from "@/lib/video/renditions";

/** From here up the stage plays v1080, where the video has one; a phone and a tablet v720. */
export const STAGE_WIDE = "(min-width: 1024px)";
export const stageSrc = (files: Pick<VideoRenditions, "v720" | "v1080">, wide: boolean) => (wide && files.v1080) || files.v720;

/** A generator's capability row, by its catalogue name (SQL 67 names the rows as VideoModel.label). */
export const videoRowOf = (name: string | null | undefined): VideoModel | null => VIDEO_MODELS.find((m) => m.label === name) ?? null;

/** The settings a video prompt opens on: its own shape, resolution and length, inside what model `m` takes. */
export function promptVideoSettings(m: VideoModel, p: { aspect_ratio?: string | null; resolution?: string | null; showcaseVideo?: Pick<VideoRenditions, "durationMs"> | null } | undefined): VideoSettings {
  const start = startSettings(m);
  return fitSettings(m, {
    ...start,
    aspect: (p?.aspect_ratio as Aspect | null | undefined) ?? start.aspect,
    resolution: (p?.resolution as Resolution | null | undefined) ?? start.resolution,
    seconds: p?.showcaseVideo?.durationMs ? Math.round(p.showcaseVideo.durationMs / 1000) : start.seconds,
  });
}

/** A video prompt's first example: the stage plays `video`, and its box takes the file's own shape. */
export const videoShot = (video: VideoRenditions) => ({ video, ...(video.width && video.height ? { ratio: `${video.width}:${video.height}` } : {}) });

/** A price for what the kit's pickers read. */
export const microQuote = (totalMicro: number): GenerationQuote => ({ totalMicro, totalUsd: microToUsd(totalMicro), networkFeeUsd: "0", artistUsd: "0", expiresAt: "", appliedRule: null });
