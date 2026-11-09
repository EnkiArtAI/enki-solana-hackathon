/**
 * What an amount makes, for Settings › Money (Kev, 2026-11-08: the Settings mock v64 replaces today's Settings; its "$5 is
 * enough for about 30 Nano Banana Pro images or 3 short videos", "about 261 × Nano Banana Pro", "What $20 makes" and the
 * packs' "up to N ×", Main.dc.html:107, 116-130, 182-225). A row is a paid generator with its sizes and what one image, or
 * one short clip, costs at each, by the server's own rules for a prompt without an artist price: an image's model leg plus
 * Enki's fee (lib/payments/generation-pricing), a clip's videoCents (lib/video/models, what the video route charges). A paid
 * prompt adds its artist's price, and a host whose last bill moved charges that bill (getModelCostMicro's cellUsd): the
 * counts are "about", as the mock says. Pure and client-safe; the catalogue and the video rates come from the caller.
 */
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import { toModelFamily } from "@/lib/generation/model-family";
import { tiersUpTo } from "@/lib/generation/resolution";
import { MICRO_PER_USDC, computeGenerationSplit, modelLegMicro } from "@/lib/payments/generation-pricing";
import { MODEL_IMAGE_PRICING } from "@/lib/pricing";
import { DEFAULT_GENERATOR } from "@/lib/ui/image-view/models";
import { VIDEO_MODELS, fitSettings, paidTenths, videoCents, type Resolution, type VideoRate } from "@/lib/video/models";

/** One size's price in integer micro-USDC: an image, or a clip of the row's `seconds`. */
export type MakesSize = { size: string; micro: number };
/** A generator, its sizes, the size preselected, and for a video the seconds a clip is paid for. */
export type MakesRow = { id: string; name: string; sizes: MakesSize[]; size: string; seconds?: number };

/** A short video, as the mock counts them ("clips of 5 s"). */
export const CLIP_SECONDS = 5;

const preselect = (sizes: MakesSize[], wanted: string) => (sizes.find((s) => s.size === wanted) ?? sizes[0]).size;

/** The paid image generators the server prices, the app's default first (the mock leads with it), then the catalogue's
 *  order; each at every size it renders, 2K preselected. */
export function imageRows(catalogue: ReadonlyArray<Pick<CatalogueEntry, "id" | "name" | "mediaType" | "maxResolution" | "free">>): MakesRow[] {
  const rows = catalogue.flatMap((m): MakesRow[] => {
    const family = toModelFamily(m.name);
    if (m.free || m.mediaType !== "image" || !Object.hasOwn(MODEL_IMAGE_PRICING, family)) return [];
    const sizes = tiersUpTo(m.maxResolution).map((size) => ({ size, micro: computeGenerationSplit(0, modelLegMicro(family, size)).totalMicro }));
    return [{ id: m.id, name: m.name, sizes, size: preselect(sizes, "2K") }];
  });
  return [...rows.filter((r) => r.name === DEFAULT_GENERATOR), ...rows.filter((r) => r.name !== DEFAULT_GENERATOR)];
}

/** The video generators that can run now (GET /api/video/models), in the composer's order; each at the sizes it makes and
 *  can run, a clip of CLIP_SECONDS without sound where sound is the buyer's, 720p preselected. */
export function videoRows(routes: ReadonlyArray<VideoRate & { id: string; available: readonly Resolution[] }>): MakesRow[] {
  return VIDEO_MODELS.flatMap((m): MakesRow[] => {
    const route = routes.find((r) => r.id === m.id);
    if (!route) return [];
    const at = (resolution: Resolution) => fitSettings(m, { seconds: CLIP_SECONDS, aspect: m.aspects[0], resolution, audio: false, bitrate: "standard" });
    const sizes = m.resolutions.filter((r) => route.available.includes(r)).flatMap((size) => {
      const cents = videoCents(m, route, at(size));
      return cents === null ? [] : [{ size, micro: cents * (MICRO_PER_USDC / 100) }];
    });
    return sizes.length ? [{ id: m.id, name: m.label, sizes, size: preselect(sizes, "720p"), seconds: paidTenths(m, at(m.resolution)) / 10 }] : [];
  });
}

/** Whole images or clips `amountUsd` buys at `micro` each, none without a price. In integer micro-USDC: 0.3 / 0.1 is
 *  2.999… in floats. */
export const countFor = (amountUsd: number, micro: number): number =>
  micro > 0 ? Math.floor(Math.round(amountUsd * MICRO_PER_USDC) / micro) : 0;

/** A row's price at `size`, else at its preselected size. */
export const priceOf = (row: MakesRow, size: string = row.size): number =>
  (row.sizes.find((s) => s.size === size) ?? row.sizes.find((s) => s.size === row.size))?.micro ?? 0;
