import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ImageViewModel, Shot } from "@/components/image-view/useImageViewModel";

/**
 * The hero's arrows and swipe (image UI v2, handoff §5.10, S:328-329, S:627):
 * the previous or next example or public image, no wrap at the ends; the
 * arrived picture slides in from its side; a swipe never opens the viewer.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], refs: [] as { current: unknown }[], s: 0, r: 0, effects: [] as (() => (() => void) | void)[] }));
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
  useEffect: (run: () => (() => void) | void) => { ui.effects.push(run); },
}));

import HeroNav from "@/components/image-view/HeroNav";
import { heroKey } from "@/lib/ui/image-view/hero-keys";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const shot = (key: string, kind: Shot["kind"] = "example") => ({ key, kind }) as Shot;
let model: ImageViewModel;
const draw = () => { ui.s = 0; ui.r = 0; return HeroNav({ model, children: "picture" }) as El; };
const arrow = (tree: El, side: string) => [...walk(tree)].find((el) => el.props["data-side"] === side)!;
const slide = (tree: El) => [...walk(tree)].find((el) => el.props.className === "iv-hero-slide")!;
beforeEach(() => {
  ui.state = []; ui.refs = []; ui.effects = [];
  model = { examples: [shot("e0"), shot("e1")], community: [shot("c0", "community")], main: shot("e1"), select: vi.fn((s: Shot) => { model.main = s; }) } as unknown as ImageViewModel;
});

describe("the hero's arrows", () => {
  it("step through the examples, then the public images, and stop at both ends", () => {
    (arrow(draw(), "right").props.onClick as () => void)();
    expect(model.select).toHaveBeenLastCalledWith(model.community[0]);
    expect(arrow(draw(), "right").props.disabled).toBe(true);
    model.main = model.examples[0];
    expect(arrow(draw(), "left").props.disabled).toBe(true);
    expect(arrow(draw(), "right").props.disabled).toBe(false);
  });

  it("slide the arrived picture in from its side, and only that one", () => {
    (arrow(draw(), "left").props.onClick as () => void)();
    expect(slide(draw()).props["data-dir"]).toBe("l");
    expect(slide(draw()).key).toBe("e0");
    model.main = model.community[0];
    expect(slide(draw()).props["data-dir"]).toBeUndefined();
  });

  it("are not there for a picture that is not one of them, nor for a single one", () => {
    model.main = shot("history:1", "history");
    expect(arrow(draw(), "left")).toBeUndefined();
    model.examples = [shot("e0")]; model.community = []; model.main = model.examples[0];
    expect(arrow(draw(), "right")).toBeUndefined();
  });
});

describe("a swipe", () => {
  const swipe = (dx: number) => {
    const root = draw();
    (root.props.onPointerDown as (e: unknown) => void)({ clientX: 200 });
    (root.props.onPointerUp as (e: unknown) => void)({ clientX: 200 + dx });
    return root;
  };

  it("of more than 40 px steps the other way it moved, and the click it ends with opens nothing", () => {
    swipe(-60);
    expect(model.select).toHaveBeenLastCalledWith(model.community[0]);
    const click = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (draw().props.onClickCapture as (e: unknown) => void)(click);
    expect(click.stopPropagation).toHaveBeenCalledOnce();
    const next = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (draw().props.onClickCapture as (e: unknown) => void)(next);
    expect(next.stopPropagation).not.toHaveBeenCalled();
  });

  it("past either end goes nowhere: no wrap", () => {
    model.main = model.community[0];
    swipe(-60);
    expect(model.select).not.toHaveBeenCalled();
    model.main = model.examples[0];
    swipe(60);
    expect(model.select).not.toHaveBeenCalled();
  });

  it("of 40 px or less is a tap: nothing steps and the click goes through", () => {
    swipe(-40);
    expect(model.select).not.toHaveBeenCalled();
    const click = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (draw().props.onClickCapture as (e: unknown) => void)(click);
    expect(click.stopPropagation).not.toHaveBeenCalled();
    swipe(60);
    expect(model.select).toHaveBeenLastCalledWith(model.examples[0]);
  });
});

/** Kev (2026-10-21): ← and → move the images outside a text field. */
describe("the arrow keys", () => {
  const calm = { typing: false, modified: false, overlay: false, shown: true };

  it("step back and on, and do nothing in a field, with a modifier, under a dialog or while the hero is hidden", () => {
    expect([heroKey("ArrowLeft", calm), heroKey("ArrowRight", calm), heroKey("ArrowUp", calm), heroKey("a", calm)]).toEqual([-1, 1, 0, 0]);
    for (const over of [{ typing: true }, { modified: true }, { overlay: true }, { shown: false }]) {
      expect(heroKey("ArrowRight", { ...calm, ...over })).toBe(0);
    }
  });

  const press = (key: string, o: { field?: string; dialog?: boolean; shown?: boolean; veiled?: boolean; prevented?: boolean } = {}) => {
    let listener: ((e: unknown) => void) | undefined;
    vi.stubGlobal("window", { addEventListener: (_: string, l: (e: unknown) => void) => { listener = l; }, removeEventListener: vi.fn() });
    vi.stubGlobal("document", { querySelector: () => (o.dialog ? {} : null) });
    vi.stubGlobal("HTMLElement", class {});
    // A shell panel over the view: .iv-frame.is-hidden, visibility hidden.
    vi.stubGlobal("getComputedStyle", () => ({ visibility: o.veiled ? "hidden" : "visible" }));
    ui.effects = [];
    // The third ref is the hero's box: on screen unless told otherwise.
    ui.refs[2] = { current: { getClientRects: () => (o.shown === false ? [] : [{}]) } };
    draw();
    ui.effects.at(-1)!();
    const target = o.field ? Object.assign(Object.create((globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype), { tagName: o.field, isContentEditable: o.field === "DIV" }) : null;
    const e = { key, target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: !!o.prevented, preventDefault: vi.fn() };
    listener!(e);
    vi.unstubAllGlobals();
    return e;
  };

  it("move the hero as its arrows do, and claim the key", () => {
    const e = press("ArrowLeft");
    expect(model.select).toHaveBeenLastCalledWith(model.examples[0]);
    expect(e.preventDefault).toHaveBeenCalled();
    press("ArrowRight");
    expect(model.select).toHaveBeenLastCalledWith(model.examples[1]);
  });

  it("leave the hero alone under a dialog, while hidden or under a panel, once the key is taken, or on a picture that is not one of them", () => {
    press("ArrowLeft", { dialog: true });
    press("ArrowLeft", { shown: false });
    press("ArrowLeft", { veiled: true });
    press("ArrowLeft", { prevented: true });
    press("ArrowLeft", { field: "TEXTAREA" });
    press("ArrowLeft", { field: "DIV" });
    model.main = shot("history:1", "history");
    press("ArrowRight");
    expect(model.select).not.toHaveBeenCalled();
  });
});
