/**
 * The click-check of a wallet NFT (Kev, 2026-11-03: "keep all NFTs first ausgegraut und erst beim anclicken darauf prüfen
 * wir ... ob die zur generierung zugelassen werden und speichern sie als zugelassen oder abgelehnt ab"): the limits on
 * renewing it, what a verdict says, and the proof that the list named this NFT in this account's wallet. The route is
 * app/api/wallet/nfts/check; the verdict is display and convenience only, the generation routes judge every reference.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { heldBack, NOT_AN_IMAGE } from "@/lib/moderation/image-check-bytes";
import type { CheckedImage } from "@/lib/moderation/image-check";

/**
 * Kev: "the user shall have up to 5x for a day the chance to renew it ... and then halt only 2x per day to make sure the
 * algo didnt change". Read as: 5 on the UTC day of the first check, 2 on every UTC day after (INFERRED, DEC-2026-11-03-61).
 * Kev, 2026-11-04: "5 am tag aktualisierungen gelten nur pro abgelehntes NFT dann": only a refused NFT has them, per user and
 * NFT. A renewal that comes back green ends them for that NFT; one that comes back red stays red and keeps counting.
 */
export const RENEWALS_FIRST_DAY = 5;
export const RENEWALS_PER_DAY = 2;

export const NFT_CHECK_NOT_READY = "The NFT check needs SQL 65: run sql-to-run/65-nft-checks.sql.";

/** One sentence for explicit content, child safety and bytes that arrive as an image and do not decode, so a noisy verdict never accuses anyone (IMAGE_REFUSED). A failed fetch or another type is no verdict: the route answers 502 and saves nothing. */
export const NFT_REFUSED = "This picture can't be used on Enki.";
const NFT_MOVES = "This picture moves, and only a still picture can be used.";
const NFT_ADULT = "This picture is 18+: generating with it needs a confirmed age, and the result counts as 18+.";

export type NftCheckRow = { nft_id: string; verdict: "allowed" | "refused"; why: string | null; no_picture: boolean; first_checked_at: string; renew_day: string; renewals: number };
/** What a tile knows. opensAt: when a renewal opens again, while none is left today. picture: false, a plain placeholder in its place. */
export type NftCheck = { verdict: NftCheckRow["verdict"]; why: string | null; left: number; opensAt: string | null; picture: boolean };

/** A date or a time as its UTC day. */
export const utcDay = (at: Date | string) => new Date(at).toISOString().slice(0, 10);

/** The day's limit less what the day has used; a green one has no renewals at all. */
export function nftCheckOf(row: NftCheckRow, now = new Date()): NftCheck {
  if (row.verdict === "allowed") return { verdict: row.verdict, why: row.why, left: 0, opensAt: null, picture: !row.no_picture };
  const today = utcDay(now);
  const limit = utcDay(row.first_checked_at) === today ? RENEWALS_FIRST_DAY : RENEWALS_PER_DAY;
  const left = Math.max(0, limit - (utcDay(row.renew_day) === today ? row.renewals : 0));
  const midnight = new Date(`${today}T00:00:00.000Z`);
  midnight.setUTCDate(midnight.getUTCDate() + 1);
  return { verdict: row.verdict, why: row.why, left, opensAt: left ? null : midnight.toISOString(), picture: !row.no_picture };
}

/**
 * What to save for a judged picture, as generate-image treats a reference: refused or unjudged is held back, an 18+ one
 * passes and makes the render 18+. Null when no judge could say: nothing is saved.
 *
 * A red tile draws its picture greyed (Kev, 2026-11-04: "rote NFTs, doch zeig sie, aber nur halt ausgegraut mitm roten rahmen."),
 * but for no_picture, one deliberate exception (DEC-2026-11-04-02): a child-safety verdict never draws, or Enki would show a
 * picture its own check flagged. An unreadable file has no picture to draw and gets the same placeholder and the same
 * sentence, so the pair says nothing about which it was. no_picture: false is no order to clear: only an allowed verdict lifts
 * the placeholder (Kev, 2026-11-04: "ja, grünes urteil hebt sperre ab passt"), and the route writes it only then or to set it.
 */
export function nftVerdict(seen: CheckedImage): { verdict: NftCheckRow["verdict"]; why: string | null; no_picture: boolean } | null {
  if (seen.verdict === "unavailable") return null;
  if (!heldBack(seen)) return { verdict: "allowed", why: seen.verdict === "adult" ? NFT_ADULT : null, no_picture: false };
  if (seen.verdict === "blocked" && seen.reason === "not a still") return { verdict: "refused", why: NFT_MOVES, no_picture: false };
  return { verdict: "refused", why: NFT_REFUSED, no_picture: seen.verdict === "child_safety" || (seen.verdict === "blocked" && (seen.reason === NOT_AN_IMAGE || seen.reason === "unreadable")) };
}

/** As long as a list's tile may be pressed: a sold NFT stays checkable this long, and only by the wallet that held it. */
const PROOF_MS = 24 * 60 * 60_000;

const proofMac = (pepper: string, parts: unknown[]) => createHmac("sha256", pepper).update(`nft-list:${JSON.stringify(parts)}`).digest();

/**
 * What the list hands each NFT: "<expires ms>.<owner>.<HMAC>", over the account, the wallet the index read it in, the NFT and
 * its picture. A press shows it instead of paying for one more index call, and can name no other picture. Null without AUTH_PEPPER.
 */
export function signNftProof(userId: string, owner: string, id: string, image: string, now = Date.now()): string | null {
  const pepper = process.env.AUTH_PEPPER;
  if (!pepper) return null;
  const expires = now + PROOF_MS;
  return `${expires}.${owner}.${proofMac(pepper, [userId, owner, id, image, expires]).toString("base64url")}`;
}

/** The wallet a proof this server signed names, while it lasts; null for anything else. */
export function readNftProof(proof: unknown, userId: string, id: string, image: string, now = Date.now()): string | null {
  const pepper = process.env.AUTH_PEPPER;
  const parts = typeof proof === "string" ? proof.split(".") : [];
  if (!pepper || parts.length !== 3) return null;
  const [exp, owner, sig] = parts;
  const expires = Number(exp);
  if (!/^\d+$/.test(exp) || expires <= now) return null;
  const given = Buffer.from(sig, "base64url");
  const want = proofMac(pepper, [userId, owner, id, image, expires]);
  return given.length === want.length && timingSafeEqual(given, want) ? owner : null;
}
