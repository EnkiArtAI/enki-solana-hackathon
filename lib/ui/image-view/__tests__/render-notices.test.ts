import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ImageViewModel, Shot } from "@/components/image-view/useImageViewModel";

/**
 * A finished render announces itself wherever the reader is on the site
 * (Kev, 2026-10-26): a notice at the top right; a click leads straight to the
 * image, in the Image View that shows its prompt or on the prompt's page; the
 * viewer's Esc or close leaves it on that view's stage (desktop-v2 tests).
 */
const ui = vi.hoisted(() => ({
  effects: [] as (() => (() => void) | void)[], state: [] as unknown[], s: 0,
  phone: false, away: false, push: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
  useEffect: (run: () => (() => void) | void) => { ui.effects.push(run); },
  useEffectEvent: <T>(fn: T) => fn,
  // Each store's own snapshot: the phone and the tab's state come from the window and document each test sets.
  useSyncExternalStore: <T>(_sub: unknown, get: () => T) => get(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: ui.push }) }));

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => el.props.className === name);

type Store = typeof import("@/lib/ui/kit/render-notices");
let store: Store;
let RenderNotices: () => unknown;
let useOpenRender: typeof import("@/components/image-view/useOpenRender").useOpenRender;
beforeEach(async () => {
  // A fresh store each test: it lives in its module.
  vi.resetModules();
  store = await import("@/lib/ui/kit/render-notices");
  ({ default: RenderNotices } = await import("@/components/kit/RenderNotices"));
  ({ useOpenRender } = await import("@/components/image-view/useOpenRender"));
  ui.state = []; ui.effects = []; ui.phone = false; ui.away = false; ui.push.mockClear();
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { get hidden() { return ui.away; } });
  stored.clear();
  vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); } });
});
// This device's storage, as each test sets it.
const stored = new Map<string, string>();
// A phone is the app's own phone query matching.
const win = { matchMedia: (q: string) => ({ matches: ui.phone && q === "(max-width: 1023.98px)" }) };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const notice = (id: string, promptId: string | null = "p1") => ({ key: `job:${id}`, src: `/r/${id}.png`, promptId, title: "Marble portrait" });
// As React draws them: the list, then each notice (its held state, its timer).
const draw = () => {
  ui.s = 0; ui.effects = [];
  const tree = RenderNotices() as El;
  const notices = [tree.props.children].flat().map((el) => { const n = el as El; return (n.type as (p: unknown) => El)(n.props); });
  return { tree, notices };
};

describe("the store of finished renders", () => {
  it("keeps the three newest, each once, newest first, and tells its listeners", () => {
    const heard = vi.fn();
    const stop = store.subscribeRenders(heard);
    for (const id of ["a", "b", "c", "d"]) store.announceRender(notice(id));
    store.announceRender(notice("c"));
    expect(store.renderNotices().map((n) => n.key)).toEqual(["job:c", "job:d", "job:b"]);
    store.dismissRender("job:d");
    store.dismissRender("job:zzz");
    expect(store.renderNotices().map((n) => n.key)).toEqual(["job:c", "job:b"]);
    expect(heard).toHaveBeenCalledTimes(6);
    stop();
    store.announceRender(notice("e"));
    expect(heard).toHaveBeenCalledTimes(6);
  });

  it("holds the render a notice opened a prompt's page for, for that prompt only, until it is cleared", () => {
    store.wantRender("p1", "/r/a.png");
    expect([store.wantedRender("p2"), store.wantedRender(null), store.wantedRender("p1"), store.wantedRender("p1")]).toEqual([null, null, "/r/a.png", "/r/a.png"]);
    store.clearWantedRender();
    expect(store.wantedRender("p1")).toBeNull();
  });

  it("forgets that render after a minute, so a later visit of the prompt is never taken over", () => {
    vi.useFakeTimers();
    store.wantRender("p1", "/r/a.png");
    vi.advanceTimersByTime(store.WANT_MS - 1);
    expect(store.wantedRender("p1")).toBe("/r/a.png");
    vi.advanceTimersByTime(1);
    expect(store.wantedRender("p1")).toBeNull();
    expect(store.WANT_MS).toBe(60_000);
  });
});

describe("the notices, wherever the reader is", () => {
  it("keep their live region, empty, so the first one is announced; then each with its image and title", () => {
    expect(draw().tree.props).toMatchObject({ className: "ek-ready-list", role: "region", "aria-live": "polite" });
    expect(draw().notices).toEqual([]);
    store.announceRender(notice("b"));
    store.announceRender(notice("a"));
    const { notices } = draw();
    expect(notices.map((n) => [...walk(n)].find((el) => el.type === "img")!.props.src)).toEqual(["/r/a.png", "/r/b.png"]);
    expect(byClass(notices[0], "ek-ready-text")[0].props.children).toEqual([expect.objectContaining({ props: { children: "Your render is ready" } }), expect.objectContaining({ props: { children: "Marble portrait" } })]);
  });

  it("show one at a time on a phone", () => {
    for (const id of ["c", "b", "a"]) store.announceRender(notice(id));
    expect(draw().notices).toHaveLength(3);
    ui.phone = true;
    expect(draw().notices).toHaveLength(1);
  });

  it("open in the Image View that takes the render, else on the prompt's page, a blank composer's render in the gallery", () => {
    const sent: CustomEvent[] = [];
    let taken = false;
    vi.stubGlobal("window", { ...win, dispatchEvent: (e: CustomEvent) => { sent.push(e); if (taken) e.preventDefault(); return !e.defaultPrevented; } });
    vi.stubGlobal("CustomEvent", class extends Event { detail: unknown; constructor(t: string, i: { detail: unknown; cancelable: boolean }) { super(t, i); this.detail = i.detail; } });
    store.announceRender(notice("a"));
    store.announceRender(notice("b"));
    store.announceRender(notice("c", null));
    const open = (i: number) => (byClass(draw().notices[i], "ek-ready-open")[0].props.onClick as () => void)();
    taken = true;
    open(2);
    expect([sent[0].type, sent[0].detail]).toEqual([store.OPEN_RENDER_EVENT, { promptId: "p1", src: "/r/a.png" }]);
    expect(ui.push).not.toHaveBeenCalled();
    taken = false;
    open(1);
    // Nobody took it: the prompt's page opens.
    expect(sent.slice(1).map((e) => e.type)).toEqual([store.OPEN_RENDER_EVENT]);
    expect(ui.push).toHaveBeenLastCalledWith("/home?prompt=p1");
    expect(store.wantedRender("p1")).toBe("/r/b.png");
    open(0);
    expect(ui.push).toHaveBeenLastCalledWith("/profile");
    expect(store.renderNotices()).toEqual([]);
  });

  it("let × go without opening, and go by themselves after 5 s in sight, not in a background tab or under the pointer", () => {
    vi.useFakeTimers();
    store.announceRender(notice("a"));
    (byClass(draw().notices[0], "ek-ready-x kit-hit")[0].props.onClick as () => void)();
    expect(store.renderNotices()).toEqual([]);
    store.announceRender(notice("b"));
    draw();
    ui.effects[1]();
    // Nothing chosen in Settings: 5 s (Kev, 2026-10-26).
    vi.advanceTimersByTime(4999);
    expect(store.renderNotices()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.renderNotices()).toEqual([]);
    store.announceRender(notice("c"));
    ui.away = true;
    draw();
    expect(ui.effects[1]()).toBeUndefined();
    ui.away = false;
    const [first] = draw().notices;
    (first.props.onPointerEnter as () => void)();
    draw();
    expect(ui.effects[1]()).toBeUndefined();
    const blur = first.props.onBlur as (e: unknown) => void;
    blur({ currentTarget: { contains: () => true }, relatedTarget: {} });
    expect(ui.state[0]).toBe(true);
    blur({ currentTarget: { contains: () => false }, relatedTarget: null });
    expect(ui.state[0]).toBe(false);
  });
});

describe("the reader's seconds (Settings → Profile)", () => {
  // Kev, 2026-10-26: "lass es nach 5s verschwinden. brauchen in Profil die Einstellung für den Sekundentimer."
  it("offer 3, 5 and 10 s and until closed, 5 when nothing or nothing valid is stored", () => {
    expect([store.NOTICE_SECONDS, store.noticeSeconds()]).toEqual([[3, 5, 10, 0], 5]);
    stored.set("enki:notice-seconds", "10");
    expect(store.noticeSeconds()).toBe(10);
    for (const odd of ["7", "", "abc"]) {
      stored.set("enki:notice-seconds", odd);
      expect(store.noticeSeconds()).toBe(5);
    }
  });

  it("keep a choice on this device and tell who shows it; a refused storage keeps it for the visit", () => {
    const heard = vi.fn();
    store.subscribeNoticeSeconds(heard);
    store.setNoticeSeconds(3);
    expect([stored.get("enki:notice-seconds"), store.noticeSeconds(), heard.mock.calls.length]).toEqual(["3", 3, 1]);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    store.setNoticeSeconds(10);
    expect(store.noticeSeconds()).toBe(10);
  });

  it("time each notice by the choice, and never take one away when it is until closed", () => {
    vi.useFakeTimers();
    store.setNoticeSeconds(3);
    store.announceRender(notice("a"));
    draw();
    ui.effects[1]();
    vi.advanceTimersByTime(2999);
    expect(store.renderNotices()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.renderNotices()).toEqual([]);
    store.setNoticeSeconds(0);
    store.announceRender(notice("b"));
    draw();
    expect(ui.effects[1]()).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(store.renderNotices()).toHaveLength(1);
  });

  it("are chosen in Settings → Profile, after 18+ content", () => {
    const settings = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "settings", "SettingsView.tsx"), "utf8").split("\r\n").join("\n");
    expect(settings).toContain('<SettingsSection num={no(4)} title="Notifications">');
    expect(settings).toContain("const noticeFor = useSyncExternalStore(subscribeNoticeSeconds, noticeSeconds, () => DEFAULT_NOTICE_SECONDS);");
    // A switch: the thumb glides (Kev, 2026-10-26: "wie ein schalter"), four short choices.
    expect(settings).toContain('<Segmented slide role="radiogroup" ariaLabel="How long the notice stays"');
    expect(settings).toContain('options={NOTICE_SECONDS.map((s) => (s ? { key: String(s), label: `${s} s` } : { key: "0", label: "∞", title: "Until I close it" }))} />');
    expect(settings).toContain("onChange={(k) => setNoticeSeconds(NOTICE_SECONDS.find((s) => String(s) === k) ?? DEFAULT_NOTICE_SECONDS)}");
  });
});

describe("the notices and the gate", () => {
  it("go with the page that shows them: a sign-out's wall never shows the account's renders", () => {
    store.announceRender(notice("a"));
    store.wantRender("p1", "/r/a.png");
    draw();
    const leave = ui.effects[0]() as () => void;
    leave();
    expect([store.renderNotices(), store.wantedRender("p1")]).toEqual([[], null]);
  });
});

describe("a focused notice", () => {
  it("lets Esc dismiss it, and keeps the key from the view behind it", () => {
    store.announceRender(notice("a"));
    const [first] = draw().notices;
    const key = first.props.onKeyDown as (e: unknown) => void;
    const stop = vi.fn();
    key({ key: "Tab", stopPropagation: stop });
    expect([stop.mock.calls.length, store.renderNotices().length]).toEqual([0, 1]);
    key({ key: "Escape", stopPropagation: stop });
    expect([stop.mock.calls.length, store.renderNotices().length]).toEqual([1, 0]);
  });
});

describe("an Image View taking a render", () => {
  const shot = (key: string, src: string, original?: string) => ({ key, kind: "history", src, original, ratio: "1:1" }) as Shot;
  let m: ImageViewModel;
  const open = vi.fn();
  const stage = { focus: vi.fn() };
  const root = { current: { querySelector: (q: string) => (q === ".iv-open" ? stage : null) } as unknown as HTMLElement };
  let listen: ((e: unknown) => void) | undefined;
  beforeEach(() => {
    open.mockClear(); stage.focus.mockClear();
    m = { promptId: "p1", finished: [shot("example:0", "/e.png"), shot("history:9", "/r/9-preview.webp", "/r/9.png")] } as unknown as ImageViewModel;
    vi.stubGlobal("window", { addEventListener: (_: string, l: (e: unknown) => void) => { listen = l; }, removeEventListener: vi.fn() });
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
    vi.stubGlobal("document", { querySelector: () => null });
  });
  const useMounted = () => { ui.effects = []; useOpenRender(m, open, root); ui.effects[0](); };
  const ask = (promptId: string | null, src: string) => {
    const e = { detail: { promptId, src }, preventDefault: vi.fn() };
    listen!(e);
    return e.preventDefault.mock.calls.length > 0;
  };

  it("opens its prompt's render on a click, by its returned or stored address, the stage's Open focused first", () => {
    useMounted();
    expect(ask("p1", "/r/9.png")).toBe(true);
    expect(open).toHaveBeenCalledWith(m.finished[1]);
    expect(stage.focus.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
    expect(ask("p2", "/r/9.png")).toBe(false);
    expect(ask("p1", "/r/unknown.png")).toBe(false);
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "hidden" }));
    expect(ask("p1", "/r/9.png")).toBe(false);
    expect(open).toHaveBeenCalledOnce();
  });

  it("leaves a render another view already took: one viewer opens, not two", () => {
    useMounted();
    listen!({ detail: { promptId: "p1", src: "/r/9.png" }, defaultPrevented: true, preventDefault: vi.fn() });
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps the focus inside a viewer already open, which only turns to the render", () => {
    const close = { focus: vi.fn() };
    vi.stubGlobal("document", { querySelector: (q: string) => (q === ".kit-viewer .kit-viewer-x" ? close : null) });
    useMounted();
    expect(ask("p1", "/r/9.png")).toBe(true);
    expect(close.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(stage.focus).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(m.finished[1]);
  });

  it("opens the render a notice opened this page for, once it stands among the finished images, and only once", () => {
    store.wantRender("p1", "/r/9.png");
    m.finished = [m.finished[0]];
    ui.effects = [];
    useOpenRender(m, open, root);
    ui.effects[1]();
    expect(open).not.toHaveBeenCalled();
    m.finished = [m.finished[0], shot("history:9", "/r/9-preview.webp", "/r/9.png")];
    ui.effects = [];
    useOpenRender(m, open, root);
    ui.effects[1]();
    ui.effects[1]();
    expect(open).toHaveBeenCalledOnce();
    expect(store.wantedRender("p1")).toBeNull();
  });

  it("reads its History again every 3 s while that render is not in it yet, and stops once it is", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    m.historyState = { retry } as unknown as ImageViewModel["historyState"];
    store.wantRender("p1", "/r/9.png");
    m.finished = [m.finished[0]];
    ui.effects = [];
    useOpenRender(m, open, root);
    const stop = ui.effects[2]() as () => void;
    vi.advanceTimersByTime(3000);
    expect(retry).toHaveBeenCalledOnce();
    stop();
    vi.advanceTimersByTime(9000);
    expect(retry).toHaveBeenCalledOnce();
    m.finished = [m.finished[0], shot("history:9", "/r/9-preview.webp", "/r/9.png")];
    ui.effects = [];
    useOpenRender(m, open, root);
    expect(ui.effects[2]()).toBeUndefined();
  });
});

describe("where the notices come from and where they show", () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8").split("\r\n").join("\n");

  it("the queue hands over a finished job's image, never on a failure", () => {
    expect(read("hooks", "useRenderQueue.ts")).toContain('      publish(result.action);\n      if (result.action.type === "resolve") latest.current.onReady?.(id, result.action.imageUrl);');
  });

  it("the Image View announces each to the site-wide store with its prompt and title, and has the History read afresh", () => {
    expect(read("components", "image-view", "useImageViewModel.ts")).toContain('    onReady: (id, imageUrl) => {\n      announceRender({ key: `job:${id}`, src: imageUrl, promptId, title: blank ? "New image" : (prompt?.title ?? s?.title ?? "") });\n      // Its row is new: a History read before it (on leaving, on opening this prompt again) reads afresh.\n      void queryClient.invalidateQueries({ queryKey: ["user-generations"] });\n    },');
  });

  it("the shell closes an open panel when a notice leads to its prompt", () => {
    const HOME = read("components", "enki-shell", "EnkiHome.tsx");
    // The panel is the address's since 2026-10-30: the notice's push of the prompt's page names none, so the panel goes,
    // and Back brings it back.
    expect(HOME).toContain("const at = panelOf(search);");
    expect(read("components", "kit", "RenderNotices.tsx")).toContain("    router.push(promptPage(n.promptId));");
    expect(read("lib", "ui", "image-view", "open-link.ts")).toContain("export const promptPage = (id: string) => `/home?${PARAM}=${encodeURIComponent(id)}`;");
  });

  it("the shell shows them on every page, beside the toaster; both views take their clicks", () => {
    // Inside the gate: a walled page (signed out) shows none.
    expect(read("providers", "index.tsx")).toContain("                    {children}\n                    {/* A finished render, wherever the reader is (Kev, 2026-10-26); inside the gate: none over its wall. */}\n                    <RenderNotices />\n                    {/* The share a release offers, over the page it opened; inside the gate as well. */}\n                    <ShareHost />\n                  </BetaGate>");
    for (const view of ["ImageViewDesktop.tsx", "ImageViewMobile.tsx"]) expect(read("components", "image-view", view)).toContain("  useOpenRender(m, open, root);");
  });

  it("slide in at the top right above every layer, under the shell's banner, along the top of a phone", () => {
    const CSS = read("components", "kit", "kit-notices.css");
    expect(CSS).toMatch(/\.ek-ready-list \{\n  position: fixed;\n  top: calc\(var\(--ek-banner-h, 0px\) \+ 16px\);\n  right: 16px;\n  z-index: 10020;/);
    expect(CSS).toContain("@keyframes ek-ready-in { from { transform: translateX(calc(100% + 24px)); opacity: 0; } }");
    // A fullscreen viewer open: below its top bar, never over its Close (bench: 16 -> 68 px, a phone 10 -> 60).
    expect(CSS).toContain("body:has(> .kit-viewer) .ek-ready-list { top: 68px; }");
    expect(CSS).toContain("  body:has(> .kit-viewer) .ek-ready-list { top: calc(60px + env(safe-area-inset-top, 0px)); }");
    expect(CSS).toMatch(/@media \(max-width: 1023\.98px\) \{\n  \.ek-ready-list \{ top: calc\(var\(--ek-banner-h, 0px\) \+ 10px \+ env\(safe-area-inset-top, 0px\)\); right: 12px; left: 12px; width: auto; \}\n  \.ek-ready \{ animation-name: ek-ready-down; \}/);
  });
});
