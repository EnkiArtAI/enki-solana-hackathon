import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { withCapabilities } from "@/lib/generation/models";
import { videoLeg, videoSplit } from "@/lib/video/charge";
import { VIDEO_MODELS, fitSettings, startSettings, videoCanRun, videoCents, videoPrice, type VideoRate } from "@/lib/video/models";
import { RATES } from "./rates";

/**
 * Kev, 2026-11-04: "videos sind nicht umsonst. die kosten alle." The closed state: no price at or under zero, and no way to a
 * render but a paid unit. The routes themselves are in quote-route.test.ts (a zero or a rounded-away rate over SQL 68),
 * video-routes.test.ts (no unit, 402; no intent at $0) and lib/generation/__tests__/video-rows-refused.test.ts (generate-free,
 * generate-image and x402 on a video row). Blind spot: the scans read words; a free route put together at run time would pass.
 */
const ROOT = join(__dirname, "..", "..", "..");
const SD = VIDEO_MODELS[0];

type Source = { path: string; text: string };
function sources(dir: string): Source[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [{ path, text: readFileSync(join(ROOT, path), "utf8") }] : [];
  });
}
const ALL = ["lib", "components", "app", "hooks"].flatMap(sources);
const VIDEO_PATH = /^(lib\/video\/|components\/create\/video\/|components\/image-view\/useVideoPrompt|hooks\/useVideoRun|hooks\/useVideoRoutes|app\/api\/video\/|app\/api\/cron\/video-jobs\/)/;
/** What a render without a payment goes through: the free route, its host, its claims, a waived leg. */
const FREE_ROUTE = /generate-free|pollinations|free-quota|free-render|claim_free|free_generation|freeGenerationDecision|applyRuleToSplit/i;
const freeOnVideoPath = (files: Source[]) => files.filter((f) => VIDEO_PATH.test(f.path) && FREE_ROUTE.test(f.text)).map((f) => f.path);
const writers = (files: Source[], word: RegExp) => files.filter((f) => word.test(f.text)).map((f) => f.path);

describe("a video's price", () => {
  it("is above zero for every generator, resolution, length and sound at SQL 68's rates, and so is the charge", () => {
    let seen = 0;
    for (const m of VIDEO_MODELS) {
      for (const resolution of m.resolutions) {
        for (const seconds of [m.seconds.min, m.seconds.max]) {
          for (const audio of [true, false]) {
            const s = fitSettings(m, { ...startSettings(m), resolution, seconds, audio });
            const cents = videoCents(m, RATES[m.id], s);
            const leg = videoLeg(m, RATES[m.id], s);
            expect(cents, `${m.id} ${resolution} ${seconds}`).toBeGreaterThan(0);
            expect(videoSplit(0, leg!).totalMicro).toBeGreaterThanOrEqual(cents! * 10_000);
            seen++;
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(50);
  });

  it.each<[string, VideoRate | null]>([
    ["no rate", null],
    ["no cell at this resolution", { cost: { "720p": 231_100 }, clipsAdded: false }],
    ["a rate of zero", { cost: { "480p": 0 }, clipsAdded: false }],
    ["a rate below zero", { cost: { "480p": -102_800 }, clipsAdded: false }],
    ["a rate that rounds to no cent", { cost: { "480p": 1 }, clipsAdded: false }],
  ])("%s is no price: the chip waits, nothing can be charged, Generate cannot go", (_, rate) => {
    const s = startSettings(SD);
    expect(videoCents(SD, rate, s)).toBeNull();
    expect(videoPrice(SD, rate, s)).toBe("…");
    expect(videoLeg(SD, rate, s)).toBeNull();
    expect(videoCanRun(SD, rate && { ...rate, available: ["480p"] }, s)).toBe(false);
  });

  it("Generate needs the operator as well as the price", () => {
    const s = startSettings(SD);
    expect(videoCanRun(SD, { ...RATES[SD.id], available: ["480p"] }, s)).toBe(true);
    expect(videoCanRun(SD, { ...RATES[SD.id], available: ["720p"] }, s)).toBe(false);
    expect(videoCanRun(SD, { ...RATES[SD.id], available: [] }, s)).toBe(false);
  });
});

describe("no free route", () => {
  const onFreeHost = [{ id: "mp", role: "normal", provider_model: "flux", active: true, priority: 0, provider_id: "p", providers: { id: "p", key: "pollinations", audience: "public", active: true } }];
  const row = (media_type: string) => ({ id: "m", name: "A generator", allowed_ratios: ["16:9"], max_reference_images: 0, media_type, model_providers: onFreeHost }) as never;

  it("a video row is never free in the catalogue, even linked to the free host; an image row on it is", () => {
    expect(withCapabilities([row("image")])[0].free).toBe(true);
    expect(withCapabilities([row("video")])[0].free).toBe(false);
  });

  it("nothing on the video path reaches the free route, its host, its claims or a waived leg", () => {
    expect(ALL.length).toBeGreaterThan(500);
    expect(ALL.filter((f) => VIDEO_PATH.test(f.path)).length).toBeGreaterThan(15);
    expect(freeOnVideoPath(ALL)).toEqual([]);
    expect(freeOnVideoPath([{ path: "app/api/video/jobs/route.ts", text: 'import x from "@/lib/generation/free-quota"' }])).toEqual(["app/api/video/jobs/route.ts"]);
    expect(freeOnVideoPath([{ path: "lib/generation/x.ts", text: "generate-free" }])).toEqual([]);
  });

  it("a video job starts in one place, from a unit written in one place", () => {
    // /api/video/jobs refuses a unit that is not authorized (video-routes.test.ts); the cron only follows the jobs it wrote.
    expect(writers(ALL, /from\("video_jobs"\)\.insert/)).toEqual(["app/api/video/jobs/route.ts"]);
    expect(writers(ALL, /\bvideo_settings: \{/)).toEqual(["app/api/video/intent/route.ts"]);
    expect(writers(ALL, /\.submit\(/).filter((p) => VIDEO_PATH.test(p))).toEqual(["app/api/video/jobs/route.ts"]);
  });
});
