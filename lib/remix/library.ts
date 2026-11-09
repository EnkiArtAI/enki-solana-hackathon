import type { RemixMode } from "./modes";

/** One remix on a card in History or Examples: its clip, which way it was made, and a title. */
export interface RemixCardData {
  id: string;
  mode: RemixMode;
  title: string;
  /** The clip's address; Recreate puts it into the composer. */
  clip: string;
  seconds: number;
  poster?: string;
}

/** The viewer's own remixes: none until the remix backend exists, and no stand-ins meanwhile. */
export const MY_REMIXES: readonly RemixCardData[] = [];

/** Enki's example remixes to start from, short looping clips (Kev, 2026-10-30: "lauter webm animationen ...
    später"): none yet. */
export const REMIX_EXAMPLES: readonly RemixCardData[] = [];
