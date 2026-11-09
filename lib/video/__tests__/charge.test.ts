import { describe, expect, it } from "vitest";
import { PRICING_POLICY } from "@/lib/payments/generation-pricing";
import { videoLeg, videoSplit } from "@/lib/video/charge";
import { RESOLUTIONS, VIDEO_MODELS, fitSettings, startSettings, videoCents } from "@/lib/video/models";
import { RATES } from "./rates";

/**
 * Shown = charged, for every model, resolution, length and sound, with and without an artist: the arithmetic on integers, a
 * machine's every case. Blind spot: the rates are the seeded list rates; an operator's other rates are a row away, and the
 * test does not know them, though the rule holds for any rate of $0.05 a second or more (below it rounding could eat the bill).
 */
const ARTISTS = [0, 10_000, 330_000, 400_000, 1_234_567, 99_990_000];

function* every() {
  for (const m of VIDEO_MODELS)
    for (const resolution of RESOLUTIONS)
      for (let seconds = m.seconds.min; seconds <= m.seconds.max; seconds++)
        for (const audio of [true, false]) {
          const s = { ...startSettings(m), resolution, seconds, audio };
          if (fitSettings(m, s).resolution === resolution) yield { m, s };
        }
}

describe("one video's split", () => {
  it("covers a real number of cases", () => {
    expect([...every()].length).toBeGreaterThan(300);
  });

  it("is the chip's cents, plus the artist, plus 10% of the artist; the fee never below zero, the total never below the bill", () => {
    for (const { m, s } of every()) {
      const leg = videoLeg(m, RATES[m.id], s);
      const label = `${m.id} ${s.resolution} ${s.seconds} s ${s.audio}`;
      if (!leg) { expect(videoCents(m, RATES[m.id], s), label).toBeNull(); continue; }
      expect(leg.cents, label).toBe(videoCents(m, RATES[m.id], s));
      for (const artist of ARTISTS) {
        const split = videoSplit(artist, leg);
        expect(split.totalMicro, label).toBe(leg.cents * 10_000 + artist + Math.floor(artist / 10));
        expect(split.artistAmountMicro, label).toBe(artist);
        expect(split.modelCostMicro, label).toBe(leg.modelCostMicro);
        expect(split.enkiFeeMicro, label).toBeGreaterThanOrEqual(0);
        expect(split.totalMicro, label).toBeGreaterThanOrEqual(artist + leg.modelCostMicro);
        expect(split.artistAmountMicro + split.enkiTotalMicro, label).toBe(split.totalMicro);
        expect(split.modelCostMicro + split.enkiFeeMicro, label).toBe(split.enkiTotalMicro);
      }
    }
  });

  it("the bill is the provider's seconds at its rate, the dearer one with sound, the most the words can run, the clips' tenths", () => {
    const row = (id: string) => VIDEO_MODELS.find((m) => m.id === id)!;
    const at = (id: string, over: object) => ({ ...startSettings(row(id)), ...over });
    expect(videoLeg(row("seedance-2.5"), RATES["seedance-2.5"], at("seedance-2.5", { seconds: 4, resolution: "480p" }))).toEqual({ cents: 45, modelCostMicro: 411_200 });
    expect(videoLeg(row("kling-3.0"), RATES["kling-3.0"], at("kling-3.0", { seconds: 5, resolution: "720p", audio: false }))).toEqual({ cents: 46, modelCostMicro: 420_000 });
    expect(videoLeg(row("kling-3.0"), RATES["kling-3.0"], at("kling-3.0", { seconds: 5, resolution: "720p", audio: true }))).toEqual({ cents: 69, modelCostMicro: 630_000 });
    expect(videoLeg(row("omni-1.1-flash"), RATES["omni-1.1-flash"], at("omni-1.1-flash", { seconds: 3, resolution: "720p" }))).toEqual({ cents: 112, modelCostMicro: 1_014_000 });
    expect(videoLeg(row("wan-3.0"), RATES["wan-3.0"], at("wan-3.0", { seconds: 3, resolution: "480p" }), 24)).toEqual({ cents: 30, modelCostMicro: 270_000 });
    // Partial micro-USD round up: a bill is never under the provider's.
    expect(videoLeg(row("wan-3.0"), { cost: { "480p": 50_001 }, clipsAdded: true }, at("wan-3.0", { seconds: 3, resolution: "480p" }), 1)?.modelCostMicro).toBe(155_004);
  });

  it("is nothing without a number", () => {
    const sd = VIDEO_MODELS[0];
    expect(videoLeg(sd, null, startSettings(sd))).toBeNull();
    expect(videoLeg(sd, RATES[sd.id], startSettings(sd), 100)).toBeNull();
    expect(videoLeg(sd, { cost: {}, clipsAdded: false }, startSettings(sd))).toBeNull();
  });

  it("takes Enki's fee from the policy, the same 10% the images pay", () => {
    expect(PRICING_POLICY.enkiFeeBps).toBe(1000);
    expect(videoSplit(1_000_000, { cents: 100, modelCostMicro: 900_000 }).enkiFeeMicro).toBe(200_000);
    expect(videoSplit(9, { cents: 100, modelCostMicro: 900_000 }).enkiFeeMicro).toBe(100_000);
  });
});
