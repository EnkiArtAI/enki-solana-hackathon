import { decryptString, encryptString, type EncryptedPayload } from "@/lib/crypto";

/**
 * A referred post as the server read it (app/api/referrals/preview), sealed
 * so the client can show it and hand it back unchanged: the prompt a visitor
 * will see is never the client's word (Kev, 2026-10-14: "the prompt must not
 * be editable, but can be taken just like that"). Sealed with the field key
 * (AES-GCM, lib/crypto), so a changed byte fails to open, and bound to the
 * account it was made for.
 */
export interface ImportPreview {
  v: 1;
  /** users.id the preview was made for; another account cannot publish it. */
  userId: string;
  /** Unix ms: published within the hour, or made again. */
  exp: number;
  /** authorId: X's numeric user id, the author's vault is derived from it (docs/ESCROW-V2-SHARES.md); "" when FxTwitter gave none. */
  source: { url: string; normalized: string; handle: string; authorId: string };
  prompt: string;
  /** Catalogue names the post names; empty = every generator. */
  generators: string[];
  /** The post's pictures, each bound to the bytes that were judged. */
  photos: { url: string; sha256: string }[];
  title: string;
  category: string;
  tags: string[];
  adult: boolean;
}

const AAD = "referral-preview";
export const PREVIEW_TTL_MS = 60 * 60 * 1000;

export function sealPreview(p: ImportPreview): string {
  return Buffer.from(JSON.stringify(encryptString(JSON.stringify(p), AAD)), "utf8").toString("base64url");
}

/** The preview a token holds, or null: unreadable, changed, expired, or not shaped like one. */
export function openPreview(token: unknown, now = Date.now()): ImportPreview | null {
  if (typeof token !== "string" || !token) return null;
  try {
    const sealed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as EncryptedPayload;
    const p = JSON.parse(decryptString(sealed, AAD)) as ImportPreview;
    const strings = (xs: unknown): xs is string[] => Array.isArray(xs) && xs.every((x) => typeof x === "string");
    if (p?.v !== 1 || typeof p.userId !== "string" || !p.userId || typeof p.exp !== "number" || p.exp < now) return null;
    if (typeof p.prompt !== "string" || !p.prompt.trim() || typeof p.title !== "string" || typeof p.category !== "string") return null;
    if (!strings(p.generators) || !strings(p.tags) || typeof p.adult !== "boolean") return null;
    if (!p.source || typeof p.source.url !== "string" || typeof p.source.normalized !== "string" || typeof p.source.handle !== "string" || typeof p.source.authorId !== "string") return null;
    if (!Array.isArray(p.photos) || !p.photos.every((x) => x && typeof x.url === "string" && typeof x.sha256 === "string")) return null;
    return p;
  } catch {
    return null;
  }
}
