/** What a card already knows about a prompt, painted while
 *  /api/prompts/[id] loads. Only real data: what the card does not know
 *  is absent, never filled in. */
export interface ImageViewSeed {
  promptId: string;
  title?: string;
  artist?: { handle?: string; name?: string; id?: string };
  imageUrl?: string;
  showcase?: string[];
  isFree?: boolean;
  /** Recreate from the gallery (Kev, 2026-10-15): the recorded image whose settings and references the composer takes on open. */
  recreateImageId?: string;
}
