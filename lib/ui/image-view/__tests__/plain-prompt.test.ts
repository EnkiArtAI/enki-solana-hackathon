import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";
import { parseTokens } from "@/lib/editor/prompt-tokens";
import { fitFont } from "@/lib/ui/image-view/fit-font";
import { parseSegments } from "@/lib/ui/image-view/segments";

/**
 * A prompt without variables (text-only handoff, Kev 2026-10-21): its text
 * stands in place of the fields, always the editor, so a click puts the caret
 * there and changes no size; no Easy | Expert; its photos keep their area and
 * a short prompt's type grows until the words reach the agent row at the foot.
 * Without photo places there is no photo area.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], refs: [] as { current: unknown }[], s: 0, r: 0 }));
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
  useLayoutEffect: (run: () => void) => run(),
  useEffect: () => {},
}));
vi.mock("@/components/image-view/PhotoDeck", () => ({ default: () => null }));
vi.mock("@/components/image-view/PromptPanel", () => ({ default: () => null, Fields: () => null, inDocument: () => false }));
vi.mock("@/components/kit/PromptMirror", () => ({ default: () => null }));

import Composer from "@/components/image-view/Composer";
import PhotoDeck from "@/components/image-view/PhotoDeck";
import PlainPrompt, { WORDS_MAX, WORDS_MIN } from "@/components/image-view/PlainPrompt";
import PromptPanel, { Fields } from "@/components/image-view/PromptPanel";
import PromptMirror from "@/components/kit/PromptMirror";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const of = (tree: ReactNode, type: unknown) => [...walk(tree)].filter((el) => el.type === type);
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => el.props.className === name);
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("")
    : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children)
      : typeof node === "string" || typeof node === "number" ? String(node) : "";

const WITH = "A quiet portrait of Reference image 1 beside Reference image 2 at dusk.";
const WITHOUT = "A quiet portrait of two sitters at dusk.";
let m: ImageViewModel;
const plain = (t: string) => ({
  text: t, segments: parseSegments(t, []), plain: true, photoless: !/Reference image/.test(t),
  guest: false, room: 3, slotTotal: 2, photosNeeded: 0, accept: "image/*", textMissing: false, addFiles: vi.fn(),
  refs: [{ id: "a", src: "data:a" }], values: {}, edited: false, resetText: vi.fn(), setText: vi.fn(),
  growOnly: () => false, release: vi.fn(), addVariable: vi.fn(),
}) as unknown as ImageViewModel;
const draw = (phone = false) => { ui.s = 0; ui.r = 0; return Composer({ model: m, phone }) as El; };

beforeEach(() => {
  ui.state = []; ui.refs = [];
  m = plain(WITH);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("a prompt without variables", () => {
  it("has no Easy | Expert, shows its photos under Your images in a fixed area and its text in place of the fields", () => {
    const tree = draw();
    expect([...walk(tree)].filter((el) => el.props.role === "radiogroup")).toHaveLength(0);
    expect(text(byClass(tree, "iv-mode-label")[0])).toBe("Your images");
    const deck = of(tree, PhotoDeck)[0];
    expect(deck.props.fixed).toBe(true);
    expect(of(tree, PlainPrompt)[0].props.phone).toBe(false);
    expect(of(draw(true), PlainPrompt)[0].props.phone).toBe(true);
    expect(of(tree, Fields)).toHaveLength(0);
    expect(of(tree, PromptPanel)).toHaveLength(0);
  });

  it("leaves Easy's photo area free to take the column's height", () => {
    m.plain = false;
    const deck = of(draw(), PhotoDeck)[0];
    expect(deck.props.fixed).toBeUndefined();
  });

  // Kev, 2026-11-01: "bei jedem bild von image ui reference images möglich sein ... die sind bei jedem free image ein muss"
  // (the photo-area part of DEC-330 reversed): a prompt that names no photo still takes yours.
  it("keeps the photo area and its head when it names no photo", () => {
    m = plain(WITHOUT);
    const tree = draw();
    expect(byClass(tree, "iv-mode-head")).toHaveLength(1);
    expect(of(tree, PhotoDeck).map((d) => d.props.fixed)).toEqual([true]);
    expect(of(tree, PlainPrompt)).toHaveLength(1);
  });

  it("ignores a stored Expert, and gives a guest no photo area and no head over it", () => {
    ui.state[0] = "expert";
    expect(of(draw(), PlainPrompt)).toHaveLength(1);
    expect(of(draw(), PromptPanel)).toHaveLength(0);
    m.guest = true;
    expect(of(draw(), PhotoDeck)).toHaveLength(0);
    expect(byClass(draw(), "iv-mode-head")).toHaveLength(0);
  });

  it("keeps the words while a variable typed into them appears, and shows the fields once they are left", () => {
    const editing = () => of(draw(), PlainPrompt)[0].props.onEditing as (on: boolean) => void;
    editing()(true);
    expect(ui.state[3]).toBe(true);
    m.plain = false;
    let tree = draw();
    expect(of(tree, PlainPrompt)).toHaveLength(1);
    expect(of(tree, Fields)).toHaveLength(0);
    editing()(false);
    tree = draw();
    expect(of(tree, PlainPrompt)).toHaveLength(0);
    expect(of(tree, Fields)).toHaveLength(1);
    expect([...walk(tree)].filter((el) => el.props.role === "radiogroup")).toHaveLength(1);
  });

  it("keeps Expert while its text has the focus, though the last variable just went, and turns plain once it is left", () => {
    m.plain = false;
    ui.state[0] = "expert";
    const hold = () => of(draw(), PromptPanel)[0];
    const box = () => [...walk(draw())].find((el) => el.type === "div" && (el.props.style as { display?: string } | undefined)?.display === "contents")!;
    (box().props.onFocus as () => void)();
    m.plain = true;
    expect(hold()).toBeDefined();
    expect([...walk(draw())].filter((el) => el.props.role === "radiogroup")).toHaveLength(1);
    (box().props.onBlur as (e: unknown) => void)({ currentTarget: { contains: () => true }, relatedTarget: {} });
    expect(hold()).toBeDefined();
    (box().props.onBlur as (e: unknown) => void)({ currentTarget: { contains: () => false }, relatedTarget: null });
    expect(of(draw(), PromptPanel)).toHaveLength(0);
    expect(of(draw(), PlainPrompt)).toHaveLength(1);
  });

  it("holds Expert only in Expert: a switch lets the hold go", () => {
    m.plain = false;
    ui.state[0] = "expert";
    const radio = (k: string) => [...walk(draw())].find((el) => el.props.role === "radio" && el.props.children === k)!;
    const box = [...walk(draw())].find((el) => el.type === "div" && (el.props.style as { display?: string } | undefined)?.display === "contents")!;
    (box.props.onFocus as () => void)();
    (radio("Variable").props.onClick as () => void)();
    ui.state[0] = "expert";
    m.plain = true;
    expect(of(draw(), PlainPrompt)).toHaveLength(1);
  });
});

describe("the prompt's words", () => {
  const show = (o: { phone?: boolean; onEditing?: (on: boolean) => void } = {}) => {
    ui.s = 0; ui.r = 0;
    return PlainPrompt({ model: m, phone: !!o.phone, onEditing: o.onEditing ?? vi.fn() }) as El;
  };
  const wrap = (tree: ReactNode) => byClass(tree, "iv-plain-words")[0];
  const size = (tree: ReactNode) => (wrap(tree).props.style as Record<string, string>)["--iv-fs"];

  it("are always the editor: the creator's words under the label Prompt, the photo places as pills", () => {
    const tree = show();
    expect(text(byClass(tree, "iv-mode-label")[0])).toBe("Prompt");
    const editor = of(tree, PromptMirror)[0];
    expect([editor.props.className, editor.props.value, editor.props.missingRefs]).toEqual(["iv-pm", WITH, []]);
    expect(editor.props.tokens).toEqual(parseTokens(WITH, { refs: "plain" }));
    (editor.props.onChange as (v: string) => void)("new words");
    expect(m.setText).toHaveBeenCalledWith("new words");
    expect(text(byClass(tree, "iv-plain-probe")[0])).toBe(WITH);
    // A phone keeps 17 px and measures nothing.
    expect(byClass(show({ phone: true }), "iv-plain-probe")).toHaveLength(0);
  });

  it("keep their size when clicked: the focus only says the words are being edited, leaving them ends it", () => {
    const onEditing = vi.fn();
    const before = show({ onEditing });
    (wrap(before).props.onFocus as () => void)();
    expect(onEditing).toHaveBeenLastCalledWith(true);
    const after = show({ onEditing });
    expect([size(after), of(after, PromptMirror)[0].props.min]).toEqual([size(before), of(before, PromptMirror)[0].props.min]);
    const blur = wrap(after).props.onBlur as (e: unknown) => void;
    blur({ currentTarget: { contains: () => true }, relatedTarget: {} });
    expect(onEditing).toHaveBeenCalledTimes(1);
    blur({ currentTarget: { contains: () => false }, relatedTarget: null });
    expect(onEditing).toHaveBeenLastCalledWith(false);
  });

  it("start at 19 px, 17 on a phone whatever was fitted, the field at least one line of that size", () => {
    let tree = show();
    expect([size(tree), of(tree, PromptMirror)[0].props.min]).toEqual(["19px", 19 * 1.7 + 14]);
    ui.state[0] = 30;
    tree = show({ phone: true });
    expect([size(tree), of(tree, PromptMirror)[0].props.min]).toEqual(["17px", 17 * 1.7 + 14]);
  });

  it("give the field a new least height for every half pixel, so it measures itself again at each size", () => {
    const mins = new Set<number>();
    for (let px = WORDS_MIN; px <= WORDS_MAX; px += 0.5) {
      ui.state[0] = px;
      mins.add(of(show(), PromptMirror)[0].props.min as number);
    }
    expect(mins.size).toBe((WORDS_MAX - WORDS_MIN) * 2 + 1);
  });

  it("offer the artist's wording back once changed", () => {
    expect(byClass(show(), "iv-link")).toHaveLength(0);
    m.edited = true;
    (byClass(show(), "iv-link")[0].props.onClick as () => void)();
    expect(m.resetText).toHaveBeenCalledOnce();
  });
});

describe("the words' size on desktop", () => {
  // A probe 10 px tall per px of type, plus its 14 px frame.
  const probe = { style: { fontSize: "" }, get offsetHeight() { return 10 * parseFloat(this.style.fontSize || "19") + 14; } };
  let scroller: Record<string, unknown>;
  let observed: () => void;
  const fit = (phone = false) => {
    ui.s = 0; ui.r = 0;
    // The refs before the render: the layout effect runs within it.
    ui.refs[0] = { current: { closest: () => scroller, getBoundingClientRect: () => ({ bottom: 400 }) } };
    ui.refs[1] = { current: { offsetHeight: 100 } };
    ui.refs[2] = { current: probe };
    PlainPrompt({ model: m, phone, onEditing: vi.fn() });
    return ui.state[0];
  };
  beforeEach(() => {
    probe.style.fontSize = "";
    scroller = { getBoundingClientRect: () => ({ bottom: 610 }), scrollHeight: 900, clientHeight: 900, children: [{}, {}] };
    vi.stubGlobal("getComputedStyle", () => ({ paddingBottom: "10px" }));
    vi.stubGlobal("ResizeObserver", class { constructor(run: () => void) { observed = run; } observe() {} disconnect() {} });
  });

  // The agent row stands under the scroller, above the foot (Kev, 2026-10-21): the words fill the scroller.
  it("grows until the words reach the scroller's foot, inside its padding, and puts the probe back", () => {
    // Field 100 + (610 - 10 - 400) free = 300: 10 px + 14 <= 300 up to 28.6 px.
    expect(fit()).toBe(28.5);
    expect(probe.style.fontSize).toBe("");
  });

  it("gives what overflows back, and fits again when the column changes", () => {
    // 300 less the 50 that overflow: up to 23.6 px.
    scroller.scrollHeight = 950;
    expect(fit()).toBe(23.5);
    scroller.scrollHeight = 900;
    // The scroller 100 px shorter (the agent row opened under it): 200, less than 19 px takes.
    scroller.getBoundingClientRect = () => ({ bottom: 510 });
    observed();
    expect(ui.state[0]).toBe(WORDS_MIN);
  });

  it("is left alone on a phone", () => {
    ui.state[0] = 30;
    expect(fit(true)).toBe(30);
  });
});

describe("fitFont", () => {
  const h = (px: number) => 10 * px + 14;

  it("is the largest half pixel whose height fits the room", () => {
    expect(fitFont(h, 300, 19, 36)).toBe(28.5);
    expect(fitFont(h, 264, 19, 36)).toBe(25);
    expect(h(fitFont(h, 300, 19, 36) + 0.5)).toBeGreaterThan(300);
  });

  it("stays at the least size when even that does not fit, at the most when that does", () => {
    expect(fitFont(h, 100, 19, 36)).toBe(19);
    expect(fitFont(h, 204, 19, 36)).toBe(19);
    expect(fitFont(h, 374, 19, 36)).toBe(36);
    expect(fitFont(h, 9999, 19, 36)).toBe(36);
  });
});

describe("the wiring", () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8");
  const MODEL = read("components", "image-view", "useImageViewModel.ts");
  const CSS = read("components", "image-view", "image-view.css");
  const PHONE = read("components", "image-view", "image-view-mobile.css");

  it("calls a prompt plain when its text is here and it has no variable, photoless when it names no photo either; then none travels, is priced or blocks Generate", () => {
    expect(MODEL).toContain("const plain = text !== null && !blank && fields.length === 0;");
    expect(MODEL).toContain("const photoless = plain && textSlots === 0;");
    expect(MODEL).toContain("const sent = photoless || photosOff ? [] : refs;");
    expect(MODEL).toContain("const slots = refSlots(cap, sent.length, photoless || photosOff ? 0 : reads.pending.length);");
    expect(MODEL).toContain("refs: sent.map((r) => r.src),");
    expect(MODEL).toContain("referenceImageCount: sent.length,");
    expect(MODEL).not.toMatch(/refSlots\(cap, refs\.length|referenceImageCount: refs\.length/);
  });

  it("calls a prompt's photos off only for a premium one the route says no for, so none travels from an old render either", () => {
    expect(MODEL).toContain('const photosOff = premium && prompt?.allowReferences === false;');
  });

  it("sets the words at 1.7, 62 characters wide, 18 px above (14 on the phone) and 10 below, the editor's frame only with the focus", () => {
    expect(CSS).toContain(".iv-plain { position: relative; display: flex; flex-direction: column; gap: 10px; padding: 18px 0 10px; animation: iv-in-l 0.3s cubic-bezier(0.3, 0.7, 0.3, 1); }");
    expect(PHONE).toContain(".iv-mobile .iv-plain { padding: 14px 0 10px; }");
    expect(CSS).toContain(".iv-plain-words { max-width: calc(62ch + 18px); margin: -7px -9px; font-size: var(--iv-fs); }");
    // .iv-pm sets its own --kit-fs: the fitted size reaches the editor under another name.
    expect(CSS).toContain(".iv-pm { --kit-fs: 14.5px;");
    expect(CSS).toContain(".iv-plain-words .iv-pm { --kit-fs: var(--iv-fs); --kit-lh: 1.7; --kit-pad: 6px 8px; --kit-radius: 10px; }");
    expect(CSS).toContain(".iv-plain-words .kit-pm-text { border-color: transparent; background: transparent; }");
    expect(CSS).toContain(".iv-plain-words .kit-pm-text:focus { border-color: var(--enki-rule); }");
  });

  it("measures the probe as the field: its frame, its type and its measure, out of sight", () => {
    const rule = CSS.slice(CSS.indexOf(".iv-plain-probe {"), CSS.indexOf("}", CSS.indexOf(".iv-plain-probe {")));
    for (const d of ["left: -9px;", "width: calc(100% + 18px);", "max-width: calc(62ch + 18px);", "padding: 6px 8px;", "border: 1px solid transparent;",
      "font: 400 19px/1.7 var(--font-sans), sans-serif;", "letter-spacing: normal;", "white-space: pre-wrap;", "overflow-wrap: break-word;",
      "box-sizing: border-box;", "position: absolute;", "visibility: hidden;"]) expect(rule).toContain(d);
  });

  // The frame reaches 9 px past the text on each side: the scrollers hold it, neither clipped nor panning sideways.
  it("gives the words' frame room in both scrollers", () => {
    expect(CSS).toContain(".iv-v2 .iv-left-scroll { margin-left: -9px; padding: 0 10px 10px 9px; }");
    expect(PHONE).toMatch(/\.iv-mscroll \{[^}]*margin: 0 -9px;\n\s+padding: 0 9px 10px;/);
  });

  // The agent row left the scroller (DEC-346); a hovered tile lifts as everywhere, by :hover alone.
  it("keeps no rule for the agent row in the scroller, nor a linked tile's lift", () => {
    expect(CSS).not.toContain(".iv-left-scroll > .iv-agent");
    expect(CSS).not.toMatch(/data-lit|data-lift/);
  });
});
