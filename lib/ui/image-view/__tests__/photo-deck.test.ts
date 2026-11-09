import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "@/lib/__tests__/_read-source";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";

/**
 * The buyer's photos (image UI v2, README §5.1, plan B7): one tile per slot
 * the text names ("Reference image k" is photo k). An empty slot asks for a
 * photo and Generate says "Add N photos" until it has one; × takes a slot out
 * with its reference; past the named slots a photo adds a reference.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], refs: [] as { current: unknown }[], s: 0, r: 0, click: vi.fn(), layout: [] as (() => void)[], effects: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T | ((x: T) => T)) => { ui.state[i] = typeof next === "function" ? (next as (x: T) => T)(ui.state[i] as T) : next; }];
  },
  useRef: <T>(start: T) => {
    const i = ui.r++;
    ui.refs[i] ??= { current: start };
    return ui.refs[i];
  },
  useEffect: (run: () => void) => { ui.effects.push(run); },
  useLayoutEffect: (run: () => void) => { ui.layout.push(run); },
}));
vi.mock("@/components/kit/AddFundsPopover", () => ({ default: () => null }));
vi.mock("@/components/image-view/RefPicker", () => ({ default: () => null }));
vi.mock("@/components/kit/CostLine", () => ({ default: () => null }));
vi.mock("@/components/kit/GeneratorPill", () => ({ default: () => null }));
vi.mock("@/components/kit/PillMenu", () => ({ default: () => null }));
vi.mock("@/components/kit/SettingsPills", () => ({ RatioPill: () => null, ResolutionPill: () => null, QualityPill: () => null }));

import PhotoDeck from "@/components/image-view/PhotoDeck";
import RefPicker from "@/components/image-view/RefPicker";
import Zoom from "@/components/image-view/Zoom";
import ComposeFoot from "@/components/image-view/ComposeFoot";
import GenerateButton from "@/components/kit/GenerateButton";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => el.props.className === name);
const press = (el: El) => (el.props.onClick as () => void)();

let model: ImageViewModel;
const draw = (phone = false) => {
  ui.s = 0; ui.r = 0;
  const tree = PhotoDeck({ model, phone }) as El;
  // The hidden file input's ref (the second useRef) gets a click to watch.
  (ui.refs[1] as { current: unknown }).current = { click: ui.click };
  return tree;
};
const photo = (n: number) => ({ id: `p${n}`, src: `/p${n}.png` });
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  ui.state = []; ui.refs = []; ui.layout = []; ui.effects = []; ui.click.mockClear();
  model = {
    refs: [photo(1)], pending: [], slotTotal: 3, cap: 14, room: 13, accept: "image/*",
    addFiles: vi.fn(), removeSlot: vi.fn(), replacePhoto: vi.fn(), photosNeeded: 2,
  } as unknown as ImageViewModel;
});

describe("the photo tiles", () => {
  it("are one per slot: the buyer's photos first, then the empty slots that ask for one", () => {
    const tiles = byClass(draw(), "iv-photo");
    expect(tiles).toHaveLength(3);
    expect(tiles.map((t) => [!!t.props["data-own"], !!t.props["data-empty"]])).toEqual([[true, false], [false, true], [false, true]]);
    expect((tiles[0].props.style as { backgroundImage: string }).backgroundImage).toBe('url("/p1.png")');
  });

  it("open the reference picker from an empty slot and from +; its Upload and Replace use the file picker", () => {
    const at = (rect: object) => ({ currentTarget: { getBoundingClientRect: () => rect } });
    (byClass(draw(), "iv-photo-pick")[1].props.onClick as (e: unknown) => void)(at({ left: 1 }));
    const picker = [...walk(draw())].find((el) => el.type === RefPicker)!;
    expect(picker.props.anchor).toEqual({ left: 1 });
    expect(ui.click).not.toHaveBeenCalled();
    (picker.props.onUpload as () => void)();
    expect(ui.click).toHaveBeenCalledTimes(1);
    (picker.props.onClose as () => void)();
    expect([...walk(draw())].filter((el) => el.type === RefPicker)).toHaveLength(0);
    (byClass(draw(), "iv-photo-add")[0].props.onClick as (e: unknown) => void)(at({ left: 2 }));
    expect([...walk(draw())].find((el) => el.type === RefPicker)!.props.anchor).toEqual({ left: 2 });
    ui.click.mockClear();
    (([...walk(draw())].find((el) => el.type === RefPicker)!.props.onUpload) as () => void)();
    expect(ui.click).toHaveBeenCalledTimes(1);
    ui.click.mockClear();
    draw();
    const swap = byClass(draw(), "iv-photo-swap kit-hit");
    expect(swap).toHaveLength(1);
    press(swap[0]);
    expect((ui.refs[2] as { current: unknown }).current).toBe(0);
    expect(ui.click).toHaveBeenCalledTimes(1);
  });

  it("take a slot out with ×, but never the last empty one", () => {
    press(byClass(draw(), "iv-photo-x kit-hit")[1]);
    expect(model.removeSlot).toHaveBeenCalledWith(1);
    model.refs = []; model.slotTotal = 1;
    expect(byClass(draw(), "iv-photo-x kit-hit")).toHaveLength(0);
    model.refs = [photo(1)];
    expect(byClass(draw(), "iv-photo-x kit-hit")).toHaveLength(1);
  });

  // Kev (2026-10-29): "i also need the + image als standalone button on the right too ... the add image always appends".
  it("show + after the last card whenever the generator takes another photo, empty places or not", () => {
    // One photo and two empty places (the text names three): the + stands after the third card.
    const plus = byClass(draw(), "iv-photo-add");
    expect(plus).toHaveLength(1);
    const cards = byClass(draw(), "iv-photo").map((t) => t.props.style as { left: number; width: number });
    expect(cards).toHaveLength(3);
    expect((plus[0].props.style as { left: number }).left).toBe(cards[2].left + cards[2].width + 10);
    model.pending = ["/a.png", "/b.png"];
    expect(byClass(draw(), "iv-photo-add")).toHaveLength(1);
    // Every photo the generator takes is in: no + (room counts the photos still being read).
    model.room = 0;
    expect(byClass(draw(), "iv-photo-add")).toHaveLength(0);
    // The text names as many places as the generator takes, two of them still empty: the + too (it hid here before).
    model.pending = []; model.cap = 3; model.slotTotal = 3; model.room = 2;
    expect(byClass(draw(), "iv-photo-add")).toHaveLength(1);
  });

  // Kev (2026-10-29): "if on image ui is no ref image at all, dann zeige auch nicht rechts diesen ref image zusatz, but
  // just transform that quadratische ref image to the on the appending one".
  it("with no photo at all show no + beside the empty place, and draw the lone place of a text naming none as the +", () => {
    model.refs = []; model.pending = []; model.slotTotal = 1; model.photosNeeded = 0;
    let tree = draw();
    expect(byClass(tree, "iv-photo-add")).toHaveLength(0);
    const [lone] = byClass(tree, "iv-photo");
    expect(lone.props["data-add"]).toBe(true);
    expect(lone.props["data-empty"]).toBe(true);
    expect(byClass(tree, "iv-photo-n")).toHaveLength(0);
    const pick = byClass(tree, "iv-photo-pick")[0];
    expect(pick.props["aria-label"]).toBe("Add a photo");
    (pick.props.onClick as (e: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 3 }) } });
    expect([...walk(draw())].find((el) => el.type === RefPicker)!.props.anchor).toEqual({ left: 3 });
    // The text names two images, none in yet: two places that wait, numbered, still no + beside them.
    model.slotTotal = 2; model.photosNeeded = 2;
    tree = draw();
    expect(byClass(tree, "iv-photo-add")).toHaveLength(0);
    expect(byClass(tree, "iv-photo").map((t) => t.props["data-add"])).toEqual([undefined, undefined]);
    expect(byClass(tree, "iv-photo-n")).toHaveLength(2);
    // A generator that takes no image while the text names two: nothing asks (photosNeeded 0), the places still wait.
    model.cap = 0; model.room = 0; model.photosNeeded = 0;
    expect(byClass(draw(), "iv-photo").map((t) => t.props["data-add"])).toEqual([undefined, undefined]);
    model.cap = 14; model.room = 13;
    // One that names an image: its place waits, as it did.
    model.slotTotal = 1; model.photosNeeded = 1;
    expect(byClass(draw(), "iv-photo")[0].props["data-add"]).toBeUndefined();
    // The first photo being read: the + comes back after it.
    model.pending = ["/a.png"]; model.photosNeeded = 0;
    expect(byClass(draw(), "iv-photo-add")).toHaveLength(1);
    expect(byClass(draw(), "iv-photo")[0].props["data-add"]).toBeUndefined();
  });

  it("give the lone + place the +'s own look", () => {
    const css = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
    expect(css).toContain(".iv-photo[data-add] { border-color: var(--enki-rule); background: transparent; color: var(--enki-ink-3); }");
    expect(css.indexOf(".iv-photo[data-add] {")).toBeGreaterThan(css.indexOf(".iv-photo[data-empty] {"));
  });

  it("flag a photo past the generator's cap, and show photos still being read greyed", () => {
    model.refs = [photo(1), photo(2)]; model.cap = 1; model.slotTotal = 3; model.pending = ["/reading.png"];
    const tiles = byClass(draw(), "iv-photo");
    expect(tiles.map((t) => !!t.props["data-over"])).toEqual([false, true, false]);
    expect(tiles[2].props["data-pending"]).toBe(true);
  });

  it("hand the picked or dropped files to the model, and a Replace to its slot", () => {
    draw();
    const input = [...walk(draw())].find((el) => el.type === "input")!;
    const files = [new File(["a"], "a.png"), new File(["b"], "b.png")];
    (input.props.onChange as (e: unknown) => void)({ target: { files, value: "x" } });
    expect(model.addFiles).toHaveBeenCalledWith(files);
    (ui.refs[2] as { current: unknown }).current = 0;
    (input.props.onChange as (e: unknown) => void)({ target: { files: [files[1]], value: "x" } });
    expect(model.replacePhoto).toHaveBeenCalledWith(0, files[1]);
    const box = byClass(draw(), "iv-deck-box")[0];
    const drop = { preventDefault: vi.fn(), dataTransfer: { types: ["Files"], files: [files[0]] } };
    (box.props.onDrop as (e: unknown) => void)(drop);
    expect(model.addFiles).toHaveBeenLastCalledWith([files[0]]);
    // A Replace whose file dialog was cancelled: a later drop of two still adds both.
    (ui.refs[2] as { current: unknown }).current = 0;
    model.replacePhoto = vi.fn();
    (box.props.onDrop as (e: unknown) => void)({ ...drop, dataTransfer: { types: ["Files"], files } });
    expect(model.addFiles).toHaveBeenLastCalledWith(files);
    expect(model.replacePhoto).not.toHaveBeenCalled();
  });

  // Kev, 2026-10-29: "pack die reference images alle in einer line and ordne die dann wie ein kartendeck nebeneinander an".
  it("lay out one row of overlapping cards, on desktop too, the desktop's at most 132 px", () => {
    model.refs = Array.from({ length: 6 }, (_, i) => photo(i + 1)); model.slotTotal = 6;
    const desktop = byClass(draw(false), "iv-photo").map((t) => t.props.style as { left: number; top: number; width: number });
    expect(desktop.map((s) => [s.left, s.top, s.width])).toEqual([[4, 8, 132], [68, 8, 132], [133, 8, 132], [197, 8, 132], [262, 8, 132], [326, 8, 132]]);
    expect(byClass(draw(false), "iv-deck-box")[0].props["data-overlap"]).toBe(true);
    const phone = byClass(draw(true), "iv-photo").map((t) => (t.props.style as { left: number; width: number }));
    expect(phone[1].left - phone[0].left).toBeLessThan(phone[0].width);
  });

  // Kev, 2026-10-29: "damit via hover over diese leicht hochschauen und ich sie via click nochmal in ganz sehen kann".
  it("peek the card whose strip the mouse is on, none past the last card or off the deck, and show it whole on a click", () => {
    model.refs = Array.from({ length: 6 }, (_, i) => photo(i + 1)); model.slotTotal = 6;
    const box = () => byClass(draw(), "iv-deck-box")[0];
    const move = (clientX: number, pointerType = "mouse") =>
      (box().props.onPointerMove as (e: unknown) => void)({ pointerType, clientX, currentTarget: { getBoundingClientRect: () => ({ left: 100 }) } });
    move(250);
    const hot = () => byClass(draw(), "iv-photo").findIndex((t) => t.props["data-hot"]);
    expect(hot()).toBe(2);
    expect((byClass(draw(), "iv-photo")[2].props.style as { zIndex: number }).zIndex).toBe(60);
    move(100 + 326 + 131);
    expect(hot()).toBe(5);
    move(100 + 326 + 132);
    expect(hot()).toBe(-1);
    move(150);
    (box().props.onPointerLeave as (e: unknown) => void)({ pointerType: "mouse" });
    expect(hot()).toBe(-1);
    // A finger does not peek; it slides the deck once it has gone down (the phone's swipe).
    move(250, "touch");
    expect(hot()).toBe(-1);
    const pick = byClass(draw(), "iv-photo-pick")[2];
    (pick.props.onClick as (e: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 7 }) } });
    expect([...walk(draw())].find((el) => el.type === Zoom)!.props).toMatchObject({ src: "/p3.png", n: 3, from: { left: 7 } });
    // Cards side by side, none covering the next: :hover lifts them, nothing to pick by the strip.
    model.refs = [photo(1), photo(2)]; model.slotTotal = 2;
    move(250);
    expect(byClass(draw(), "iv-deck-box")[0].props["data-overlap"]).toBeUndefined();
    expect(hot()).toBe(-1);
  });
});

describe("the photo area", () => {
  // Kev (2026-10-21): a plain prompt's words take what the column leaves; its photos keep their first size.
  it("takes the height the column leaves, and keeps its first one under a plain prompt's words", () => {
    vi.stubGlobal("getComputedStyle", () => ({ paddingTop: "0", paddingBottom: "10" }));
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const scroller = { clientHeight: 900, children: [] };
    const area = (o: { fixed?: boolean; phone?: boolean }) => {
      ui.state = []; ui.layout = []; ui.s = 0; ui.r = 0;
      PhotoDeck({ model, ...o });
      ui.refs[0].current = { closest: () => scroller, offsetHeight: 150, clientWidth: 400 };
      ui.layout[0]();
      return ui.state[0];
    };
    // 900 - 10 - (0 - 150) - 4 = 1036 free, the most a deck takes: 520 (460 on the phone).
    expect(area({})).toEqual({ width: 400, height: 520 });
    expect(area({ phone: true })).toEqual({ width: 400, height: 460 });
    expect(area({ fixed: true })).toEqual({ width: 400, height: 150 });
    expect(area({ fixed: true, phone: true })).toEqual({ width: 400, height: 110 });
  });

  it("measures again when anything in its column changes size, the x402 fold under the scroller too", () => {
    vi.stubGlobal("getComputedStyle", () => ({ paddingTop: "0", paddingBottom: "10" }));
    const watched: unknown[] = [];
    vi.stubGlobal("ResizeObserver", class { observe(el: unknown) { watched.push(el); } disconnect() {} });
    const field = { getBoundingClientRect: () => ({ top: 0, bottom: 50, height: 50 }) };
    const agent = { getBoundingClientRect: () => ({ bottom: 700 }) }, foot = { getBoundingClientRect: () => ({ bottom: 900 }) };
    const scroller: Record<string, unknown> = { clientHeight: 300, children: [field] };
    const col = { children: [scroller, agent, foot], lastElementChild: foot, getBoundingClientRect: () => ({ bottom: 910 }) };
    scroller.parentElement = col;
    ui.layout = []; ui.s = 0; ui.r = 0;
    PhotoDeck({ model });
    ui.refs[0].current = { closest: () => scroller, offsetHeight: 150, clientWidth: 400 };
    ui.layout[0]();
    expect(watched).toEqual(expect.arrayContaining([scroller, field, agent, foot]));
  });

  it("grows into what the column leaves below the foot, never less than its own measure", () => {
    vi.stubGlobal("getComputedStyle", () => ({ paddingTop: "0", paddingBottom: "10" }));
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const foot = { getBoundingClientRect: () => ({ bottom: 700 }) };
    const col = { getBoundingClientRect: () => ({ bottom: 900 }), lastElementChild: foot };
    const scroller = { clientHeight: 100, children: [], parentElement: col };
    const area = () => {
      ui.state = []; ui.layout = []; ui.s = 0; ui.r = 0;
      PhotoDeck({ model });
      ui.refs[0].current = { closest: () => scroller, offsetHeight: 150, clientWidth: 400 };
      ui.layout[0]();
      return (ui.state[0] as { height: number }).height;
    };
    // 100 - 10 - (0 - 150) - 4 = 236 in the scroller, + 900 - 10 - 700 = 190 below the foot.
    expect(area()).toBe(426);
    // A column that overflows leaves nothing below its foot.
    col.getBoundingClientRect = () => ({ bottom: 600 });
    expect(area()).toBe(236);
  });
});

describe("Generate's Add N photos", () => {
  it("brings the first empty place into view, then opens the picker at it", () => {
    let open: (() => void) | undefined;
    vi.stubGlobal("window", { addEventListener: (_: string, l: () => void) => { open = l; }, removeEventListener: vi.fn() });
    const seen = vi.fn(), rect = { left: 3, top: 40, bottom: 80 };
    const place = { scrollIntoView: seen, getBoundingClientRect: vi.fn(() => rect) };
    draw();
    ui.refs[0].current = { querySelector: (q: string) => (q === ".iv-photo[data-empty]" ? place : null) };
    ui.effects[0]();
    open!();
    expect(seen).toHaveBeenCalledWith({ block: "nearest" });
    expect(seen.mock.invocationCallOrder[0]).toBeLessThan(place.getBoundingClientRect.mock.invocationCallOrder[0]);
    expect(ui.state[4]).toBe(rect);
    // No empty place (the pending ones fill them): the photo area itself.
    const all = { left: 0, top: 10, bottom: 150 };
    ui.refs[0].current = { querySelector: () => null, scrollIntoView: seen, getBoundingClientRect: () => all };
    open!();
    expect(ui.state[4]).toBe(all);
  });
});

describe("Generate while photos are missing", () => {
  const foot = (over: Partial<ImageViewModel>) => {
    const m = { guest: false, core: { entry: null, supportsQuality: false, free: false }, models: [], count: 1, countMax: 8, settingsChanged: false,
      chip: "$0.20", short: "$0.10", quotePending: true, button: { label: "Add 2 photos", dimmed: false }, funds: null, photosNeeded: 2, ...over } as unknown as ImageViewModel;
    return [...walk(ComposeFoot({ model: m }))].find((el) => el.type === GenerateButton)!;
  };

  it("carries no price and no short balance: that press only opens the picker", () => {
    expect(foot({}).props).toMatchObject({ chip: null, short: null, chipPending: false, label: "Add 2 photos" });
    expect(foot({ photosNeeded: 0 }).props).toMatchObject({ chip: "$0.20", short: "$0.10", chipPending: true });
  });
});

describe("the model", () => {
  const MODEL = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"));

  it("reads the slots from the text and waits for each named one, none on a premium prompt", () => {
    expect(MODEL).toContain("const textSlots = text === null ? 0 : slotCount(text);");
    expect(MODEL).toContain("const slotTotal = Math.min(MAX_SLOTS, Math.max(1, textSlots, refs.length + reads.pending.length));");
    expect(MODEL).toContain("const photosNeeded = Math.max(0, Math.min(textSlots, cap) - refs.length - reads.pending.length);");
    expect(MODEL).toContain('if (photosNeeded) return { label: `Add ${plural(photosNeeded, "photo")}`, why: null, add: true };');
    expect(MODEL).toContain("if (gate.add) return void window.dispatchEvent(new Event(ADD_PHOTOS_EVENT));");
  });

  it("keeps the text in step: a photo past the named slots names one more, a removed slot drops its reference", () => {
    expect(MODEL).toContain("if (text === null || total <= textSlots) return;");
    expect(MODEL).toContain("setEdited(at === undefined ? (resizeSlots(initialSlots(text), total).text ?? text) : refsAt(text, total, at));");
    expect(MODEL).toContain("growText(refs.length + reads.pending.length + take.length, at);");
    expect(MODEL).toContain("growText(refs.length + reads.pending.length + picks.length, at);");
    expect(MODEL).toContain("if (i < refs.length) setRefs((r) => r.filter((_, j) => j !== i));");
    expect(MODEL).toContain("if (text !== null && i < textSlots && textSlots > 1) setEdited(dropSlot(initialSlots(text), i + 1).text ?? text);");
  });

  // What it does then: "Generate's Add N photos" above.
  it("listens for Generate's ask", () => {
    const deck = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "PhotoDeck.tsx"), "utf8");
    expect(deck).toContain("window.addEventListener(ADD_PHOTOS_EVENT, open);");
  });
});
