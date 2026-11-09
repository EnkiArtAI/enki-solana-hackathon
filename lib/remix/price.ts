import { microToUsd } from "@/lib/generation-checkout";

/** The output resolutions, 720p unless the buyer picks another. */
export const REMIX_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export type RemixResolution = (typeof REMIX_RESOLUTIONS)[number];
export const DEFAULT_RESOLUTION: RemixResolution = "720p";

/**
 * Remix's one price table: our cost per second of the source clip, in micro-USD. Seedance 2.5 with a video input on
 * BytePlus ModelArk, a remix being as long as its clip, so the clip's seconds are the seconds paid for. 480p $0.1230
 * was read on the BytePlus pricing page (2026-10-27); 720p $0.2765 and 1080p $0.6804 are the rates handed over on
 * 2026-10-30, to be read on that page again before the backend charges anything.
 *
 * Remix is sold at that cost, with no Enki fee, as Sume does: it brings people in, every other generation carries the
 * fee (Kev, 2026-10-30: "locken user mit seedance und lassen die dann noch den rest generieren einfach worauf wir extra
 * nehmen"). The remix route must charge remixCents itself, whole cents (shown price = charged price).
 */
export const COST_MICRO_PER_SECOND: Readonly<Record<RemixResolution, number>> = { "480p": 123_000, "720p": 276_500, "1080p": 680_400 };

/** A clip's length in tenths of a second: the length shown, checked and charged, so all three agree. */
export const tenths = (seconds: number) => Math.round(seconds * 10);

/** What a remix of a clip `seconds` long costs the buyer, in cents: the clip's seconds x our cost, rounded to the cent. */
export function remixCents(seconds: number, resolution: RemixResolution): number {
  // Integer micro-USD per tenth (12,300 / 27,650 / 68,040): no float sum ever reaches the rounding.
  const micro = (tenths(seconds) * COST_MICRO_PER_SECOND[resolution]) / 10;
  return Math.round(micro / 10_000);
}

/** The chip on Generate: "$2.77", never an estimate. */
export const remixPrice = (seconds: number, resolution: RemixResolution) => `$${microToUsd(remixCents(seconds, resolution) * 10_000)}`;
