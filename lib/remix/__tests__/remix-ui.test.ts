import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * The Remix world (Kev, 2026-10-30: "do you see the UI of sume? we need EXACTLY the same one, slightly angepasst an
 * unsere UI aber ... bei Remix kommt dann diese UI"; "ok erstmal keine styles"): the composer, its draft, a card's
 * Recreate, and the phone column. The components are called with their state set, as React would render them.
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, refs: [] as { current: unknown }[], r: 0, effects: [] as (() => (() => void) | void)[],
  deps: [] as unknown[], notify: vi.fn(), offset: vi.fn(), login: vi.fn(), seconds: vi.fn(),
  lists: { mine: [] as unknown[], examples: [] as unknown[] },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
  useRef: <T>(start: T) => {
    const i = ui.r++;
    ui.refs[i] ??= { current: start };
    return ui.refs[i];
  },
  // Each effect and the deps it runs again on, as React was handed them.
  useEffect: (run: () => (() => void) | void, deps?: unknown[]) => { ui.effects.push(run); ui.deps.push(deps); },
}));
vi.mock("@/components/kit/notify", () => ({ notify: ui.notify, useToastOffset: ui.offset }));
vi.mock("@/lib/openLogin", () => ({ openLogin: ui.login }));
vi.mock("@/lib/remix/inputs", async (original) => ({ ...(await original<typeof import("@/lib/remix/inputs")>()), readSeconds: ui.seconds }));
vi.mock("@/lib/remix/library", () => ({ MY_REMIXES: ui.lists.mine, REMIX_EXAMPLES: ui.lists.examples }));

import RemixComposer, { REMIX_SOON } from "@/components/remix/RemixComposer";
import RemixCard from "@/components/remix/RemixCard";
import RemixView from "@/components/remix/RemixView";
// Called outside React on purpose, its hooks answered by the mocks above.
import { useRemixDraft as runDraft, type RemixDraft } from "@/components/remix/useRemixDraft";
import AutosizeTextarea from "@/components/kit/AutosizeTextarea";
import CostLine from "@/components/kit/CostLine";
import GenerateButton from "@/components/kit/GenerateButton";
import PillMenu from "@/components/kit/PillMenu";
import Segmented from "@/components/kit/Segmented";
import { CLIP_MAX_BYTES } from "@/lib/remix/inputs";
import { REMIX_MODES } from "@/lib/remix/modes";
import type { RemixCardData } from "@/lib/remix/library";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const all = (tree: ReactNode) => [...walk(tree)];
const of = (tree: ReactNode, type: unknown) => all(tree).filter((el) => el.type === type);
const byClass = (tree: ReactNode, name: string) => all(tree).filter((el) => String(el.props.className ?? "").split(" ").includes(name));
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("") : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);
const button = (tree: ReactNode, label: string) => all(tree).find((el) => el.type === "button" && (el.props["aria-label"] === label || text(el) === label));
const press = (el: El | undefined) => (el!.props.onClick as () => void)();

const CARD: RemixCardData = { id: "c1", mode: "swap", title: "Cat on a skateboard", clip: "https://cdn.example/clip.mp4", seconds: 10 };
const file = (type: string, name = "a", size = 10) => ({ type, name, size }) as File;

// The draft as the hook returns it, its state kept across draws.
const draft = () => {
  ui.s = 0; ui.r = 0; ui.effects = []; ui.deps = [];
  return runDraft();
};
// An x pressed in a zone whose buttons, once the tile is out, are `after`: what was focused before React drew the
// change, and after.
const pressX = (el: El | undefined, after: string[]) => {
  const buttons = after.map((name) => ({ name, focus: vi.fn() }));
  const zone = { querySelectorAll: (sel: string) => (sel === "button" ? buttons : []) };
  (el!.props.onClick as (e: unknown) => void)({ currentTarget: { closest: (sel: string) => (sel === ".rx-drop" ? zone : null) } });
  const focused = () => buttons.filter((b) => b.focus.mock.calls.length > 0).map((b) => b.name);
  const before = focused();
  vi.runAllTimers();
  return [before, focused()];
};
const compose = (d: RemixDraft, guest = false) => {
  ui.r = 0;
  return RemixComposer({ d, guest }) as ReactNode;
};
// A draft with what one test needs, its handlers spies.
const fake = (over: Partial<RemixDraft> = {}) => ({
  mode: "motion", clip: null, clipWhy: null, photos: [], photoWhy: null, promptOn: false, prompt: "", resolution: "720p",
  setMode: vi.fn(), setPromptOn: vi.fn(), setPrompt: vi.fn(), setResolution: vi.fn(), addClip: vi.fn(), addPhotos: vi.fn(),
  removePhoto: vi.fn(), removeClip: vi.fn(), recreate: vi.fn(), ...over,
}) as unknown as RemixDraft;

let made: string[];
let revoked: string[];
beforeEach(() => {
  ui.state = []; ui.refs = []; ui.effects = []; ui.lists.mine.length = 0; ui.lists.examples.length = 0;
  ui.notify.mockClear(); ui.offset.mockClear(); ui.login.mockClear(); ui.seconds.mockReset();
  made = []; revoked = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => { made.push(`blob:${made.length + 1}`); return made.at(-1)!; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((src: string) => { revoked.push(src); });
  vi.stubGlobal("window", { scrollTo: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

// What a reader gets: the other mode's words, there only to hold their space, left out.
const seen = (node: ReactNode): string => Array.isArray(node) ? node.map(seen).join("")
  : isValidElement<{ children?: ReactNode; "aria-hidden"?: boolean }>(node) ? (node.props["aria-hidden"] ? "" : seen(node.props.children))
    : node == null || typeof node === "boolean" ? "" : String(node);

describe("the composer", () => {
  it("runs top to bottom: title, mode, clip, photos, hint, prompt, model and resolution, Generate; no style row", () => {
    const aside = compose(fake()) as El;
    expect(aside.props.className).toBe("rx-compose");
    const parts = ([aside.props.children].flat() as unknown[]).filter(isValidElement) as El[];
    expect(parts.map((el) => el.props.className)).toEqual(["rx-head", "rx-modes", "rx-drop", "rx-drop rx-drop--photos", "rx-hint rx-both", "kit-field-check rx-prompt", "rx-bar", "rx-foot"]);
    expect(all(aside).some((el) => /style/i.test(text(el.props.children as ReactNode)) && el.type !== "aside")).toBe(false);
  });

  it("says what each mode does, names its photos, and switches between the two", () => {
    const motion = compose(fake());
    expect(seen(byClass(motion, "rx-head")[0])).toBe("RemixYour photos move the way the clip moves.");
    expect(text(byClass(motion, "rx-drop--photos")[0])).toBe("Add person photo(1-8)");
    expect(seen(byClass(motion, "rx-hint")[0])).toBe("A 4-15 s clip and 1-8 photos that move like it. The prompt is optional.");
    const swap = compose(fake({ mode: "swap" }));
    expect(seen(byClass(swap, "rx-head")[0])).toBe("RemixPeople or things in the clip become the ones in your photos.");
    expect(text(byClass(swap, "rx-drop--photos")[0])).toBe("Add reference image(1-8)");
    expect(seen(byClass(swap, "rx-hint")[0])).toBe("A 4-15 s clip and 1-8 photos that take the place of people or things in it. The prompt is optional.");
    const d = fake();
    const seg = of(compose(d), Segmented)[0];
    expect(seg.props).toMatchObject({ role: "radiogroup", slide: true, value: "motion", onChange: d.setMode });
    expect((seg.props.options as Array<{ label: string }>).map((o) => o.label)).toEqual(["Motion transfer", "Object swap"]);
  });

  // Kev, 2026-10-30: "beim swappen von motion transfer zu object swap soll sich die oberfläche drunter nicht bewegen bitte".
  it("holds both modes' line and hint in one place, the other mode's hidden, so a switch moves nothing below", () => {
    for (const mode of ["motion", "swap"] as const) {
      const tree = compose(fake({ mode }));
      for (const cell of [byClass(byClass(tree, "rx-head")[0], "rx-both")[0], byClass(tree, "rx-hint")[0]]) {
        expect(cell.props.className).toMatch(/\brx-both\b/);
        const spans = [cell.props.children].flat() as El[];
        expect(spans.map((s) => [s.key, s.props["aria-hidden"] ?? false])).toEqual([["motion", mode !== "motion"], ["swap", mode !== "swap"]]);
      }
      expect(text(byClass(tree, "rx-hint")[0])).toBe(`${REMIX_MODES.motion.hint}${REMIX_MODES.swap.hint}`);
    }
    const css = readFileSync(join(__dirname, "..", "..", "..", "components", "remix", "remix.css"), "utf8").split("\r\n").join("\n");
    expect(css).toContain(".rx-both { display: grid; }\n.rx-both > * { grid-area: 1 / 1; }\n.rx-both > [aria-hidden] { visibility: hidden; }");
  });

  it("asks for a 4 to 15 s MP4 or MOV, from the picker or a drop", () => {
    const d = fake();
    const tree = compose(d);
    const zone = byClass(tree, "rx-drop")[0];
    expect(text(zone)).toBe("Add video4 to 15 seconds");
    const input = all(zone).find((el) => el.type === "input")!;
    expect(input.props).toMatchObject({ type: "file", accept: "video/mp4,video/quicktime", hidden: true });
    expect(input.props.multiple).toBeUndefined();
    const click = vi.fn();
    ui.refs[0].current = { click };
    press(button(tree, "Add video4 to 15 seconds"));
    expect(click).toHaveBeenCalledOnce();
    const picked = file("video/mp4", "a.mp4");
    const target = { files: [picked], value: "C:\\a.mp4" };
    (input.props.onChange as (e: unknown) => void)({ currentTarget: target });
    expect(d.addClip).toHaveBeenLastCalledWith(picked);
    expect(target.value).toBe("");
    const dropped = file("video/quicktime", "b.mov");
    const prevent = vi.fn();
    (zone.props.onDrop as (e: unknown) => void)({ preventDefault: prevent, dataTransfer: { files: [dropped] } });
    expect(d.addClip).toHaveBeenLastCalledWith(dropped);
    expect(prevent).toHaveBeenCalled();
    // A browser fires drop only on a zone whose dragover was prevented; else it opens the file and leaves the page.
    const over = vi.fn();
    (zone.props.onDragOver as (e: unknown) => void)({ preventDefault: over });
    expect(over).toHaveBeenCalledOnce();
  });

  it("once a clip is in, shows it muted and looping with its length, and an x that takes it out", () => {
    const d = fake({ clip: { src: "blob:1", seconds: 7.43 } });
    const zone = byClass(compose(d), "rx-drop")[0];
    expect(zone.props["data-filled"]).toBe(true);
    const video = all(zone).find((el) => el.type === "video")!;
    expect(video.props).toMatchObject({ src: "blob:1", muted: true, loop: true, playsInline: true, autoPlay: true });
    expect(text(byClass(zone, "rx-len")[0])).toBe("7.4 s");
    expect(button(zone, "Add video4 to 15 seconds")).toBeUndefined();
    vi.useFakeTimers();
    // Focus goes to Add video, which takes the x's place, once it is drawn.
    expect(pressX(button(zone, "Remove the video"), ["Add video"])).toEqual([[], ["Add video"]]);
    expect(d.removeClip).toHaveBeenCalledOnce();
  });

  it("shows a refusal beside the zone it belongs to", () => {
    const tree = compose(fake({ clipWhy: "Pick an MP4 or MOV video.", photoWhy: "Only PNG, JPEG or WebP photos." }));
    expect(byClass(tree, "rx-why").map((el) => [text(el), el.props.role])).toEqual([["Pick an MP4 or MOV video.", "alert"], ["Only PNG, JPEG or WebP photos.", "alert"]]);
  });

  it("takes PNG, JPEG and WebP photos, shows each with an x, and a + while fewer than 8", () => {
    const d = fake();
    const empty = byClass(compose(d), "rx-drop--photos")[0];
    const input = all(empty).find((el) => el.type === "input")!;
    expect(input.props).toMatchObject({ type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true, hidden: true });
    // The zone's button and the + open the photo picker, not the clip's.
    const [clipClick, photoClick] = [vi.fn(), vi.fn()];
    ui.refs[0].current = { click: clipClick };
    ui.refs[1].current = { click: photoClick };
    press(button(empty, "Add person photo(1-8)"));
    expect([clipClick.mock.calls.length, photoClick.mock.calls.length]).toEqual([0, 1]);
    const picked = [file("image/jpeg"), file("image/png")];
    const target = { files: picked, value: "C:\\p.jpg" };
    (input.props.onChange as (e: unknown) => void)({ currentTarget: target });
    expect(d.addPhotos).toHaveBeenLastCalledWith(picked);
    // Emptied, so picking the same photo again after its x still fires a change.
    expect(target.value).toBe("");
    const photos = (n: number) => Array.from({ length: n }, (_, i) => ({ src: `blob:p${i}`, file: file("image/png") }));
    const seven = byClass(compose(fake({ photos: photos(7) })), "rx-drop--photos")[0];
    expect(byClass(seven, "kit-ref")).toHaveLength(7);
    press(button(seven, "Add person photo"));
    expect([clipClick.mock.calls.length, photoClick.mock.calls.length]).toEqual([0, 2]);
    const eight = fake({ photos: photos(8) });
    const full = byClass(compose(eight), "rx-drop--photos")[0];
    expect(byClass(full, "kit-ref")).toHaveLength(8);
    expect(byClass(full, "kit-ref-add")).toHaveLength(0);
    vi.useFakeTimers();
    // Photo 3 out: focus goes to photo 4's x, now third, once it is drawn.
    const after = ["x1", "x2", "x4", "x5", "x6", "x7", "x8", "+"];
    expect(pressX(button(full, "Remove photo 3"), after)).toEqual([[], ["x4"]]);
    expect(eight.removePhoto).toHaveBeenCalledWith("blob:p2");
    const list = [file("image/png"), file("image/webp")];
    (empty.props.onDrop as (e: unknown) => void)({ preventDefault: () => {}, dataTransfer: { files: list } });
    expect(d.addPhotos).toHaveBeenLastCalledWith(list);
    const over = vi.fn();
    (empty.props.onDragOver as (e: unknown) => void)({ preventDefault: over });
    expect(over).toHaveBeenCalledOnce();
  });

  it("has an optional prompt behind a switch", () => {
    const d = fake();
    const row = byClass(compose(d), "rx-prompt")[0];
    const toggle = all(row).find((el) => el.type === "input")!;
    expect(toggle.props).toMatchObject({ type: "checkbox", role: "switch", checked: false });
    (toggle.props.onChange as (e: unknown) => void)({ target: { checked: true } });
    expect(d.setPromptOn).toHaveBeenCalledWith(true);
    expect(of(compose(d), AutosizeTextarea)).toHaveLength(0);
    const on = fake({ promptOn: true, mode: "swap", prompt: "the dog" });
    const area = of(compose(on), AutosizeTextarea)[0];
    expect(area.props).toMatchObject({ value: "the dog", onChange: on.setPrompt, placeholder: "Which person or thing to replace, e.g. the dog", "aria-label": "Prompt" });
    // Taller than before (64 to 160): Kev, 2026-10-30, "the prompt davon soll auch länger sein".
    expect([area.props.min, area.props.max]).toEqual([112, 240]);
  });

  it("names the model Enki Remix (Seedance 2.5), one option, and offers 480p, 720p, 1080p with their prices once a clip is in", () => {
    const d = fake();
    const [model, res] = of(compose(d), PillMenu);
    expect(text(model.props.trigger as ReactNode)).toBe("Enki Remix");
    expect(model.props.title).toBe("Seedance 2.5");
    expect(model.props.options).toEqual([{ key: "enki-remix", label: "Enki Remix" }]);
    expect(text(res.props.trigger as ReactNode)).toBe("720p");
    expect(res.props.value).toBe("720p");
    expect(res.props.options).toEqual([{ key: "480p", label: "480p", sub: null }, { key: "720p", label: "720p", sub: null }, { key: "1080p", label: "1080p", sub: null }]);
    (res.props.onPick as (k: string) => void)("1080p");
    expect(d.setResolution).toHaveBeenCalledWith("1080p");
    const priced = of(compose(fake({ clip: { src: "blob:1", seconds: 10 } })), PillMenu)[1];
    expect((priced.props.options as Array<{ sub: string }>).map((o) => o.sub)).toEqual(["$1.23", "$2.77", "$6.80"]);
  });

  it("prices Generate by the clip's seconds at the picked resolution, stays dimmed and says Remix opens soon", () => {
    const gen = (d: RemixDraft, guest = false) => of(compose(d, guest), GenerateButton)[0].props;
    expect(gen(fake())).toMatchObject({ label: "✦ Generate", chip: null, dimmed: true, size: "block" });
    expect(gen(fake({ clip: { src: "blob:1", seconds: 10 } })).chip).toBe("$2.77");
    expect(gen(fake({ clip: { src: "blob:1", seconds: 10 }, resolution: "480p" })).chip).toBe("$1.23");
    expect(gen(fake({ clip: { src: "blob:1", seconds: 12.5 }, resolution: "1080p" })).chip).toBe("$8.51");
    (gen(fake()).onPress as () => void)();
    expect(ui.notify).toHaveBeenCalledWith("Remix opens soon.");
    expect(REMIX_SOON).toBe("Remix opens soon.");
    expect(of(compose(fake()), CostLine)[0].props.left).toBe("Remix opens soon.");
    expect(ui.login).not.toHaveBeenCalled();
    // That toast sits above the foot instead of over Generate and the line under it, as the image view's does.
    expect(ui.offset.mock.calls.length).toBeGreaterThan(0);
    expect(new Set(ui.offset.mock.calls.map((c) => c[0]))).toEqual(new Set([120]));
  });

  it("gives a guest Log in instead, with no price", () => {
    const guest = of(compose(fake({ clip: { src: "blob:1", seconds: 10 } }), true), GenerateButton)[0].props;
    expect(guest).toMatchObject({ label: "Log in to generate", chip: null, dimmed: false });
    (guest.onPress as () => void)();
    expect(ui.login).toHaveBeenCalledOnce();
    expect(ui.notify).not.toHaveBeenCalled();
  });
});

describe("the draft", () => {
  const why = () => draft().clipWhy;

  it("refuses a clip of another type or over 200 MB before reading it", async () => {
    await draft().addClip(file("video/webm", "a.webm"));
    expect(why()).toBe("Pick an MP4 or MOV video.");
    await draft().addClip(file("video/mp4", "a.mp4", CLIP_MAX_BYTES + 1));
    expect(why()).toBe("This video is over 200 MB. Pick a smaller one.");
    expect([made, ui.seconds.mock.calls.length]).toEqual([[], 0]);
  });

  it("reads the clip's length and refuses one under 4 s or over 15 s, letting its URL go", async () => {
    ui.seconds.mockResolvedValueOnce(3.2);
    await draft().addClip(file("video/mp4", "a.mp4"));
    expect([why(), draft().clip]).toEqual(["This clip is 3.2 s long. Pick one of 4 to 15 seconds.", null]);
    ui.seconds.mockResolvedValueOnce(16);
    await draft().addClip(file("video/quicktime", "b.mov"));
    expect(why()).toBe("This clip is 16.0 s long. Pick one of 4 to 15 seconds.");
    ui.seconds.mockRejectedValueOnce(new Error("no length"));
    await draft().addClip(file("video/mp4", "c.mp4"));
    expect(why()).toBe("This video could not be read. Try an MP4 or MOV file.");
    expect(ui.seconds.mock.calls).toEqual([["blob:1"], ["blob:2"], ["blob:3"]]);
    expect(revoked).toEqual(["blob:1", "blob:2", "blob:3"]);
  });

  it("takes a clip of 4 to 15 s and lets its URL go once it is removed", async () => {
    ui.seconds.mockResolvedValueOnce(7.43);
    const picked = file("video/mp4", "a.mp4");
    await draft().addClip(picked);
    const d = draft();
    expect([d.clip, d.clipWhy]).toEqual([{ src: "blob:1", seconds: 7.43, file: picked }, null]);
    // Let go when the clip changes (removed, replaced), and everything still held only when the composer leaves.
    expect(ui.deps.slice(0, 2)).toEqual([[d.clip], []]);
    const leave = ui.effects[0]();
    expect(revoked).toEqual([]);
    (leave as () => void)();
    expect(revoked).toEqual(["blob:1"]);
    d.removeClip();
    expect(draft().clip).toBeNull();
  });

  it("drops the clip's refusal once a good clip goes in, the clip comes out, or Recreate fills it", async () => {
    ui.seconds.mockResolvedValueOnce(2).mockResolvedValueOnce(6);
    await draft().addClip(file("video/mp4", "a.mp4"));
    expect(why()).toBe("This clip is 2.0 s long. Pick one of 4 to 15 seconds.");
    await draft().addClip(file("video/mp4", "b.mp4"));
    expect([why(), draft().clip?.seconds]).toEqual([null, 6]);
    await draft().addClip(file("video/webm", "c.webm"));
    expect(why()).toBe("Pick an MP4 or MOV video.");
    draft().removeClip();
    expect([why(), draft().clip]).toEqual([null, null]);
    await draft().addClip(file("video/webm", "c.webm"));
    draft().recreate(CARD);
    expect([why(), draft().clip]).toEqual([null, { src: CARD.clip, seconds: 10 }]);
  });

  it("takes at most 8 photos and says so, and lets a removed one's URL go", () => {
    draft().addPhotos(Array.from({ length: 9 }, () => file("image/jpeg")));
    let d = draft();
    expect(d.photos.map((p) => p.src)).toEqual(["blob:1", "blob:2", "blob:3", "blob:4", "blob:5", "blob:6", "blob:7", "blob:8"]);
    expect(d.photoWhy).toBe("At most 8 photos: 1 left out.");
    d.removePhoto("blob:4");
    d = draft();
    expect([d.photos.length, d.photoWhy, revoked]).toEqual([7, null, ["blob:4"]]);
    // Beside the 7 already in, two more fit as one.
    d.addPhotos([file("image/png"), file("image/png")]);
    d = draft();
    expect([d.photos.length, d.photoWhy]).toEqual([8, "At most 8 photos: 1 left out."]);
    d.removePhoto("blob:1");
    draft().addPhotos([file("image/gif"), file("image/webp")]);
    d = draft();
    expect([d.photos.length, d.photoWhy]).toEqual([8, "Only PNG, JPEG or WebP photos."]);
    expect(made).toHaveLength(10);
  });

  it("starts on Motion transfer at 720p with the prompt off, and lets every held URL go when it leaves", () => {
    const d = draft();
    expect([d.mode, d.resolution, d.promptOn, d.prompt, d.clip, d.photos]).toEqual(["motion", "720p", false, "", null, []]);
    d.addPhotos([file("image/png"), file("image/png")]);
    draft();
    (ui.effects[1]() as () => void)();
    expect(revoked).toEqual(["blob:1", "blob:2"]);
  });
});

describe("a card", () => {
  it("shows the clip at 16:9, muted and looping, its mode and title, and Recreate hands the card over", () => {
    const onRecreate = vi.fn();
    const tree = RemixCard({ card: CARD, onRecreate }) as ReactNode;
    const video = all(tree).find((el) => el.type === "video")!;
    expect(video.props).toMatchObject({ className: "rx-card-clip", src: CARD.clip, muted: true, loop: true, playsInline: true });
    expect(text(byClass(tree, "kit-label")[0])).toBe("Object swap");
    expect(text(byClass(tree, "rx-card-title")[0])).toBe("Cat on a skateboard");
    press(button(tree, "Recreate"));
    expect(onRecreate).toHaveBeenCalledWith(CARD);
    expect(readFileSync(join(__dirname, "..", "..", "..", "components", "remix", "remix.css"), "utf8"))
      .toContain(".rx-card-clip { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover;");
  });

  it("Recreate puts its clip and its mode into the composer, which prices it, and brings the composer into view", () => {
    ui.lists.examples.push(CARD);
    const view = () => { ui.s = 0; ui.r = 0; ui.effects = []; return RemixView({ guest: false }) as ReactNode; };
    expect(of(view(), RemixCard)).toHaveLength(0);
    ui.state[8] = "examples";
    const card = of(view(), RemixCard)[0];
    expect(card.props.card).toBe(CARD);
    press(button(RemixCard(card.props as { card: RemixCardData; onRecreate: () => void }) as ReactNode, "Recreate"));
    const d = of(view(), RemixComposer)[0].props.d as RemixDraft;
    expect([d.mode, d.clip]).toEqual(["swap", { src: CARD.clip, seconds: 10 }]);
    const composed = compose(d);
    expect(all(byClass(composed, "rx-drop")[0]).find((el) => el.type === "video")!.props.src).toBe(CARD.clip);
    expect(of(composed, GenerateButton)[0].props.chip).toBe("$2.77");
    expect((window.scrollTo as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});

describe("History | Examples", () => {
  const view = () => { ui.s = 0; ui.r = 0; return RemixView({ guest: false }) as ReactNode; };

  // Kev, 2026-10-30: "Anstelle von Library bei Remix, soll "Examples" stehen, wo dann lauter webm animationen drin sein
  // werden später"; the switch glides as Create's row does.
  it("are two gliding tabs beside the composer, no Styles, each empty until there are remixes", () => {
    const tree = view();
    const tabs = of(tree, Segmented)[0];
    expect(tabs.props).toMatchObject({ role: "tablist", value: "history", slide: true });
    expect((tabs.props.options as Array<{ key: string; label: string }>).map((o) => [o.key, o.label])).toEqual([["history", "History"], ["examples", "Examples"]]);
    expect(of(tree, RemixComposer)).toHaveLength(1);
    expect(text(byClass(tree, "rx-empty")[0])).toBe("No remixes yet.The remixes you make show up here.");
    ui.state[8] = "examples";
    expect(text(byClass(view(), "rx-empty")[0])).toBe("No examples yet.Short looping clips of each mode arrive here soon.");
    (tabs.props.onChange as (t: string) => void)("history");
    expect(ui.state[8]).toBe("history");
  });
});

describe("the layout", () => {
  const css = readFileSync(join(__dirname, "..", "..", "..", "components", "remix", "remix.css"), "utf8").split("\r\n").join("\n");
  const phone = css.slice(css.indexOf("@media (max-width: 767.98px)"));

  it("is a 320 px composer beside a library that may shrink, the composer as tall as the window and Generate at its foot", () => {
    // 320 unless the view sets its own column (Create > Video, video.css).
    expect(css).toContain(".rx { display: grid; grid-template-columns: var(--rx-col, 320px) minmax(0, 1fr); align-items: start; }");
    expect(css).not.toMatch(/\.rx[- ][^{]*\{[^}]*--rx-col:/);
    expect(css).toContain(".rx-lib { min-width: 0;");
    expect(css).toMatch(/\.rx-compose \{\n  --rx-top: calc\(var\(--feed-world-h\) \+ var\(--ek-banner-h, 0px\)\);\n  position: sticky; top: var\(--rx-top\);[^}]*height: calc\(100dvh - var\(--rx-top\)\); overflow-y: auto;/);
    expect(css).toMatch(/\.rx-foot \{\n  position: sticky; bottom: 0;[^}]*margin-top: auto;/);
    // Four 52 px photos to a row in the 320 px column, so 8 take two rows; at 56 px only three fit.
    expect(css).toContain(".rx-photos { --kit-ref: 52px; gap: 8px; }");
  });

  it("on a phone is one column, the composer first with 16 px sides, Generate stuck to the bottom, nothing wider than the screen", () => {
    expect(phone).toContain(".rx { grid-template-columns: minmax(0, 1fr); }");
    expect(phone).toContain(".rx-compose { position: static; height: auto; overflow: visible; padding: 16px 16px 0; border-right: 0;");
    expect(phone).toContain(".rx-lib { padding: 16px 16px 40px; }");
    expect(phone).toContain(".rx-cards { grid-template-columns: minmax(0, 1fr); }");
    expect(phone).toContain(".rx-foot { padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }");
    expect(phone).not.toMatch(/\.rx-foot \{[^}]*position: static/);
  });
});
