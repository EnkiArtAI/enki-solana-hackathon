import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { growFrom, zoomBox } from "@/lib/ui/image-view/zoom";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";

/**
 * The photo zoom (image UI v2, handoff §5.15, README §5.8, plan B12): an own
 * photo grows from its tile to its own size, centred, and shrinks back on close.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], refs: [] as { current: unknown }[], s: 0, r: 0, effects: [] as (() => unknown)[] }));
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
  // Kept, not run: a test runs the one it needs.
  useEffect: (run: () => unknown) => { ui.effects.push(run); },
  useLayoutEffect: () => {},
  useEffectEvent: <F>(f: F) => f,
}));
vi.mock("react-dom", async (original) => ({ ...(await original<typeof import("react-dom")>()), createPortal: (node: ReactNode) => node }));

import Zoom from "@/components/image-view/Zoom";
import PhotoDeck from "@/components/image-view/PhotoDeck";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => el.props.className === name);
const tile = { left: 100, top: 600, width: 66, height: 66 };
beforeEach(() => {
  ui.state = []; ui.refs = []; ui.effects = [];
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { body: {} });
});

describe("the zoom", () => {
  const draw = (onClose = vi.fn(), phone = false) => { ui.s = 0; ui.r = 0; return Zoom({ src: "/p.png", n: 2, from: tile, phone, onClose }) as El; };

  it("paints the square on its tile first, then grows it into the middle with its number", () => {
    const frame = { left: 0, top: 0, width: 1440, height: 900 };
    const box = zoomBox(frame, false);
    let img = byClass(draw(), "iv-zoom-img")[0];
    expect(img.props.style).toMatchObject({ ...box, backgroundImage: 'url("/p.png")', transform: growFrom(frame, tile, box) });
    expect(box.width).toBe(560);
    expect(byClass(draw(), "iv-zoom-x kit-hit")).toHaveLength(0);
    ui.state[0] = "open";
    img = byClass(draw(), "iv-zoom-img")[0];
    expect((img.props.style as { transform: string }).transform).toBe("none");
    expect(byClass(draw(), "iv-zoom-n")[0].props.children).toBe(2);
    expect(byClass(draw(), "iv-zoom-x kit-hit")).toHaveLength(1);
  });

  // Kev, 2026-10-29: "i want to see the images in its correct size ... also up to vollbild natürlich".
  it("opens at once as the square, takes the photo's own size once read, and stays the square without one", () => {
    const pics: { src?: string; naturalWidth: number; naturalHeight: number; onload: (() => void) | null }[] = [];
    vi.stubGlobal("Image", class { naturalWidth = 3000; naturalHeight = 1000; onload = null; constructor() { pics.push(this as never); } });
    vi.useFakeTimers();
    try {
      // Zoom's effects, in order: focus, read, resize, open, out, Esc.
      const effects = () => { ui.effects = []; const tree = draw(); return { tree, read: ui.effects[1], open: ui.effects[3] }; };
      let { tree, read, open } = effects();
      expect(byClass(tree, "iv-zoom-img")[0].props.style).toMatchObject({ width: 560, height: 560 });
      // A slow photo: it opens anyway, 30 ms on, as the square (review 2026-10-29: no unseen layer over the page).
      open();
      vi.advanceTimersByTime(30);
      expect(ui.state[0]).toBe("open");
      const stop = read() as () => void;
      expect(pics[0].src).toBe("/p.png");
      pics[0].onload!();
      expect(ui.state[1]).toEqual({ width: 3000, height: 1000 });
      ({ tree } = effects());
      expect(byClass(tree, "iv-zoom-img")[0].props.style).toMatchObject({ left: 24, top: 218, width: 1392, height: 464, transform: "none" });
      stop();
      expect(pics[0].onload).toBeNull();
      // A picture without its own pixels (an SVG without a size) keeps the square, either side.
      for (const zero of [{ naturalWidth: 0 }, { naturalHeight: 0 }]) {
        ui.state = [];
        ({ read } = effects());
        read();
        Object.assign(pics[pics.length - 1], zero);
        pics[pics.length - 1].onload!();
        expect(ui.state[1], JSON.stringify(zero)).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures the window again on a resize, so an open photo stays centred in it", () => {
    ui.effects = [];
    draw();
    const stop = ui.effects[2]() as () => void;
    const on = vi.mocked(window.addEventListener).mock.calls.find(([type]) => type === "resize")![1] as () => void;
    ui.state[1] = { width: 3000, height: 1000 };
    ui.state[2] = 0;
    on();
    expect(ui.state[2]).toBe(1);
    Object.assign(window, { innerWidth: 720 });
    expect(byClass(draw(), "iv-zoom-img")[0].props.style).toMatchObject({ left: 24, top: 338, width: 672, height: 224 });
    stop();
    expect(window.removeEventListener).toHaveBeenCalledWith("resize", on);
  });

  // Review 2026-10-29: a size that arrived while on the tile moved the box under the square's transform.
  it("moves nothing while on its tile; open, the square grows on into a late size", () => {
    const css = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
    expect(css).toContain(".iv-zoom[data-phase=\"in\"] .iv-zoom-img { transition: none; }");
    expect(css).toContain("transition: transform 0.34s cubic-bezier(0.3, 0.7, 0.3, 1), left 0.34s ease, top 0.34s ease, width 0.34s ease, height 0.34s ease;");
  });

  it("is 350 at most on a phone", () => {
    expect((byClass(draw(vi.fn(), true), "iv-zoom-img")[0].props.style as { width: number }).width).toBe(350);
  });

  it("shrinks back from a click on it, on the backdrop or on close", () => {
    for (const name of ["iv-zoom-img", "iv-zoom-backdrop", "iv-zoom-x kit-hit"]) {
      ui.state[0] = "open";
      (byClass(draw(), name)[0].props.onClick as () => void)();
      expect(ui.state[0], name).toBe("out");
    }
  });
});

describe("an own photo tile", () => {
  const model = { refs: [{ id: "p1", src: "/p1.png" }], pending: [], slotTotal: 2, cap: 14, room: 13, accept: "image/*", addFiles: vi.fn(), removeSlot: vi.fn(), replacePhoto: vi.fn() } as unknown as ImageViewModel;
  const draw = (phone = false) => { ui.s = 0; ui.r = 0; return PhotoDeck({ model, phone }) as El; };
  const tap = (tree: El) => (byClass(tree, "iv-photo-pick")[0].props.onClick as (e: unknown) => void)({ currentTarget: { getBoundingClientRect: () => tile } });
  // PhotoDeck's own state: area, hot, over, zoom.
  const zoom = () => ui.state[3] as { i: number; from: typeof tile } | null;

  it("zooms on a click on desktop", () => {
    tap(draw());
    expect(zoom()).toEqual({ i: 0, from: tile });
    const opened = [...walk(draw())].filter((el) => el.type === Zoom);
    expect(opened).toHaveLength(1);
    expect(opened[0].props).toMatchObject({ src: "/p1.png", n: 1, from: tile, phone: false });
  });

  it("on a phone shows its × first and zooms on the second tap", () => {
    tap(draw(true));
    expect(zoom()).toBeNull();
    expect(ui.state[1]).toBe(0);
    tap(draw(true));
    expect(zoom()).toEqual({ i: 0, from: tile });
  });
});
