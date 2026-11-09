import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRICING_POLICY } from "@/lib/payments/generation-pricing";
import { formatCopy } from "@/lib/ui/kit/option-copy";
import { frameRefusal, freePlace, overRefs, refKind, takeRefs } from "@/lib/video/media";
import {
  DEFAULT_MODEL, MARKUP_PERCENT, VIDEO_MODELS, fitSettings, modelOf, placeholderOf, startSettings, typedSeconds, videoCents as centsAt, videoPrice as priceAt,
  type VideoModel, type VideoSettings,
} from "@/lib/video/models";
import { RATES } from "./rates";

/**
 * Create > Video's rows and rules (Kev, 2026-10-30: "kling 4.0, kling 3.0, seedance 2.0, seedance 2.5, google = Omni
 * (Gemini Omni 1.1 Flash), wan aktuellste (Wan 3.0)"): what each model takes, and its price, the provider's rate per
 * output second x 1.10, from its row in video_routes (./rates, held to SQL 68 by routes.test.ts).
 */
const row = (id: string) => VIDEO_MODELS.find((m) => m.id === id)!;
const videoCents = (m: VideoModel, s: VideoSettings, clipTenths = 0) => centsAt(m, RATES[m.id], s, clipTenths);
const videoPrice = (m: VideoModel, s: VideoSettings, clipTenths = 0) => priceAt(m, RATES[m.id], s, clipTenths);
const at = (id: string, over: Partial<VideoSettings>) => fitSettings(row(id), { ...startSettings(row(id)), ...over });

describe("the models", () => {
  it("are the six Kev named, Seedance 2.5 first and picked", () => {
    expect(VIDEO_MODELS.map((m) => m.label)).toEqual(["Seedance 2.5", "Seedance 2.0", "Kling 4.0", "Kling 3.0", "Gemini Omni 1.1 Flash", "Wan 3.0"]);
    expect(DEFAULT_MODEL.id).toBe("seedance-2.5");
    expect(modelOf("wan-3.0").label).toBe("Wan 3.0");
    expect(modelOf("veo-3.1")).toBe(DEFAULT_MODEL);
  });

  it("take media by family: Seedance references, Kling and Omni frames, Wan one or the other", () => {
    expect(VIDEO_MODELS.map((m) => [m.id, m.slots.join("+"), m.oneSlot ?? false])).toEqual([
      ["seedance-2.5", "refs", false], ["seedance-2.0", "refs", false], ["kling-4.0", "frames", false],
      ["kling-3.0", "frames", false], ["omni-1.1-flash", "frames", false], ["wan-3.0", "frames+refs", true],
    ]);
    expect([row("seedance-2.5").refs, row("seedance-2.0").refs, row("wan-3.0").refs]).toEqual([
      { images: 30, clips: 10, clipSeconds: 30 }, { images: 9, clips: 3, clipSeconds: 15 }, { images: 10, clips: 5, clipSeconds: 15 },
    ]);
    expect(placeholderOf(row("seedance-2.0"))).toBe("Describe the video, e.g. a slow push-in as rain starts. Name a reference by its place: image 1, clip 1.");
    expect(placeholderOf(row("wan-3.0"))).toBe(placeholderOf(row("seedance-2.5")));
    expect(placeholderOf(row("kling-4.0"))).toBe("What video do you want to make?");
  });

  it("offer their own aspects, resolutions, lengths, sound and bitrate", () => {
    expect(VIDEO_MODELS.map((m) => [m.id, m.aspects.join(" "), m.resolutions.join(" "), m.resolution, `${m.seconds.min}-${m.seconds.max}`, m.audio, m.bitrate, m.promptLength ?? false])).toEqual([
      ["seedance-2.5", "16:9 9:16 1:1 21:9 4:3 3:4 auto", "480p 720p 1080p", "480p", "4-30", "switch", true, false],
      ["seedance-2.0", "16:9 9:16 1:1 21:9 4:3 3:4 auto", "480p 720p 1080p", "720p", "4-15", "switch", true, false],
      ["kling-4.0", "16:9 9:16 1:1 21:9", "720p 1080p", "720p", "3-30", "on", false, false],
      ["kling-3.0", "16:9 9:16 1:1", "720p 1080p", "1080p", "3-15", "switch", false, false],
      ["omni-1.1-flash", "16:9 9:16", "720p 1080p", "720p", "10-10", "on", false, true],
      ["wan-3.0", "16:9 9:16 1:1 21:9 4:3 3:4 auto", "480p 720p 1080p", "1080p", "2-30", "switch", false, false],
    ]);
    // Wan 3.0 alone is silent from frames and bills a clip's seconds as the output's (the UI matrix, its billing line).
    expect(VIDEO_MODELS.map((m) => [m.id, m.framesMute ?? false, RATES[m.id].clipsAdded]).filter(([, a, b]) => a || b)).toEqual([["wan-3.0", true, true]]);
  });
});

describe("what each model is for", () => {
  // Kev, 2026-10-30: "die erklärungen bei den video generatoren sind so nichtssagend, i need a better explanation on what
  // these generators are rather used for". Each line rests on the row beside it.
  it("is one short line per model, each its own, as Higgsfield's list has them", () => {
    expect(VIDEO_MODELS.map((m) => [m.id, m.line])).toEqual([
      ["seedance-2.5", "Steer a video with many pictures and clips, up to 30 s"],
      ["seedance-2.0", "Guide a short video with references, up to 15 s"],
      ["kling-4.0", "Turn words or frames into shots with sound, up to 30 s"],
      ["kling-3.0", "Make shots with or without sound, up to 15 s"],
      ["omni-1.1-flash", "Let your words set the length, with sound, up to 10 s"],
      ["wan-3.0", "Start from words, frames or references, 2 to 30 s"],
    ]);
    // Two lines on the model card at most (review 2026-10-30: 69 to 87 characters took three), no price: that is the chips'.
    for (const m of VIDEO_MODELS) expect(m.line, m.id).toMatch(/^[A-Z][^$.;]{0,54}$/);
    for (const m of VIDEO_MODELS) expect(m.line, m.id).not.toMatch(/less|cheap|rate|lowest/i);
  });

  it("says only what the rows hold", () => {
    const sd25 = row("seedance-2.5").refs!;
    for (const m of VIDEO_MODELS) {
      const says = (words: RegExp) => words.test(m.line);
      // Each names a length, as the slider has it.
      expect(says(/\d+ s$/), m.id).toBe(true);
      const upTo = m.line.match(/up to (\d+) s/)?.[1];
      const span = m.line.match(/(\d+) to (\d+) s/);
      if (upTo) expect(Number(upTo), m.id).toBe(m.seconds.max);
      if (span) expect([Number(span[1]), Number(span[2])], m.id).toEqual([m.seconds.min, m.seconds.max]);
      // "short": 15 s at most; "many": no other row takes as many pictures or clips.
      if (says(/short/)) expect(m.seconds.max, m.id).toBeLessThanOrEqual(15);
      if (says(/many/)) expect(VIDEO_MODELS.every((x) => x === m || !x.refs || (x.refs.images < sd25.images && x.refs.clips < sd25.clips)), m.id).toBe(true);
      // The media it names it takes: frames, or pictures, clips or references.
      if (says(/frames/)) expect(m.slots, m.id).toContain("frames");
      if (says(/references|pictures|clips/)) expect(m.slots, m.id).toContain("refs");
      // The sound: "with sound" where it always has it, "with or without" where it is the buyer's; the words' length (Omni).
      expect(says(/with sound/), m.id).toBe(m.audio === "on");
      if (says(/with or without sound/)) expect(m.audio, m.id).toBe("switch");
      expect(says(/words set the length/), m.id).toBe(Boolean(m.promptLength));
    }
  });
});

describe("Auto", () => {
  // Kev, 2026-10-30: "also add "auto" ratio wo son generator das zb ermöglicht": where the official docs offer it.
  it("is offered where the model's docs offer it, last in the list, never the opening shape", () => {
    expect(VIDEO_MODELS.filter((m) => m.aspects.includes("auto")).map((m) => m.id)).toEqual(["seedance-2.5", "seedance-2.0", "wan-3.0"]);
    expect(VIDEO_MODELS.every((m) => !m.aspects.includes("auto") || m.aspects.at(-1) === "auto")).toBe(true);
    expect(VIDEO_MODELS.map((m) => startSettings(m).aspect)).toEqual(Array(6).fill("16:9"));
    // From Auto to a model without it: its first shape; back again, Auto is as picked.
    const auto = { ...startSettings(DEFAULT_MODEL), aspect: "auto" as const };
    expect(fitSettings(row("kling-4.0"), auto).aspect).toBe("16:9");
    expect(fitSettings(row("wan-3.0"), auto).aspect).toBe("auto");
  });

  it("costs what any other shape costs", () => {
    for (const m of VIDEO_MODELS.filter((x) => x.aspects.includes("auto")))
      for (const resolution of m.resolutions) {
        const s = { ...startSettings(m), resolution, seconds: 9 };
        expect(videoCents(m, { ...s, aspect: "auto" }), `${m.id} ${resolution}`).toBe(videoCents(m, { ...s, aspect: "16:9" }));
      }
  });

  it("and every other shape a model offers has its line, as the image pills have", () => {
    for (const m of VIDEO_MODELS) for (const a of m.aspects) expect(formatCopy(a), `${m.id} ${a}`).not.toBeNull();
  });
});

describe("a typed length", () => {
  // Kev, 2026-10-30: "let me type in the length ... into an integer between the min and max länge des jeweiligen generators".
  it("is a whole number of seconds inside the model's range", () => {
    const sd = row("seedance-2.5");
    expect(["12", " 12 ", "7.4", "7.5", "99", "1", "-5", "0", "30", "4"].map((t) => typedSeconds(sd, t))).toEqual([12, 12, 7, 8, 30, 4, 4, 4, 30, 4]);
    expect(["20", "2"].map((t) => typedSeconds(row("kling-3.0"), t))).toEqual([15, 3]);
    expect(typedSeconds(row("wan-3.0"), "2")).toBe(2);
  });

  it("is nothing when nothing, or no number, is typed: the length stays", () => {
    for (const t of ["", "  ", "abc", "1e400", "NaN"]) expect(typedSeconds(DEFAULT_MODEL, t), JSON.stringify(t)).toBeNull();
  });
});

describe("the settings", () => {
  it("open as Sume's: 4 s, 16:9, with sound, high bitrate, at the model's own resolution", () => {
    expect(startSettings(DEFAULT_MODEL)).toEqual({ seconds: 4, aspect: "16:9", resolution: "480p", audio: true, bitrate: "high" });
    // Omni has no length to set: the slider's stays for the next model, its price is for its 10 s.
    expect(startSettings(row("omni-1.1-flash")).seconds).toBe(4);
    expect(fitSettings(row("omni-1.1-flash"), { ...startSettings(DEFAULT_MODEL), seconds: 6 }).seconds).toBe(6);
    expect(fitSettings(row("wan-3.0"), fitSettings(row("omni-1.1-flash"), { ...startSettings(DEFAULT_MODEL), seconds: 6 })).seconds).toBe(6);
  });

  it("follow a new model: the length into its range, an aspect and resolution it makes, sound where it is always on; picks that fit stay", () => {
    const s: VideoSettings = { seconds: 25, aspect: "4:3", resolution: "480p", audio: false, bitrate: "standard" };
    expect(fitSettings(row("kling-3.0"), s)).toEqual({ seconds: 15, aspect: "16:9", resolution: "1080p", audio: false, bitrate: "standard" });
    expect(fitSettings(row("kling-4.0"), s)).toEqual({ seconds: 25, aspect: "16:9", resolution: "720p", audio: true, bitrate: "standard" });
    expect(fitSettings(row("wan-3.0"), { ...s, seconds: 1 })).toEqual({ seconds: 2, aspect: "4:3", resolution: "480p", audio: false, bitrate: "standard" });
    expect(fitSettings(row("seedance-2.0"), { ...s, seconds: 7.4, aspect: "9:16", resolution: "1080p" }))
      .toEqual({ seconds: 7, aspect: "9:16", resolution: "1080p", audio: false, bitrate: "standard" });
  });
});

describe("the price", () => {
  it("carries Enki's 10% fee, the platform's own", () => {
    expect(MARKUP_PERCENT).toBe(110);
    expect(MARKUP_PERCENT).toBe(100 + PRICING_POLICY.enkiFeeBps / 100);
  });

  it("is plain arithmetic the server can read: nothing here comes from a \"use client\" file", () => {
    expect(readFileSync(join(__dirname, "..", "models.ts"), "utf8")).not.toMatch(/^import(?! type)/m);
  });

  it("has no rate in a capability row: the rate is the operator's, in video_routes", () => {
    for (const m of VIDEO_MODELS) for (const key of ["cost", "audioCost", "clipsAdded"]) expect(key in m, `${m.id} ${key}`).toBe(false);
  });

  it("is the seconds x the rate x 1.10, rounded to the cent, down and up", () => {
    // 4 s at 480p: 4 x $0.1028 x 1.1 = $0.45232; Sume's own is $0.42 (no fee).
    expect(videoPrice(DEFAULT_MODEL, startSettings(DEFAULT_MODEL))).toBe("$0.45");
    expect(videoCents(row("seedance-2.5"), at("seedance-2.5", { seconds: 30, resolution: "1080p" }))).toBe(1876);
    expect(videoPrice(row("seedance-2.0"), at("seedance-2.0", { seconds: 5, resolution: "720p" }))).toBe("$0.83");
    // $0.6908 down, $0.165 up.
    expect(videoPrice(row("kling-4.0"), at("kling-4.0", { seconds: 4 }))).toBe("$0.69");
    expect(videoPrice(row("wan-3.0"), at("wan-3.0", { seconds: 3, resolution: "480p" }))).toBe("$0.17");
    expect(videoPrice(row("wan-3.0"), at("wan-3.0", { seconds: 4 }))).toBe("$0.88");
  });

  it("moves with the length and the resolution; sound costs more only where the provider charges it (Kling 3.0)", () => {
    const k3 = (over: Partial<VideoSettings>) => videoPrice(row("kling-3.0"), at("kling-3.0", { seconds: 5, ...over }));
    expect([k3({ resolution: "720p", audio: false }), k3({ resolution: "720p" }), k3({ audio: false }), k3({})]).toEqual(["$0.46", "$0.69", "$0.62", "$0.92"]);
    expect(videoPrice(row("kling-3.0"), at("kling-3.0", { seconds: 15 }))).toBe("$2.77");
    const sd = (audio: boolean) => videoPrice(row("seedance-2.5"), at("seedance-2.5", { audio }));
    expect(sd(true)).toBe(sd(false));
  });

  it("is for the most the words can run where they set the length (Omni, 10 s), the whole of it, not \"up to\"", () => {
    expect(videoPrice(row("omni-1.1-flash"), at("omni-1.1-flash", {}))).toBe("$1.12");
    expect(videoPrice(row("omni-1.1-flash"), { ...at("omni-1.1-flash", { resolution: "1080p" }), seconds: 3 })).toBe("$1.67");
  });

  it("adds a held clip's seconds where the model bills them at its rate (Wan 3.0), and is no number where that rate is unread (Seedance)", () => {
    // Wan 1080p, 5 s out, a 10 s clip in: (10 + 5) x $0.20 x 1.10 = $3.30 (review 2026-10-30: it showed $1.10).
    const wan = at("wan-3.0", { seconds: 5 });
    expect([videoPrice(row("wan-3.0"), wan), videoPrice(row("wan-3.0"), wan, 100)]).toEqual(["$1.10", "$3.30"]);
    // Tenths count: 2.4 s in, 3 s out at 480p: 5.4 x $0.05 x 1.1 = $0.297.
    expect(videoCents(row("wan-3.0"), at("wan-3.0", { seconds: 3, resolution: "480p" }), 24)).toBe(30);
    // Seedance bills a clip at its own rate with a minimum not read yet: never a number below the provider's.
    expect([videoCents(row("seedance-2.5"), startSettings(DEFAULT_MODEL), 100), videoPrice(row("seedance-2.0"), at("seedance-2.0", {}), 1)]).toEqual([null, "…"]);
    expect(videoPrice(row("seedance-2.5"), startSettings(DEFAULT_MODEL), 0)).toBe("$0.45");
  });

  it("is no number where the model has no rate", () => {
    const off = { ...startSettings(row("kling-4.0")), resolution: "480p" as const };
    expect(videoCents(row("kling-4.0"), off)).toBeNull();
    expect(videoPrice(row("kling-4.0"), off)).toBe("…");
  });

  it("is no number before SQL 68, when there is no row", () => {
    expect([centsAt(DEFAULT_MODEL, null, startSettings(DEFAULT_MODEL)), priceAt(DEFAULT_MODEL, null, startSettings(DEFAULT_MODEL))]).toEqual([null, "…"]);
  });
});

describe("the media", () => {
  const f = (type: string, size = 10, name = "f") => ({ type, size, name });
  const caps = { images: 2, clips: 1, clipSeconds: 15 };

  it("frames are PNG, JPEG or WebP pictures", () => {
    expect(["image/png", "image/jpeg", "image/webp"].map((t) => frameRefusal(f(t)))).toEqual([null, null, null]);
    expect(frameRefusal(f("image/gif"))).toBe("Pick a PNG, JPEG or WebP image.");
    expect(frameRefusal(f("video/mp4"))).toBe("Pick a PNG, JPEG or WebP image.");
  });

  it("references are pictures or MP4/MOV clips of up to 200 MB", () => {
    expect([refKind(f("image/webp")), refKind(f("video/mp4")), refKind(f("", 10, "a.mov")), refKind(f("video/webm")), refKind(f("video/mp4", 200 * 1024 * 1024 + 1))])
      .toEqual(["image", "clip", "clip", null, null]);
  });

  it("take what fits beside what is held, in order, and say what was left out", () => {
    const [a, b, c, v, w, gif] = [f("image/png"), f("image/jpeg"), f("image/webp"), f("video/mp4"), f("video/quicktime"), f("image/gif")];
    expect(takeRefs([a, v], [], caps)).toEqual({ take: [{ file: a, kind: "image" }, { file: v, kind: "clip" }], why: null });
    expect(takeRefs([a, b, c], [], caps)).toEqual({ take: [{ file: a, kind: "image" }, { file: b, kind: "image" }], why: "At most 2 images and 1 clips here." });
    expect(takeRefs([w, a], [{ kind: "clip" }, { kind: "image" }], caps)).toEqual({ take: [{ file: a, kind: "image" }], why: "At most 2 images and 1 clips here." });
    expect(takeRefs([gif, a], [], caps)).toEqual({ take: [{ file: a, kind: "image" }], why: "Only PNG, JPEG or WebP images and MP4 or MOV clips of up to 200 MB." });
  });

  it("past a model's caps are marked and said, the clips counted in all by the tenths they show", () => {
    const sd2 = row("seedance-2.0");
    const imgs = Array.from({ length: 11 }, () => ({ kind: "image" as const }));
    expect(overRefs(sd2, imgs, false)).toEqual({ over: [9, 10], why: "Seedance 2.0 takes 9 images and 3 clips of 15 s in all: take 2 out.", clipTenths: 0 });
    const clips = [10, 5.04, 0.1, 1].map((seconds) => ({ kind: "clip" as const, seconds }));
    expect(overRefs(sd2, clips, false).over).toEqual([2, 3]);
    expect(overRefs(sd2, clips.slice(0, 2), false)).toEqual({ over: [], why: null, clipTenths: 150 });
    expect(overRefs(sd2, [1, 1, 1, 1].map((seconds) => ({ kind: "clip" as const, seconds })), false).over).toEqual([3]);
    // A clip left out leaves its seconds free for the next.
    expect(overRefs(sd2, [10, 10, 4].map((seconds) => ({ kind: "clip" as const, seconds })), false).over).toEqual([1]);
    // The price counts the seconds of the clips taken, not of one left out.
    expect(overRefs(sd2, [10, 10, 4].map((seconds) => ({ kind: "clip" as const, seconds })), false).clipTenths).toBe(140);
    expect(overRefs(row("kling-4.0"), [...imgs, { kind: "clip", seconds: 5 }], false)).toEqual({ over: [], why: null, clipTenths: 0 });
  });

  it("frames and references both held under Wan 3.0 are said; under Seedance frames do not count", () => {
    expect(overRefs(row("wan-3.0"), [{ kind: "image" }], true)).toEqual({ over: [], why: "Wan 3.0 takes frames or references, not both: take one out.", clipTenths: 0 });
    expect(overRefs(row("wan-3.0"), [{ kind: "image" }], false).why).toBeNull();
    expect(overRefs(row("seedance-2.5"), [{ kind: "image" }], true).why).toBeNull();
  });

  // Kev, 2026-10-30: "Animate, wodurch es als reference image in den letzten video editor eingefügt wird, in den wo noch
  // was frei ist".
  it("Animate's picture goes to the start frame, else the end, where the model takes frames; else the references with room", () => {
    const pics = (n: number) => Array.from({ length: n }, () => ({ kind: "image" as const }));
    const clips = (n: number) => Array.from({ length: n }, () => ({ kind: "clip" as const, seconds: 1 }));
    for (const id of ["kling-4.0", "kling-3.0", "omni-1.1-flash"]) {
      expect([freePlace(row(id), {}, []), freePlace(row(id), { start: 1 }, []), freePlace(row(id), { end: 1 }, []), freePlace(row(id), { start: 1, end: 1 }, [])], id)
        .toEqual(["start", "end", "start", null]);
    }
    // Seedance: the references while a picture fits under the cap; clips take no picture's place; frames do not count.
    expect([freePlace(row("seedance-2.0"), {}, pics(8)), freePlace(row("seedance-2.0"), {}, pics(9)), freePlace(row("seedance-2.0"), {}, [...pics(8), ...clips(3)])])
      .toEqual(["refs", null, "refs"]);
    expect(freePlace(row("seedance-2.5"), { start: 1, end: 1 }, pics(29))).toBe("refs");
    // Wan: frames first; frames shut while references are held, references shut while a frame is.
    const wan = row("wan-3.0");
    expect([freePlace(wan, {}, []), freePlace(wan, { start: 1 }, []), freePlace(wan, { start: 1, end: 1 }, []), freePlace(wan, { end: 1 }, [])])
      .toEqual(["start", "end", null, "start"]);
    expect([freePlace(wan, {}, pics(1)), freePlace(wan, {}, pics(10)), freePlace(wan, {}, clips(1))]).toEqual(["refs", null, "refs"]);
    // Either frame shuts the references, the end one alone too, though a picture would still fit there.
    expect([freePlace(wan, { start: 1, end: 1 }, pics(1)), freePlace(wan, { start: 1 }, pics(1)), freePlace(wan, { end: 1 }, pics(1))]).toEqual([null, null, null]);
  });
});
