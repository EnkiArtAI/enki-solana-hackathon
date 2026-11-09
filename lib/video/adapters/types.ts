/**
 * What one operator's file must do, and all the rest of the code knows of it (Kev, 2026-11-03: "wir wechseln den betreiber
 * später"). `configured`: its key is set here, a yes or no; the key itself never leaves the file.
 */
export interface VideoSubmit {
  providerModel: string;
  words: string;
  frames: { start?: string; end?: string };
  refs: string[];
  settings: { seconds: number; aspect: string; resolution: string; audio: boolean };
  /** The per-user hash an operator's safety field takes; never an id or an address. */
  endUserHash: string;
}
export type VideoPoll =
  | { state: "running" }
  | { state: "done"; url: string; usage: unknown }
  | { state: "failed"; kind: "real_person" | "moderation" | "other"; code: string | null };

/** Thrown by `submit` when the operator refuses the buyer's input outright: no task exists, and the sentence is the buyer's. */
export class VideoRefused extends Error {
  constructor(readonly kind: "real_person" | "moderation", readonly code: string | null) {
    super(`[video] refused: ${kind}`);
  }
}

export interface VideoAdapter {
  configured(): boolean;
  submit(job: VideoSubmit): Promise<{ taskId: string }>;
  poll(taskId: string): Promise<VideoPoll>;
}
