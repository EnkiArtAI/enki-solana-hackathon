import { isPublicText } from "@/lib/prompt-visibility";
import { boxRatio } from "@/lib/ui/kit/ratio";
import type { ImageViewSeed } from "@/lib/ui/image-view/seed";
import { promptVideoSettings, videoRowOf } from "@/lib/ui/image-view/video";
import { videoPrice, type VideoRate } from "@/lib/video/models";
import { videoRenditions, type VideoRenditions } from "@/lib/video/renditions";

/** A feed card as the payload states it. What the payload does not carry is
 *  empty or null, never filled in: no placeholder image, no made-up text. */
/** One showcase image: the original (Download, the Image View's key) with its WebP preview (stage) and thumb (grid), when the store has them. */
export interface FeedImage {
  url: string;
  preview: string | null;
  thumb: string | null;
}

/** What a prompt did on a creator's shelf (the marketplace's ?stats=1): renders by others, likes, opens. */
export interface CardStats {
  uses: number;
  likes: number;
  views: number;
}

export interface FeedCard {
  id: string;
  /** Trimmed; "" when untitled, which the card shows as "Untitled prompt". */
  title: string;
  /** Integer cents; null when missing or malformed, and then no chip. */
  priceCents: number | null;
  /** prompts.category, lowercased like the category chips. */
  category: string;
  /** Showcase images, then preview images, each original once. */
  images: FeedImage[];
  /** Width over height of the card's box, known before the image loads. */
  ratio: number;
  creator: { id: string; handle: string; name: string } | null;
  /** The prompt's words are public (free or showcase). */
  publicText: boolean;
  /** Null when the read did not ask for them, or their count failed: never a 0 that nobody counted. */
  stats: CardStats | null;
  /** A video prompt's files; null for an image, and for a video whose stored object a card cannot use: then its poster shows. */
  video: VideoRenditions | null;
  /** An Open video prompt's generator and settings, which its chip is priced at; null for anything else. */
  openVideo: (Parameters<typeof promptVideoSettings>[1] & { model: string }) | null;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const cents = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const image = (i: unknown): FeedImage | null => {
  const r = typeof i === "string" ? { url: i } : rec(i);
  const url = str(r.url);
  return url ? { url, preview: str(r.preview) || null, thumb: str(r.thumb) || null } : null;
};
const images = (...lists: unknown[]): FeedImage[] => {
  const seen = new Map<string, FeedImage>();
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      const im = image(entry);
      if (im && !seen.has(im.url)) seen.set(im.url, im);
    }
  }
  return [...seen.values()];
};

const cardStats = (v: unknown): CardStats | null => {
  const r = rec(v);
  const [uses, likes, views] = [cents(r.uses), cents(r.likes), cents(r.views)];
  return uses === null || likes === null || views === null ? null : { uses, likes, views };
};

/** One row of /api/marketplace/prompts or /api/search; null without an id. */
export function toFeedCard(raw: unknown): FeedCard | null {
  const r = rec(raw);
  const id = str(r.id);
  if (!id) return null;
  const c = rec(r.creator);
  const handle = str(c.handle);
  const creatorId = str(c.id);
  const video = videoRenditions(r.video);
  return {
    id,
    title: str(r.title),
    priceCents: cents(r.priceUsdCents),
    category: str(r.category).toLowerCase(),
    images: images(r.showcaseImages, r.previewImages),
    // A video's own shape where it was measured: its prompt may say "auto".
    ratio: boxRatio(video?.width && video.height ? `${video.width}:${video.height}` : str(r.aspectRatio)),
    creator: creatorId || handle ? { id: creatorId, handle, name: str(c.displayName) || handle } : null,
    publicText: isPublicText({ prompt_type: r.promptType, is_free_showcase: r.isFreeShowcase }),
    stats: cardStats(r.stats),
    video,
    openVideo: r.isVideo === true && cents(r.priceUsdCents) === 0
      ? { model: str(r.model), aspect_ratio: str(r.aspectRatio) || null, resolution: str(r.resolution) || null, showcaseVideo: video }
      : null,
  };
}

/** The card's price chip: "Open" at 0 cents (an open prompt; Kev, 2026-10-13:
 *  "free aka Open"), "$0.40" otherwise, and none for a price that is not
 *  whole cents (the card never guesses). */
export function priceChipLabel(v: unknown): string | null {
  const c = cents(v);
  return c === null ? null : c === 0 ? "Open" : `$${(c / 100).toFixed(2)}`;
}

/** Where an image's chip says Open, an Open video's says what its generator costs at the prompt's own settings, the number the
 *  Image View's chip opens on (Kev, 2026-11-04: "videos sind nicht umsonst. die kosten alle."). Null with no rate known: its chip
 *  stays Open, never a $0. */
export function openVideoChip(card: Pick<FeedCard, "openVideo">, rateOf: (id: string) => VideoRate | null): string | null {
  const m = videoRowOf(card.openVideo?.model);
  const price = m && videoPrice(m, rateOf(m.id), promptVideoSettings(m, card.openVideo ?? undefined));
  return price && price !== "…" ? price : null;
}

/** What the Image View paints while /api/prompts/[id] loads. */
export function seedFromFeedCard(card: FeedCard): ImageViewSeed {
  const by = card.creator;
  return {
    promptId: card.id,
    title: card.title || undefined,
    artist: by ? { handle: by.handle || undefined, name: by.name || undefined, id: by.id || undefined } : undefined,
    imageUrl: card.images[0]?.preview ?? card.images[0]?.url,
    showcase: card.images.map((i) => i.url),
    isFree: card.publicText,
  };
}
