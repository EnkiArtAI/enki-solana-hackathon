import type { VideoRate } from "@/lib/video/models";

/** SQL 68's seeded rates, by the model's id; routes.test.ts holds this list to the file, so a test here prices what it seeds. */
export const RATES: Readonly<Record<string, VideoRate>> = {
  "seedance-2.5": { cost: { "480p": 102_800, "720p": 231_100, "1080p": 568_600 }, audioCost: null, clipsAdded: false },
  "seedance-2.0": { cost: { "480p": 70_300, "720p": 151_200, "1080p": 374_200 }, audioCost: null, clipsAdded: false },
  "kling-4.0": { cost: { "720p": 157_000, "1080p": 235_000 }, audioCost: null, clipsAdded: false },
  "kling-3.0": { cost: { "720p": 84_000, "1080p": 112_000 }, audioCost: { "720p": 126_000, "1080p": 168_000 }, clipsAdded: false },
  "omni-1.1-flash": { cost: { "720p": 101_400, "1080p": 152_000 }, audioCost: null, clipsAdded: false },
  "wan-3.0": { cost: { "480p": 50_000, "720p": 100_000, "1080p": 200_000 }, audioCost: null, clipsAdded: true },
};
