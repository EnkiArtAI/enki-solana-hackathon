/**
 * Create > Video's models (Kev, 2026-10-30: "kling 4.0, kling 3.0, seedance 2.0, seedance 2.5, google = Omni (Gemini
 * Omni 1.1 Flash), wan aktuellste (Wan 3.0)"), one capability row each: what the composer shows for it. One form after
 * Sume's, its fields set by the row (research 2026-10-30, the UI matrix). Who runs a model and at what rate is its row in
 * video_routes (SQL 68, lib/video/routes; Kev, 2026-11-03: "wir wechseln den betreiber später"), and nothing here names one.
 */
export const RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export const ASPECTS = ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"] as const;
/**
 * "auto": the model picks the shape from the media and the words (Kev, 2026-10-30: "also add "auto" ratio wo son
 * generator das zb ermöglicht"), only where the official docs offer it, read 2026-10-30: Seedance's ratio "adaptive", which
 * "automatically selects an aspect ratio based on the task type and input", and Wan 3.0's, which "automatically recommends
 * a suitable aspect ratio". Gemini Omni lists 16:9 and 9:16 only; Kling 3.0 lists 16:9, 9:16, 1:1; Kling 4.0's pages did
 * not load, so it has none. The price is the same as for any other shape: videoCents does not read the aspect.
 */
export const AUTO = "auto";
export type Aspect = (typeof ASPECTS)[number] | typeof AUTO;
const ANY_SHAPE: readonly Aspect[] = [...ASPECTS, AUTO];
export const BITRATES = [
  { key: "high", label: "High", desc: "Less compression, a larger file" },
  { key: "standard", label: "Standard", desc: "More compression, a smaller file" },
] as const;
export type Bitrate = (typeof BITRATES)[number]["key"];

/** Where a model takes pictures: a start and an end frame, or reference media (images and clips). */
export type Slot = "frames" | "refs";
/** How many reference images and clips a model takes, and the clips' seconds in all. */
export interface RefCaps { images: number; clips: number; clipSeconds: number }

/** The provider's price per output second, in micro-USD, by resolution. */
export type RateCells = Readonly<Partial<Record<Resolution, number>>>;
/** A model's rate, from its row in video_routes: `audioCost` where sound costs more; `clipsAdded`: a held clip's seconds
 *  are paid as the output's are, at the same rate. A reference model without it bills a clip at a rate and a minimum not
 *  read yet. */
export interface VideoRate { cost: RateCells; audioCost?: RateCells | null; clipsAdded: boolean }

export interface VideoModel {
  id: string;
  label: string;
  /** What the model is best used for, in one line: on the model card and in Change (Kev, 2026-10-30: "i need a better
   *  explanation on what these generators are rather used for as they all have distinct performances or use cases"). */
  line: string;
  slots: readonly Slot[];
  /** Frames or references, never both in one video (Wan 3.0). */
  oneSlot?: true;
  refs?: RefCaps;
  aspects: readonly Aspect[];
  resolutions: readonly Resolution[];
  /** Picked when the model opens and the resolution before is not one it makes. */
  resolution: Resolution;
  seconds: { min: number; max: number };
  /** No length to set: the model takes it from the words, up to `seconds.max`, and that is what is priced (Omni). */
  promptLength?: true;
  /** "switch": Include audio is the buyer's; "on": always with sound. */
  audio: "switch" | "on";
  /** No sound from a start or an end frame (Wan 3.0, the UI matrix: "bei Start/End aus"). */
  framesMute?: true;
  bitrate: boolean;
}

/**
 * The rows. Each line says what the model is best used for in Higgsfield's few words (Kev, 2026-10-30: "forme die
 * beschreibung einfach um"), from what its row holds: the media it takes, its length, its sound. The price is on the
 * chips, not in the lines (review 2026-10-30: three lines led with it).
 */
export const VIDEO_MODELS: readonly VideoModel[] = [
  {
    id: "seedance-2.5", label: "Seedance 2.5", line: "Steer a video with many pictures and clips, up to 30 s",
    slots: ["refs"], refs: { images: 30, clips: 10, clipSeconds: 30 }, aspects: ANY_SHAPE,
    resolutions: ["480p", "720p", "1080p"], resolution: "480p", seconds: { min: 4, max: 30 }, audio: "switch", bitrate: true,
  },
  {
    id: "seedance-2.0", label: "Seedance 2.0", line: "Guide a short video with references, up to 15 s",
    slots: ["refs"], refs: { images: 9, clips: 3, clipSeconds: 15 }, aspects: ANY_SHAPE,
    resolutions: ["480p", "720p", "1080p"], resolution: "720p", seconds: { min: 4, max: 15 }, audio: "switch", bitrate: true,
  },
  {
    id: "kling-4.0", label: "Kling 4.0", line: "Turn words or frames into shots with sound, up to 30 s",
    slots: ["frames"], aspects: ["16:9", "9:16", "1:1", "21:9"],
    resolutions: ["720p", "1080p"], resolution: "720p", seconds: { min: 3, max: 30 }, audio: "on", bitrate: false,
  },
  {
    id: "kling-3.0", label: "Kling 3.0", line: "Make shots with or without sound, up to 15 s",
    slots: ["frames"], aspects: ["16:9", "9:16", "1:1"],
    resolutions: ["720p", "1080p"], resolution: "1080p", seconds: { min: 3, max: 15 }, audio: "switch", bitrate: false,
  },
  {
    id: "omni-1.1-flash", label: "Gemini Omni 1.1 Flash", line: "Let your words set the length, with sound, up to 10 s",
    slots: ["frames"], aspects: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"], resolution: "720p", seconds: { min: 10, max: 10 }, promptLength: true, audio: "on", bitrate: false,
  },
  {
    id: "wan-3.0", label: "Wan 3.0", line: "Start from words, frames or references, 2 to 30 s",
    slots: ["frames", "refs"], oneSlot: true, refs: { images: 10, clips: 5, clipSeconds: 15 }, aspects: ANY_SHAPE,
    resolutions: ["480p", "720p", "1080p"], resolution: "1080p", seconds: { min: 2, max: 30 }, audio: "switch", framesMute: true, bitrate: false,
  },
];

export const DEFAULT_MODEL = VIDEO_MODELS[0];
export const modelOf = (id: string) => VIDEO_MODELS.find((m) => m.id === id) ?? DEFAULT_MODEL;

/** The prompt's placeholder: a model that takes references is told what to change, one that takes frames what to make. */
export const placeholderOf = (m: VideoModel) => m.slots.includes("refs")
  ? "Describe the video, e.g. a slow push-in as rain starts. Name a reference by its place: image 1, clip 1."
  : "What video do you want to make?";

export interface VideoSettings { seconds: number; aspect: Aspect; resolution: Resolution; audio: boolean; bitrate: Bitrate }

/** As Sume opens: 4 s, 16:9, with sound, high bitrate. */
export const DEFAULT_SECONDS = 4;

/** A length as model `m` takes it: whole seconds inside its range. The slider's, the typed one's and the price's rule. */
const inRange = (m: VideoModel, seconds: number) => Math.min(m.seconds.max, Math.max(m.seconds.min, Math.round(seconds)));

/** A length typed into Length's number (Kev, 2026-10-30: "let me type in the length by clicking on the second anzahl
 *  ... into an integer between the min and max länge des jeweiligen generators"): a whole number of seconds inside the
 *  model's range; null for nothing typed, which keeps the length as it was. */
export function typedSeconds(m: VideoModel, typed: string): number | null {
  const n = typed.trim() === "" ? NaN : Number(typed);
  return Number.isFinite(n) ? inRange(m, n) : null;
}

/** The settings `s` as model `m` takes them: the length inside its range, an aspect and a resolution it makes (else its
 *  first aspect and its own resolution), sound where it always has it. The buyer's picks stay wherever they fit; a model
 *  whose words set the length leaves the slider's as it was, for the next model (bench 2026-10-30: through Omni a 6 s
 *  Wan came back as 10 s). */
export function fitSettings(m: VideoModel, s: VideoSettings): VideoSettings {
  return {
    seconds: m.promptLength ? s.seconds : inRange(m, s.seconds),
    aspect: m.aspects.includes(s.aspect) ? s.aspect : m.aspects[0],
    resolution: m.resolutions.includes(s.resolution) ? s.resolution : m.resolution,
    audio: m.audio === "on" || s.audio,
    bitrate: s.bitrate,
  };
}

export const startSettings = (m: VideoModel) =>
  fitSettings(m, { seconds: DEFAULT_SECONDS, aspect: "16:9", resolution: m.resolution, audio: true, bitrate: "high" });

/**
 * Every generation but Remix carries Enki's 10% fee (PRICING_POLICY.enkiFeeBps; Kev, 2026-10-30: "locken user mit
 * seedance und lassen die dann noch den rest generieren einfach worauf wir extra nehmen"; a test ties the two).
 */
export const MARKUP_PERCENT = 110;

/** The provider's price per second for these settings, in micro-USD: its dearer one with sound, where it has one (Kling 3.0). */
export const secondRate = (rate: VideoRate, s: VideoSettings) => (s.audio && rate.audioCost?.[s.resolution]) || rate.cost[s.resolution];

/** The tenths of a second paid for: the output's, the most the words can run where they set the length, and the held clips'. */
export const paidTenths = (m: VideoModel, s: VideoSettings, clipTenths = 0) => 10 * (m.promptLength ? m.seconds.max : s.seconds) + clipTenths;

/** What a video costs the buyer, in cents: its seconds x the provider's rate x 1.10, rounded to the cent, the held clips'
 *  seconds (`clipTenths`, in the tenths they show) added where the model bills them so. Null with no rate (SQL 68 has not
 *  run), where the model has no rate for that resolution, or bills a clip at a rate not read yet (Seedance: "die
 *  Input-Sekunden zählen mit, und es gibt eine Mindestmenge", its tables unread): never a number below the provider's. Null
 *  too where it rounds to no cent: every video costs (Kev, 2026-11-04: "videos sind nicht umsonst. die kosten alle."), so a
 *  rate that small is no price, never a $0 charge. The route charges videoCents itself (lib/video/charge; shown price = charged price). */
export function videoCents(m: VideoModel, rate: VideoRate | null, s: VideoSettings, clipTenths = 0): number | null {
  const perSecond = rate && secondRate(rate, s);
  if (!perSecond || (clipTenths > 0 && !rate.clipsAdded)) return null;
  // Integer micro-USD x tenths x percent: no float sum ever reaches the rounding.
  const cents = Math.round((paidTenths(m, s, clipTenths) * perSecond * MARKUP_PERCENT) / 10_000_000);
  return cents > 0 ? cents : null;
}

/** Whether Generate can go at these settings: its operator is set for them (lib/video/routes availableAt) and they have a price. */
export const videoCanRun = (m: VideoModel, rate: (VideoRate & { available: readonly Resolution[] }) | null, s: VideoSettings) =>
  (rate?.available ?? []).includes(s.resolution) && videoCents(m, rate, s) !== null;

/** The chip on Generate: "$0.45"; "…" with no rate. Where the words set the length this is the whole of what they can run:
 *  a signed amount cannot follow usage, so that is what is charged, and it is not "up to" anything. */
export function videoPrice(m: VideoModel, rate: VideoRate | null, s: VideoSettings, clipTenths = 0): string {
  const cents = videoCents(m, rate, s, clipTenths);
  return cents === null ? "…" : `$${(cents / 100).toFixed(2)}`;
}

/** Under and on Generate, wherever a video is set up, until an operator is set (lib/video/routes availableAt). */
export const VIDEO_NOT_AVAILABLE = "Not available yet.";
