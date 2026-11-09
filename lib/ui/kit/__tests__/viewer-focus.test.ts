import { afterEach, expect, it, vi } from "vitest";

/**
 * The fullscreen viewer gives the focus back to what opened it. React's
 * development run mounts its effects twice (StrictMode): the second run found
 * the viewer's own Close focused and took it for the opener, so Esc left the
 * focus nowhere (bench 2026-10-26: body after Esc, from the stage and from a
 * render notice alike).
 */
const ui = vi.hoisted(() => ({ refs: [] as { current: unknown }[], r: 0, effects: [] as (() => (() => void) | void)[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  // A ref lives as long as the component, across both of the development run's mounts.
  useRef: <T>(start: T) => (ui.refs[ui.r++] ??= { current: start }),
  useState: <T>(start: T) => [start, () => {}],
  useEffect: (run: () => (() => void) | void) => { ui.effects.push(run); },
  useLayoutEffect: () => {},
  useEffectEvent: <T>(fn: T) => fn,
}));
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));
vi.mock("@/lib/ui/kit/controls", () => ({ lockScroll: () => () => {}, trapStep: () => 0 }));

import FullscreenViewer from "@/components/kit/FullscreenViewer";

afterEach(() => vi.unstubAllGlobals());

it("gives the focus back to what opened it, though React mounts its effects twice", () => {
  const body = {};
  let active: unknown;
  const stage = { focus: vi.fn(() => { active = stage; }) };
  const close = { focus: vi.fn(() => { active = close; }) };
  active = stage;
  vi.stubGlobal("document", { get activeElement() { return active; }, body, documentElement: {}, querySelector: () => null });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 1440 });
  FullscreenViewer({ items: [{ key: "a", src: "/a.png" }], index: 0, onIndex: vi.fn(), onClose: vi.fn(), layout: "side", nav: "thumbs", panel: null });
  // Its second ref is Close's.
  ui.refs[1].current = close;
  const [mount] = ui.effects;
  // The development run: mount, unmount, mount again; Close holds the focus from the first mount on.
  (mount() as () => void)();
  const leave = mount() as () => void;
  expect(active).toBe(close);
  // Esc: the viewer is gone, the focus with it.
  active = body;
  leave();
  expect(active).toBe(stage);
});
