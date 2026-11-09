import { PRICING_POLICY, computeGenerationSplit, type GenerationSplit } from "@/lib/payments/generation-pricing";
import { paidTenths, secondRate, videoCents, type VideoModel, type VideoRate, type VideoSettings } from "./models";

/** What one video bills: the cents on its chip, and the provider's price for it in micro-USD. */
export interface VideoLeg { cents: number; modelCostMicro: number }

/** Null where videoCents has no number: nothing can be charged for it. */
export function videoLeg(m: VideoModel, rate: VideoRate | null, s: VideoSettings, clipTenths = 0): VideoLeg | null {
  const cents = videoCents(m, rate, s, clipTenths);
  const perSecond = rate && secondRate(rate, s);
  return cents === null || !perSecond ? null : { cents, modelCostMicro: Math.ceil((paidTenths(m, s, clipTenths) * perSecond) / 10) };
}

/**
 * The split of one video, so the chip is the charge (Kev, 2026-11-03: shown = charged): the fee is what the chip's cents
 * leave over the provider's bill, plus Enki's 10% of the artist's price. So the total is cents x 10,000 + artist + 10% of the
 * artist, floored. The prompt check and the frames' image check, under $0.002, come out of the fee; the chip stays one
 * number. A test over every row, resolution and length holds the fee at zero or more and the total at the bill or more.
 */
export function videoSplit(artistPriceMicro: number, { cents, modelCostMicro }: VideoLeg): GenerationSplit {
  const base = computeGenerationSplit(artistPriceMicro, modelCostMicro);
  const enkiFeeMicro = cents * 10_000 - modelCostMicro + Math.floor((artistPriceMicro * PRICING_POLICY.enkiFeeBps) / 10_000) + base.networkFeeMicro;
  const enkiTotalMicro = modelCostMicro + enkiFeeMicro;
  return { ...base, enkiFeeMicro, enkiTotalMicro, totalMicro: base.artistAmountMicro + enkiTotalMicro };
}
