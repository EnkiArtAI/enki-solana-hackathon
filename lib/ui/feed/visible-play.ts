/**
 * Which cards of an endless wall play (Kev, 2026-11-03: "endlos laufleiste für alle videos"): at least half on screen, at
 * most 6 at once, the nearest the middle of the screen first. A phone's decoders are few and a wall is endless, so the
 * cap is on what is mounted, not on what is playing (components/enki/FeedVideo). Save-Data and reduced motion play nothing.
 */
export const MAX_PLAYING = 6;
export const MIN_VISIBLE = 0.5;
/** How long the wall holds still before a card starts: preview.mp4 is about 400 KB, and a request is made the moment a player mounts. */
export const DWELL_MS = 200;
/** How long a wall may go on playing under something that just opened over it: its picks are asked again this often. */
export const COVER_SWEEP_MS = 500;

export type SeenCard<K> = { key: K; visible: number; distance: number };

export function pickPlaying<K>(cards: readonly SeenCard<K>[], reader: { saveData: boolean; reducedMotion: boolean }): Set<K> {
  if (reader.saveData || reader.reducedMotion) return new Set();
  return new Set(cards.filter((c) => c.visible >= MIN_VISIBLE).sort((a, b) => a.distance - b.distance).slice(0, MAX_PLAYING).map((c) => c.key));
}

/** What this reader asked of the page, for pickPlaying. */
export const playReader = () => ({
  saveData: (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true,
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
});

type Player = Pick<HTMLVideoElement, "muted" | "play">;

/** Starts a silent loop. A refusal (NotAllowedError in Low Power Mode, a file it cannot play) leaves the poster; an AbortError is our own stop. */
export function startPlaying(video: Player, refused: () => void) {
  video.muted = true;
  void video.play()?.catch((e: { name?: string }) => { if (e?.name !== "AbortError") refused(); });
}

/**
 * What stopPlaying took off, back on: React owns `src` and will not put it back, so an effect that runs again on the same element
 * (next dev's StrictMode: mount, cleanup, mount; a new src on one player) found nothing to play, and said nothing.
 */
export function holdSource(video: Pick<HTMLVideoElement, "getAttribute" | "setAttribute">, src: string) {
  if (video.getAttribute("src") !== src) video.setAttribute("src", src);
}

/** Gives the decoder and the download back: an element only taken out of the page holds both until it is collected. */
export function stopPlaying(video: Pick<HTMLVideoElement, "pause" | "removeAttribute" | "load">) {
  video.pause();
  video.removeAttribute("src");
  video.load();
}
