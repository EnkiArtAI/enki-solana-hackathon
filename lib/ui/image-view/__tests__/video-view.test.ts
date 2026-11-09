import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { ImageViewModel, Shot } from "@/components/image-view/useImageViewModel";
import { RATES } from "@/lib/video/__tests__/rates";
import { VIDEO_MODELS, startSettings, type VideoSettings } from "@/lib/video/models";

/**
 * A video prompt in the Image View (Kev, 2026-11-03: "gleiches visualisierungprinzip wie bei den bildern für image UI ...
 * allow also only the creation of 1 video for premium prompts"): the route's answer on PGlite before and after SQL 52, the
 * player where the picture is, the settings row where the pills are, no count, the chip the quote's. What the real view does
 * with real clicks is the fxp harness's. Blind spot here: the components are called with their state set, no browser.
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, effects: [] as (() => (() => void) | void)[], refs: [] as { current: unknown }[], r: 0, wide: false,
  run: { jobs: [] as unknown[], busy: false, press: vi.fn(async () => "job-1") }, runArgs: [] as unknown[],
  client: null as unknown, routesOn: [] as boolean[], asked: [] as unknown[][], totals: [] as Array<number | null>, pending: false, rateOf: (() => null) as (id: string) => unknown,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T | (() => T)) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = typeof start === "function" ? (start as () => T)() : start;
    return [ui.state[i] as T, (next: T | ((old: T) => T)) => { ui.state[i] = typeof next === "function" ? (next as (old: T) => T)(ui.state[i] as T) : next; }];
  },
  useRef: <T>(start: T) => {
    const i = ui.r++;
    ui.refs[i] ??= { current: start };
    return ui.refs[i];
  },
  useEffect: (run: () => (() => void) | void) => { ui.effects.push(run); },
  useId: () => "len",
}));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ui.client }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => ui.wide }));
vi.mock("@/hooks/useVideoRoutes", () => ({
  useVideoRoutes: (on: boolean) => { ui.routesOn.push(on); return { rateOf: (id: string) => ui.rateOf(id) }; },
  useVideoQuotes: (asks: unknown[]) => { ui.asked.push(asks); return { totals: asks.map((_, i) => ui.totals[i] ?? null), pending: ui.pending }; },
}));
vi.mock("@/hooks/useVideoRun", () => ({ useVideoRun: (a: unknown) => { ui.runArgs.push(a); return ui.run; } }));
vi.mock("@/hooks/useComposerQuote", () => ({ useComposerQuote: () => ({ quote: null, pending: false }) }));
vi.mock("@/components/kit/AddFundsPopover", () => ({ default: () => null }));

import ComposeFoot from "@/components/image-view/ComposeFoot";
import MainImage from "@/components/image-view/MainImage";
import StageVideo from "@/components/image-view/StageVideo";
import HeroNav from "@/components/image-view/HeroNav";
import Composer from "@/components/image-view/Composer";
import PhotoDeck from "@/components/image-view/PhotoDeck";
import { useVideoPrompt } from "@/components/image-view/useVideoPrompt";
import VideoSettingsRow from "@/components/create/video/VideoSettingsRow";
import CountStepper from "@/components/kit/CountStepper";
import GenerateButton from "@/components/kit/GenerateButton";
import GeneratorPill from "@/components/kit/GeneratorPill";
import { QualityPill, RatioPill, ResolutionPill } from "@/components/kit/SettingsPills";
import { defaultModel, modelOptions } from "@/lib/ui/image-view/models";
import { STAGE_WIDE, promptVideoSettings, stageSrc, videoRowOf, videoShot } from "@/lib/ui/image-view/video";
import { generatorCopy } from "@/lib/ui/kit/option-copy";
import { GET as promptRead } from "../../../../app/api/prompts/[id]/route";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const all = (tree: ReactNode) => [...walk(tree)];
const of = (tree: ReactNode, type: unknown) => all(tree).filter((el) => el.type === type);
const byClass = (tree: ReactNode, name: string) => all(tree).filter((el) => String(el.props.className ?? "").split(" ").includes(name));

const entry = (name: string, over: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  id: `id-${name}`, name, price: 0, mediaType: "image", supportsQuality: false, maxResolution: "2K", ratios: ["1:1"], free: false, ...over,
});
const IMAGES = [entry("Flux (free)", { free: true }), entry("Nano Banana Pro")];
const VIDEOS = VIDEO_MODELS.map((m) => entry(m.label, { mediaType: "video" }));
const CATALOGUE = [...IMAGES, ...VIDEOS];
const FILES = { preview: "https://v/p.mp4", v720: "https://v/720.mp4", v1080: "https://v/1080.mp4", poster: "https://v/poster.webp", width: 480, height: 854, durationMs: 6000 };

beforeEach(() => {
  ui.state = []; ui.s = 0; ui.effects = []; ui.refs = []; ui.r = 0; ui.wide = false;
  ui.routesOn = []; ui.asked = []; ui.totals = []; ui.pending = false; ui.rateOf = (id) => RATES[id] ?? null;
  ui.run = { jobs: [], busy: false, press: vi.fn(async () => "job-1") }; ui.runArgs = [];
});

describe("which generators a video prompt offers", () => {
  it("its video rows, an image prompt its image rows, the free host never on a premium one", () => {
    expect(modelOptions(CATALOGUE, false, [], "video")).toEqual(VIDEOS);
    expect(modelOptions(CATALOGUE, false)).toEqual(IMAGES);
    expect(modelOptions(CATALOGUE, true)).toEqual([IMAGES[1]]);
    expect(modelOptions([...CATALOGUE, entry("Free video", { mediaType: "video", free: true })], true, [], "video")).toEqual(VIDEOS);
    expect(modelOptions(CATALOGUE, true, ["Kling 3.0", "Nano Banana Pro"], "video").map((m) => m.name)).toEqual(["Kling 3.0"]);
  });

  it("opens on the prompt's own generator, else the first on offer; never on an image row", () => {
    const pick = (aiModel: string | null, p = "") => defaultModel({ catalogue: CATALOGUE, pick: p, aiModel, premium: true, medium: "video" });
    expect(pick("Kling 4.0")).toBe("Kling 4.0");
    expect(pick(null)).toBe("Seedance 2.5");
    expect(pick("Nano Banana Pro")).toBe("Seedance 2.5");
    expect(pick("Kling 4.0", "Wan 3.0")).toBe("Wan 3.0");
    expect(defaultModel({ catalogue: CATALOGUE, pick: "", aiModel: "Kling 4.0", premium: true })).toBe("Nano Banana Pro");
  });

  it("says what each is for, in its menu", () => {
    expect(generatorCopy("Seedance 2.5")).toBe(VIDEO_MODELS[0].line);
    expect(generatorCopy("Nano Banana Pro")).not.toBe(null);
    expect(generatorCopy("No such thing")).toBeNull();
  });
});

describe("what the stage plays and the row opens on", () => {
  it("v720 on a phone, v1080 from 1024 px where the video has one", () => {
    expect(STAGE_WIDE).toBe("(min-width: 1024px)");
    expect([stageSrc(FILES, false), stageSrc(FILES, true), stageSrc({ ...FILES, v1080: null }, true)]).toEqual([FILES.v720, FILES.v1080, FILES.v720]);
  });

  it("the prompt's own shape, resolution and length, inside what the model takes", () => {
    const k4 = videoRowOf("Kling 4.0")!;
    expect(promptVideoSettings(k4, { aspect_ratio: "9:16", resolution: "1080p", showcaseVideo: { durationMs: 6400 } })).toEqual({ seconds: 6, aspect: "9:16", resolution: "1080p", audio: true, bitrate: "high" });
    expect(promptVideoSettings(k4, { aspect_ratio: "auto", resolution: "2K", showcaseVideo: { durationMs: 99_000 } })).toEqual({ seconds: 30, aspect: "16:9", resolution: "720p", audio: true, bitrate: "high" });
    expect(promptVideoSettings(k4, undefined)).toEqual(startSettings(k4));
    expect(videoRowOf("Nano Banana Pro")).toBeNull();
  });

  it("the shot takes the file's own shape", () => {
    expect(videoShot(FILES)).toEqual({ video: FILES, ratio: "480:854" });
    expect(videoShot({ ...FILES, width: null })).toEqual({ video: { ...FILES, width: null } });
  });
});

describe("the player", () => {
  const stage = (files = FILES) => { ui.s = 0; ui.r = 0; ui.effects = []; return StageVideo({ files, label: "Video: Rain", onSeen: vi.fn() }) as El; };
  const stubbed = (reader: { saveData?: boolean; reduced?: boolean } = {}) => {
    vi.stubGlobal("navigator", { connection: { saveData: reader.saveData === true } });
    vi.stubGlobal("matchMedia", () => ({ matches: reader.reduced === true }));
  };
  const element = (play: () => Promise<void>) => ({ muted: false, play: vi.fn(play), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), getAttribute: () => FILES.v720, setAttribute: vi.fn() });

  it("has its poster and control, muted, inline, looped, loading nothing until it plays", () => {
    const tree = stage();
    expect(tree.type).toBe("video");
    expect(tree.props).toMatchObject({ className: "iv-video", "aria-label": "Video: Rain", poster: FILES.poster, muted: true, playsInline: true, loop: true, preload: "none", controls: true, src: FILES.v720 });
    expect("autoPlay" in tree.props).toBe(false);
    ui.wide = true;
    expect(stage().props.src).toBe(FILES.v1080);
  });

  it("starts on opening, muted, and gives its decoder back on leaving", () => {
    stubbed();
    stage();
    const el = element(async () => {});
    ui.refs[0].current = el;
    const leave = ui.effects[0]() as () => void;
    expect([el.play.mock.calls.length, el.muted]).toEqual([1, true]);
    leave();
    expect([el.pause.mock.calls.length, el.removeAttribute.mock.calls[0], el.load.mock.calls.length]).toEqual([1, ["src"], 1]);
    vi.unstubAllGlobals();
  });

  it("a shell panel over the view stops it; gone again, it goes on only if it was playing", () => {
    const heard = new EventTarget();
    vi.stubGlobal("window", heard);
    stubbed();
    stage();
    const el = Object.assign(element(async () => {}), { paused: false });
    el.pause.mockImplementation(() => { el.paused = true; });
    el.play.mockImplementation(async () => { el.paused = false; });
    ui.refs[0].current = el;
    const leave = ui.effects[1]() as () => void;
    heard.dispatchEvent(new Event("enki:hide-detail"));
    expect([el.pause.mock.calls.length, el.paused]).toEqual([1, true]);
    // A second panel over the first: still hidden, and it still means to go on.
    heard.dispatchEvent(new Event("enki:hide-detail"));
    heard.dispatchEvent(new Event("enki:show-detail"));
    expect([el.play.mock.calls.length, el.paused]).toEqual([1, false]);
    // Paused by the viewer: a panel and back leave it paused.
    el.paused = true;
    heard.dispatchEvent(new Event("enki:hide-detail"));
    heard.dispatchEvent(new Event("enki:show-detail"));
    expect(el.play).toHaveBeenCalledTimes(1);
    leave();
    el.paused = false;
    heard.dispatchEvent(new Event("enki:hide-detail"));
    expect(el.pause).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("the chip leaves the player's timeline alone; an image's stays where it was", () => {
    const css = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
    expect(css).toContain(".iv-box:has(.iv-video) .iv-meta { top: 10px; bottom: auto; }");
    expect(css).toMatch(/\.iv-meta \{\s+position: absolute;\s+left: 10px;\s+bottom: 10px;/);
  });

  it("a bookmark names a picture: a video's poster, never its mp4, since a first bookmark becomes the category's logo", () => {
    const actions = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "PromptActions.tsx"), "utf8");
    expect(actions).toContain("imageUrl={m.main?.video?.poster ?? m.main?.original}");
  });

  it("Save-Data or reduced motion leave the poster and the control", () => {
    for (const reader of [{ saveData: true }, { reduced: true }]) {
      stubbed(reader);
      stage();
      const el = element(async () => {});
      ui.refs[0].current = el;
      ui.effects[0]();
      expect(el.play, JSON.stringify(reader)).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("a refused play is no error: the poster stays, the control takes the tap", async () => {
    stubbed();
    stage();
    const el = element(() => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })));
    ui.refs[0].current = el;
    expect(() => ui.effects[0]()).not.toThrow();
    await Promise.resolve();
    expect(el.play).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("says it was seen once it has its size", () => {
    const onSeen = vi.fn();
    ui.s = 0; ui.r = 0;
    const tree = StageVideo({ files: FILES, label: "Video: Rain", onSeen }) as El;
    (tree.props.onLoadedMetadata as () => void)();
    expect(onSeen).toHaveBeenCalledTimes(1);
  });
});

describe("the stage", () => {
  const model = (main: Partial<Shot>) => ({ main: { key: "example:0", kind: "example", src: FILES.poster, ratio: null, ...main }, ratio: "1:1", now: 0, seen: vi.fn(), blank: false, status: "ready" }) as unknown as ImageViewModel;
  const draw = (m: ImageViewModel) => { ui.s = 0; ui.r = 0; return MainImage({ model: m, onOpen: vi.fn(), onClose: vi.fn() }) as El; };

  it("plays a video prompt's example where the picture is, no fullscreen button over it", () => {
    const m = model({ video: FILES });
    const tree = draw(m);
    const [player] = of(tree, StageVideo);
    expect(player.props.files).toBe(FILES);
    (player.props.onSeen as () => void)();
    expect(m.seen).toHaveBeenCalledWith(m.main);
    expect(byClass(tree, "iv-open")).toEqual([]);
  });

  it("an image stays its button and its picture", () => {
    const tree = draw(model({}));
    expect(of(tree, StageVideo)).toEqual([]);
    expect(byClass(tree, "iv-open")).toHaveLength(1);
  });

  it("the box takes the file's shape: a portrait video stands tall", () => {
    const tree = draw(model({ video: FILES, ratio: "480:854" }));
    const box = byClass(tree, "iv-box")[0];
    expect((box.props.style as Record<string, number>)["--ar"]).toBeCloseTo(480 / 854);
  });

  it("a render's spinner comes before any file", () => {
    const tree = draw(model({ video: FILES, job: { status: "rendering" } as never }));
    expect(of(tree, StageVideo)).toEqual([]);
    expect(byClass(tree, "iv-ring")).toHaveLength(1);
  });
});

describe("the foot", () => {
  const foot = { model: VIDEO_MODELS[0], settings: startSettings(VIDEO_MODELS[0]), set: vi.fn(), price: () => "$0.45" };
  const model = (over: Partial<ImageViewModel> = {}) => ({
    models: VIDEOS, core: { entry: VIDEOS[0], supportsQuality: true }, modelPrices: [], quote: null, guest: false, count: 1, countMax: 1, settingsChanged: false,
    button: { label: "✦ Generate", dimmed: true }, chip: "$0.89", photosNeeded: 0, quotePending: false, short: null, funds: null, cost: "Not available yet.", video: { foot }, resetSettings: vi.fn(), ...over,
  }) as unknown as ImageViewModel;

  it("has the settings row where the pills are, and no count on either width", () => {
    for (const phone of [false, true]) {
      const tree = ComposeFoot({ model: model(), phone });
      const [row] = of(tree, VideoSettingsRow);
      expect(row.props).toMatchObject({ m: foot.model, s: foot.settings, price: foot.price, onSet: foot.set });
      for (const t of [CountStepper, RatioPill, ResolutionPill, QualityPill]) expect(of(tree, t), `${phone} ${String(t)}`).toEqual([]);
      expect(all(tree).filter((el) => String(el.props.title ?? "") === "How many images")).toEqual([]);
    }
  });

  it("Generate carries the quote's number, dimmed", () => {
    expect(of(ComposeFoot({ model: model() }), GenerateButton)[0].props).toMatchObject({ chip: "$0.89", dimmed: true });
  });

  it("the phone's sheet says video; the set-back shows when a setting moved", () => {
    expect(of(ComposeFoot({ model: model() }), GeneratorPill)[0].props).toMatchObject({ sheetHint: "Which AI makes your video", look: "named" });
    expect(byClass(ComposeFoot({ model: model() }), "iv-reset")).toEqual([]);
    const reset = vi.fn();
    (byClass(ComposeFoot({ model: model({ settingsChanged: true, resetSettings: reset }) }), "iv-reset")[0].props.onClick as () => void)();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("a guest has the generator and no row; before SQL 67 there is no row either", () => {
    expect(of(ComposeFoot({ model: model({ guest: true }) }), VideoSettingsRow)).toEqual([]);
    expect(of(ComposeFoot({ model: model({ video: { foot: null } }) }), VideoSettingsRow)).toEqual([]);
  });

  it("an image prompt keeps its pills and its count, and has no row", () => {
    const tree = ComposeFoot({ model: model({ video: null, countMax: 8 }) });
    expect(of(tree, VideoSettingsRow)).toEqual([]);
    for (const t of [CountStepper, RatioPill, ResolutionPill, QualityPill]) expect(of(tree, t)).toHaveLength(1);
    expect(of(tree, GeneratorPill)[0].props.sheetHint).toBeUndefined();
    expect(of(tree, GeneratorPill)[0].props.look).toBe("logo-name");
  });
});

describe("the prices around it", () => {
  const run = (over: Partial<Parameters<typeof useVideoPrompt>[0]> = {}) => {
    ui.s = 0;
    return useVideoPrompt({ on: true, catalogue: CATALOGUE, pick: "", prompt: { ai_model: "Seedance 2.5" }, premium: true, offered: [], promptId: "p1", guest: false, ...over });
  };
  const SD = VIDEO_MODELS[0];
  const start = (m = SD): VideoSettings => startSettings(m);

  it("asks one batch: the chip, each resolution, each generator, each for this prompt", () => {
    run();
    const asks = ui.asked.at(-1) as Array<{ promptId: string; modelId: string; settings: VideoSettings }>;
    expect(asks.map((a) => [a.modelId, a.settings.resolution])).toEqual([
      ["seedance-2.5", "480p"], ["seedance-2.5", "480p"], ["seedance-2.5", "720p"], ["seedance-2.5", "1080p"],
      ["seedance-2.5", "480p"], ["seedance-2.0", "480p"], ["kling-4.0", "720p"], ["kling-3.0", "1080p"], ["omni-1.1-flash", "720p"], ["wan-3.0", "480p"],
    ]);
    expect(asks.every((a) => a.promptId === "p1")).toBe(true);
    expect(ui.routesOn.at(-1)).toBe(true);
  });

  it("the chip is the batch's first answer, each menu its own; \"…\" where the server has none", () => {
    ui.totals = [890_000, 1, 2_000_000, 3_000_000, 4, 5_000_000];
    const v = run();
    expect(v.chip).toBe("$0.89");
    expect(v.foot!.price("720p")).toBe("$2.00");
    expect(v.foot!.price("1080p")).toBe("$3.00");
    expect(v.modelPrices[1]?.totalMicro).toBe(5_000_000);
    expect(v.modelPrices[2]).toBeNull();
    ui.totals = [];
    expect(run().chip).toBe("…");
  });

  it("is off on an image prompt: no route asked, nothing to offer", () => {
    const v = run({ on: false });
    expect([ui.routesOn.at(-1), ui.asked.at(-1), v.models, v.entry, v.foot, v.modelPrices]).toEqual([false, [], [], undefined, null, []]);
    expect(ui.runArgs.at(-1)).toEqual({ enabled: false, promptId: "p1" });
  });

  it("reads this prompt's own videos, signed in only", () => {
    run();
    expect(ui.runArgs.at(-1)).toEqual({ enabled: true, promptId: "p1" });
    run({ guest: true });
    expect(ui.runArgs.at(-1)).toEqual({ enabled: false, promptId: "p1" });
  });

  it("Generate is pressable only where its operator runs these settings", () => {
    expect(run().available).toBe(false);
    ui.rateOf = (id) => ({ ...RATES[id], available: ["720p"] });
    expect(run().available).toBe(false);
    expect(run({ prompt: { ai_model: "Seedance 2.5", resolution: "720p" } }).available).toBe(true);
    expect(run({ catalogue: IMAGES }).available).toBe(false);
  });

  it("one press: this model, these settings, this prompt, the words and values it is handed", async () => {
    expect(await run({ prompt: { ai_model: "Seedance 2.5", aspect_ratio: "9:16" } }).press("rain", { city: "Rome" })).toBe("job-1");
    expect(ui.run.press.mock.calls).toEqual([[{ modelId: "seedance-2.5", settings: { ...start(), aspect: "9:16" }, promptId: "p1", words: "rain", variableValues: { city: "Rome" } }]]);
    ui.run.press.mockClear();
    expect(await run({ catalogue: IMAGES }).press("rain", undefined)).toBeNull();
    expect(ui.run.press).not.toHaveBeenCalled();
  });

  it("under Generate: the newest under way, or how it ended; the delivered ones go to the history", () => {
    expect(run().line).toBeNull();
    const made = { id: "a", status: "delivered", why: null, video: FILES };
    ui.run.jobs = [{ id: "b", status: "running", why: null, video: null }, made];
    expect(run().line).toBe("Your video is being made. It lands in History when it is ready.");
    expect(run().delivered).toEqual([made]);
    ui.run.jobs = [{ id: "c", status: "refused", why: "No.", video: null }, made];
    expect(run().line).toBe("No.");
    ui.run.jobs = [made];
    expect(run().line).toBeNull();
  });

  it("a guest asks no quote, has no chip, and reads each generator's rate on its menu", () => {
    const v = run({ guest: true });
    expect([ui.asked.at(-1), v.chip]).toEqual([[], null]);
    expect(v.modelPrices.map((q) => q?.totalUsd)).toEqual(["0.45", "0.67", "0.69", "0.74", "1.12", "0.88"]);
    ui.rateOf = () => null;
    expect(run({ guest: true }).modelPrices).toEqual(Array(6).fill(null));
  });

  it("opens on the prompt's settings; a pick moves them, is one change, and a set-back clears it", () => {
    expect(run({ prompt: { ai_model: "Seedance 2.5", aspect_ratio: "9:16", resolution: "720p" } }).foot!.settings).toEqual({ ...start(), aspect: "9:16", resolution: "720p" });
    const v = run();
    expect(v.changed).toBe(false);
    v.foot!.set({ seconds: 9 });
    const moved = run();
    expect([moved.foot!.settings.seconds, moved.changed]).toEqual([9, true]);
    moved.reset();
    expect([run().foot!.settings.seconds, run().changed]).toEqual([4, false]);
  });

  it("another generator is a change; its settings are as it takes them; before SQL 67 there is nothing", () => {
    const v = run({ pick: "Kling 4.0" });
    expect([v.entry?.name, v.ownName, v.changed, v.foot!.model.id, v.foot!.settings.resolution]).toEqual(["Kling 4.0", "Seedance 2.5", true, "kling-4.0", "720p"]);
    const none = run({ catalogue: IMAGES });
    expect([none.foot, none.models, none.chip]).toEqual([null, [], "…"]);
  });
});

describe("a drag on the player", () => {
  it("is its timeline, never a swipe to the next example; beside it a swipe is as ever", () => {
    const m = { examples: [{ key: "a" }, { key: "b" }], community: [], main: { key: "a" }, select: vi.fn() } as unknown as ImageViewModel;
    const hero = () => { ui.s = 0; ui.r = 0; return HeroNav({ model: m, children: "x" }) as El; };
    const drag = (onVideo: boolean) => {
      const target = { closest: (q: string) => (q === "video" && onVideo ? {} : null) };
      (hero().props.onPointerDown as (e: unknown) => void)({ clientX: 300, target });
      (hero().props.onPointerUp as (e: unknown) => void)({ clientX: 100 });
    };
    drag(true);
    expect(m.select).not.toHaveBeenCalled();
    drag(false);
    expect(m.select).toHaveBeenCalledTimes(1);
  });

  it("the arrow keys are the player's while it has the focus", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "HeroNav.tsx"), "utf8");
    expect(src).toContain("/^(INPUT|TEXTAREA|SELECT|VIDEO)$/");
  });
});

describe("the photos", () => {
  it("are off on a video prompt, on a phone's Full prompt and a plain prompt too", () => {
    const m = (over: object) => ({ guest: false, photosOff: true, text: "words Reference image 1", plain: true, segments: [{ kind: "ref" }], fields: [], room: 0, slotTotal: 1, accept: "", ...over }) as unknown as ImageViewModel;
    ui.s = 0; ui.r = 0;
    expect(of(Composer({ model: m({}) }), PhotoDeck)).toEqual([]);
    ui.s = 0; ui.r = 0;
    expect(of(Composer({ model: m({ photosOff: false }) }), PhotoDeck)).toHaveLength(1);
  });
});

describe("GET /api/prompts/[id]", () => {
  const STUBS = `
    create table public.users (id uuid primary key, deleted_at timestamptz, account_status text default 'active', adult_confirmed_at timestamptz);
    insert into public.users (id) values ('00000000-0000-4000-8000-000000000001');
    create table public.bans (id uuid primary key default gen_random_uuid(), user_id uuid, lifted_at timestamptz, expires_at timestamptz);
    create table public.prompts (id uuid primary key, title text, encrypted_content text, encrypted_content_iv text, encrypted_content_tag text, encrypted_content_kid text,
      creator_id uuid, category text, tags text[], ai_model text, ai_settings jsonb, price_usd_cents int default 0, aspect_ratio text, photo_count int, prompt_type text,
      showcase_images jsonb, showcase_before_images jsonb, resolution text, is_free_showcase boolean default false, is_listed boolean default true, listing_status text default 'active',
      deleted_at timestamptz, public_prompt_text text, description text, published_at timestamptz, created_at timestamptz default now(), updated_at timestamptz, is_adult boolean default false);
    create table public.prompt_variables (id uuid primary key default gen_random_uuid(), prompt_id uuid, name text, label text, description text, data_type text, default_value text, is_required boolean,
      position int, min_value numeric, max_value numeric, options jsonb, deleted_at timestamptz);
    create table public.generated_images (id uuid primary key default gen_random_uuid(), user_id uuid, storage_url text, preview_url text, thumbnail_url text, view_url text, tiny_url text, deleted_at timestamptz, references_public boolean, visibility text);
    create table public.generations (id uuid primary key default gen_random_uuid());
  `;
  const CREATOR = "00000000-0000-4000-8000-000000000001";
  const PREMIUM = "00000000-0000-4000-8000-0000000000b1";
  const IMAGE = "00000000-0000-4000-8000-0000000000b2";
  const SECRET = "the artist's secret words";
  const INSERT = `insert into public.prompts (id, title, creator_id, ai_model, price_usd_cents, prompt_type, showcase_images, aspect_ratio, public_prompt_text, encrypted_content) values
    ('${PREMIUM}', 'A video', '${CREATOR}', 'Seedance 2.5', 40, 'paid', '["${FILES.poster}"]', '9:16', null, null),
    ('${IMAGE}', 'An image', '${CREATOR}', 'Nano Banana Pro', 40, 'paid', '["https://a/1.png"]', '1:1', null, null);`;
  const read = async (id: string) => {
    const res = await promptRead(new NextRequest(`http://enki.test/api/prompts/${id}`) as never, { params: Promise.resolve({ id }) });
    return { status: res.status, text: await res.text() };
  };
  const body = (r: { text: string }) => (JSON.parse(r.text) as { prompt: Record<string, unknown> }).prompt;
  let before: PGlite, after: PGlite;
  const SQL52 = readFileSync(join(__dirname, "..", "..", "..", "..", "migrations", "2026-11-03-video-prompts.sql"), "utf8");
  beforeAll(async () => {
    [before, after] = await Promise.all([PGlite.create(), PGlite.create()]);
    await before.exec(STUBS + INSERT);
    await after.exec(STUBS + INSERT + SQL52);
    await after.exec(`update public.prompts set media_type = 'video', showcase_video = '${JSON.stringify(FILES)}' where id = '${PREMIUM}'`);
    await after.exec(`update public.prompts set showcase_video = '{"v720": "http://not-https/x.mp4"}' where id = '${IMAGE}'`);
  }, 60_000);
  afterAll(async () => { await Promise.all([before.close(), after.close()]); });

  it("before SQL 52 every prompt is an image's, and it answers as it did", async () => {
    ui.client = pglitePostgrest(before).client;
    const p = body(await read(IMAGE));
    expect([p.mediaType, p.showcaseVideo, p.title]).toEqual(["image", null, "An image"]);
  });

  it("after it a video prompt says so and hands its files; its picture list stays the poster, its words stay the artist's", async () => {
    ui.client = pglitePostgrest(after).client;
    const r = await read(PREMIUM);
    const p = body(r);
    expect([p.mediaType, p.showcaseVideo]).toEqual(["video", FILES]);
    expect((p.showcaseImages as { url: string }[]).map((s) => s.url)).toEqual([FILES.poster]);
    expect(p.publicPromptText).toBeUndefined();
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toMatch(/encrypted_/);
  });

  it("an image prompt stays one; a stored file that is no https address hands none", async () => {
    ui.client = pglitePostgrest(after).client;
    const p = body(await read(IMAGE));
    expect([p.mediaType, p.showcaseVideo]).toEqual(["image", null]);
  });
});
