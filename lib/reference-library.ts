import { createHash } from "crypto";
import sharp from "sharp";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { stillImageType } from "@/lib/moderation/image-check-bytes";
import { REQUEST_MAX_BYTES } from "@/lib/request-size";

/**
 * Saved reference images (Kev, 2026-10-29: "the images uploaded via ref image uploading must remain in that image
 * upload UI until i delete them, this must be the database of uploaded referenced images";
 * migrations/2026-10-29-reference-uploads.sql = SQL 51). A saved picture is image-checked where every reference is, at
 * the render that sends it, so until then it is its owner's alone: kept in a private bucket, reached through addresses
 * signed for an hour and answered to its owner only (DEC-525). The render stores its own copy once checked
 * (lib/generation/reference-images).
 */

/** As many as one account keeps, held by SQL 51's trigger (Kev, 2026-10-30: "500 refs pro konto sind schon ein bisschen
 *  viel ... eher bei 50"). At the cap a save is refused with the sentence below, never an older one dropped. */
export const MAX_REFERENCES = 50;
/** SQL 51's private bucket, and how long an address to one of its files stays good (seconds). */
export const REFERENCE_BUCKET = "reference-uploads";
export const REFERENCE_SIGN_TTL = 3_600;

export const REFERENCES_NOT_READY = "Saving references is not available yet.";
export const REFERENCES_FULL = `You can keep up to ${MAX_REFERENCES} references. Delete some first.`;
export const NOT_A_REFERENCE = "Only a PNG, JPEG or WebP image under 4 MB can be saved.";

/** A failed read or write: the outage 503, SQL 51 not run yet (503), or a 500 with its sentence. */
export const referenceFailure = (error: { code?: string } | null, sentence: string) =>
  isDbUnreachable(error) ? dbUnavailableResponse()
  : error?.code === "PGRST205" || error?.code === "42P01" ? NextResponse.json({ error: REFERENCES_NOT_READY }, { status: 503 })
  : NextResponse.json({ error: sentence }, { status: 500 });

/**
 * The picture as the picker reads it (hooks/useReferenceReads readReference: a base64 data URL, made at most 1024 px
 * in the browser) and as a render would send it: a PNG, JPEG or WebP whose bytes are the type it names, so the file is
 * stored and served as that type, within the size a request can carry. Null for anything else.
 */
export function readUpload(image: unknown): { type: string; bytes: Buffer; hash: string } | null {
  if (typeof image !== "string" || image.length > REQUEST_MAX_BYTES) return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!m) return null;
  const bytes = Buffer.from(m[2], "base64");
  return stillImageType(bytes) === m[1] ? { type: m[1], bytes, hash: createHash("sha256").update(bytes).digest("hex") } : null;
}

/** The tile: a WebP of at most 256 px. Null when the picture does not decode, which makes it no picture to keep. */
export async function thumbOf(bytes: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(bytes).resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true }).webp({ quality: 75, effort: 2 }).toBuffer();
  } catch {
    return null;
  }
}

type Row = { id: string; path: string; thumb_path: string | null; content_hash: string };

/**
 * The rows as their owner gets them: the picture's address and the tile's (the picture's where it has none), signed
 * for REFERENCE_SIGN_TTL, and the hash the picker knows a render's copy by. A row whose picture has no file is left
 * out; null when the store cannot sign at all.
 */
export async function signed(supabase: SupabaseClient, rows: Row[]) {
  if (!rows.length) return [];
  const { data, error } = await supabase.storage.from(REFERENCE_BUCKET)
    .createSignedUrls(rows.flatMap((r) => (r.thumb_path ? [r.path, r.thumb_path] : [r.path])), REFERENCE_SIGN_TTL);
  if (error) return null;
  const at = new Map(data.map((s) => [s.path, s.signedUrl]));
  return rows.flatMap((r) => {
    const url = at.get(r.path);
    return url ? [{ id: r.id, url, thumb: (r.thumb_path && at.get(r.thumb_path)) || url, hash: r.content_hash }] : [];
  });
}
