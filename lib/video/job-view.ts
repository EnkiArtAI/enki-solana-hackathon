import { VIDEO_MODELS, type VideoSettings } from "./models";
import { videoRenditions, type VideoRenditions } from "./renditions";

export type VideoJobStatus = "submitting" | "running" | "transcoding" | "delivered" | "failed" | "refused";
/** Why a job ended without a video, as video_jobs.error_class holds it. */
export type VideoJobWhy = "real_person" | "moderation" | "image_check" | "unchecked" | "payment" | "owed" | "failed";

/** The one sentence each ending gets (Kev, 2026-10-30: a real-face refusal is one clear sentence, voided, not billed). */
export const JOB_WHY: Readonly<Record<VideoJobWhy, string>> = {
  real_person: "This video can't use a photo of a real person's face. Nothing was charged.",
  moderation: "This video can't be made on Enki. Nothing was charged.",
  image_check: "This video can't be delivered on Enki. Nothing was charged.",
  unchecked: "Your video could not be checked right now, so it was not delivered. Nothing was charged. Please try again.",
  payment: "Your payment did not go through, so the video was not delivered. Nothing was charged.",
  owed: "Your payment went through but the video could not be delivered. It is refunded.",
  failed: "The video could not be made. Nothing was charged.",
};

/** Beside the pictures wherever a frame or a reference is held, in Sume's words (Kev, 2026-10-30: "die pflichten sollten wir alle einbauen"), and the route's refusal without it. */
export const VIDEO_CONSENT = "I am the person in this photo, or I have their permission";
export const VIDEO_CONSENT_REFUSED = "Confirm you are the person in the photo, or have their permission. Nothing was charged.";

/** Under Generate while a video of theirs is under way. */
export const VIDEO_MAKING = "Your video is being made. It lands in History when it is ready.";

/** What a person may read of their own job: never the operator, its task or code, the words or the hash. */
export interface VideoJobView {
  id: string;
  status: VideoJobStatus;
  /** The generator's name, by the capability row its catalogue row is named after. */
  label: string | null;
  settings: Partial<VideoSettings>;
  promptId: string | null;
  createdAt: string;
  why: string | null;
  video: VideoRenditions | null;
  imageId: string | null;
}

export const jobRunning = (status: VideoJobStatus) => status === "submitting" || status === "running" || status === "transcoding";

/** What the routes read of a row for the view; nothing else is selected for an owner. */
export const VIEW_COLUMNS = "id, status, settings, prompt_id, created_at, error_class, video, generated_image_id";

export function jobView(row: { id: string; status: string; settings: unknown; prompt_id: string | null; created_at: string; error_class: string | null; video: unknown; generated_image_id: string | null }): VideoJobView {
  const settings = (row.settings ?? {}) as Partial<VideoSettings> & { modelId?: string };
  const status = row.status as VideoJobStatus;
  const { modelId, seconds, aspect, resolution, audio, bitrate } = settings;
  return {
    id: row.id,
    status,
    label: VIDEO_MODELS.find((m) => m.id === modelId)?.label ?? null,
    settings: { seconds, aspect, resolution, audio, bitrate },
    promptId: row.prompt_id,
    createdAt: row.created_at,
    why: status === "failed" || status === "refused" ? JOB_WHY[(row.error_class as VideoJobWhy) ?? "failed"] ?? JOB_WHY.failed : null,
    // Handed over only once delivered: a stored file before the capture is not the buyer's yet.
    video: status === "delivered" ? videoRenditions(row.video) : null,
    imageId: status === "delivered" ? row.generated_image_id : null,
  };
}
