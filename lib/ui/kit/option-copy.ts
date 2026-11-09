/**
 * The one line under each settings option (plan B4): what a generator is good
 * at, what a format is for, what a resolution or quality buys. Copy only:
 * which options exist, and their prices, still come from useGenerationCore.
 * Wording from the prototype (Enki Prompt Studio v2, lines 116-120).
 */
import { VIDEO_MODELS } from "@/lib/video/models";
import { toModelFamily } from "@/lib/generation/model-family";

/** By model family, the key the payment and the generation agree on. */
const GENERATOR: Record<string, string> = {
  "nano-banana-pro": "Best all-rounder: lifelike faces and skin, keeps your people recognisable.",
  "gpt-image-2": "Follows long, detailed prompts closely and can write text into the image.",
  flux: "Fast and cheap: good for quick drafts and trying ideas.",
  // From the makers' own pages (2026-10-26): OpenAI calls Flare its fastest model for high-quality everyday images and
  // Sunburst its most capable, for workflows where editing precision matters most; Google calls Nano Banana 2 its
  // high-efficiency workhorse with multi-reference consistency.
  "gpt-image-2-5-flare": "The fastest GPT model: high quality for everyday images and many quick tries.",
  "gpt-image-2-5-sunburst": "The most capable GPT model: precise edits of your photos, slower than Flare.",
  "nano-banana-2": "Quick all-rounder: sharp images, keeps several reference photos consistent.",
};

/** The format's name, then what it is used for. */
const FORMAT: Record<string, string> = {
  "1:1": "Square · Instagram feed, profile pictures",
  "4:5": "Portrait · Instagram feed posts",
  "3:4": "Portrait · classic photo prints",
  "2:3": "Tall · Pinterest, posters",
  "16:9": "Wide · YouTube, desktop screens",
  "9:16": "Full phone screen · Instagram Stories, Reels, TikTok",
  // Every ratio a generator offers has its line (Kev, 2026-10-26: "einige felder wo einfach keine zusätze stehen").
  "3:2": "Landscape · camera photos, postcards",
  "4:3": "Landscape · tablets, presentation slides",
  "5:4": "Landscape · 8×10 prints, framed art",
  "21:9": "Cinematic · film stills, website banners",
  // Create > Video's aspects carry the same lines (Kev, 2026-10-30: "zu aspect ratios will ich die gleichen angaben wie
  // bei den bildern haben"), Auto too where the model offers it (lib/video/models AUTO).
  auto: "Auto · the model picks the shape to fit your media and words",
};

const RESOLUTION: Record<string, string> = {
  "1K": "Fast preview, smallest file",
  "2K": "Sharp on any screen",
  "4K": "Print quality, the most detail",
};

const QUALITY: Record<string, string> = {
  low: "Quick drafts, lowest cost",
  medium: "Good for everyday images",
  high: "Finest detail, best for portraits",
};

/** Own keys only, so "constructor" has no line either. */
const line = (table: Record<string, string>, key: string) => (Object.hasOwn(table, key) ? table[key] : null);

/** A generator's line by catalogue name or family ("Flux (free)" and "flux" alike); null for a family without one. */
export const generatorCopy = (name: string) => line(GENERATOR, toModelFamily(name)) ?? VIDEO_MODELS.find((m) => m.label === name)?.line ?? null;
/** A format's line by ratio as the models table writes it ("4:5"); null for any other ratio. */
export const formatCopy = (ratio: string) => line(FORMAT, ratio);
/** A resolution tier's line ("1K" | "2K" | "4K"); null otherwise. */
export const resolutionCopy = (tier: string) => line(RESOLUTION, tier);
/** The gpt quality lever's line ("low" | "medium" | "high"); null otherwise. */
export const qualityCopy = (quality: string) => line(QUALITY, quality);
