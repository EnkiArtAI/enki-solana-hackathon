import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { join } from "node:path";
import { readSource } from "../../../__tests__/_read-source";

/**
 * A prompt box sized by its edge (Kev, 2026-10-30: "the prompt box inside image and video generator must be flexible an
 * der kante. bei videos unten rechts, bei images oben nach oben"): the grip, its drag, its keys and its reset. The
 * component is called as React would render it, its state kept between calls.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], s: 0, refs: [] as { current: unknown }[], r: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i], (next: unknown) => { ui.state[i] = next; }];
  },
  useRef: <T>(current: T) => { const i = ui.r++; return (ui.refs[i] ??= { current }); },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useImperativeHandle: () => {},
  useEffectEvent: (fn: unknown) => fn,
}));

import AutosizeTextarea from "@/components/kit/AutosizeTextarea";
import { GRIP_STEP, dragHeight, gripMax } from "../autosize";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const all = (tree: ReactNode) => [...walk(tree)];
const draw = (grip?: "down" | "up", boxClassName?: string) => {
  ui.s = 0; ui.r = 0;
  return AutosizeTextarea({ value: "", onChange: () => {}, min: 40, max: 120, growOnly: false, grip, boxClassName }) as El;
};
const gripOf = (tree: ReactNode) => all(tree).find((el) => el.props.role === "separator")!;
const fieldOf = (tree: ReactNode) => all(tree).find((el) => el.type === "textarea")!;
const pointer = (clientY: number) => ({ clientY, pointerId: 7, preventDefault: vi.fn(), currentTarget: { setPointerCapture: vi.fn() } });
const keyEv = (key: string) => ({ key, preventDefault: vi.fn() });

beforeEach(() => {
  ui.state = []; ui.refs = [];
  vi.stubGlobal("window", { innerHeight: 1000 });
});
afterEach(() => vi.unstubAllGlobals());

describe("dragHeight", () => {
  it("follows the edge: down grows with a drag down, up with a drag up, held between min and max, whole pixels", () => {
    expect(dragHeight({ start: 100, dy: 30.4, edge: "down", min: 40, max: 600 })).toBe(130);
    expect(dragHeight({ start: 100, dy: -30, edge: "up", min: 40, max: 600 })).toBe(130);
    expect(dragHeight({ start: 100, dy: 30, edge: "up", min: 40, max: 600 })).toBe(70);
    expect([dragHeight({ start: 100, dy: -500, edge: "down", min: 40, max: 600 }), dragHeight({ start: 100, dy: -900, edge: "up", min: 40, max: 600 })]).toEqual([40, 600]);
  });

  it("lets a dragged box reach most of the window, or its own max where that is more", () => {
    expect([gripMax(120, 1000), gripMax(900, 1000), gripMax(320, 401)]).toEqual([600, 900, 320]);
  });
});

describe("the grip (AutosizeTextarea)", () => {
  it("is none without one asked for: the field alone, as before", () => {
    const tree = draw();
    expect((tree as El).type).toBe("textarea");
    expect(gripOf(tree)).toBeUndefined();
  });

  it("sits in a box with the field, at the edge it grows by, a focusable separator", () => {
    for (const edge of ["down", "up"] as const) {
      const tree = draw(edge, "ci-text-box");
      expect((tree as El).props.className).toBe(`kit-grow kit-grow--${edge} ci-text-box`);
      expect(gripOf(tree).props).toMatchObject({ "aria-orientation": "horizontal", "aria-label": "Resize the prompt", tabIndex: 0, className: "kit-grip" });
    }
  });

  it("takes the dragged height (up: dragged up is taller) and holds it, scrolling inside, until a double click fits the text again", () => {
    draw("up");
    const g = gripOf(draw("up"));
    const down = pointer(500);
    (g.props.onPointerDown as (e: unknown) => void)(down);
    expect([down.preventDefault.mock.calls.length, down.currentTarget.setPointerCapture.mock.calls]).toEqual([1, [[7]]]);
    (g.props.onPointerMove as (e: unknown) => void)(pointer(400));
    expect(fieldOf(draw("up")).props.style).toMatchObject({ height: 140, minHeight: 40, maxHeight: "none", overflowY: "auto" });
    expect(gripOf(draw("up")).props["aria-valuenow"]).toBe(140);
    // Released, a move no longer sizes it.
    (gripOf(draw("up")).props.onPointerUp as () => void)();
    (gripOf(draw("up")).props.onPointerMove as (e: unknown) => void)(pointer(0));
    expect(fieldOf(draw("up")).props.style).toMatchObject({ height: 140 });
    (gripOf(draw("up")).props.onDoubleClick as () => void)();
    expect(fieldOf(draw("up")).props.style).toEqual({ minHeight: 40, maxHeight: 120 });
  });

  it("goes as far as most of the window and no further, nor below the field's least", () => {
    const g = gripOf(draw("down"));
    (g.props.onPointerDown as (e: unknown) => void)(pointer(100));
    (g.props.onPointerMove as (e: unknown) => void)(pointer(5000));
    expect(fieldOf(draw("down")).props.style).toMatchObject({ height: 600 });
    (gripOf(draw("down")).props.onPointerMove as (e: unknown) => void)(pointer(-5000));
    expect(fieldOf(draw("down")).props.style).toMatchObject({ height: 40 });
  });

  it("moves by the arrow pointing its way to grow, back by the other, and lets other keys be", () => {
    for (const [edge, taller, shorter] of [["down", "ArrowDown", "ArrowUp"], ["up", "ArrowUp", "ArrowDown"]] as const) {
      ui.state = []; ui.refs = [];
      const press = (k: string) => { const e = keyEv(k); (gripOf(draw(edge)).props.onKeyDown as (e: unknown) => void)(e); return e; };
      press(taller);
      expect(fieldOf(draw(edge)).props.style).toMatchObject({ height: 40 + GRIP_STEP });
      press(taller);
      press(shorter);
      expect(fieldOf(draw(edge)).props.style).toMatchObject({ height: 40 + GRIP_STEP });
      const other = press("Enter");
      expect([other.preventDefault.mock.calls.length, fieldOf(draw(edge)).props.style]).toEqual([0, expect.objectContaining({ height: 40 + GRIP_STEP })]);
    }
  });
});

describe("the grip's look", () => {
  const css = readSource(join(__dirname, "..", "..", "..", "..", "components", "kit", "kit-media.css"));
  // Kev, 2026-10-30: "warum kann ich nicht an der oberen kante der prompt box das nicht hoch ziehen? das an oben rechts
  // ecke geht auch nicht". The whole edge takes the drag; and the field keeps its own height in the grip's column, where
  // a caller's flex: 1 (.ci-text) had sized it (bench: style 200px, drawn 40).
  it("takes the drag along the whole edge, the strokes at its right end, at the foot growing down and the top growing up", () => {
    expect(css).toMatch(/\.kit-grip \{[^}]*left: 0; right: 0;[^}]*justify-content: flex-end;[^}]*height: 12px;[^}]*cursor: ns-resize; touch-action: none;/);
    expect(css).toContain(".kit-grow--down > .kit-grip { bottom: -6px; }");
    expect(css).toContain(".kit-grow--up > .kit-grip { top: -6px; }");
    expect(css).toMatch(/@media \(pointer: coarse\) \{\n  \.kit-grip \{ height: 24px; \}\n  \.kit-grow--down > \.kit-grip \{ bottom: -12px; \}\n  \.kit-grow--up > \.kit-grip \{ top: -12px; \}/);
  });

  it("lets the field keep its own height in the grip's box, whatever flex its caller gave it, by a stronger rule", () => {
    expect(css).toContain(".kit-grow > textarea.kit-autosize { flex: none; width: 100%; }");
    // The bar's own rule for the field it has to beat: two classes, so the grip's needs two classes and an element.
    const feed = readSource(join(__dirname, "..", "..", "..", "..", "components", "enki", "feed.css"));
    expect(feed).toMatch(/\.feed-create-image \.ci-text \{\n  flex: 1;/);
  });
});
