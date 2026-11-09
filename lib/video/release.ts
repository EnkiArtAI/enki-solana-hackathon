import type { SupabaseClient } from "@supabase/supabase-js";
import { VIDEO_SQL, videoColumns } from "@/lib/marketplace/video-columns";
import { VIDEO_MODELS } from "./models";
import { videoRenditions, type VideoRenditions } from "./renditions";

const NOTHING = "Nothing was saved.";
const isVideoRow = (name: string) => VIDEO_MODELS.some((m) => m.label === name);

export type VideoSave =
  /** Not a video save at all: the image path, with nothing read. */
  | { ok: true; files: null }
  /** The files of the render this save shows. */
  | { ok: true; files: VideoRenditions }
  | { ok: false; status: number; error: string; run?: string };

/**
 * What POST /api/prompt says to a save that names a video (Kev, 2026-11-03: "allow also only the creation of 1 video for
 * premium prompts"): one render, the creator's own, a real video with its files. A released prompt keeps its medium. A save
 * that names none reads nothing here, so an image save is as it was. Before SQL 52 it names the file and saves nothing.
 */
export async function videoForSave(
  supabase: SupabaseClient,
  body: { id?: string | null; mediaType?: unknown; showcaseVideoImageId?: unknown; aiModel?: unknown; aiModels?: unknown; uploadedPhotos?: unknown },
  owners: string[],
): Promise<VideoSave> {
  const { id, mediaType, showcaseVideoImageId: render } = body;
  if (mediaType === undefined && render === undefined) return { ok: true, files: null };
  if (mediaType !== "image" && mediaType !== "video" && mediaType !== undefined) return { ok: false, status: 400, error: `A prompt makes images or videos. ${NOTHING}` };
  const video = mediaType === "video" || render !== undefined;
  if (mediaType === "image" && render !== undefined) return { ok: false, status: 400, error: `An image prompt shows no video. ${NOTHING}` };
  if (!(await videoColumns(supabase))) {
    return video ? { ok: false, status: 503, error: `Video prompts need sql-to-run/${VIDEO_SQL}. ${NOTHING}`, run: VIDEO_SQL } : { ok: true, files: null };
  }
  if (id) {
    const { data, error } = await supabase.from("prompts").select("media_type").eq("id", id).maybeSingle();
    if (error) return { ok: false, status: 503, error: `This prompt could not be checked right now. ${NOTHING}` };
    if (data && data.media_type !== (video ? "video" : "image")) return { ok: false, status: 422, error: `A released prompt keeps what it makes. ${NOTHING}` };
  }
  if (!video) return { ok: true, files: null };

  const photos = Array.isArray(body.uploadedPhotos) ? body.uploadedPhotos : [];
  if (Array.isArray(render) || photos.length > 1) return { ok: false, status: 422, error: `A video prompt shows one video. ${NOTHING}` };
  const names = [body.aiModel, ...(Array.isArray(body.aiModels) ? body.aiModels : [])].filter((n) => typeof n === "string" && n.trim());
  if (!names.every((n) => isVideoRow(String(n).trim()))) return { ok: false, status: 422, error: `A video prompt runs on video generators. ${NOTHING}` };
  // An update of what is live keeps its video; a new prompt needs one.
  if (render === undefined) return id ? { ok: true, files: null } : { ok: false, status: 422, error: `Make the video first. ${NOTHING}` };
  if (typeof render !== "string" || !/^[0-9a-f-]{36}$/i.test(render)) return { ok: false, status: 400, error: `Which video? ${NOTHING}` };
  const { data: row, error } = await supabase.from("generated_images").select("mime_type, video").eq("id", render).in("user_id", owners).is("deleted_at", null).maybeSingle();
  if (error) return { ok: false, status: 503, error: `This prompt could not be checked right now. ${NOTHING}` };
  const files = videoRenditions(row?.video);
  if (!files || !String(row?.mime_type ?? "").startsWith("video/")) return { ok: false, status: 422, error: `The video must be one of your own renders on Enki. ${NOTHING}` };
  return { ok: true, files };
}
