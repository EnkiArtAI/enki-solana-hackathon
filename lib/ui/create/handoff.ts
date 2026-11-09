import { toolLink } from "@/lib/ui/feed/world";

/**
 * Animate (Kev, 2026-10-30: "Animate, wodurch es als reference image in den letzten video editor eingefügt wird, in
 * den wo noch was frei ist"): a picture from Create > Image goes to Create > Video, which takes it once into its first
 * free place. Left in session storage, as Quick Create's seed is (lib/ui/quick-create-seed.ts), so a reload of Create >
 * Video does not take it again.
 */
const KEY = "enki:animate";

/** The picture as Create > Video reads it: its full address, and the tile's where there is a smaller one. */
export interface AnimatePicture { url: string; thumb?: string }

/** Leaves the picture for Create > Video and answers the address to open. */
export function sendToVideo(picture: AnimatePicture): string {
  try { sessionStorage.setItem(KEY, JSON.stringify(picture)); } catch { /* no storage: the video view opens empty */ }
  return toolLink("video");
}

/** The picture left for Create > Video, taken once; null when there is none. */
export function takeForVideo(): AnimatePicture | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const picture = JSON.parse(raw) as AnimatePicture;
    return typeof picture?.url === "string" && picture.url ? picture : null;
  } catch {
    return null;
  }
}
