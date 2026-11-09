import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Create > Video (Kev, 2026-10-30: "die UI für image und video generations die genauso aussehen sollten wie bei sume mit
 * aber Make it a prompt zusatz bei beiden iwo so wie bei quick create"): the composer, its draft, the saved references
 * (Kev, 2026-10-30: "i only want these ref images for videos") and History | How it works. The components are called
 * with their state set, as React would render them.
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, refs: [] as { current: unknown }[], r: 0, effects: [] as (() => (() => void) | void)[],
  notify: vi.fn(), offset: vi.fn(), login: vi.fn(), read: vi.fn(), seconds: vi.fn(), push: vi.fn(), stash: vi.fn(),
  library: vi.fn(), access: { userId: "u1" as string | null }, phone: false, rateOf: (() => null) as (id: string) => unknown,
  run: { jobs: [] as unknown[], busy: false, press: vi.fn() },
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
  useEffectEvent: <T,>(fn: T) => fn,
  useId: () => "len",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: ui.push }) }));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ui.access }));
vi.mock("@/components/enki-shell/editorBridge", () => ({ stashEditorSeed: ui.stash }));
vi.mock("@/hooks/useReferenceLibrary", () => ({ useReferenceLibrary: ui.library }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => ui.phone }));
vi.mock("@/hooks/useReferenceReads", () => ({ readReference: ui.read }));
vi.mock("@/hooks/useVideoRoutes", () => ({ useVideoRoutes: () => ({ rateOf: (id: string) => ui.rateOf(id) }) }));
vi.mock("@/hooks/useVideoRun", () => ({ useVideoRun: () => ui.run }));
vi.mock("@/components/kit/notify", () => ({ notify: ui.notify, useToastOffset: ui.offset }));
vi.mock("@/lib/openLogin", () => ({ openLogin: ui.login }));
vi.mock("@/lib/remix/inputs", async (original) => ({ ...(await original<typeof import("@/lib/remix/inputs")>()), readSeconds: ui.seconds }));

import VideoComposer, { CLIPS_NOT_YET, CLIP_UNPRICED, ONE_SLOT, type VideoLibrary } from "@/components/create/video/VideoComposer";
import VideoSettingsRow from "@/components/create/video/VideoSettingsRow";
import VideoView, { EXPLORE_VIDEOS, JobCard } from "@/components/create/video/VideoView";
import { VIDEO_CONSENT, VIDEO_CONSENT_REFUSED, VIDEO_MAKING, type VideoJobView } from "@/lib/video/job-view";
import type { VideoPress } from "@/hooks/useVideoRun";
// Called outside React on purpose, its hooks answered by the mocks above.
import { NO_FREE_PLACE, forgetVideoDraft, useVideoDraft as runDraft, type VideoDraft } from "@/components/create/video/useVideoDraft";
import { sendToVideo } from "@/lib/ui/create/handoff";
import AutosizeTextarea from "@/components/kit/AutosizeTextarea";
import CostLine from "@/components/kit/CostLine";
import GenerateButton from "@/components/kit/GenerateButton";
import PillMenu from "@/components/kit/PillMenu";
import Segmented from "@/components/kit/Segmented";
import RefPicker, { type RefSource } from "@/components/image-view/RefPicker";
import { VIDEO_MODELS, VIDEO_NOT_AVAILABLE, modelOf, startSettings, videoPrice, type VideoModel, type VideoSettings } from "@/lib/video/models";
import { RATES } from "./rates";
import { ArrowLeftRight } from "lucide-react";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  // The settings row called in place, its state after the composer's three, its ref after the composer's three.
  else if (isValidElement<Record<string, unknown>>(node) && node.type === VideoSettingsRow) {
    ui.s = 3; ui.r = 3;
    yield* walk(VideoSettingsRow(node.props as Parameters<typeof VideoSettingsRow>[0]));
  } else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const all = (tree: ReactNode) => [...walk(tree)];
const of = (tree: ReactNode, type: unknown) => all(tree).filter((el) => el.type === type);
const byClass = (tree: ReactNode, name: string) => all(tree).filter((el) => String(el.props.className ?? "").split(" ").includes(name));
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("") : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);
const button = (tree: ReactNode, label: string) => all(tree).find((el) => el.type === "button" && (el.props["aria-label"] === label || text(el) === label));
const press = (el: El | undefined) => (el!.props.onClick as () => void)();
const pill = (tree: ReactNode, title: string) => of(tree, PillMenu).find((el) => el.props.title === title);
const file = (type: string, name = "a", size = 10) => ({ type, name, size }) as File;

const draft = () => {
  ui.s = 0; ui.r = 0; ui.effects = [];
  return runDraft();
};
const lib = (saved: VideoLibrary["saved"] = [], deleted: string[] = []): VideoLibrary => ({ saved, deleted, save: vi.fn(async () => null), remove: vi.fn() });
const compose = (d: VideoDraft, { guest = false, phone = false, library = lib(), onMakePrompt = vi.fn(), run = undefined as Parameters<typeof VideoComposer>[0]["run"] } = {}) => {
  ui.s = 0; ui.r = 0;
  return VideoComposer({ d, guest, phone, library, onMakePrompt, run }) as ReactNode;
};
// A draft with what one test needs, its handlers spies.
const fake = (model = "seedance-2.5", over: Partial<VideoDraft> = {}) => {
  const settings = over.settings ?? startSettings(modelOf(model));
  return {
    model: modelOf(model), settings, wanted: settings, frames: {}, framesWhy: null, refs: [], refsWhy: null, prompt: "",
    uploads: [], room: 9, setPrompt: vi.fn(), setModel: vi.fn(), set: vi.fn(), addFrame: vi.fn(), removeFrame: vi.fn(), swapFrames: vi.fn(), addRefs: vi.fn(),
    toggleSaved: vi.fn(), toggleUpload: vi.fn(), addNfts: vi.fn(), dropSaved: vi.fn(), removeRef: vi.fn(), ...over,
  } as unknown as VideoDraft;
};
const frame = { id: "f", src: "data:f", kind: "image" as const };
// What the button that asked measured (no DOMRect outside a browser).
const RECT = { left: 10, top: 20, width: 30, height: 40 } as DOMRect;
const sub = (tree: ReactNode, id: string) => (pill(tree, "Model")!.props.options as Array<{ key: string; sub: string }>).find((o) => o.key === id)!.sub;
const drop = (files: File[] = []) => ({ preventDefault: vi.fn(), dataTransfer: { files } });
// The composer's parts in order, a fragment's own read in its place: a tag by its class, a kit component by itself.
const parts = (tree: ReactNode): unknown[] => ([(tree as El).props.children].flat() as unknown[]).filter(isValidElement)
  .flatMap((el) => ((el as El).type === Fragment ? parts(el as ReactNode) : [typeof (el as El).type === "string" ? (el as El).props.className : (el as El).type]));

let made: string[];
let revoked: string[];
beforeEach(() => {
  ui.state = []; ui.refs = []; ui.effects = []; ui.access = { userId: "u1" }; ui.rateOf = (id) => RATES[id];
  for (const fn of [ui.notify, ui.offset, ui.login, ui.push, ui.stash]) fn.mockClear();
  ui.read.mockReset(); ui.seconds.mockReset(); ui.library.mockReset().mockReturnValue(lib());
  made = []; revoked = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => { made.push(`blob:${made.length + 1}`); return made.at(-1)!; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((src: string) => { revoked.push(src); });
  // The draft outlives its composer (kept for its return): each test starts from a fresh one.
  forgetVideoDraft();
});
afterEach(() => { vi.restoreAllMocks(); });
// Away to Image or Remix and back, as React does it: the draft's effects run, it unmounts, and Video mounts anew.
const away = () => {
  draft();
  for (const leave of ui.effects.map((run) => run())) if (typeof leave === "function") leave();
  ui.state = []; ui.refs = [];
  return draft();
};

describe("the composer", () => {
  it("runs as Sume's: title, model card, the model's media, prompt, Include audio, the settings grid, Generate", () => {
    const sd = compose(fake());
    expect((sd as El).props.className).toBe("rx-compose vg-compose");
    expect(parts(sd)).toEqual(["rx-head", "vg-model", "rx-drop rx-drop--photos", "vg-note", "vg-prompt-head", AutosizeTextarea, "kit-field-check rx-prompt", VideoSettingsRow, "rx-foot"]);
    expect(parts(compose(fake("kling-4.0")))).toEqual(["rx-head", "vg-model", "vg-frames", "vg-note", "vg-prompt-head", AutosizeTextarea, "kit-field-check rx-prompt", VideoSettingsRow, "rx-foot"]);
    // Wan takes both, one at a time, and says so in the kept line.
    const wan = compose(fake("wan-3.0"));
    expect(parts(wan)).toEqual(["rx-head", "vg-model", "vg-frames", "rx-drop rx-drop--photos", "vg-note", "vg-prompt-head", AutosizeTextarea, "kit-field-check rx-prompt", VideoSettingsRow, "rx-foot"]);
    expect(text(byClass(byClass(wan, "vg-note")[0], "rx-hint")[0])).toBe("Frames or references, not both.");
    expect(ONE_SLOT).toBe("Frames or references, not both.");
  });

  it("shows the model on its card, and Change opens the six with their line and the price they would have now", () => {
    const tree = compose(fake("kling-3.0"));
    // Every model's name and line in one cell, only the picked one shown (Kev, 2026-10-30: "i also dont like how the UI
    // changes when selecting the video generators, as the text pushes it runter"): the card keeps the longest's height.
    const card = byClass(tree, "vg-model-text")[0];
    expect(card.props.className).toBe("vg-model-text rx-both");
    const pairs = byClass(card, "vg-model-pair");
    // The picked pair has no aria-hidden at all: "false" would still match .rx-both > [aria-hidden] and hide all six.
    expect(pairs.map((el) => [text(el), el.props["aria-hidden"]])).toStrictEqual(VIDEO_MODELS.map((m) => [`${m.label}${m.line}`, m.id === "kling-3.0" ? undefined : true]));
    const change = pill(tree, "Model")!;
    expect(text(change.props.trigger as ReactNode)).toBe("Change");
    expect(change.props.value).toBe("kling-3.0");
    expect((change.props.options as Array<{ key: string; label: string; desc: string; sub: string }>).map((o) => [o.key, o.label, o.sub]))
      .toEqual(VIDEO_MODELS.map((m) => [m.id, m.label, expect.any(String)]));
    // Kling 3.0's 4 s at 1080p with sound, carried to each: Omni prices its 10 s.
    expect((change.props.options as Array<{ sub: string }>).map((o) => o.sub)).toEqual(["$2.50", "$1.65", "$1.03", "$0.74", "$1.67", "$0.88"]);
    expect((change.props.options as Array<{ desc: string }>).map((o) => o.desc)).toEqual(VIDEO_MODELS.map((m) => m.line));
    // Seedance 2.5's 480p, which no Kling makes: each priced at its own resolution.
    expect((pill(compose(fake()), "Model")!.props.options as Array<{ sub: string }>).map((o) => o.sub)).toEqual(["$0.45", "$0.31", "$0.69", "$0.74", "$1.12", "$0.22"]);
    const d = fake();
    (pill(compose(d), "Model")!.props.onPick as (k: string) => void)("wan-3.0");
    expect(d.setModel).toHaveBeenCalledWith("wan-3.0");
    // Each priced from the buyer's picks, not from what this model forces: under Kling 4.0 (always with sound) a
    // silent Kling 3.0 is 4 s x $0.084 x 1.1.
    const k4 = fake("kling-4.0", { wanted: { ...startSettings(modelOf("kling-4.0")), audio: false } });
    expect(sub(compose(k4), "kling-3.0")).toBe("$0.37");
  });

  it("asks a frame model for a start and an end frame, each optional, and shows and removes what is in", () => {
    const d = fake("kling-4.0", { frames: { end: { id: "e", src: "data:end", kind: "image" } }, framesWhy: "Pick a PNG, JPEG or WebP image." });
    const tree = compose(d);
    expect(byClass(tree, "vg-frame").map((el) => text(el))).toEqual(["Start frameoptional", ""]);
    expect(all(tree).find((el) => el.props.className === "vg-frame-img")!.props).toMatchObject({ src: "data:end", alt: "End frame" });
    press(button(tree, "Remove the end frame"));
    expect(d.removeFrame).toHaveBeenCalledWith("end");
    expect(text(byClass(tree, "rx-why")[0])).toBe("Pick a PNG, JPEG or WebP image.");
    // The pick remembers which end asked.
    const click = vi.fn();
    ui.refs = [{ current: { click } }, { current: null }, { current: "start" }];
    const k = fake("kling-4.0");
    const fresh = compose(k);
    press(byClass(byClass(fresh, "vg-frame")[1], "rx-pick")[0]);
    expect([click.mock.calls.length, ui.refs[2].current]).toEqual([1, "end"]);
    // The device's picker offers pictures only, and is emptied after each pick so the same file can come again.
    const input = all(fresh).find((el) => el.type === "input" && el.props.type === "file" && !el.props.multiple)!;
    expect(input.props.accept).toBe("image/png,image/jpeg,image/webp");
    const pic = file("image/png");
    const target = { files: [pic], value: "C:\\fakepath\\a.png" };
    (input.props.onChange as (e: unknown) => void)({ currentTarget: target });
    expect(target.value).toBe("");
    expect(k.addFrame).toHaveBeenCalledWith("end", pic);
  });

  it("asks a reference model for media, marks what it cannot take, and removes a tile", () => {
    const refs = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, src: `s${i}`, kind: i === 3 ? "clip" : "image", seconds: 20 }));
    const d = fake("seedance-2.0", { refs: refs as VideoDraft["refs"] });
    const tree = compose(d);
    const tiles = byClass(tree, "kit-ref");
    expect(tiles.map((t) => t.props["data-over"] ?? false)).toEqual([false, false, false, true]);
    expect(all(tiles[3]).find((el) => el.type === "video")!.props).toMatchObject({ src: "s3", muted: true, autoPlay: true, playsInline: true, loop: true });
    expect(text(byClass(tiles[3], "kit-ref-label")[0])).toBe("20.0 s");
    expect(text(byClass(tree, "rx-why")[0])).toBe("Seedance 2.0 takes 9 images and 3 clips of 15 s in all: take 1 out.");
    press(button(tree, "Remove reference 2"));
    expect(d.removeRef).toHaveBeenCalledWith("r1");
    expect(text(byClass(compose(fake()), "rx-drop--photos")[0])).toBe("Add reference mediaImages or clips, optional");
  });

  it("closes frames while references are held under Wan, and the other way round", () => {
    const withRefs = compose(fake("wan-3.0", { refs: [{ id: "r", src: "s", kind: "image" }] }));
    expect(byClass(withRefs, "vg-frame").map((el) => byClass(el, "rx-pick")[0].props.disabled)).toEqual([true, true]);
    const withFrame = compose(fake("wan-3.0", { frames: { start: { id: "f", src: "s", kind: "image" } } }));
    expect(byClass(byClass(withFrame, "rx-drop--photos")[0], "rx-pick")[0].props.disabled).toBe(true);
    expect(byClass(byClass(compose(fake("wan-3.0")), "rx-drop--photos")[0], "rx-pick")[0].props.disabled).toBe(false);
    // The picker stays shut while a frame is held, though it was open.
    ui.state = [RECT];
    expect(of(compose(fake("wan-3.0", { frames: { start: frame } })), RefPicker)).toHaveLength(0);
    expect(of(compose(fake("wan-3.0")), RefPicker)).toHaveLength(1);
  });

  // Kev, 2026-10-30: "außerdem will bei bei video editors, wo start und end image drin sein darf, eine funktion haben, wo
  // ich start und end image responsively miteinander switchen kann".
  it("swaps the start and the end frame from a button between them, which slide in from the end they left", () => {
    const swapOf = (t: ReactNode) => button(t, "Swap start and end frame");
    // Every model that takes frames has it, inside the frames; none that does not.
    for (const id of ["kling-4.0", "kling-3.0", "omni-1.1-flash", "wan-3.0"]) expect(byClass(byClass(compose(fake(id)), "vg-frames")[0], "vg-swap"), id).toHaveLength(1);
    expect(byClass(compose(fake("seedance-2.0")), "vg-swap")).toHaveLength(0);
    // Shut with nothing to swap, a button the keyboard reaches with its name said.
    const empty = swapOf(compose(fake("kling-4.0")))!;
    expect(empty.props).toMatchObject({ type: "button", disabled: true, "aria-label": "Swap start and end frame", title: "Swap start and end frame" });
    expect(of(empty, ArrowLeftRight)[0].props["aria-hidden"]).toBe(true);
    const end = { id: "e", src: "data:end", kind: "image" as const };
    // One frame alone opens it, either one: it moves to the other end.
    expect([{ start: frame }, { end }].map((frames) => swapOf(compose(fake("kling-4.0", { frames })))!.props.disabled)).toEqual([false, false]);
    const d = fake("kling-4.0", { frames: { start: frame, end } });
    expect(swapOf(compose(d))!.props.disabled).toBe(false);
    expect(all(compose(d)).filter((el) => el.props.className === "vg-frame-img").map((el) => el.props["data-moved"] ?? null)).toEqual([null, null]);
    press(swapOf(compose(d)));
    expect(d.swapFrames).toHaveBeenCalledTimes(1);
    // As the draft answers it: each picture keyed by itself, so it mounts anew in its new place, marked with that place.
    const swapped = { ...d, frames: { start: end, end: frame } } as VideoDraft;
    const imgs = () => all(compose(swapped)).filter((el) => el.props.className === "vg-frame-img");
    expect(imgs().map((el) => [el.key, el.props.src, el.props.alt, el.props["data-moved"]]))
      .toEqual([["e", "data:end", "Start frame", "start"], ["f", "data:f", "End frame", "end"]]);
    // Each slides once: its mark goes as its slide ends, so a model switch out and back (the frames mounting anew) does
    // not replay it (review 2026-10-30).
    (imgs()[0].props.onAnimationEnd as () => void)();
    expect(imgs().map((el) => el.props["data-moved"] ?? null)).toEqual([null, "end"]);
    (imgs()[1].props.onAnimationEnd as () => void)();
    expect(imgs().map((el) => el.props["data-moved"] ?? null)).toEqual([null, null]);
    // One alone opens it too; a picture added later does not slide.
    const one = fake("kling-4.0", { frames: { end } });
    press(swapOf(compose(one)));
    const moved = compose({ ...one, frames: { start: end, end: { id: "n", src: "data:n", kind: "image" } } } as VideoDraft);
    expect(all(moved).filter((el) => el.props.className === "vg-frame-img").map((el) => el.props["data-moved"] ?? null)).toEqual(["start", null]);
  });

  it("keeps one line under the media for every model, saying one thing: a refusal, else the clip's price, else Wan's rule", () => {
    const note = (t: ReactNode) => byClass(t, "vg-note")[0];
    const said = (t: ReactNode) => all(note(t)).filter((el) => el.type === "p").map((el) => [el.props.className, el.props.role ?? null, text(el)]);
    for (const m of VIDEO_MODELS) expect(byClass(compose(fake(m.id)), "vg-note"), m.id).toHaveLength(1);
    expect(said(compose(fake("kling-4.0")))).toEqual([]);
    expect(said(compose(fake("wan-3.0")))).toEqual([["rx-hint", null, ONE_SLOT]]);
    const clip = { id: "c", src: "blob:c", kind: "clip" as const, seconds: 5 };
    expect(said(compose(fake("seedance-2.5", { refs: [clip] })))).toEqual([["rx-hint", null, CLIP_UNPRICED]]);
    // A refusal before either, as an alert; the frames' only where the model takes frames, the references' likewise.
    expect(said(compose(fake("wan-3.0", { framesWhy: "F", refsWhy: "R" })))).toEqual([["rx-why", "alert", "F"]]);
    expect(said(compose(fake("wan-3.0", { refsWhy: "R" })))).toEqual([["rx-why", "alert", "R"]]);
    expect(said(compose(fake("seedance-2.5", { framesWhy: "F", refs: [clip] })))).toEqual([["rx-hint", null, CLIP_UNPRICED]]);
    expect(said(compose(fake("kling-4.0", { refsWhy: "R" })))).toEqual([]);
    // What a model cannot take, before the clip's price.
    const refs = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, src: `s${i}`, kind: "clip" as const, seconds: 5 }));
    expect(said(compose(fake("seedance-2.0", { refs })))).toEqual([["rx-why", "alert", "Seedance 2.0 takes 9 images and 3 clips of 15 s in all: take 1 out."]]);
    expect(said(compose(fake("seedance-2.0", { refs, refsWhy: "R" })))).toEqual([["rx-why", "alert", "R"]]);
  });

  it("takes a dropped file only where its zone is open, and lets a drop happen on both zones", () => {
    const pic = file("image/png");
    const withRef = fake("wan-3.0", { refs: [{ id: "r", src: "s", kind: "image" }] });
    (byClass(compose(withRef), "vg-frame")[0].props.onDrop as (e: unknown) => void)(drop([pic]));
    const withFrame = fake("wan-3.0", { frames: { start: frame } });
    (byClass(compose(withFrame), "rx-drop--photos")[0].props.onDrop as (e: unknown) => void)(drop([pic]));
    expect([withRef.addFrame, withFrame.addRefs].map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([0, 0]);
    const open = fake("wan-3.0");
    (byClass(compose(open), "vg-frame")[1].props.onDrop as (e: unknown) => void)(drop([pic]));
    (byClass(compose(open), "rx-drop--photos")[0].props.onDrop as (e: unknown) => void)(drop([pic]));
    expect([(open.addFrame as ReturnType<typeof vi.fn>).mock.calls, (open.addRefs as ReturnType<typeof vi.fn>).mock.calls])
      .toEqual([[["end", pic]], [[[pic], expect.any(Function)]]]);
    // Without preventDefault on dragover the browser never lets a drop land.
    const over = ["vg-frames", "rx-drop--photos"].map((name) => {
      const e = drop();
      (byClass(compose(open), name)[0].props.onDragOver as (e: unknown) => void)(e);
      return e.preventDefault.mock.calls.length;
    });
    expect(over).toEqual([1, 1]);
  });

  // Kev, 2026-10-30: "pack diese popup ref was wir auch bei image UI haben wo man dann reference content character und
  // NFTs hat. hier werden aber ref content gespeichert bitte, mit X oben rechts löschbar".
  it("opens the image view's picker at the button that asked, on a phone as its sheet, and closes it", () => {
    const rect = RECT;
    for (const [label, d] of [["Add reference mediaImages or clips, optional", fake()], ["Add reference media", fake("seedance-2.5", { refs: [frame] })]] as const) {
      ui.state = [];
      const shut = compose(d);
      expect(of(shut, RefPicker)).toHaveLength(0);
      expect(button(shut, label)!.props).toMatchObject({ "aria-haspopup": "dialog", "aria-expanded": false });
      (button(shut, label)!.props.onClick as (e: unknown) => void)({ currentTarget: { getBoundingClientRect: () => rect } });
      const open = compose(d, { phone: true });
      expect(button(open, label)!.props["aria-expanded"]).toBe(true);
      const picker = of(open, RefPicker)[0];
      expect(picker.props).toMatchObject({ anchor: rect, phone: true, uploads: true });
      (picker.props.onClose as () => void)();
      expect(of(compose(d), RefPicker)).toHaveLength(0);
    }
  });

  it("hands the picker this visit's unsaved pictures, the saved ones with their deleted hashes, what is in, and the room", () => {
    const library = lib([{ id: "k1", url: "u1", src: "t1", hash: "h1" }], ["h0"]);
    const d = fake("seedance-2.5", {
      uploads: [{ id: "a", src: "sa", kind: "image" }, { id: "b", src: "sb", kind: "image", saved: "k1" }],
      refs: [{ id: "a", src: "sa", kind: "image" }, { id: "b", src: "sb", kind: "image", saved: "k1" }], room: 7,
    });
    ui.state = [RECT];
    const m = of(compose(d, { library }), RefPicker)[0].props.model as RefSource;
    expect(m).toMatchObject({ uploads: [{ id: "a", src: "sa" }], library: library.saved, deletedRefs: ["h0"], myImages: [], refs: [{ id: "a" }, { id: "k1" }], room: 7 });
    expect(m.uploads).toHaveLength(1);
  });

  it("switches a saved tile by the saved one and any other by this visit's picture; x deletes it everywhere; NFTs go in", () => {
    const library = lib([{ id: "k1", url: "u1", src: "t1", hash: "h1" }]);
    const d = fake();
    ui.state = [RECT];
    const m = of(compose(d, { library }), RefPicker)[0].props.model as RefSource;
    m.toggleRef("k1");
    m.toggleRef("a");
    expect([d.toggleSaved, d.toggleUpload].map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls)).toEqual([[[library.saved[0]]], [["a"]]]);
    m.deleteRef("k1");
    expect([(library.remove as ReturnType<typeof vi.fn>).mock.calls, (d.dropSaved as ReturnType<typeof vi.fn>).mock.calls]).toEqual([[["k1"]], [["k1"]]]);
    const picks = [{ image: "i", thumb: "t" }];
    m.addNfts(picks);
    expect(d.addNfts).toHaveBeenCalledWith(picks);
    // Upload is the device's picker, pictures and clips; what it picks is saved (the library's save goes with it).
    const click = vi.fn();
    ui.refs = [{ current: null }, { current: { click } }, { current: "start" }];
    (of(compose(d, { library }), RefPicker)[0].props.onUpload as () => void)();
    expect(click).toHaveBeenCalledTimes(1);
    const files = [file("image/png")];
    (all(compose(d, { library })).find((el) => el.type === "input" && el.props.multiple)!.props.onChange as (e: unknown) => void)({ currentTarget: { files, value: "x" } });
    expect(d.addRefs).toHaveBeenCalledWith(files, library.save);
  });

  it("asks a family's own question, and carries the words to Make it a prompt", () => {
    const onMakePrompt = vi.fn();
    const tree = compose(fake("kling-3.0"), { onMakePrompt });
    expect(of(tree, AutosizeTextarea)[0].props.placeholder).toBe("What video do you want to make?");
    // Taller, downwards (Kev, 2026-10-30: "vergrößere prompt editor nach unten"): 88 to 200 before.
    expect([of(tree, AutosizeTextarea)[0].props.min, of(tree, AutosizeTextarea)[0].props.max]).toEqual([148, 320]);
    // Sized by its foot's right corner (Kev, 2026-10-30: "bei videos unten rechts").
    expect(of(tree, AutosizeTextarea)[0].props.grip).toBe("down");
    expect(of(compose(fake()), AutosizeTextarea)[0].props.placeholder).toMatch(/^Describe the video/);
    press(button(tree, "Make it a prompt →"));
    expect(onMakePrompt).toHaveBeenCalledTimes(1);
  });

  it("lets the buyer switch sound where the model can, and shows it always on where it cannot", () => {
    const sw = (tree: ReactNode) => all(tree).find((el) => el.props.role === "switch")!;
    expect(sw(compose(fake("seedance-2.5"))).props).toMatchObject({ checked: true, disabled: false });
    expect(sw(compose(fake("kling-4.0"))).props).toMatchObject({ checked: true, disabled: true });
    const d = fake("kling-3.0");
    (sw(compose(d)).props.onChange as (e: unknown) => void)({ target: { checked: false } });
    expect(d.set).toHaveBeenCalledWith({ audio: false });
    // Wan 3.0 makes no sound from a frame ("bei Start/End aus"): off and shut while one is held; Kling 3.0 keeps its switch.
    const wan = compose(fake("wan-3.0", { frames: { start: frame }, settings: { ...startSettings(modelOf("wan-3.0")), audio: false } }));
    expect(sw(wan).props).toMatchObject({ checked: false, disabled: true });
    expect(byClass(wan, "kit-field-check")[0].props.title).toBe("Wan 3.0 makes no sound from frames");
    expect([sw(compose(fake("wan-3.0"))).props.disabled, sw(compose(fake("kling-3.0", { frames: { start: frame } }))).props.disabled]).toEqual([false, false]);
  });

  it("prices a held clip where the model bills its seconds, and says why there is no number where it cannot yet", () => {
    const clip = { id: "c", src: "blob:c", kind: "clip" as const, seconds: 10 };
    const settings = { ...startSettings(modelOf("wan-3.0")), seconds: 5 };
    // Wan 1080p, 5 s out and the 10 s clip in: (10 + 5) x $0.20 x 1.10 (review 2026-10-30: it showed $1.10).
    const wan = compose(fake("wan-3.0", { settings, refs: [clip] }));
    expect(of(wan, GenerateButton)[0].props.chip).toBe("$3.30");
    expect((pill(wan, "Resolution")!.props.options as Array<{ sub: string }>).map((o) => o.sub)).toEqual(["$0.83", "$1.65", "$3.30"]);
    // Each model in the picker with the clips it takes: Seedance's rate for a clip is not read, the Klings take none.
    expect(VIDEO_MODELS.map((m) => sub(wan, m.id))).toEqual(["…", "…", "$1.29", "$0.92", "$1.67", "$3.30"]);
    expect(byClass(wan, "rx-hint").map((el) => text(el))).toEqual(["Frames or references, not both."]);
    const sd = compose(fake("seedance-2.5", { refs: [clip] }));
    expect([of(sd, GenerateButton)[0].props.chip, byClass(sd, "rx-hint").map((el) => text(el))]).toEqual(["…", [CLIP_UNPRICED]]);
    const pics = compose(fake("seedance-2.5", { refs: [{ id: "p", src: "s", kind: "image" }] }));
    expect([of(pics, GenerateButton)[0].props.chip, byClass(pics, "rx-hint")]).toEqual(["$0.45", []]);
  });

  it("sets Length on a slider in the model's range (Omni: by the words), Aspect and Resolution by menu, Bitrate for Seedance", () => {
    const d = fake("kling-3.0");
    const tree = compose(d);
    // Length on its own row, Aspect, Resolution and Bitrate side by side under it (Kev, 2026-10-30: "bei video
    // generatoren, aspect ratio, resolution und bitrate kann in einer reihe platziert werden um platz zu sparen").
    const rowsOf = (t: ReactNode) => ([(byClass(t, "vg-rows")[0].props.children)].flat() as unknown[]).filter(isValidElement)
      .map((el) => [(el as El).props.className, [...byClass(el as El, "kit-label")].map((l) => text(l))]);
    expect(rowsOf(tree)).toEqual([["vg-row", ["Length"]], ["vg-set", ["Aspect", "Resolution"]]]);
    expect(rowsOf(compose(fake("seedance-2.0")))).toEqual([["vg-row", ["Length"]], ["vg-set", ["Aspect", "Resolution", "Bitrate"]]]);
    // Each in a cell of its own, its pill in it.
    expect(byClass(compose(fake("seedance-2.0")), "vg-cell").map((c) => of(c, PillMenu)[0].props.title)).toEqual(["Aspect", "Resolution", "Bitrate"]);
    const range = all(tree).find((el) => el.props.type === "range")!;
    expect(range.props).toMatchObject({ min: 3, max: 15, value: 4, "aria-labelledby": "len" });
    (range.props.onChange as (e: unknown) => void)({ target: { value: "9" } });
    expect(d.set).toHaveBeenCalledWith({ seconds: 9 });
    // Beside it the seconds, typed as a number in the same range: a text field, which no wheel steps (review 2026-10-30:
    // a number field's value moved under the wheel while it had focus, and the price with it), the phone's number pad.
    const num = all(tree).find((el) => el.props.inputMode === "numeric")!;
    expect([num.type, num.props]).toEqual(["input", expect.objectContaining({
      type: "text", value: 4, inputMode: "numeric", enterKeyHint: "done", "aria-label": "Length in seconds, 3 to 15",
    })]);
    expect(text(byClass(tree, "kit-field-num")[0])).toBe("s");
    expect(of(tree, PillMenu).map((el) => el.props.title)).toEqual(["Model", "Aspect", "Resolution"]);
    expect((pill(tree, "Aspect")!.props.options as Array<{ key: string }>).map((o) => o.key)).toEqual(["16:9", "9:16", "1:1"]);
    expect((pill(tree, "Resolution")!.props.options as Array<{ key: string; sub: string }>).map((o) => [o.key, o.sub])).toEqual([["720p", "$0.55"], ["1080p", "$0.74"]]);
    (pill(tree, "Resolution")!.props.onPick as (k: string) => void)("720p");
    expect(d.set).toHaveBeenCalledWith({ resolution: "720p" });
    const omni = compose(fake("omni-1.1-flash"));
    expect(all(omni).some((el) => el.props.type === "range" || el.props.inputMode === "numeric")).toBe(false);
    expect(text(byClass(omni, "vg-fixed")[0])).toBe("Up to 10 s, set by the words");
    const sd = compose(fake("seedance-2.0"));
    const bitrate = pill(sd, "Bitrate")!;
    expect((bitrate.props.options as Array<{ key: string; label: string; desc: string }>)).toEqual([
      { key: "high", label: "High", desc: "Less compression, a larger file" }, { key: "standard", label: "Standard", desc: "More compression, a smaller file" },
    ]);
    // The closed pill shows its value only; what it means is in the open menu (Kev, 2026-10-30: "remove the zusatz bei
    // bitrate ... zeig das nur beim dropdown").
    expect(text(bitrate.props.trigger as ReactNode)).toBe("High");
  });

  it("takes a typed length on Enter or on leaving the number, inside the model's range; Esc keeps the length", () => {
    const d = fake("kling-3.0");
    const num = () => all(compose(d)).find((el) => el.props.inputMode === "numeric")!.props as Record<string, (e?: unknown) => void>;
    const select = vi.fn();
    const blur = vi.fn();
    const typed = (value: string) => {
      num().onFocus({ currentTarget: { select } });
      num().onChange({ target: { value } });
    };
    // A click selects the seconds, so what is typed replaces them; the click's own mouseup would undo that.
    num().onFocus({ currentTarget: { select } });
    expect([select.mock.calls.length, num().value]).toEqual([1, "4"]);
    const up = { preventDefault: vi.fn() };
    num().onMouseUp(up);
    expect(up.preventDefault).toHaveBeenCalledTimes(1);
    num().onChange({ target: { value: "12" } });
    expect(num().value).toBe("12");
    num().onKeyDown({ key: "Enter", currentTarget: { blur } });
    expect(blur).toHaveBeenCalledTimes(1);
    num().onBlur();
    expect(d.set).toHaveBeenLastCalledWith({ seconds: 12 });
    expect(num().value).toBe(4);
    // Past the end: the end. Leaving it with Tab takes it too.
    typed("99");
    num().onBlur();
    expect(d.set).toHaveBeenLastCalledWith({ seconds: 15 });
    // Esc: nothing taken; the next visit, left with Tab, takes again.
    (d.set as ReturnType<typeof vi.fn>).mockClear();
    typed("7");
    num().onKeyDown({ key: "Escape", currentTarget: { blur } });
    expect(blur).toHaveBeenCalledTimes(2);
    num().onBlur();
    expect([(d.set as ReturnType<typeof vi.fn>).mock.calls.length, num().value]).toEqual([0, 4]);
    typed("6");
    num().onBlur();
    expect(d.set).toHaveBeenLastCalledWith({ seconds: 6 });
    // Any other key is typing; nothing typed keeps the length.
    num().onKeyDown({ key: "5", currentTarget: { blur } });
    expect(blur).toHaveBeenCalledTimes(2);
    (d.set as ReturnType<typeof vi.fn>).mockClear();
    typed("");
    num().onBlur();
    expect((d.set as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("gives each shape its use as the image pills do, and Auto where the model's docs offer it, at the same price", () => {
    const d = fake();
    const sd = compose(d);
    const aspect = pill(sd, "Aspect")!;
    const opts = aspect.props.options as Array<{ key: string; label: string; desc: string; icon: El }>;
    expect(opts.map((o) => [o.key, o.label, o.desc])).toEqual([
      ["16:9", "16:9", "Wide · YouTube, desktop screens"], ["9:16", "9:16", "Full phone screen · Instagram Stories, Reels, TikTok"],
      ["1:1", "1:1", "Square · Instagram feed, profile pictures"], ["21:9", "21:9", "Cinematic · film stills, website banners"],
      ["4:3", "4:3", "Landscape · tablets, presentation slides"], ["3:4", "3:4", "Portrait · classic photo prints"],
      ["auto", "Auto", "Auto · the model picks the shape to fit your media and words"],
    ]);
    expect(opts.map((o) => (o.icon.props.children as El).props.ratio)).toEqual(["16:9", "9:16", "1:1", "21:9", "4:3", "3:4", "auto"]);
    expect(aspect.props).toMatchObject({ columns: 1, sheetColumns: 2, sheetHint: "The shape of your video", ariaLabel: "Aspect 16:9" });
    expect(text(aspect.props.trigger as ReactNode)).toBe("16:9");
    (aspect.props.onPick as (k: string) => void)("auto");
    expect(d.set).toHaveBeenCalledWith({ aspect: "auto" });
    // Picked: the pill says Auto and what it does; Generate's price is 16:9's.
    const auto = compose(fake("seedance-2.5", { settings: { ...startSettings(modelOf("seedance-2.5")), aspect: "auto" } }));
    expect(pill(auto, "Aspect")!.props.ariaLabel).toBe("Aspect Auto");
    expect(text(pill(auto, "Aspect")!.props.trigger as ReactNode)).toBe("Auto");
    expect(of(auto, GenerateButton)[0].props.chip).toBe(of(sd, GenerateButton)[0].props.chip);
    // No Auto where the docs list none.
    expect((pill(compose(fake("kling-4.0")), "Aspect")!.props.options as Array<{ key: string }>).map((o) => o.key)).toEqual(["16:9", "9:16", "1:1", "21:9"]);
  });

  it("before SQL 68 every price reads \"…\", and a clip's line stands whatever the model", () => {
    ui.rateOf = () => null;
    const tree = compose(fake("wan-3.0"));
    expect(of(tree, GenerateButton)[0].props.chip).toBe("…");
    expect((pill(tree, "Resolution")!.props.options as Array<{ sub: string }>).map((o) => o.sub)).toEqual(["…", "…", "…"]);
    expect(VIDEO_MODELS.map((m) => sub(tree, m.id))).toEqual(Array(6).fill("…"));
    const clip = { id: "c", src: "blob:c", kind: "clip" as const, seconds: 5 };
    expect(byClass(compose(fake("wan-3.0", { refs: [clip] })), "rx-hint").map((el) => text(el))).toEqual([CLIP_UNPRICED]);
  });

  it("keeps Generate dimmed with the price on it and one honest line; its press says so; a guest logs in", () => {
    const tree = compose(fake("kling-3.0", { settings: { ...startSettings(modelOf("kling-3.0")), seconds: 10, resolution: "720p", audio: false } }));
    const gen = of(tree, GenerateButton)[0];
    expect(gen.props).toMatchObject({ label: "✦ Generate", chip: "$0.92", dimmed: true, size: "block" });
    expect(of(tree, CostLine)[0].props.left).toBe(VIDEO_NOT_AVAILABLE);
    expect(VIDEO_NOT_AVAILABLE).toBe("Not available yet.");
    (gen.props.onPress as () => void)();
    expect(ui.notify).toHaveBeenCalledWith(VIDEO_NOT_AVAILABLE);
    expect(ui.offset).toHaveBeenCalledWith(120);
    const guest = of(compose(fake(), { guest: true }), GenerateButton)[0];
    expect(guest.props).toMatchObject({ label: "Log in to generate", chip: null, dimmed: false });
    (guest.props.onPress as () => void)();
    expect([ui.login.mock.calls.length, ui.notify.mock.calls.length]).toEqual([1, 1]);
  });
});

describe("Generate with its operator set", () => {
  const run = () => ({ jobs: [], busy: false, press: vi.fn(async (_ask: VideoPress): Promise<string | null> => "job-1") });
  const open = () => { ui.rateOf = (id) => ({ ...RATES[id], available: ["480p", "720p", "1080p"] }); };
  const gen = (tree: ReactNode) => of(tree, GenerateButton)[0];
  const said = (tree: ReactNode) => of(tree, CostLine)[0].props.left;
  const pressed = async (tree: ReactNode) => { (gen(tree).props.onPress as () => void)(); await new Promise((r) => setTimeout(r, 0)); };
  const consentBox = (tree: ReactNode) => byClass(tree, "vg-consent")[0];
  const tick = (tree: ReactNode) => (of(consentBox(tree), "input")[0].props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  const REF = { id: "r", src: "data:r", kind: "image" as const, saved: "saved-r" };

  it("with no rate cell at this resolution it stays Not available, whichever operator", async () => {
    ui.rateOf = (id) => ({ ...RATES[id], available: ["720p"] });
    const r = run();
    const tree = compose(fake("seedance-2.5", { prompt: "rain" }), { run: r });
    expect(said(tree)).toBe(VIDEO_NOT_AVAILABLE);
    expect(gen(tree).props.dimmed).toBe(true);
    await pressed(tree);
    expect(ui.notify).toHaveBeenCalledWith(VIDEO_NOT_AVAILABLE);
    expect(r.press).not.toHaveBeenCalled();
  });

  it("no words: dimmed, said on the press, nothing sent", async () => {
    open();
    const r = run();
    const tree = compose(fake(), { run: r });
    expect(gen(tree).props.dimmed).toBe(true);
    expect(said(tree)).toBe("Write what the video shows first.");
    await pressed(tree);
    expect(r.press).not.toHaveBeenCalled();
  });

  it("words: lit, one press sends the model, its settings and the words, and no count of any kind", async () => {
    open();
    const r = run();
    const tree = compose(fake("seedance-2.5", { prompt: "  rain  " }), { run: r });
    expect(gen(tree).props.dimmed).toBe(false);
    expect(said(tree)).toBeNull();
    expect(consentBox(tree)).toBeUndefined();
    await pressed(tree);
    expect(r.press.mock.calls).toEqual([[{ modelId: "seedance-2.5", settings: startSettings(modelOf("seedance-2.5")), words: "rain" }]]);
    expect(JSON.stringify(r.press.mock.calls)).not.toContain("count");
  });

  it("while one goes out, dimmed", () => {
    open();
    expect(gen(compose(fake("seedance-2.5", { prompt: "rain" }), { run: { ...run(), busy: true } })).props.dimmed).toBe(true);
  });

  it("a reference held asks the box in Sume's words first; ticked, its saved id goes with the consent", async () => {
    open();
    const r = run();
    const d = fake("seedance-2.5", { prompt: "rain", refs: [REF] });
    let tree = compose(d, { run: r });
    expect(text(consentBox(tree))).toBe(VIDEO_CONSENT);
    expect(VIDEO_CONSENT).toBe("I am the person in this photo, or I have their permission");
    expect(said(tree)).toBe(VIDEO_CONSENT_REFUSED);
    await pressed(tree);
    expect(r.press).not.toHaveBeenCalled();
    tick(tree);
    tree = compose(d, { run: r });
    expect(gen(tree).props.dimmed).toBe(false);
    await pressed(tree);
    expect(r.press.mock.calls[0][0]).toMatchObject({ refs: ["saved-r"], consent: true });
  });

  it("a frame not saved yet is saved first, and goes by its id; Animate's full picture is read, not its tile", async () => {
    open();
    const r = run();
    const library = lib();
    library.save = vi.fn(async (image: string) => ({ id: `id-of-${image}` })) as never;
    ui.read.mockResolvedValue("data:full");
    const d = fake("kling-4.0", { prompt: "rain", frames: { start: frame, end: { id: "a", src: "thumb", url: "https://full", kind: "image" as const } } });
    const tree = compose(d, { run: r, library });
    tick(tree);
    await pressed(compose(d, { run: r, library }));
    await new Promise((done) => setTimeout(done, 0));
    expect(r.press.mock.calls[0][0]).toMatchObject({ frames: { start: "id-of-data:f", end: "id-of-data:full" }, consent: true });
    expect(ui.read).toHaveBeenCalledWith("https://full");
  });

  it("a picture that cannot be saved stops it, and says so", async () => {
    open();
    const r = run();
    const d = fake("kling-4.0", { prompt: "rain", frames: { start: frame } });
    tick(compose(d, { run: r }));
    await pressed(compose(d, { run: r }));
    await new Promise((done) => setTimeout(done, 0));
    expect(r.press).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("A picture could not be saved. Nothing was charged. Try again.", { tone: "error" });
  });

  it("a clip stays in the composer and blocks Generate with a sentence", async () => {
    open();
    const r = run();
    const clip = { id: "c", src: "blob:c", kind: "clip" as const, seconds: 5 };
    const tree = compose(fake("seedance-2.5", { prompt: "rain", refs: [clip] }), { run: r });
    expect(said(tree)).toBe(CLIPS_NOT_YET);
    expect(gen(tree).props.dimmed).toBe(true);
    await pressed(tree);
    expect(r.press).not.toHaveBeenCalled();
  });

  it("media this model does not take stays out of it", async () => {
    open();
    const r = run();
    // Frames held from before, under a model that takes references only.
    const tree = compose(fake("seedance-2.5", { prompt: "rain", frames: { start: frame } }), { run: r });
    expect(consentBox(tree)).toBeUndefined();
    await pressed(tree);
    expect(r.press.mock.calls[0][0]).not.toHaveProperty("frames");
    expect(r.press.mock.calls[0][0]).not.toHaveProperty("consent");
  });

  it("a guest logs in, whatever the operator", async () => {
    open();
    const r = run();
    const tree = compose(fake("seedance-2.5", { prompt: "rain" }), { guest: true, run: r });
    expect(gen(tree).props).toMatchObject({ dimmed: false, label: "Log in to generate" });
    expect(said(tree)).toBe(VIDEO_NOT_AVAILABLE);
    await pressed(tree);
    expect(ui.login).toHaveBeenCalled();
    expect(r.press).not.toHaveBeenCalled();
  });
});

describe("History's cards", () => {
  const job = (over: Partial<VideoJobView>): VideoJobView => ({ id: "j", status: "running", label: "Seedance 2.5", settings: {}, promptId: null, createdAt: "t", why: null, video: null, imageId: null, ...over });
  const FILES = { preview: "https://s/p.mp4", v720: "https://s/720.mp4", v1080: "https://s/1080.mp4", poster: "https://s/p.webp", width: 854, height: 480, durationMs: 4000 };

  it("under way: its spinner and the sentence", () => {
    const card = JobCard({ job: job({}) });
    expect(byClass(card, "kit-spinner")).toHaveLength(1);
    expect(text(card)).toContain(VIDEO_MAKING);
    expect(of(card, "video")).toEqual([]);
  });

  it("delivered: the player with its control and poster, the v720, in the file's own shape, never playing by itself", () => {
    const card = JobCard({ job: job({ status: "delivered", video: FILES }) });
    const v = of(card, "video")[0].props;
    expect(v).toMatchObject({ src: FILES.v720, poster: FILES.poster, controls: true, playsInline: true, preload: "none", style: { aspectRatio: "854 / 480" } });
    expect(v.autoPlay).toBeUndefined();
    expect(byClass(card, "kit-spinner")).toEqual([]);
    expect(text(card)).toBe("Seedance 2.5");
  });

  it("ended without one: its sentence, no player, no spinner", () => {
    const card = JobCard({ job: job({ status: "failed", why: "The video could not be made. Nothing was charged." }) });
    expect(text(card)).toContain("The video could not be made. Nothing was charged.");
    expect(of(card, "video")).toEqual([]);
    expect(byClass(card, "kit-spinner")).toEqual([]);
  });
});

describe("the draft", () => {
  it("opens on Seedance 2.5 at Sume's settings; a switch reads the buyer's picks into the new model's ranges", () => {
    let d = draft();
    expect([d.model.id, d.settings]).toEqual(["seedance-2.5", { seconds: 4, aspect: "16:9", resolution: "480p", audio: true, bitrate: "high" }]);
    d.set({ seconds: 25, aspect: "4:3", audio: false });
    d = draft();
    d.setModel("kling-3.0");
    d = draft();
    expect([d.model.id, d.settings]).toEqual(["kling-3.0", { seconds: 15, aspect: "16:9", resolution: "1080p", audio: false, bitrate: "high" }]);
    d.setModel("kling-4.0");
    d = draft();
    expect(d.settings).toMatchObject({ seconds: 25, audio: true, resolution: "720p" });
    // A setting out of the model's range lands inside it.
    d.set({ seconds: 99 });
    expect(draft().settings.seconds).toBe(30);
  });

  it("gives a model back the buyer's sound, resolution and aspect after a look at another (review 2026-10-30: the price more than doubled)", () => {
    const price = () => { const d = draft(); return videoPrice(d.model, RATES[d.model.id], d.settings); };
    draft().set({ aspect: "4:3", audio: false });
    draft().setModel("kling-4.0");
    expect(draft().settings).toMatchObject({ aspect: "16:9", resolution: "720p", audio: true });
    // A length set there changes only the length.
    draft().set({ seconds: 6 });
    draft().setModel("seedance-2.5");
    expect([draft().settings, price()]).toEqual([{ seconds: 6, aspect: "4:3", resolution: "480p", audio: false, bitrate: "high" }, "$0.68"]);
    draft().set({ seconds: 4 });
    // Kling 3.0 silent at 4 s 1080p, through Kling 4.0 and back: still silent, 4 x $0.112 x 1.1.
    draft().setModel("kling-3.0");
    draft().setModel("kling-4.0");
    draft().setModel("kling-3.0");
    expect([draft().settings.audio, price()]).toEqual([false, "$0.49"]);
  });

  it("is silent under Wan 3.0 while a frame is held, the buyer's sound back once it is out", async () => {
    ui.read.mockResolvedValue("data:frame");
    draft().setModel("wan-3.0");
    await draft().addFrame("end", file("image/png"));
    expect([draft().settings.audio, draft().wanted.audio]).toEqual([false, true]);
    draft().removeFrame("end");
    expect(draft().settings.audio).toBe(true);
    draft().setModel("kling-3.0");
    await draft().addFrame("start", file("image/png"));
    expect(draft().settings.audio).toBe(true);
  });

  it("puts a frame in once read, refuses a wrong file in a sentence, and takes one out", async () => {
    ui.read.mockResolvedValue("data:frame");
    let d = draft();
    await d.addFrame("start", file("image/png"));
    d = draft();
    expect(d.frames.start).toMatchObject({ src: "data:frame", kind: "image" });
    await d.addFrame("end", file("image/gif"));
    d = draft();
    expect([d.frames.end, d.framesWhy]).toEqual([undefined, "Pick a PNG, JPEG or WebP image."]);
    ui.read.mockResolvedValue(null);
    await d.addFrame("end", file("image/png"));
    expect(draft().framesWhy).toBe("This file could not be read. Try another.");
    ui.read.mockResolvedValue("data:end");
    await draft().addFrame("end", file("image/png"));
    expect([draft().frames.end?.src, draft().framesWhy]).toEqual(["data:end", null]);
    await draft().addFrame("end", file("image/gif"));
    draft().removeFrame("start");
    expect(draft()).toMatchObject({ frames: { start: undefined }, framesWhy: null });
  });

  it("reads pictures and clips into the references, keeps the pictures in the library, and refuses a clip past the seconds", async () => {
    ui.read.mockResolvedValue("data:pic");
    ui.seconds.mockResolvedValueOnce(20).mockResolvedValueOnce(12).mockRejectedValueOnce(new Error("no length"));
    const keep = vi.fn(async () => ({ id: "saved-1", url: "https://x/saved-1.webp" }));
    let d = draft();
    await d.addRefs([file("image/png"), file("video/mp4"), file("video/mp4")], keep);
    await Promise.resolve();
    d = draft();
    expect(d.refs.map((r) => [r.kind, r.src, r.seconds ?? null, r.saved ?? null, r.url ?? null])).toEqual([["image", "data:pic", null, "saved-1", "https://x/saved-1.webp"], ["clip", "blob:1", 20, null, null]]);
    expect(keep).toHaveBeenCalledWith("data:pic");
    // Seedance 2.5 takes 30 s of clips in all: 32 s is past it, and its URL goes.
    expect(d.refsWhy).toBe("Clips here add up to 30 s at most.");
    expect(revoked).toEqual(["blob:2"]);
    // An unreadable picture says so and stays out.
    ui.read.mockResolvedValueOnce(null);
    await draft().addRefs([file("image/webp")]);
    expect([draft().refsWhy, draft().refs.length]).toEqual(["This file could not be read. Try another.", 2]);
    // An unreadable clip says so and its URL goes; a clip taken out keeps its URL, for the picker's Uploads.
    await d.addRefs([file("video/mp4")]);
    expect(draft().refsWhy).toBe("This file could not be read. Try another.");
    d = draft();
    d.removeRef(d.refs[1].id);
    expect(revoked).toEqual(["blob:2", "blob:3"]);
    expect(draft().refs).toHaveLength(1);
    expect(draft().uploads.map((u) => [u.kind, u.src])).toEqual([["image", "data:pic"], ["clip", "blob:1"]]);
  });

  // Kev, 2026-10-30: "bei videos, instead of images, mach da Uploads, and also show videos there".
  it("keeps this visit's clips in the picker's Uploads, a switch out and back in within the clips' count and seconds", async () => {
    ui.seconds.mockResolvedValueOnce(12).mockResolvedValueOnce(10);
    await draft().addRefs([file("video/mp4"), file("video/mp4")]);
    let d = draft();
    expect(d.uploads.map((u) => [u.kind, u.seconds])).toEqual([["clip", 12], ["clip", 10]]);
    const [a, b] = d.uploads.map((u) => u.id);
    d.toggleUpload(a);
    expect(draft().refs.map((r) => r.id)).toEqual([b]);
    draft().toggleUpload(a);
    expect([draft().refs.map((r) => r.id), draft().refsWhy]).toEqual([[b, a], null]);
    // Seedance 2.0 takes 15 s of clips in all: with 10 held, the 12 s one does not come back, and says why.
    draft().setModel("seedance-2.0");
    draft().removeRef(a);
    draft().toggleUpload(a);
    d = draft();
    expect([d.refs.map((r) => r.id), d.refsWhy]).toEqual([[b], "Clips here add up to 15 s at most."]);
    // Past the model's clip count, the cap's own sentence.
    ui.seconds.mockResolvedValue(1);
    await draft().addRefs([file("video/mp4"), file("video/mp4"), file("video/mp4")]);
    const extra = draft().uploads.at(-1)!.id;
    draft().removeRef(extra);
    await draft().addRefs([file("video/mp4")]);
    draft().toggleUpload(extra);
    expect(draft().refsWhy).toBe("At most 9 images and 3 clips here.");
    expect(revoked).toEqual([]);
  });

  const saved = (i: number) => ({ id: `k${i}`, src: `t${i}`, url: `u${i}` });

  it("keeps this visit's pictures for the picker, marked once saved, a switch out and back in within the cap", async () => {
    ui.read.mockResolvedValue("data:pic");
    const keep = vi.fn(async () => ({ id: "saved-1", url: "u-saved" }));
    await draft().addRefs([file("image/png")], keep);
    await Promise.resolve();
    let d = draft();
    expect(d.uploads).toEqual([{ id: d.refs[0].id, src: "data:pic", kind: "image", saved: "saved-1", url: "u-saved" }]);
    const cap = modelOf("seedance-2.5").refs!.images;
    expect(d.room).toBe(cap - 1);
    // A clip takes no picture's place.
    ui.seconds.mockResolvedValueOnce(5);
    await draft().addRefs([file("video/mp4")]);
    expect([draft().refs.length, draft().room]).toEqual([2, cap - 1]);
    draft().removeRef(draft().refs[1].id);
    await draft().addRefs([file("image/png")]);
    d = draft();
    const id = d.refs[1].id;
    d.toggleUpload(id);
    d = draft();
    // Uploads: the first picture, the clip taken out, the second picture.
    expect([d.refs.length, d.uploads.length, d.room]).toEqual([1, 3, cap - 1]);
    d.toggleUpload(id);
    expect(draft().refs.map((r) => r.id)).toContain(id);
    // Back in only where the model has room.
    draft().toggleUpload(id);
    draft().setModel("kling-4.0");
    draft().toggleUpload(id);
    expect(draft().refs.map((r) => r.id)).not.toContain(id);
    expect(draft().room).toBeLessThanOrEqual(0);
  });

  it("reads NFTs into pictures within the cap, says so for one that cannot be read, and drops a deleted saved one everywhere", async () => {
    ui.read.mockResolvedValueOnce("data:nft").mockResolvedValueOnce(null);
    await draft().addNfts([{ image: "i1", thumb: "t1" }, { image: "i2", thumb: "t2" }]);
    let d = draft();
    expect(ui.read.mock.calls.map((c) => c[0])).toEqual([{ image: "i1", thumb: "t1" }, { image: "i2", thumb: "t2" }]);
    expect(d.refs.map((r) => [r.src, r.kind])).toEqual([["data:nft", "image"]]);
    expect(d.refsWhy).toBe("That NFT's image could not be read.");
    d.toggleSaved(saved(1));
    ui.read.mockResolvedValue("data:pic");
    await draft().addRefs([file("image/png")], vi.fn(async () => ({ id: "k1", url: "u1" })));
    await Promise.resolve();
    draft().dropSaved("k1");
    d = draft();
    expect(d.refs.map((r) => r.src)).toEqual(["data:nft"]);
    expect(d.uploads).toEqual([]);
  });


  it("a saved reference is a switch: in by its saved id with its full picture, out again; past the model's cap it is refused", () => {
    let d = draft();
    d.toggleSaved(saved(1));
    d = draft();
    expect(d.refs).toEqual([{ id: "k1", src: "t1", url: "u1", kind: "image", saved: "k1" }]);
    d.toggleSaved(saved(1));
    expect(draft().refs).toEqual([]);
    d = draft();
    d.setModel("seedance-2.0");
    for (let i = 0; i < 10; i++) draft().toggleSaved(saved(i));
    d = draft();
    expect([d.refs.length, d.refsWhy]).toEqual([9, "At most 9 images and 3 clips here."]);
  });

  it("lets each refusal go once it no longer holds: a saved one out, a good pick, a removal, a model switch", async () => {
    ui.read.mockResolvedValue("data:pic");
    draft().setModel("seedance-2.0");
    for (let i = 0; i < 10; i++) draft().toggleSaved(saved(i));
    draft().toggleSaved(saved(0));
    expect([draft().refs.length, draft().refsWhy]).toEqual([8, null]);
    await draft().addRefs([file("image/gif")]);
    expect(draft().refsWhy).toBe("Only PNG, JPEG or WebP images and MP4 or MOV clips of up to 200 MB.");
    await draft().addRefs([file("image/png")]);
    expect([draft().refs.length, draft().refsWhy]).toEqual([9, null]);
    await draft().addRefs([file("image/gif")]);
    draft().removeRef(draft().refs[0].id);
    expect([draft().refs.length, draft().refsWhy]).toEqual([8, null]);
    await draft().addRefs([file("image/gif")]);
    await draft().addFrame("start", file("image/gif"));
    expect([draft().refsWhy, draft().framesWhy].map(Boolean)).toEqual([true, true]);
    draft().setModel("wan-3.0");
    expect([draft().refsWhy, draft().framesWhy]).toEqual([null, null]);
  });

  describe("checks the caps again as each pick lands, a second pick made before the first is read", () => {
    let release!: () => void;
    beforeEach(() => {
      const gate = new Promise<void>((r) => { release = r; });
      ui.read.mockImplementation(async () => { await gate; return "data:x"; });
      ui.seconds.mockImplementation(async () => { await gate; return 10; });
    });

    it("9 + 1 pictures under Seedance 2.0 hold 9, and only those 9 are kept in the library", async () => {
      const keep = vi.fn(async () => null);
      draft().setModel("seedance-2.0");
      const pics = (n: number) => Array.from({ length: n }, () => file("image/png"));
      const picks = [draft().addRefs(pics(9), keep), draft().addRefs(pics(1), keep)];
      release();
      await Promise.all(picks);
      expect([draft().refs.length, draft().refsWhy, keep.mock.calls.length]).toEqual([9, "At most 9 images and 3 clips here.", 9]);
    });

    it("two 10 s clips against Seedance 2.0's 15 s hold one, and the other's URL goes", async () => {
      draft().setModel("seedance-2.0");
      const picks = [draft().addRefs([file("video/mp4")]), draft().addRefs([file("video/mp4")])];
      release();
      await Promise.all(picks);
      expect([draft().refs.map((r) => r.src), draft().refsWhy, revoked]).toEqual([["blob:1"], "Clips here add up to 15 s at most.", ["blob:2"]]);
    });

    it("a saved one switched in from the handler of a render before the pictures landed still counts them", async () => {
      draft().setModel("seedance-2.0");
      const before = draft();
      const pick = draft().addRefs(Array.from({ length: 9 }, () => file("image/png")));
      release();
      await pick;
      before.toggleSaved(saved(1));
      expect([draft().refs.length, draft().refsWhy]).toEqual([9, "At most 9 images and 3 clips here."]);
    });
  });

  // Kev, 2026-10-30: "Animate, wodurch es als reference image in den letzten video editor eingefügt wird, in den wo noch
  // was frei ist".
  describe("takes the picture Animate left, once, into the first free place", () => {
    let store: Map<string, string>;
    beforeEach(() => {
      store = new Map();
      vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    });
    afterEach(() => { vi.unstubAllGlobals(); });
    // The draft as it mounts: its effects run, then it is read again.
    const mount = () => { for (const run of ui.effects) run(); return draft(); };
    const PIC = { url: "https://x/full.webp", thumb: "https://x/tile.webp" };

    it("under the first model, Seedance 2.5, into the references: its tile shown, its full picture kept; a second run adds none", () => {
      draft();
      sendToVideo(PIC);
      let d = mount();
      expect(d.refs).toEqual([{ id: expect.any(String), src: PIC.thumb, url: PIC.url, kind: "image" }]);
      expect([d.frames, d.refsWhy, store.size]).toEqual([{}, null, 0]);
      // React's second run in development, or a reload: the hand-off is empty.
      d = mount();
      expect(d.refs).toHaveLength(1);
      // Nothing left: nothing taken.
      draft();
      expect(mount().refs).toHaveLength(1);
    });

    // Each Animate opens Video anew (review 2026-10-30: a Kling 4.0 draft with a start frame and words came back as an
    // empty Seedance 2.5, the picture a reference).
    it("meets the last video editor: a Kling 4.0 draft's free end frame, its words kept; with both held it stays out and says so", async () => {
      ui.read.mockResolvedValue("data:a");
      draft().setModel("kling-4.0");
      await draft().addFrame("start", file("image/png"));
      draft().setPrompt("a slow push-in");
      away();
      sendToVideo({ url: "u1" });
      let d = mount();
      // No tile of its own: the full picture shows.
      expect([d.model.id, d.frames.start?.src, d.frames.end, d.prompt, d.refs])
        .toEqual(["kling-4.0", "data:a", { id: expect.any(String), src: "u1", url: "u1", kind: "image" }, "a slow push-in", []]);
      away();
      sendToVideo({ url: "u2" });
      d = mount();
      expect([d.frames.start?.src, d.frames.end?.url, d.refs, d.framesWhy, d.refsWhy, store.size]).toEqual(["data:a", "u1", [], NO_FREE_PLACE, null, 0]);
      expect(NO_FREE_PLACE).toBe("No free place for the picture from Animate: take one out, then animate it again.");
      // As the sentence says: one out, Animate again, and it is in.
      d.removeFrame("start");
      away();
      sendToVideo({ url: "u3" });
      d = mount();
      expect([d.frames.start?.url, d.frames.end?.url, d.framesWhy]).toEqual(["u3", "u1", null]);
    });

    it("under Wan 3.0 a frame while references are not held, the references while they are; Wan stays silent with it in a frame", () => {
      draft().setModel("wan-3.0");
      draft();
      sendToVideo({ url: "w1" });
      let d = mount();
      expect([d.frames.start?.url, d.settings.audio]).toEqual(["w1", false]);
      d.removeFrame("start");
      draft().toggleSaved({ id: "k1", src: "t1", url: "u1" });
      draft();
      sendToVideo({ url: "w2" });
      d = mount();
      expect([d.frames, d.refs.map((r) => r.url)]).toEqual([{}, ["u1", "w2"]]);
    });

    it("under a reference model whose pictures are full, it stays out and says so beside the references", () => {
      draft().setModel("seedance-2.0");
      for (let i = 0; i < 9; i++) draft().toggleSaved({ id: `k${i}`, src: `t${i}`, url: `u${i}` });
      draft();
      sendToVideo(PIC);
      const d = mount();
      expect([d.refs.length, d.refsWhy, d.framesWhy]).toEqual([9, NO_FREE_PLACE, null]);
    });
  });

  it("swaps the start and the end frame; one alone moves to the other end; Wan stays silent through it", async () => {
    ui.read.mockResolvedValueOnce("data:a").mockResolvedValueOnce("data:b");
    draft().setModel("wan-3.0");
    await draft().addFrame("start", file("image/png"));
    draft().swapFrames();
    let d = draft();
    expect([d.frames.start, d.frames.end?.src, d.settings.audio]).toEqual([undefined, "data:a", false]);
    await d.addFrame("start", file("image/png"));
    draft().swapFrames();
    d = draft();
    expect([d.frames.start?.src, d.frames.end?.src, d.settings.audio]).toEqual(["data:a", "data:b", false]);
    // A refusal said before still holds.
    await draft().addFrame("end", file("image/gif"));
    draft().swapFrames();
    expect([draft().frames.start?.src, draft().framesWhy]).toEqual(["data:b", "Pick a PNG, JPEG or WebP image."]);
  });

  // Review 2026-10-30: Create's tool switch mounts Video anew (CreateView), which threw the draft away.
  it("comes back as it was left after Image or Remix, clips playing; a clip taken out stays in Uploads, its URL kept", async () => {
    ui.read.mockResolvedValue("data:p");
    ui.seconds.mockResolvedValue(5);
    draft().set({ seconds: 7, resolution: "720p" });
    await draft().addRefs([file("image/png"), file("video/mp4")]);
    draft().setPrompt("rain on neon");
    let d = away();
    expect([d.model.id, d.wanted.seconds, d.settings.resolution, d.refs.map((r) => r.src), d.uploads.map((u) => u.src), d.prompt, revoked])
      .toEqual(["seedance-2.5", 7, "720p", ["data:p", "blob:1"], ["data:p", "blob:1"], "rain on neon", []]);
    // Counted with what came back: one more picture joins them.
    d.toggleSaved({ id: "k", src: "t", url: "u" });
    d = draft();
    expect(d.refs.map((r) => r.src)).toEqual(["data:p", "blob:1", "t"]);
    d.removeRef(d.refs[1].id);
    expect([revoked, away().uploads.map((u) => u.src)]).toEqual([[], ["data:p", "blob:1"]]);
    // A model switch is kept too.
    draft().setModel("wan-3.0");
    expect(away().model.id).toBe("wan-3.0");
  });
});

describe("the view", () => {
  const view = (guest = false) => {
    ui.s = 0; ui.r = 0;
    return VideoView({ guest }) as ReactNode;
  };

  it("sets the composer beside History | How it works, History empty until videos are made", () => {
    const tree = view();
    expect((tree as El).props.className).toBe("rx vg");
    expect(of(tree, VideoComposer)).toHaveLength(1);
    const tabs = of(tree, Segmented)[0];
    // Gliding as Create's and Explore's rows do (Kev, 2026-10-30: "switch between history und how it works must be as
    // responsive as between the other pills").
    expect(tabs.props).toMatchObject({ role: "tablist", slide: true, value: "history" });
    expect((tabs.props.options as Array<{ label: string }>).map((o) => o.label)).toEqual(["History", "How it works"]);
    expect(text(byClass(tree, "rx-empty")[0])).toBe("No videos yet.The videos you make show up here.");
    (tabs.props.onChange as (k: string) => void)("how");
    const how = view();
    expect(byClass(how, "vg-how-card").map((el) => text(byClass(el, "kit-title")[0]))).toEqual(["Add a frame or a reference", "Pick a model", "Get your video"]);
    expect(byClass(how, "rx-empty")).toHaveLength(0);
  });

  it("sets How it works three in a row where each card has 220 px, else one under the other, a phone included", () => {
    const css = readFileSync(join(__dirname, "..", "..", "..", "components", "create", "video", "video.css"), "utf8");
    // Measured on the area, not the window: the menu beside it changes width with the window (review 2026-10-30: two and
    // one left alone at 1024 px).
    expect(css).toContain(".vg .rx-lib { container-type: inline-size; }");
    expect(css).toContain(".vg-how { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px;");
    expect(css).toContain("@container (min-width: 692px) { .vg-how { grid-template-columns: repeat(3, minmax(0, 1fr)); } }");
    expect(css).not.toMatch(/auto-fit|auto-fill/);
  });

  it("ends How it works on a picture that opens Explore on Videos, in the app on a plain click", () => {
    vi.stubGlobal("window", { scrollTo: vi.fn() });
    expect(byClass(view(), "vg-inspire")).toHaveLength(0);
    (of(view(), Segmented)[0].props.onChange as (k: string) => void)("how");
    const link = byClass(view(), "vg-inspire")[0];
    expect(EXPLORE_VIDEOS).toBe("/home?media=videos");
    expect([link.type, link.props.href]).toEqual(["a", EXPLORE_VIDEOS]);
    expect(text(link)).toBe("Don't know what to create?Get inspired by our creators →");
    expect(all(link).find((el) => el.type === "img")!.props).toMatchObject({ src: "/previews/crystal-purple.webp", alt: "", loading: "lazy" });
    const click = (over = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), ...over });
    const plain = click();
    (link.props.onClick as (e: unknown) => void)(plain);
    expect(plain.preventDefault).toHaveBeenCalledTimes(1);
    expect(ui.push).toHaveBeenCalledWith("/home?media=videos", { scroll: false });
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
    // A new tab, a new window, a download or a middle click: the browser's, as for any link.
    ui.push.mockClear();
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const e = click(over);
      (link.props.onClick as (e: unknown) => void)(e);
      expect(e.preventDefault, JSON.stringify(over)).not.toHaveBeenCalled();
    }
    expect(ui.push).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  describe("the stylesheet", () => {
    const css = readFileSync(join(__dirname, "..", "..", "..", "components", "create", "video", "video.css"), "utf8").split("\r\n").join("\n");

    it("widens the column from Remix's 320 to 384 where the window has room", () => {
      expect(css).toContain(".vg { --rx-col: clamp(320px, 30vw, 384px); }");
    });

    it("sets Length on its own row and the three side by side in equal cells, each pill cut short inside its cell", () => {
      expect(css).toContain(".vg-row { display: grid; grid-template-columns: 88px minmax(0, 1fr); align-items: center; gap: 10px; min-height: 36px; }");
      // Two or three equal cells, never wrapping: one row on a phone too (no media query touches it).
      expect(css).toContain(".vg-set { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 8px; }");
      expect(css).not.toMatch(/@media[^{]*\{[^@]*\.vg-set \{/);
      expect(css).toContain(".vg-cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; }");
      expect(css).toMatch(/\.vg-set \.kit-pill \{[^}]*width: 100%; min-width: 0; overflow: hidden;/);
      // The value and its use line shrink with an ellipsis, the use line first; the caret stays.
      expect(css).toContain(".vg-set .kit-pill > span:not(.kit-caret) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }");
      expect(css).toContain(".vg-set .kit-caret { margin-left: auto; }");
      expect(css).not.toContain(".vg-pill-line");
      // Omni's fixed line as tall as the slider's row on a touch screen (bench 2026-10-30: 8 px shorter on a phone).
      expect(css).toMatch(/@media \(pointer: coarse\) \{\n  \.vg-row \{ min-height: 44px; \}/);
    });

    it("keeps the card, the line under the media and the media themselves as tall across the models", () => {
      expect(css).toContain(".vg-model-text { display: grid; gap: 2px; flex: 1; min-width: 0; }");
      expect(css).toContain(".vg-note { min-height: calc(2 * 1.45 * 12px); margin-top: -4px; font-size: 12px; line-height: 1.45; flex-shrink: 0; }");
      expect(css).toContain(".vg-note > p { margin: 0; line-height: inherit; }");
      // Held references as tall as the frames, 104 px less the zone's 12 px padding twice, in one row for any count that
      // scrolls sideways, Add kept in sight at its end (review 2026-10-30: a second row from five moved the prompt 32 px).
      expect(css).toContain(".vg .rx-photos { flex-wrap: nowrap; align-items: center; min-height: 80px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }");
      expect(css).toContain(".vg .rx-photos .kit-ref-add { position: sticky; right: 0; background: var(--enki-paper-2); }");
      expect(css).toContain(".vg-pick { min-height: 104px; }");
    });

    it("sets the swap on the gap between the frames, the pictures sliding in from the end they left, still where motion is reduced", () => {
      expect(css).toContain(".vg-frames { position: relative;");
      expect(css).toMatch(/\.vg-swap \{\n  position: absolute; left: 50%; top: 50%; z-index: 1; translate: -50% -50%;/);
      // Shut, it lets presses through to the picker under it; on a touch screen its 44 px box clears the start frame's x
      // (review 2026-10-30: a click 10 px into an empty picker opened nothing; a tap meant for x swapped).
      expect(css).toContain(".vg-swap:disabled { opacity: 0.45; pointer-events: none; }");
      expect(css).toContain("@media (pointer: coarse) { .vg-swap { top: calc(50% + 10px); } }");
      expect(css).toContain(".vg-frame-img[data-moved] { animation: vg-swap-in 0.24s cubic-bezier(0.2, 0.8, 0.2, 1); }");
      expect(css).toContain('.vg-frame-img[data-moved="start"] { --vg-from: 36%; }');
      expect(css).toContain('.vg-frame-img[data-moved="end"] { --vg-from: -36%; }');
      expect(css).toContain("@keyframes vg-swap-in { from { transform: translateX(var(--vg-from)); opacity: 0.35; } }");
    });

    it("shows where the seconds are typed: a rule under them, a full border while typing; a thumb's 44 px on a touch screen", () => {
      expect(css).toMatch(/\.vg-len-num input \{[^}]*border: 1px solid transparent; border-bottom-color: var\(--enki-rule\);/);
      expect(css).toContain(".vg-len-num input:focus { border-color: var(--enki-ink-2); border-radius: 6px; outline: none; }");
      // 16 px so iOS does not zoom in; 44 px wide and high (review 2026-10-30: 41 x 40, a tap landed on the slider).
      expect(css).toContain("@media (pointer: coarse) {\n  .vg-row { min-height: 44px; }\n  .vg-len-num { min-width: 44px; }\n  .vg-len-num input { height: 44px; font-size: 16px; }\n}");
    });

    it("spans How it works' three steps across the area, the words larger", () => {
      // Larger again (Kev, 2026-10-30: "even further"): 40 / 21 px, 30 / 18 px on a phone.
      expect(css).toMatch(/\.vg-how-card h3 \{ margin: 0; font-size: 40px;/);
      expect(css).toMatch(/\.vg-how-card p \{ margin: 0; font-size: 21px;/);
      expect(css).toMatch(/@media \(max-width: 767\.98px\) \{[^@]*\.vg-how-card h3 \{ font-size: 30px; \}\n  \.vg-how-card p \{ font-size: 18px; \}/);
    });

    it("keeps the link's words on top of its picture and readable over it, the picture still where motion is reduced", () => {
      // The picture under everything, the darkening between it and the words, in the link's own layer.
      expect(css).toMatch(/\.vg-inspire \{\n  position: relative; isolation: isolate;/);
      expect(css).toContain(".vg-inspire-img { position: absolute; inset: 0; z-index: -2; width: 100%; height: 100%; object-fit: cover;");
      expect(css).toMatch(/\.vg-inspire::before \{\n  content: ""; position: absolute; inset: 0; z-index: -1;\n  background: linear-gradient\(90deg, color-mix\(in oklab, var\(--enki-stage\) 88%, transparent\) 0%/);
      expect(css).toContain(".vg-inspire .kit-title { max-width: 18ch; color: inherit; font-size: 32px;");
      expect(css).toContain("@media (prefers-reduced-motion: reduce) {\n  .vg-inspire-img { transition: none; }\n  .vg-frame-img[data-moved] { animation: none; }\n}");
    });
  });

  it("hands a guest the picture from Animate too", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    view(true);
    sendToVideo({ url: "g1", thumb: "g1t" });
    for (const run of ui.effects) run();
    expect((of(view(true), VideoComposer)[0].props.d as VideoDraft).refs.map((r) => [r.src, r.url])).toEqual([["g1t", "g1"]]);
    vi.unstubAllGlobals();
  });

  it("reads the saved references only for an account, and hands them to the composer", () => {
    const library = lib([{ id: "k", url: "u", src: "t", hash: "h" }]);
    ui.library.mockReturnValue(library);
    expect(of(view(), VideoComposer)[0].props).toMatchObject({ library, phone: false });
    expect(ui.library.mock.calls.map((c) => c[0])).toEqual([true]);
    view(true);
    expect(ui.library.mock.calls.at(-1)![0]).toBe(false);
    // On a phone the picker is a sheet.
    ui.phone = true;
    expect(of(view(), VideoComposer)[0].props.phone).toBe(true);
    ui.phone = false;
  });

  it("Make it a prompt carries the words to the editor as Quick Create does; a guest signs in first", () => {
    view();
    // The draft's words (its seventh state).
    ui.state[6] = "a slow push-in on a rainy street at night, neon";
    (of(view(), VideoComposer)[0].props.onMakePrompt as () => void)();
    expect(ui.stash).toHaveBeenCalledWith({ kind: "library", title: "a slow push-in on a rainy", promptText: "a slow push-in on a rainy street at night, neon", media: "video" }, "u1");
    expect(ui.stash.mock.invocationCallOrder[0]).toBeLessThan(ui.push.mock.invocationCallOrder[0]);
    expect(ui.push).toHaveBeenCalledWith("/editor");
    ui.stash.mockClear(); ui.push.mockClear();
    (of(view(true), VideoComposer)[0].props.onMakePrompt as () => void)();
    expect([ui.login.mock.calls.length, ui.stash.mock.calls.length, ui.push.mock.calls.length]).toEqual([1, 0, 0]);
  });
});
