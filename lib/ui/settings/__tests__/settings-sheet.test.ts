import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { CARD, PILL } from "@/components/enki-window";

/**
 * Settings' sheet (the mock v64's SHEETS frame, Main.dc.html:447-558; DEC-2026-11-08-43): the shell's veil, a window's
 * frame, its own scroller, a form step and a done step. The step-up dialog ("Confirm it's you") opens over it, so the
 * sheet hears Esc after the layers on top and keeps it from the panel under it (lib/__tests__/esc-top-layer.test.ts
 * lists it with the layers that stay open under others). The sheet is called as React would render it: its refs kept,
 * its effects run by hand, the portal in place.
 */
const ui = vi.hoisted(() => ({
  refs: [] as { current: unknown }[], r: 0, effects: [] as { run: () => (() => void) | void; deps?: unknown[] }[],
  lock: { calls: 0, released: 0 }, portal: [] as unknown[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: <T>(start: T) => (ui.refs[ui.r++] ??= { current: start }),
  useEffect: (run: () => (() => void) | void, deps?: unknown[]) => { ui.effects.push({ run, deps }); },
  useEffectEvent: <T>(fn: T) => fn,
  useId: () => "sheet-title",
}));
vi.mock("react-dom", () => ({ createPortal: (node: unknown, target: unknown) => { ui.portal.push(target); return node; } }));
vi.mock("@/lib/ui/kit/controls", async (original) => ({
  ...(await original<typeof import("@/lib/ui/kit/controls")>()),
  lockScroll: () => { ui.lock.calls++; return () => { ui.lock.released++; }; },
}));

import SettingsSheet from "@/components/settings/SettingsSheet";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const find = (tree: ReactNode, test: (el: El) => boolean) => [...walk(tree)].filter(test);
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join(" ") : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);

const page = { listeners: [] as { type: string; fn: (e: unknown) => void; capture: boolean }[], active: null as unknown, body: { tag: "body" } };
const focusable = (name: string) => ({ name, focus: vi.fn(() => { page.active = focusable.last = name; }) });
focusable.last = "";

beforeEach(() => {
  ui.refs = []; ui.r = 0; ui.effects = []; ui.lock = { calls: 0, released: 0 }; ui.portal = [];
  page.listeners = []; page.active = page.body;
  vi.stubGlobal("document", {
    get activeElement() { return page.active; },
    body: page.body,
    documentElement: { style: {} },
    addEventListener: (type: string, fn: (e: unknown) => void, capture?: boolean) => page.listeners.push({ type, fn, capture: !!capture }),
    removeEventListener: (type: string, fn: (e: unknown) => void) => { page.listeners = page.listeners.filter((l) => l.type !== type || l.fn !== fn); },
  });
  vi.stubGlobal("window", { innerWidth: 1440 });
});
afterEach(() => vi.unstubAllGlobals());

const render = (props: Partial<Parameters<typeof SettingsSheet>[0]> = {}) => {
  ui.r = 0;
  ui.effects = [];
  return SettingsSheet({ title: "Add funds", onClose: vi.fn(), children: createElement("p", { id: "form" }, "the form"), ...props }) as El;
};
const dialogOf = (tree: El) => find(tree, (el) => el.props.role === "dialog")[0];

describe("Esc", () => {
  it("is heard on the document as it bubbles: after a dialog on top took it, before the panel under the sheet", () => {
    const onClose = vi.fn();
    render({ onClose });
    const leave = ui.effects[0].run() as () => void;
    expect(page.listeners.map(({ type, capture }) => [type, capture])).toEqual([["keydown", false]]);
    const press = (over: Record<string, unknown> = {}) => {
      const e = { key: "Escape", defaultPrevented: false, stopPropagation: vi.fn(), ...over };
      page.listeners[0].fn(e);
      return e;
    };
    // The step-up dialog on top closed itself with it (Radix marks it used): the sheet stays, and the Esc goes on.
    const used = press({ defaultPrevented: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(used.stopPropagation).not.toHaveBeenCalled();
    // An Esc for the sheet closes the sheet alone.
    const mine = press();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mine.stopPropagation).toHaveBeenCalledTimes(1);
    press({ key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
    leave();
    expect(page.listeners).toEqual([]);
  });
});

describe("the page behind", () => {
  it("does not scroll while the sheet is up, and gets its focus back on the opener once it closes", () => {
    const opener = { focus: vi.fn(), isConnected: true };
    page.active = opener;
    render();
    const leave = ui.effects[0].run() as () => void;
    expect(ui.lock).toEqual({ calls: 1, released: 0 });
    leave();
    expect(ui.lock).toEqual({ calls: 1, released: 1 });
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("leaves the focus alone when the opener left the page", () => {
    const opener = { focus: vi.fn(), isConnected: false };
    page.active = opener;
    render();
    (ui.effects[0].run() as () => void)();
    expect(opener.focus).not.toHaveBeenCalled();
  });

  it("is mounted once: the keys, the lock and the focus belong to the sheet's life, not to each render", () => {
    render();
    expect(ui.effects[0].deps).toEqual([]);
  });
});

describe("the focus inside", () => {
  it("starts on the field marked data-autofocus, else the first control, else the sheet itself, and again on each step", () => {
    const tree = render();
    const box = dialogOf(tree).props.ref as { current: unknown };
    const field = focusable("field"), first = focusable("first");
    const self = { focus: vi.fn() };
    box.current = { ...self, querySelector: (sel: string) => (sel === "[data-autofocus]" ? field : first) };
    ui.effects[1].run();
    expect(field.focus).toHaveBeenCalledWith({ preventScroll: true });
    box.current = { ...self, querySelector: (sel: string) => (sel === "[data-autofocus]" ? null : first) };
    ui.effects[1].run();
    expect(first.focus).toHaveBeenCalledWith({ preventScroll: true });
    box.current = { ...self, querySelector: () => null };
    ui.effects[1].run();
    expect(self.focus).toHaveBeenCalledWith({ preventScroll: true });
    // Keyed by the step: the done step takes the focus to its Done.
    expect(ui.effects[1].deps).toEqual(["form"]);
    render({ done: { title: "Done", lines: [] } });
    expect(ui.effects[1].deps).toEqual(["done"]);
  });

  it("stays inside: Tab wraps last to first, Shift+Tab first to last, and from outside it enters at the near end", () => {
    const dialog = dialogOf(render());
    const [a, b, c] = ["a", "b", "c"].map(focusable);
    let asked = "";
    const tab = (shiftKey: boolean) => {
      const e = { key: "Tab", shiftKey, preventDefault: vi.fn(), currentTarget: { querySelectorAll: (sel: string) => { asked = sel; return [a, b, c]; } } };
      (dialog.props.onKeyDown as (e: unknown) => void)(e);
      return e;
    };
    page.active = c;
    expect(tab(false).preventDefault).toHaveBeenCalled();
    expect(focusable.last).toBe("a");
    page.active = a;
    tab(true);
    expect(focusable.last).toBe("c");
    page.active = b;
    tab(false);
    expect(focusable.last).toBe("c");
    page.active = page.body;
    tab(false);
    expect(focusable.last).toBe("a");
    page.active = page.body;
    tab(true);
    expect(focusable.last).toBe("c");
    expect(asked).toContain("button:not(:disabled)");
    expect(asked).toContain('[tabindex]:not([tabindex="-1"])');
    const other = { key: "a", shiftKey: false, preventDefault: vi.fn(), currentTarget: { querySelectorAll: () => [a] } };
    (dialog.props.onKeyDown as (e: unknown) => void)(other);
    expect(other.preventDefault).not.toHaveBeenCalled();
  });
});

describe("the frame", () => {
  it("is a modal dialog named by its title, in a window's frame at the sheet's width, on the shell's veil", () => {
    const tree = render();
    expect(String(tree.props.className).split(" ")).toContain("ek-modal-scrim");
    const dialog = dialogOf(tree);
    expect(dialog.props).toMatchObject({ "aria-modal": "true", "aria-labelledby": "sheet-title", tabIndex: -1 });
    // The mock's 24 px veil all round (Main.dc.html:450: max-height calc(100vh - 48px)); the scroller is inside.
    expect(dialog.props.style).toMatchObject({ ...CARD, maxWidth: 520, maxHeight: "calc(100vh - 48px)", overflowY: "hidden", borderWidth: 1, borderStyle: "solid" });
    expect(dialogOf(render({ width: 640 })).props.style).toMatchObject({ maxWidth: 640 });
    const [title] = find(tree, (el) => el.props.id === "sheet-title");
    expect(title.type).toBe("h2");
    expect(title.props).toMatchObject({ className: "ek-modal-title", children: "Add funds" });
  });

  it("closes from its round corner, and from the veil only when the press began and ended on it", () => {
    const onClose = vi.fn();
    const tree = render({ onClose });
    const [x] = find(tree, (el) => el.type === "button" && el.props["aria-label"] === "Close");
    expect(String(x.props.className).split(" ")).toContain("ek-modal-x");
    (x.props.onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
    const veil = { tag: "veil" }, card = { tag: "card" };
    const down = tree.props.onPointerDown as (e: unknown) => void, click = tree.props.onClick as (e: unknown) => void;
    // A text selection begun in the card and let go on the veil.
    down({ target: card, currentTarget: veil });
    click({ target: veil, currentTarget: veil });
    expect(onClose).toHaveBeenCalledTimes(1);
    // A click in the card.
    down({ target: card, currentTarget: veil });
    click({ target: card, currentTarget: veil });
    expect(onClose).toHaveBeenCalledTimes(1);
    // A click on the veil.
    down({ target: veil, currentTarget: veil });
    click({ target: veil, currentTarget: veil });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows the form, or once it is done the done step instead: a mark, a title, its lines and Done, which closes it", () => {
    const form = render();
    expect(find(form, (el) => el.props.id === "form")).toHaveLength(1);
    const onClose = vi.fn();
    const done = render({ onClose, done: { title: "$20 added", lines: ["The dollars are in your wallet.", "Go make something."] } });
    expect(find(done, (el) => el.props.id === "form")).toHaveLength(0);
    const [step] = find(done, (el) => el.props.role === "status");
    expect(text(step)).toContain("$20 added");
    expect(text(step)).toContain("The dollars are in your wallet.");
    expect(text(step)).toContain("Go make something.");
    const [ok] = find(step, (el) => el.type === "button");
    expect(text(ok)).toBe("Done");
    expect(ok.props["data-autofocus"]).toBe(true);
    expect(ok.props.style).toMatchObject({ ...PILL, width: "auto", padding: "0 24px" });
    (ok.props.onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is drawn on the page's body, over the panel's own layers; with no page (a test's document) in place", () => {
    render();
    expect(ui.portal).toEqual([page.body]);
    vi.stubGlobal("document", undefined);
    expect(dialogOf(render())).toBeDefined();
    expect(ui.portal).toEqual([page.body]);
  });
});

describe("its stylesheet", () => {
  const css = readFileSync("components/settings/areas.css", "utf8").replace(/\/\*[^]*?\*\//g, "");
  const rule = (selector: string) => {
    const body = css.match(new RegExp(`\\n${selector.replace(/[.()[\]*+?:]/g, "\\$&")} \\{([^}]*)\\}`))?.[1];
    if (body === undefined) throw new Error(`no rule ${selector}`);
    return body;
  };

  it("scrolls inside the frame as the mock does: its padding and gap, a thin bar in the theme's photo ring, ember under the mouse", () => {
    expect(rule(".sa-sheet-body")).toContain("overflow: auto;");
    expect(rule(".sa-sheet-body")).toContain("padding: 24px 22px 28px 28px;");
    expect(rule(".sa-sheet-body")).toContain("gap: 18px;");
    expect(rule(".sa-sheet-body::-webkit-scrollbar-thumb")).toContain("background: var(--enki-photo-ring);");
    expect(rule(".sa-sheet-body::-webkit-scrollbar-thumb:hover")).toContain("background: var(--enki-ember);");
    expect(css).toMatch(/@supports not selector\(::-webkit-scrollbar\) \{\n\s+\.sa-sheet-body \{ scrollbar-width: thin; scrollbar-color: var\(--enki-photo-ring\) transparent; \}/);
  });

  it("marks done in the theme's green on the settings badge's tint", () => {
    expect(rule(".sa-done-mark")).toContain("background: rgba(31, 138, 91, 0.1);");
    expect(rule(".sa-done-mark")).toContain("color: var(--enki-green);");
    expect(readFileSync("components/settings/settings.css", "utf8")).toMatch(/\.set-badge-good \{[^}]*background: rgba\(31, 138, 91, 0\.1\);/);
  });

  it("is the Settings root's container, so the phone layout follows the panel's width, not the window's", () => {
    expect(rule(".sa")).toContain("container-type: inline-size;");
    expect(rule(".sa")).toContain("container-name: settings;");
  });

  it("names no colour of its own: tokens, the badge tint, and the white plate the card brands are drawn on", () => {
    const literals = [...css.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map((m) => m[0]);
    expect([...new Set(literals)].sort()).toEqual(["#fff", "rgba(31, 138, 91, 0.1)"]);
    expect(css.match(/#fff\b/g)).toHaveLength(1);
    expect(rule(".sa-prov-badge")).toContain("background: #fff;");
  });

  it("moves nothing for someone who asked for less motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n\s+\.sa-sheet \{ animation: none; \}\n\s+\.sa-prov \{ transition: none; \}/);
  });
});
