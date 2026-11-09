import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ORIGINALS_BUCKET, VIDEO_BUCKET } from "./ready";
import type { VideoRenditions } from "./renditions";
import type { Transcoded } from "./transcode";

const YEAR = "31536000";

export type StoredVideo = VideoRenditions & {
  /** What the bucket holds of it, for taking it down again; never handed to a page. */
  paths: string[];
  v720Bytes: number;
};

/**
 * The files in the public bucket under their content's hash, immutable for a year, the same name for the same bytes. The
 * original goes to the private one, best effort: the buyer's video does not depend on it, and it is the first thing to drop
 * when storage matters (60% of a video's bytes, 2026-11-03). Throws when a public file cannot be stored; what landed comes down.
 */
export async function storeVideo(db: SupabaseClient, userId: string, t: Transcoded): Promise<StoredVideo> {
  const bucket = db.storage.from(VIDEO_BUCKET);
  const paths: string[] = [];
  const put = async (bytes: Buffer, ext: string, contentType: string) => {
    const path = `${userId}/${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
    const { error } = await bucket.upload(path, bytes, { contentType, cacheControl: YEAR, upsert: true });
    if (error) throw new Error(`[video] a file could not be stored: ${error.message}`);
    paths.push(path);
    return bucket.getPublicUrl(path).data.publicUrl;
  };
  try {
    const preview = await put(await readFile(t.preview), "mp4", "video/mp4");
    const v720File = await readFile(t.v720);
    const v720 = await put(v720File, "mp4", "video/mp4");
    const v1080 = t.v1080 ? await put(await readFile(t.v1080), "mp4", "video/mp4") : null;
    const poster = await put(t.poster, "webp", "image/webp");

    const original = await readFile(t.original);
    const kept = await db.storage.from(ORIGINALS_BUCKET)
      .upload(`${userId}/${createHash("sha256").update(original).digest("hex")}.mp4`, original, { contentType: "video/mp4", upsert: true })
      .catch((e: unknown) => ({ error: e instanceof Error ? e : new Error(String(e)) }));
    if (kept.error) console.warn("[video] the original was not kept:", kept.error.message);

    return { preview, v720, v1080, poster, width: t.info.width, height: t.info.height, durationMs: t.info.durationMs, paths, v720Bytes: v720File.length };
  } catch (e) {
    await removeStored(db, paths);
    throw e;
  }
}

/** Best effort: a capture that did not land takes the public files down, as the image route does. */
export async function removeStored(db: SupabaseClient, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await db.storage.from(VIDEO_BUCKET).remove(paths).catch(() => null);
}
