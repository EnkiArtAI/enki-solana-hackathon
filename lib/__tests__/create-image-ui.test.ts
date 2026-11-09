import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * Create > Image after Sume's (Kev, 2026-10-30: "create > image muss auch die gleiche view haben wie bei sume ... i also
 * need there the loading icon when it is being generated, the grey loading icon when it's not yet in the api queue and
 * red if it failed with the ability to copy the prompt. i need the "recreate" button on there too ... with the generate
 * looking like our quick create with the create prompt zusatz"). The views are called with their hooks answered, as
 * React would render them; the measured look is in the headless-Edge bench (DEC entry).
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, effects: false, refs: [] as unknown[], push: vi.fn(), access: { access: "ok", role: "user", userId: "u1" as string | null },
  query: null as null | Record<string, unknown>, answer: {} as Record<string, unknown>, model: null as unknown, mine: null as unknown, mediaPhone: false,
  guarded: vi.fn(), marks: undefined as unknown, qc: { setQueriesData: vi.fn(), invalidateQueries: vi.fn() },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T | (() => T)) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = typeof start === "function" ? (start as () => T)() : start;
    // As React takes them: a value, or a function of the one before.
    return [ui.state[i] as T, (next: T | ((was: T) => T)) => { ui.state[i] = typeof next === "function" ? (next as (was: T) => T)(ui.state[i] as T) : next; }];
  },
  useEffect: (fn: () => unknown) => { if (ui.effects) fn(); },
  useLayoutEffect: (fn: () => unknown) => { if (ui.effects) fn(); },
  // The elements a test hands in, in the order the view asks for its refs; the start value after them.
  useRef: <T>(current: T) => ({ current: ui.refs.length ? ui.refs.shift() : current }),
  useMemo: <T>(make: () => T) => make(),
  useCallback: <T>(fn: T) => fn,
  useEffectEvent: <T>(fn: T) => fn,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: ui.push }) }));
vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: (o: Record<string, unknown>) => {
    ui.query = o;
    return { data: { pages: [{ generations: [{ id: "r1" }], total: 1 }] }, isPending: true, isError: false, hasNextPage: true, isFetchingNextPage: false, refetch: vi.fn(), fetchNextPage: vi.fn(), ...ui.answer };
  },
  useQueryClient: () => ui.qc,
}));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ui.access }));
vi.mock("@/hooks/useViewerWallets", () => ({ useViewerWallets: () => ({ userKey: "wallet1", payer: null }) }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => ui.mediaPhone }));
vi.mock("@/lib/openLogin", () => ({ openLogin: vi.fn() }));
vi.mock("@/lib/session-headers", () => ({ viewerHeaders: () => ({}), sessionAuthHeaders: () => ({ "X-Session-Token": "s1" }) }));
vi.mock("@/components/StepUpProvider", () => ({ useStepUp: () => ({ guarded: ui.guarded }) }));
vi.mock("@/hooks/useBookmarkIndex", () => ({ useBookmarkIndex: vi.fn(() => ui.marks) }));
vi.mock("@/components/enki-shell/editorBridge", () => ({ stashEditorSeed: vi.fn() }));
vi.mock("@/components/kit/notify", () => ({ useToastOffset: vi.fn(), notify: vi.fn() }));
vi.mock("@/components/kit/AutosizeTextarea", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/kit/JobTile", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/kit/FullscreenViewer", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/image-view/ComposeFoot", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/image-view/RefPicker", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/image-view/ViewerPanel", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/image-view/useOpenRender", () => ({ useOpenRender: vi.fn() }));
vi.mock("@/components/enki/EnkiDetailPanel", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/image-view/useImageViewModel", () => ({ PROMPT_KEY: "\u0000prompt", copyText: vi.fn(), useImageViewModel: vi.fn(() => ui.model) }));
vi.mock("@/components/image-view/useOwnRenders", async (original) => {
  const real = await original<typeof import("@/components/image-view/useOwnRenders")>();
  return { ...real, useOwnRenders: vi.fn((o: Parameters<typeof real.useOwnRenders>[0]) => (ui.mine === "real" ? real.useOwnRenders(o) : ui.mine)) };
});

import ImageWall from "@/components/create/image/ImageWall";
import ImageBar from "@/components/create/image/ImageBar";
import CreateImage from "@/components/create/image/CreateImage";
import { useOwnRenders } from "@/components/image-view/useOwnRenders";
import { useOpenRender } from "@/components/image-view/useOpenRender";
import JobTile from "@/components/kit/JobTile";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import ComposeFoot from "@/components/image-view/ComposeFoot";
import RefPicker from "@/components/image-view/RefPicker";
import ViewerPanel from "@/components/image-view/ViewerPanel";
import AutosizeTextarea from "@/components/kit/AutosizeTextarea";
import EnkiDetailPanel from "@/components/enki/EnkiDetailPanel";
import { copyText, type Shot } from "@/components/image-view/useImageViewModel";
import { notify, useToastOffset } from "@/components/kit/notify";
import { openLogin } from "@/lib/openLogin";
import { stashEditorSeed } from "@/components/enki-shell/editorBridge";
import TileActions, { ViewerActs, type TileActs } from "@/components/create/image/TileActions";
import { useBookmarkIndex } from "@/hooks/useBookmarkIndex";
import { ADD_PHOTOS_EVENT } from "@/lib/ui/image-view/slots";
import { tileFacts } from "@/lib/ui/create/tile-actions";
import { wallItems, type OwnRow, type WallItem } from "@/lib/ui/create/image";
import { boxRatio } from "@/lib/ui/kit/ratio";
import type { ImageSetup } from "@/lib/ui/image-view/setups";
import type { Job } from "@/lib/ui/kit/render-queue";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const of = (tree: ReactNode, type: unknown) => [...walk(tree)].filter((el) => el.type === type);
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => String(el.props.className ?? "").split(" ").includes(name));
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("") : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);
const render = <P,>(view: (p: P) => unknown, props: P, state: unknown[] = []) => {
  ui.state = [...state];
  ui.s = 0;
  return view(props) as ReactNode;
};

const setup = (prompt: string, aspectRatio = "1:1") => ({ prompt, aspectRatio } as unknown as ImageSetup);
const job = (id: string, over: Partial<Job<ImageSetup>> = {}): Job<ImageSetup> => ({ id, createdAt: 1, status: "rendering", sent: false, setup: setup(`words ${id}`), seen: false, ...over });
const row = (id: string, over: Partial<OwnRow> = {}): OwnRow => ({
  id, image_url: `https://cdn/${id}.png`, image_urls: [`https://cdn/${id}.webp`], thumbnail_url: null, isUploaded: false, visibility: "private",
  prompt_id: null, settings: { modelId: "gpt", aspectRatio: "1:1", resolution: "1K", boost: false }, prompt_text: `text ${id}`, created_at: "x", ...over,
});
const state = { loading: false, failed: false, retry: vi.fn(), more: false, loadingOlder: false, loadOlder: vi.fn() };
/** Browser observers that hand their callback out: `fire` runs the last one made. */
const observers = () => {
  const made = { ro: [] as Array<(e: unknown[]) => void>, io: [] as Array<{ fn: (e: unknown[]) => void; off: ReturnType<typeof vi.fn> }> };
  vi.stubGlobal("ResizeObserver", class { constructor(fn: (e: unknown[]) => void) { made.ro.push(fn); } observe() { made.ro.at(-1)?.([{ contentRect: { width: 1116 } }]); } disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { off = vi.fn(); constructor(fn: (e: unknown[]) => void) { made.io.push({ fn, off: this.off }); } observe() {} disconnect() { this.off(); } });
  return made;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  ui.effects = false;
  ui.refs = [];
  ui.answer = {};
  ui.access = { access: "ok", role: "user", userId: "u1" };
  ui.mediaPhone = false;
});

describe("the wall", () => {
  const jobs = [job("wait"), job("run", { sent: true }), job("fail", { status: "failed", sent: true, error: { message: "Render failed · boom", charged: "no" } }), job("ok", { status: "ready", sent: true, imageUrl: "data:ok" })];
  const items = wallItems(jobs, [row("r1"), row("r2", { settings: { modelId: "gpt", aspectRatio: "16:9", resolution: "1K", boost: false } })]);
  const acts = { guest: false, marks: undefined, recreate: vi.fn(), prompt: vi.fn(), reference: vi.fn(), animate: vi.fn(), remove: vi.fn() } as TileActs;
  const props = { root: { current: null }, items, state, onOpen: vi.fn(), acts, onCancel: vi.fn(), onCopy: vi.fn() };
  // useState: the wall's width, then the pictures' measured ratios.
  const wall = (ratios: Record<string, number> = {}) => render(ImageWall, props, [1116, ratios]);

  it("draws a job in line grey with its X, a sent one lit without it, a failed one red with Copy prompt", () => {
    const tiles = of(wall(), JobTile);
    expect(tiles.map((t) => [t.props.status, t.props.sent, t.props.label, typeof t.props.onCancel])).toEqual([
      ["rendering", false, "Your render, waiting to be sent", "function"],
      ["rendering", true, "Your render, rendering", "undefined"],
      ["failed", true, "Your render, failed", "undefined"],
    ]);
    (tiles[0].props.onCancel as () => void)();
    expect(props.onCancel).toHaveBeenCalledWith(jobs[0]);
    const copies = byClass(wall(), "ci-copy");
    expect(copies).toHaveLength(1);
    expect(copies[0].props.title).toBe("Render failed · boom");
    expect(text(copies[0].props.children as ReactNode)).toBe("Copy prompt");
    (copies[0].props.onClick as () => void)();
    expect(props.onCopy).toHaveBeenCalledWith(jobs[2]);
  });

  it("puts the actions on every finished picture (the ready job and the rows) at the tile's size, none on a job in line, running or failed", () => {
    const tree = wall();
    const shots = byClass(tree, "ci-shot");
    expect(shots.map((s) => s.key)).toEqual(["job:ok", "row:r1", "row:r2"]);
    const on = of(tree, TileActions).map((t) => t.props);
    expect(on.map((p) => [(p.item as WallItem).key, p.width, p.height, p.acts])).toEqual([
      ["job:ok", 277.5, 277.5, acts], ["row:r1", 300, 300, acts], ["row:r2", 300 * (16 / 9), 300, acts],
    ]);
    // The jobs' tiles carry none (a failed one keeps Copy prompt).
    expect(of(tree, JobTile).flatMap((t) => of(t.props.children as ReactNode, TileActions))).toHaveLength(0);
    expect(byClass(tree, "ci-recreate")).toHaveLength(0);
  });

  it("opens a finished picture on a click, as the profile's wall does", () => {
    const opens = byClass(wall(), "ci-open");
    expect(opens.map((b) => [b.props["aria-label"], (of(b.props.children as ReactNode, "img")[0].props.src)])).toEqual([
      ["Open", "data:ok"], ["Open", "https://cdn/r1.webp"], ["Open", "https://cdn/r2.webp"],
    ]);
    (opens[2].props.onClick as () => void)();
    expect(props.onOpen).toHaveBeenCalledWith(items[5]);
    expect(acts.recreate).not.toHaveBeenCalled();
  });

  it("lays the pictures out in the profile's justified rows at the wall's width, a measured ratio over the asked one", () => {
    const tree = wall();
    const rows = byClass(tree, "ci-row");
    const widthOf = (el: El) => (el.type === JobTile ? (el.props.height as number) * boxRatio(el.props.ratio as string) : (el.props.style as { width: number }).width);
    const tilesOf = (r: El) => (r.props.children as El[]).flat();
    // Ratios 1, 1, 1, 1 (the ready job), 1, 16:9: four fill the first row at 277.5 px (1110 + three 2 px gaps), the
    // last two stay short at the 300 px aimed for.
    expect(rows.map((r) => (r.props.style as { height: number }).height)).toEqual([277.5, 300]);
    expect(tilesOf(rows[0]).map(widthOf).reduce((a, b) => a + b, 0) + 2 * 3).toBeCloseTo(1116);
    expect(tilesOf(rows[1]).map((t) => t.key)).toEqual(["row:r1", "row:r2"]);
    expect(widthOf(tilesOf(rows[1])[1]) / 300).toBeCloseTo(16 / 9);
    // A picture's own ratio, once loaded, decides its width.
    const measured = byClass(wall({ "row:r2": 0.5 }), "ci-row").at(-1)!;
    expect(widthOf(tilesOf(measured)[1]) / (measured.props.style as { height: number }).height).toBeCloseTo(0.5);
  });

  it("aims at 180 px rows on a narrow wall, and says what to do while empty", () => {
    const narrow = render(ImageWall, { ...props, items: [items[4]] }, [600, {}]);
    expect((byClass(narrow, "ci-row")[0].props.style as { height: number }).height).toBe(180);
    const empty = render(ImageWall, { ...props, items: [] }, [1116, {}]);
    expect(text(byClass(empty, "ci-empty")[0].props.children as ReactNode)).toBe("What will you make?Describe an image below. It appears here as it renders.");
  });

  it("says when the images could not load, with Try again; a spinner while they load", () => {
    const retry = vi.fn();
    const failed = byClass(render(ImageWall, { ...props, items: [], state: { ...state, failed: true, retry } }, [1116, {}]), "ci-empty")[0];
    expect(text(failed.props.children as ReactNode)).toBe("Your images could not load.Try again");
    (byClass(failed.props.children as ReactNode, "ci-retry")[0].props.onClick as () => void)();
    expect(retry).toHaveBeenCalledTimes(1);
    const loading = byClass(render(ImageWall, { ...props, items: [], state: { ...state, loading: true, failed: true } }, [1116, {}]), "ci-empty")[0];
    expect(text(loading.props.children as ReactNode)).toBe("");
    expect(byClass(loading.props.children as ReactNode, "ci-spin")[0].props["aria-label"]).toBe("Loading your images");
  });

  it("measures the wall it is given and loads the older page once the end comes into view, not before", () => {
    const made = observers();
    ui.effects = true;
    const loadOlder = vi.fn();
    const end = {};
    ui.refs = [end];
    render(ImageWall, { ...props, root: { current: {} as HTMLDivElement }, state: { ...state, more: true, loadOlder } }, [0, {}]);
    // The wall's own width, from its ResizeObserver.
    expect(ui.state[0]).toBe(1116);
    expect(made.io).toHaveLength(1);
    made.io[0].fn([{ isIntersecting: false }]);
    expect(loadOlder).not.toHaveBeenCalled();
    made.io[0].fn([{ isIntersecting: true }]);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(made.io[0].off).toHaveBeenCalled();
    // The last page in, or one loading: nothing watches the end.
    ui.refs = [end];
    render(ImageWall, { ...props, root: { current: {} as HTMLDivElement }, state: { ...state, more: false, loadOlder } }, [0, {}]);
    ui.refs = [end];
    render(ImageWall, { ...props, root: { current: {} as HTMLDivElement }, state: { ...state, more: true, loadingOlder: true, loadOlder } }, [0, {}]);
    expect(made.io).toHaveLength(1);
  });
});

describe("the bar", () => {
  const model = (over: Record<string, unknown> = {}) => ({
    guest: false, text: "a quiet harbour", setText: vi.fn(), refs: [{ id: "a", src: "data:a" }, { id: "b", src: "data:b" }], pending: [], cap: 4,
    core: { entry: { name: "Nano Banana Pro" } }, accept: "image/*", addFiles: vi.fn(), removeSlot: vi.fn(), growOnly: () => false, release: vi.fn(),
    library: [{ id: "saved" }], myImages: [{ url: "u", src: "s" }], uploads: [], ...over,
  });
  const bar = (m: ReturnType<typeof model>, phone = false, asking: unknown = null, onLift = vi.fn()) =>
    render(ImageBar as (p: unknown) => unknown, { model: m, phone, promptRef: { current: null }, onLift }, [asking]);

  it("holds the words, Make it a prompt, + and the image view's own foot (pills, Generate with its price) for the same model", () => {
    const m = model();
    const tree = bar(m);
    const field = of(tree, AutosizeTextarea)[0];
    expect(field.props).toMatchObject({ value: "a quiet harbour", placeholder: "Describe the image you want to create", min: 40 });
    // Sized by its top edge, growing up over the wall (Kev, 2026-10-30: "bei images oben nach oben"), in the field's place.
    expect(field.props).toMatchObject({ grip: "up", boxClassName: "ci-text-box" });
    expect(readFileSync(join(__dirname, "..", "..", "components", "enki", "feed.css"), "utf8")).toContain(".feed-create-image .ci-text-box { flex: 1; min-width: 0; }");
    (field.props.onChange as (t: string) => void)("new words");
    expect(m.setText).toHaveBeenCalledWith("new words");
    expect(text(byClass(tree, "ci-make")[0].props.children as ReactNode)).toBe("Make it a prompt →");
    expect(of(tree, ComposeFoot).map((el) => el.props)).toEqual([{ model: m, phone: false }]);
    expect(byClass(tree, "ci-bar")[0].props["data-phone"]).toBeUndefined();
    expect(of(bar(m, true), ComposeFoot)[0].props.phone).toBe(true);
    expect(byClass(bar(m, true), "ci-bar")[0].props["data-phone"]).toBe(true);
    expect(of(bar(m, true), AutosizeTextarea)[0].props.placeholder).toBe("Describe your image…");
  });

  it("draws Make it a prompt with Quick Create's own button (Kev, 2026-10-30: \"so wie bei quick create\")", () => {
    expect(byClass(bar(model()), "ci-make")[0].props.className).toBe("mobile-modal-add-var-btn ci-make");
  });

  it("shows the references before the words, each with its x taking its slot out", () => {
    const m = model();
    const xs = byClass(bar(m), "ci-ref-x");
    expect(xs.map((x) => x.props["aria-label"])).toEqual(["Remove reference image 1", "Remove reference image 2"]);
    (xs[1].props.onClick as () => void)();
    expect(m.removeSlot).toHaveBeenCalledWith(1);
  });

  it("Make it a prompt takes the words to the editor, named by its first words; a guest signs in first", () => {
    (byClass(bar(model()), "ci-make")[0].props.onClick as () => void)();
    expect(stashEditorSeed).toHaveBeenCalledWith({ kind: "library", title: "a quiet harbour", promptText: "a quiet harbour" }, "u1");
    expect(ui.push).toHaveBeenCalledWith("/editor");
    vi.clearAllMocks();
    (byClass(bar(model({ guest: true })), "ci-make")[0].props.onClick as () => void)();
    expect(openLogin).toHaveBeenCalledTimes(1);
    expect(stashEditorSeed).not.toHaveBeenCalled();
    expect(ui.push).not.toHaveBeenCalled();
  });

  it("+ is greyed for a generator without references; a guest's + asks for the login", () => {
    const plus = (m: ReturnType<typeof model>) => byClass(bar(m), "ci-plus")[0];
    expect(plus(model({ cap: 0 })).props).toMatchObject({ disabled: true, title: "Nano Banana Pro takes no reference images" });
    expect(plus(model()).props.disabled).toBe(false);
    expect(plus(model({ guest: true, cap: 0 })).props.disabled).toBe(false);
    (plus(model({ guest: true })).props.onClick as () => void)();
    expect(openLogin).toHaveBeenCalledTimes(1);
  });

  it("a signed-in + opens the reference picker at +", () => {
    const at = { top: 640, left: 300 };
    // useRef: the bar, then +.
    ui.refs = [null, { getBoundingClientRect: () => at }];
    (byClass(bar(model()), "ci-plus")[0].props.onClick as () => void)();
    expect(ui.state[0]).toBe(at);
    expect(openLogin).not.toHaveBeenCalled();
  });

  it("opens the reference picker without the saved library (Kev, 2026-10-30: that is video's), uploads to the model", () => {
    const m = model();
    const picker = of(bar(m, false, { top: 1 }), RefPicker)[0];
    expect(picker.props.model).toMatchObject({ library: [], myImages: [], refs: m.refs, cap: 4 });
    expect(picker.props.anchor).toEqual({ top: 1 });
    expect(of(bar(m), RefPicker)).toHaveLength(0);
    expect(m.library).toEqual([{ id: "saved" }]);
  });

  it("answers Generate's \"Add N photos\" as + does (a guest: the login)", () => {
    const on = vi.fn();
    vi.stubGlobal("window", { addEventListener: on, removeEventListener: vi.fn() });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    ui.effects = true;
    bar(model({ guest: true }));
    vi.unstubAllGlobals();
    const listener = on.mock.calls.find((c) => c[0] === ADD_PHOTOS_EVENT)?.[1] as () => void;
    listener();
    expect(openLogin).toHaveBeenCalledTimes(1);
  });

  it("tells the page how far it reaches up from the screen's foot, 12 px over it, for the toasts", () => {
    observers();
    vi.stubGlobal("window", { innerHeight: 900, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    ui.effects = true;
    ui.refs = [{ getBoundingClientRect: () => ({ top: 700 }) }];
    const onLift = vi.fn();
    bar(model(), false, null, onLift);
    expect(onLift).toHaveBeenCalledWith(212);
  });

  it("hands the files picked to the model, and lets the words shrink again once typed in", () => {
    const m = model({ growOnly: (k: string) => k === "\u0000prompt" });
    const tree = bar(m);
    const input = [...walk(tree)].find((el) => el.type === "input")!;
    const files = [{ name: "a.png" }, { name: "b.png" }];
    const target = { files, value: "C:/a.png" };
    (input.props.onChange as (e: unknown) => void)({ target });
    expect(m.addFiles).toHaveBeenCalledWith(files);
    expect(target.value).toBe("");
    const field = of(tree, AutosizeTextarea)[0];
    expect(field.props.growOnly).toBe(true);
    (field.props.onUserInput as () => void)();
    expect(m.release).toHaveBeenCalledWith("\u0000prompt");
  });
});

describe("the page", () => {
  const ok = job("ok", { status: "ready", sent: true, imageUrl: "data:ok", setup: setup("two foxes", "16:9") });
  const fail = job("fail", { status: "failed", sent: true });
  const fakeModel = (over: Record<string, unknown> = {}) => ({
    guest: false, jobs: [ok, fail], select: vi.fn(), setText: vi.fn(), setCount: vi.fn(), cancel: vi.fn(), seen: vi.fn(), resetSettings: vi.fn(),
    cap: 4, room: 2, refs: [], pending: [], core: { entry: { name: "Nano Banana Pro" } }, addUrls: vi.fn(), ...over,
  });
  const old = row("old", { settings: null, prompt_text: "an old castle" });
  const mine = { rows: [row("r1"), row("m", { prompt_kind: "market", prompt_id: "p9" }), old], loading: false, failed: false, retry: vi.fn(), more: false, loadingOlder: false, loadOlder: vi.fn() };
  // useState: the toasts' lift, the prompt view Recreate opened, the picture in the viewer, the renders deleted here.
  const page = (open: unknown = null, viewing: string | null = null, lift: number | null = null, gone?: ReadonlySet<string>) =>
    render(CreateImage as (p: unknown) => unknown, {}, gone ? [lift, open, viewing, gone] : [lift, open, viewing]);
  type WallProps = { root: unknown; items: WallItem[]; state: unknown; onOpen: (i: WallItem) => void; acts: TileActs; onCancel: (j: Job<ImageSetup>) => void; onCopy: (j: Job<ImageSetup>) => void };
  const wallOf = (tree: ReactNode) => of(tree, ImageWall)[0].props as WallProps;
  const use = (m = fakeModel()) => { ui.model = m; ui.mine = mine; return m; };

  it("shows this visit's jobs and the viewer's renders, every prompt's, read under the account; a guest's are not read", () => {
    use();
    const w = wallOf(page());
    expect(w.items.map((i) => i.key)).toEqual(["job:ok", "job:fail", "row:r1", "row:m", "row:old"]);
    expect(w.state).toBe(mine);
    expect(useOwnRenders).toHaveBeenLastCalledWith({ userKey: "u1", promptId: null, jobs: [ok, fail], all: true });
    ui.access = { access: "ok", role: "user", userId: null };
    page();
    expect(useOwnRenders).toHaveBeenLastCalledWith({ userKey: "wallet1", promptId: null, jobs: [ok, fail], all: true });
    use(fakeModel({ guest: true }));
    page();
    expect(useOwnRenders).toHaveBeenLastCalledWith({ userKey: null, promptId: null, jobs: [ok, fail], all: true });
  });

  it("Recreate on a job loads its setup and its batch's count, the bar not reset first", () => {
    const m = use();
    const w = wallOf(page());
    w.acts.recreate(w.items[0]);
    expect(m.select).toHaveBeenCalledWith({ key: "job:ok", kind: "job", job: ok, ratio: "16:9" });
    expect(m.resetSettings).not.toHaveBeenCalled();
    expect(m.setText).not.toHaveBeenCalled();
    expect(m.setCount).toHaveBeenLastCalledWith(1);
  });

  it("Recreate on a row resets the bar first (a row keeps no quality), then loads its settings, its words and one image", () => {
    const m = use();
    const w = wallOf(page());
    w.acts.recreate(w.items[2]);
    expect(m.resetSettings).toHaveBeenCalledTimes(1);
    expect(m.resetSettings.mock.invocationCallOrder[0]).toBeLessThan(m.select.mock.invocationCallOrder[0]);
    expect(m.select).toHaveBeenLastCalledWith({ key: "history:r1", kind: "history", ratio: null, record: mine.rows[0] });
    expect(m.setText).toHaveBeenCalledWith("text r1");
    expect(m.setCount).toHaveBeenLastCalledWith(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("Recreate on a row without settings leaves the defaults and no references, its words in the bar, and says so", () => {
    const m = use();
    const w = wallOf(page());
    w.acts.recreate(w.items[4]);
    expect(m.resetSettings).toHaveBeenCalledTimes(1);
    const shot = m.select.mock.calls[0][0] as Shot;
    expect(shot.record?.settings).toEqual({ modelId: null, aspectRatio: null, resolution: null, boost: false, references: [] });
    expect(m.setText).toHaveBeenCalledWith("an old castle");
    expect(notify).toHaveBeenCalledWith("Its settings were not recorded: only its words are in the bar");
  });

  it("gives the words the focus after Recreate, without scrolling", () => {
    const focus = vi.fn();
    // useRef: the prompt, then the wall.
    ui.refs = [{ focus }];
    use();
    const w = wallOf(page());
    w.acts.recreate(w.items[2]);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("Recreate on someone's listed prompt opens its image view on that render", () => {
    use();
    const w = wallOf(page());
    w.acts.recreate(w.items[3]);
    expect(ui.state[1]).toEqual({ promptId: "p9", imageUrl: "https://cdn/m.webp", recreateImageId: "m" });
    expect(of(page(), EnkiDetailPanel)).toHaveLength(0);
    expect(of(page({ promptId: "p9", recreateImageId: "m" }), EnkiDetailPanel)[0].props.seed).toEqual({ promptId: "p9", recreateImageId: "m" });
  });

  it("Copy prompt copies the words the failed job sent; the X takes a job in line back through the queue", () => {
    const m = use();
    const w = wallOf(page());
    w.onCopy(fail);
    expect(copyText).toHaveBeenCalledWith("words fail", "Prompt copied");
    w.onCancel(fail);
    expect(m.cancel).toHaveBeenCalledWith({ key: "job:fail", kind: "job", job: fail, ratio: "1:1" });
  });

  it("a click on a picture opens it in the image view's viewer; closing leaves the bar as it is", () => {
    const m = use();
    const w = wallOf(page());
    expect(of(page(), FullscreenViewer)).toHaveLength(0);
    w.onOpen(w.items[2]);
    expect(ui.state[2]).toBe("row:r1");
    expect(m.seen).toHaveBeenCalledWith(expect.objectContaining({ key: "row:r1", record: mine.rows[0] }));
    const tree = page(null, "row:r1");
    const viewer = of(tree, FullscreenViewer)[0].props;
    // The finished ones only (the failed job has no picture), in the wall's order.
    expect((viewer.items as Array<{ key: string }>).map((i) => i.key)).toEqual(["job:ok", "row:r1", "row:m", "row:old"]);
    expect(viewer).toMatchObject({ index: 1, layout: "side", nav: "thumbs" });
    expect((of(viewer.panel as ReactNode, ViewerPanel)[0].props as { shot: Shot; model: unknown }).shot).toMatchObject({ key: "row:r1", src: "https://cdn/r1.webp", original: "https://cdn/r1.png" });
    (viewer.onIndex as (i: number) => void)(3);
    expect(ui.state[2]).toBe("row:old");
    (viewer.onClose as (i: number) => void)(1);
    expect(ui.state[2]).toBeNull();
    expect(m.select).not.toHaveBeenCalled();
    ui.mediaPhone = true;
    expect(of(page(null, "row:r1"), FullscreenViewer)[0].props).toMatchObject({ layout: "stacked", nav: "dots" });
  });

  it("takes a finished render's notice on its wall (useOpenRender, else the notice leaves for /profile)", () => {
    const m = use();
    const tree = page();
    const [model, open, root] = vi.mocked(useOpenRender).mock.calls.at(-1)!;
    expect(model).toBe(m);
    expect(root).toBe(wallOf(tree).root);
    // The queue's own shot for the render, as m.finished holds it.
    open({ key: "job:ok", kind: "job", job: ok, src: "data:ok", ratio: "16:9" });
    expect(ui.state[2]).toBe("job:ok");
    expect(of(page(null, "job:ok"), FullscreenViewer)[0].props.index).toBe(0);
  });

  it("Reference puts the picture into the bar's references inside the generator's room, else says why; a guest signs in first", () => {
    const m = use();
    const w = wallOf(page());
    const f = tileFacts(w.items[2])!;
    w.acts.reference(f);
    expect(m.addUrls).toHaveBeenCalledWith(["https://cdn/r1.webp"]);
    use(fakeModel({ room: 0 }));
    wallOf(page()).acts.reference(f);
    expect(notify).toHaveBeenCalledWith("Nano Banana Pro takes up to 4 reference images. Remove one first.");
    use(fakeModel({ cap: 0 }));
    wallOf(page()).acts.reference(f);
    expect(notify).toHaveBeenLastCalledWith("Nano Banana Pro takes no reference images");
    const guest = use(fakeModel({ guest: true }));
    wallOf(page()).acts.reference(f);
    expect(openLogin).toHaveBeenCalledTimes(1);
    expect(guest.addUrls).not.toHaveBeenCalled();
    expect(m.addUrls).toHaveBeenCalledTimes(1);
  });

  it("Animate leaves the picture for Create > Video and opens it (lib/ui/create/handoff)", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null, removeItem: vi.fn() });
    use();
    const w = wallOf(page());
    w.acts.animate(tileFacts(w.items[2])!);
    expect(JSON.parse(store.get("enki:animate")!)).toEqual({ url: "https://cdn/r1.png", thumb: "https://cdn/r1.webp" });
    expect(ui.push).toHaveBeenCalledWith("/home?create=video");
  });

  it("Make it a prompt takes the picture's words to the editor, as the bar's button does; a guest signs in first", () => {
    use();
    wallOf(page()).acts.prompt("a lighthouse in fog at dawn again");
    expect(stashEditorSeed).toHaveBeenCalledWith({ kind: "library", title: "a lighthouse in fog at dawn", promptText: "a lighthouse in fog at dawn again" }, "u1");
    expect(ui.push).toHaveBeenCalledWith("/editor");
    vi.clearAllMocks();
    use(fakeModel({ guest: true }));
    wallOf(page()).acts.prompt("x");
    expect(openLogin).toHaveBeenCalledTimes(1);
    expect(ui.push).not.toHaveBeenCalled();
  });

  it("reads the viewer's bookmarks for the rail's Bookmark, a guest's not", () => {
    ui.marks = new Map();
    use();
    expect(wallOf(page()).acts.marks).toBe(ui.marks);
    expect(useBookmarkIndex).toHaveBeenLastCalledWith(true);
    use(fakeModel({ guest: true }));
    page();
    expect(useBookmarkIndex).toHaveBeenLastCalledWith(false);
  });

  it("Delete is the profile's (DELETE /api/images/[id] behind the step-up); the picture and its job leave the wall at once", async () => {
    const fetched: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (...a: unknown[]) => { fetched.push(a); return new Response("{}", { status: 200 }); }));
    ui.guarded = vi.fn((scope: string, run: (h: Record<string, string>) => Promise<Response>) => run({ "X-StepUp-Token": "t" }));
    const done = job("done", { status: "ready", sent: true, imageUrl: "https://cdn/r1.png" });
    use(fakeModel({ jobs: [done] }));
    const w = wallOf(page());
    expect(w.items.map((i) => i.key)).toEqual(["row:r1", "row:m", "row:old"]);
    await w.acts.remove(w.items[0]);
    expect(ui.guarded).toHaveBeenCalledWith("delete-work:r1", expect.any(Function));
    expect(fetched).toEqual([["/api/images/r1", { method: "DELETE", headers: { "X-Session-Token": "s1", "X-StepUp-Token": "t" } }]]);
    expect(ui.state[3]).toEqual(new Set(["r1", "done"]));
    expect(notify).toHaveBeenCalledWith("Image deleted");
    expect(wallOf(page(null, null, null, ui.state[3] as Set<string>)).items.map((i) => i.key)).toEqual(["row:m", "row:old"]);
    // Off the rows read too (the wall opened again draws from them before the next read), then read again.
    expect(ui.qc.setQueriesData).toHaveBeenCalledWith({ queryKey: ["user-generations"] }, expect.any(Function));
    const drop = vi.mocked(ui.qc.setQueriesData).mock.calls[0][1] as (d: unknown) => unknown;
    expect(drop({ pages: [{ generations: [{ id: "r1" }, { id: "m" }], total: 2 }], pageParams: [0] }))
      .toEqual({ pages: [{ generations: [{ id: "m" }], total: 2 }], pageParams: [0] });
    expect(ui.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["user-generations"] });
  });

  it("Delete keeps the picture when the server says no (and says so), quietly when the step-up was cancelled, and asks an ended session to sign in", async () => {
    use();
    const cases = [
      [500, {}, "Couldn't delete this image", false],
      [401, { stepUp: true, factors: [] }, null, false],
      [401, { error: "Sign in to delete images" }, "Sign in again to delete this image", true],
    ] as const;
    for (const [status, body, said, login] of cases) {
      vi.clearAllMocks();
      ui.guarded = vi.fn(async () => new Response(JSON.stringify(body), { status }));
      const w = wallOf(page());
      await w.acts.remove(w.items[2]);
      expect(ui.state[3]).toEqual(new Set());
      expect(notify).toHaveBeenCalledTimes(said ? 1 : 0);
      if (said) expect(notify).toHaveBeenCalledWith(said, { tone: "error" });
      expect(openLogin).toHaveBeenCalledTimes(login ? 1 : 0);
      expect(ui.qc.setQueriesData).not.toHaveBeenCalled();
    }
    // The network gone: the same refusal, no unhandled rejection.
    vi.clearAllMocks();
    ui.guarded = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const off = wallOf(page());
    await off.acts.remove(off.items[2]);
    expect(ui.state[3]).toEqual(new Set());
    expect(notify).toHaveBeenCalledWith("Couldn't delete this image", { tone: "error" });
    // A job of this visit before its row: nothing to delete yet.
    vi.clearAllMocks();
    const w = wallOf(page());
    await w.acts.remove(w.items[0]);
    expect(ui.guarded).not.toHaveBeenCalled();
  });

  it("the viewer offers Recreate, Reference and Animate for the picture it shows; each closes it", () => {
    use();
    const viewer = of(page(null, "row:r1"), FullscreenViewer)[0].props;
    const more = (of(viewer.panel as ReactNode, ViewerPanel)[0].props as { more: El }).more;
    expect(more.type).toBe(ViewerActs);
    expect((more.props.item as WallItem).key).toBe("row:r1");
    expect(Object.keys(more.props.acts as object)).toEqual(["guest", "marks", "recreate", "prompt", "reference", "animate", "remove"]);
    (more.props.onClose as () => void)();
    expect(ui.state[2]).toBeNull();
  });

  it("puts the bar on the same model, the phone's bar below 1024 px, and the toasts above it", () => {
    use();
    expect(of(page(), ImageBar)[0].props).toMatchObject({ model: ui.model, phone: false });
    page(null, null, 212);
    expect(useToastOffset).toHaveBeenLastCalledWith(212);
    (of(page(), ImageBar)[0].props.onLift as (px: number) => void)(180);
    expect(ui.state[0]).toBe(180);
    ui.mediaPhone = true;
    expect(of(page(), ImageBar)[0].props.phone).toBe(true);
  });
});

describe("the viewer's renders", () => {
  const useAll = (key: string | null, jobs: unknown[] = []) => useOwnRenders({ userKey: key, promptId: null, jobs: jobs as never, all: true });

  it("are read without a prompt, under the image view's key, none for a guest; a finished job not yet recorded asks again", () => {
    ui.mine = "real";
    ui.effects = true;
    vi.useFakeTimers();
    try {
      expect(useAll("u1", [{ id: "j", status: "ready", imageUrl: "data:j" }]).loading).toBe(true);
      expect(ui.query).toMatchObject({ queryKey: ["user-generations", "u1"], enabled: true, initialPageParam: 0 });
      expect(vi.getTimerCount()).toBe(2);
      vi.clearAllTimers();
      const guest = useAll(null, [{ id: "j", status: "ready", imageUrl: "data:j" }]);
      expect(ui.query).toMatchObject({ queryKey: ["user-generations", null], enabled: false });
      expect(vi.getTimerCount()).toBe(0);
      expect(guest.loading).toBe(false);
      // Without `all`, the blank composer still reads nothing.
      useOwnRenders({ userKey: "u1", promptId: null, jobs: [] });
      expect(ui.query).toMatchObject({ enabled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("say whether more pages wait, whether the read failed, and load the next page on asking", () => {
    ui.mine = "real";
    const fetchNextPage = vi.fn();
    ui.answer = { hasNextPage: true, isError: false, isFetchingNextPage: true, fetchNextPage };
    const r = useAll("u1");
    expect([r.more, r.failed, r.loadingOlder]).toEqual([true, false, true]);
    r.loadOlder();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    ui.answer = { hasNextPage: false, isError: true, isFetchingNextPage: false };
    expect(useAll("u1")).toMatchObject({ more: false, failed: true, loadingOlder: false });
  });
});

describe("the look", () => {
  const css = readFileSync(join(__dirname, "..", "..", "components", "enki", "feed.css"), "utf8").split("\r\n").join("\n");
  const phone = css.slice(css.indexOf("@media (max-width: 767.98px)"));

  it("holds the bar at the window's foot, 18 px over it, the wall at its width, newest rows centred", () => {
    expect(css).toContain(".feed-create-image .ci-bar {\n  position: sticky; bottom: 18px; z-index: 40;");
    expect(css).toContain("box-sizing: border-box; width: 100%; max-width: var(--ci-w); margin: auto auto 18px;");
    expect(css).toContain("border: 1px solid var(--enki-rule); border-radius: 24px;");
    expect(css).toContain(".feed-create-image .ci-wall { flex: 1; width: 100%; max-width: var(--ci-w); margin: 0; padding-bottom: 24px; }");
    expect(css).toContain(".feed-create-image .ci-row { display: flex; justify-content: flex-start; gap: 2px; }");
  });

  it("puts the words over the pills, + first in the pills' row, Generate across both, the price under the word; on a phone Generate below", () => {
    expect(css).toContain('grid-template-areas: "prompt prompt gen" "plus pills gen" "cost cost cost";');
    expect(css).toContain(".feed-create-image .ci-plus { grid-area: plus;");
    expect(css).toContain(".feed-create-image .ci-bar .iv-foot { display: contents; }");
    expect(css).toContain(".feed-create-image .ci-bar:not([data-phone]) .kit-gen--hero { flex-direction: column;");
    expect(css).toContain(".feed-create-image .ci-bar:not([data-phone]) .kit-gen--hero .kit-gen-chip { position: static;");
    expect(css).toContain('.feed-create-image .ci-bar[data-phone] { grid-template-columns: auto minmax(0, 1fr); grid-template-areas: "prompt prompt" "plus pills" "gen gen" "cost cost"; }');
  });

  it("docks the bar to a phone's foot, edge to edge", () => {
    expect(phone).toContain("  .feed-create-image .ci-bar {\n    bottom: 0; width: calc(100% + 24px); max-width: none; margin: auto -12px 0;");
  });

  it("draws a job in line grey and a failed one red", () => {
    expect(css).toContain('.feed-create-image .kit-tile[data-status="rendering"]:not([data-sent]) .kit-spinner {\n  border-color: color-mix(in oklab, var(--enki-ink-3) 35%, transparent); border-top-color: var(--enki-ink-3);');
    expect(css).toContain('.feed-create-image .kit-tile[data-status="failed"] { background: color-mix(in oklab, var(--enki-danger) 14%, var(--enki-paper)); }');
    expect(css).toContain(".feed-create-image .ci-copy { background: var(--enki-danger); color: var(--enki-danger-ink); }");
  });

  it("shows the rail and the pair on hover, on keyboard focus and while a menu is open; the picture fills its open button", () => {
    expect(css).toContain(".feed-create-image :is(.ci-rail, .ci-pair) { position: absolute; display: flex; gap: 4px; opacity: 0; transition: opacity 0.14s; }");
    expect(css).toContain(".feed-create-image .ci-rail { top: 8px; right: 8px; flex-direction: column; }");
    expect(css).toContain(".feed-create-image .ci-pair { left: 8px; bottom: 8px; }");
    expect(css).toContain('.feed-create-image .ci-shot:is(:hover, :focus-within, :has([aria-expanded="true"])) :is(.ci-rail, .ci-pair) { opacity: 1; }');
    expect(css).toContain(".feed-create-image .ci-open { display: block; width: 100%; height: 100%; padding: 0; border: 0; background: none; cursor: zoom-in; }");
  });

  it("draws the actions as round 28 px buttons on the stage's glass (lib/ui/create/tile-actions counts on 28, 4 and 8)", () => {
    expect(css).toContain(".feed-create-image .ci-act {\n  display: inline-flex; flex: none; align-items: center; justify-content: center; gap: 6px; width: 28px; height: 28px; padding: 0;\n  border: 0; border-radius: 999px; background: color-mix(in oklab, var(--enki-stage) 62%, transparent); color: var(--enki-on-stage);");
    expect(css).toContain(".feed-create-image .ci-pair .ci-act:is(:hover, :focus-visible) { max-width: min(112px, calc(100cqi - 88px)); }");
  });

  it("gives a touch screen ⋯ alone, no rail", () => {
    expect(css).toContain(".feed-create-image .ci-dots { position: absolute; top: 8px; right: 8px; display: none; width: 32px; height: 32px; }");
    expect(css).toContain("@media (hover: none), (pointer: coarse) {\n  .feed-create-image :is(.ci-rail, .ci-pair) { display: none; }\n  .feed-create-image .ci-dots { display: inline-flex; }\n}");
  });

  it("keeps Studio's Keep on the menu's paper (it is drawn for the viewer's dark stage) and Delete red", () => {
    expect(css).toContain(".ci-keep .st-keep .st-btn { border-color: var(--enki-rule); background: var(--enki-paper); color: var(--enki-ink); }");
    expect(css).toContain(':is(.ci-menu, .ci-sheet) .kit-opt[data-tone="danger"] { color: var(--enki-danger); }');
  });

  it("leaves Make it a prompt's look to Quick Create's button and loads its sheet with the bar", () => {
    expect(css).toContain(".feed-create-image .ci-make { flex: none; margin-top: 8px; }");
    expect(css).not.toMatch(/\.ci-make[^{]*\{[^}]*font/);
    const barSrc = readFileSync(join(__dirname, "..", "..", "components", "create", "image", "ImageBar.tsx"), "utf8");
    expect(barSrc).toContain('import "../../../app/editor/mobile-modal.css";');
  });
});
