import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * Studio's UI (Kev, 2026-10-30: "help me build that as the super responsive and genius UX designer that you are, in the
 * style of enki"): the menu's Studio item with its chevron and projects, the project wizard, Create in a project's
 * context (its strip, its pictures first in the picker, renders filed into the content piece, Keep in the viewer). The
 * components are called as React would render them: state kept between calls, effects run when asked, the scope the
 * context would hand.
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, refs: [] as { current: unknown }[], r: 0, effects: [] as Array<() => unknown>,
  scope: null as unknown, push: vi.fn(), replace: vi.fn(), back: vi.fn(), notify: vi.fn(),
  api: {} as Record<string, ReturnType<typeof vi.fn>>, project: undefined as unknown,
  // Studio's reads as its pages get them; useQuery's answer to any other read (the sheets, useStudio's own).
  content: undefined as unknown, projects: undefined as unknown, notReady: false,
  query: (() => ({ data: undefined, error: null, isLoading: false })) as (o: { queryKey: unknown[]; queryFn: () => Promise<unknown> }) => unknown,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T | (() => T)) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = typeof start === "function" ? (start as () => T)() : start;
    return [ui.state[i], (next: unknown) => { ui.state[i] = typeof next === "function" ? (next as (p: unknown) => unknown)(ui.state[i]) : next; }];
  },
  useRef: <T>(current: T) => { const i = ui.r++; return (ui.refs[i] ??= { current }); },
  useEffect: (fn: () => unknown) => { ui.effects.push(fn); },
  useLayoutEffect: () => {},
  useEffectEvent: (fn: unknown) => fn,
  useId: () => "id",
  useMemo: <T>(make: () => T) => make(),
  useContext: () => ui.scope,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: ui.push, replace: ui.replace, back: ui.back }) }));
vi.mock("@/components/kit/notify", () => ({ notify: ui.notify }));
vi.mock("@/hooks/useStudio", () => ({
  useStudioApi: () => ui.api,
  useStudioProject: () => ({ data: ui.project, notReady: ui.notReady, error: null }),
  useStudioContent: () => ({ data: ui.content, notReady: ui.notReady, error: null }),
  useStudioProjects: () => ({ data: ui.projects, notReady: ui.notReady, error: null }),
  StudioError: class extends Error { constructor(m: string, readonly status: number) { super(m); } },
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (o: { queryKey: unknown[]; queryFn: () => Promise<unknown> }) => ui.query(o),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

import EnkiSidebar, { type StudioMenu } from "@/components/enki-shell/EnkiSidebar";
import StudioStrip from "@/components/studio/StudioStrip";
import StudioRefTiles from "@/components/studio/StudioRefTiles";
import KeepInStudio from "@/components/studio/KeepInStudio";
import ProjectWizard from "@/components/studio/ProjectWizard";
import StudioDialog from "@/components/studio/StudioDialog";
import ContentDialog from "@/components/studio/ContentDialog";
import PillMenu from "@/components/kit/PillMenu";
import { StudioFiling } from "@/components/studio/useFiling";
import { useCreateScope, useSheet, type StudioScopeValue } from "@/components/studio/StudioScope";
import type { Shot } from "@/components/image-view/useImageViewModel";
import StudioPanel from "@/components/studio/StudioPanel";
import StyleDialog from "@/components/studio/StyleDialog";
import MasterPromptDialog from "@/components/studio/MasterPromptDialog";
import { SheetFoot, SheetGrid, sheetsMatching, useOpenSheet } from "@/components/studio/SheetPicker";
import { useAssetUpload } from "@/components/studio/Assets";
import PanelHead from "@/components/enki-shell/PanelHead";
import ConfirmDialog from "@/components/kit/ConfirmDialog";
import { StudioError } from "@/hooks/useStudio";
import { PANEL_BACK } from "@/lib/ui/kit/shell-nav";
import { sheetLink } from "@/lib/ui/studio/links";
import {
  MAX_PROJECT_ASSETS, MAX_PROJECTS, MAX_SUBMENU_PROJECTS, NOT_READ, NOT_SAVED, PROJECT_ASSETS_FULL, PROJECT_NAME_TAKEN,
  PROMPT_NEEDED, STUDIO_NOT_READY, type ContentDetail, type ProjectDetail, type ProjectSummary,
} from "@/lib/studio/types";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) {
    yield node;
    for (const key of ["children", "foot", "marks", "top"]) yield* walk(node.props[key] as ReactNode);
  }
}
const all = (tree: ReactNode) => [...walk(tree)];
const of = (tree: ReactNode, type: unknown) => all(tree).filter((el) => el.type === type);
const byClass = (tree: ReactNode, name: string) => all(tree).filter((el) => String(el.props.className ?? "").split(" ").includes(name));
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("") : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);
const button = (tree: ReactNode, label: string) => all(tree).find((el) => el.type === "button" && (el.props["aria-label"] === label || text(el).trim() === label));
/** A render: hooks counted from the top, the effects of this render kept for `run`. */
function draw<P>(component: (p: P) => unknown, props: P): ReactNode {
  ui.s = 0; ui.r = 0; ui.effects = [];
  return component(props) as ReactNode;
}
/** Runs this render's effects; hands back their cleanups, as React keeps them for the unmount. */
const run = () => ui.effects.splice(0).map((fn) => fn() as (() => void) | undefined);
const fresh = () => { ui.state = []; ui.refs = []; ui.effects = []; };
/** A component StudioPanel picked (an element), rendered as React would render it. */
const inner = (el: ReactNode) => { ui.s = 0; ui.r = 0; ui.effects = []; const e = el as El; return (e.type as (p: unknown) => ReactNode)(e.props); };
const settle = () => new Promise((r) => setTimeout(r, 0));

const P = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const project = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  project: { id: P, name: "Moonlight", description: null, link: null, createdAt: "", updatedAt: "" },
  assets: [{ id: "a1", projectId: P, hash: "h1", createdAt: "", url: "https://s/a1.png", thumb: "https://s/a1.tile.webp" }],
  characters: [
    { id: "c1", projectId: P, name: "Mira", picture: { url: "https://s/mira.png", thumb: "https://s/mira.tile.webp" }, source: "render", imageId: "g1", assetId: null, sheetPromptId: null, createdAt: "" },
    { id: "c2", projectId: P, name: "Gone", picture: null, source: "render", imageId: "g2", assetId: null, sheetPromptId: null, createdAt: "" },
  ],
  styles: [{ id: "s1", projectId: P, name: "Warm film", words: "warm film grain", palette: ["#7d1d33"], createdAt: "", updatedAt: "" }],
  masterPrompts: [{ id: "m1", projectId: P, name: "Launch voice", prompt: "Moonlight, calm", createdAt: "", updatedAt: "" }],
  contents: [],
  ...over,
});
const piece = { id: C, projectId: P, name: "Launch teaser", description: null, link: null, styleId: "s1", masterPromptId: "m1", createdAt: "", updatedAt: "", count: 0, cover: [] };
const scope = (over: Partial<StudioScopeValue> = {}): StudioScopeValue => ({ project: project(), content: piece, filed: new Set(), sheet: null, ...over });

beforeEach(() => {
  fresh();
  ui.scope = null; ui.project = undefined; ui.content = undefined; ui.projects = undefined; ui.notReady = false;
  ui.query = () => ({ data: undefined, error: null, isLoading: false });
  ui.push.mockClear(); ui.replace.mockClear(); ui.back.mockClear(); ui.notify.mockClear();
  ui.api = {
    createProject: vi.fn(async (i: { name: string }) => ({ project: { ...project().project, name: i.name } })),
    updateProject: vi.fn(async (_id: string, i: { name: string }) => ({ project: { ...project().project, name: i.name } })),
    addCharacter: vi.fn(async () => ({ character: {} })),
    fileImages: vi.fn(async (_c: string, ids: string[]) => ({ filed: ids })),
    addContent: vi.fn(async () => ({ content: piece })),
    updateContent: vi.fn(async () => ({ content: piece })),
    addStyle: vi.fn(async () => ({ style: {} })),
    addMasterPrompt: vi.fn(async () => ({ masterPrompt: {} })),
    deleteProject: vi.fn(async () => ({ deleted: true })),
    deleteContent: vi.fn(async () => ({ deleted: true })),
  };
});
afterEach(() => vi.unstubAllGlobals());

describe("the menu's Studio item (EnkiSidebar)", () => {
  const menu = (over: Partial<StudioMenu> = {}): StudioMenu => ({
    projects: [{ id: "p1", name: "Moonlight" }, { id: "p2", name: "Spring drop" }], open: true, atCap: false, current: "p2",
    onToggle: vi.fn(), onProject: vi.fn(), onAll: vi.fn(), onCreate: vi.fn(), ...over,
  });
  const props = (over: object = {}) => ({
    nav: [{ id: "home", label: "Explore", icon: "grid" }, { id: "studio", label: "Studio", icon: "folder" }, { id: "fame", label: "Hall of Fame", icon: "trophy" }],
    active: "studio", onNav: vi.fn(), rail: false, onCreate: vi.fn(), account: { name: "kev", handle: "kev" }, closed: false, canFull: true,
    onMenu: vi.fn(), balance: "$1", onProfile: vi.fn(), onTopUp: vi.fn(), theme: "light" as const, setTheme: vi.fn(), ...over,
  });
  const side = (over: object = {}) => draw(EnkiSidebar, props(over) as Parameters<typeof EnkiSidebar>[0]);
  const rows = (tree: ReactNode) => byClass(tree, "ek-sub-row").map((el) => [text(el).trim(), el.props["aria-current"] ?? null]);

  it("puts a chevron of its own beside Studio, not inside it, that only folds the projects", () => {
    const studio = menu();
    const tree = side({ studio });
    const group = byClass(tree, "ek-nav-group")[0];
    const [item, toggle] = (byClass(group, "ek-nav-row")[0].props.children as El[]);
    expect(item.props.className).toContain("ek-nav-item");
    expect(byClass(item, "ek-sub-toggle")).toHaveLength(0);
    expect(toggle.props).toMatchObject({ className: "ek-sub-toggle kit-hit", "aria-expanded": true, "aria-controls": "ek-studio-sub", "aria-label": "Hide projects" });
    (toggle.props.onClick as () => void)();
    expect(studio.onToggle).toHaveBeenCalledTimes(1);
    const closed = byClass(side({ studio: menu({ open: false }) }), "ek-sub-toggle")[0];
    expect(closed.props).toMatchObject({ "aria-expanded": false, "aria-label": "Show projects" });
  });

  it("lists the projects under it, the one the address names marked, then Create project; folded, they take no focus", () => {
    const tree = side({ studio: menu() });
    expect(rows(tree)).toEqual([["Moonlight", null], ["Spring drop", "page"], ["Create project", null]]);
    const list = all(tree).find((el) => el.props.id === "ek-studio-sub")!;
    expect(list.props).toMatchObject({ role: "group", "aria-label": "Projects", inert: false });
    expect(byClass(tree, "ek-sub")[0].props["data-open"]).toBe(true);
    const shut = side({ studio: menu({ open: false }) });
    expect(all(shut).find((el) => el.props.id === "ek-studio-sub")!.props.inert).toBe(true);
    expect(byClass(shut, "ek-sub")[0].props["data-open"]).toBeUndefined();
  });

  it("opens a project, the overview or the wizard from its rows", () => {
    const studio = menu({ projects: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })) });
    const tree = side({ studio });
    expect(rows(tree).map(([t]) => t)).toEqual(["P0", "P1", "P2", "P3", "All projects · 6"]);
    (button(tree, "P1")!.props.onClick as () => void)();
    (button(tree, "All projects · 6")!.props.onClick as () => void)();
    expect(studio.onProject).toHaveBeenCalledWith("p1");
    expect(studio.onAll).toHaveBeenCalledTimes(1);
    const none = menu({ projects: [] });
    (button(side({ studio: none }), "Create project")!.props.onClick as () => void)();
    expect(none.onCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps the rail a plain icon (no chevron, no rows) and a guest without any", () => {
    expect(byClass(side({ studio: menu(), rail: true }), "ek-sub-toggle")).toHaveLength(0);
    expect(byClass(side({ studio: menu(), rail: true }), "ek-sub-row")).toHaveLength(0);
    expect(byClass(side({}), "ek-nav-group")).toHaveLength(0);
  });

  // Review 2026-10-30: loading read as none, and "Create project" stood alone for an account with projects.
  it("lists no row while the projects are not read (loading, failed); marks the signed-in menu for its sooner fold", () => {
    const tree = side({ studio: menu({ projects: undefined }) });
    expect(rows(tree)).toEqual([]);
    expect((tree as El).props["data-studio"]).toBe("");
    expect((side({}) as El).props["data-studio"]).toBeUndefined();
  });

  it("measures its room in the column only: the phone's drawer lists as many rows as ever", () => {
    const studio = menu({ projects: Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })) });
    ui.state = [];
    side({ studio });
    // The room the column measured: one row.
    ui.state[ui.state.length - 1] = 1;
    expect(rows(side({ studio })).map(([t]) => t)).toEqual(["All projects · 4"]);
    expect(rows(side({ studio, phone: true })).map(([t]) => t)).toEqual(["P0", "P1", "P2", "P3", "Create project"]);
    expect(MAX_SUBMENU_PROJECTS + 1).toBe(5);
  });

  it("lists the projects under Studio in the short window's Menu too, indented", () => {
    const studio = menu();
    ui.state = [];
    side({ studio });
    // Open the Menu (its state: the second useState).
    ui.state[1] = true;
    const tree = side({ studio });
    const items = byClass(tree, "ek-burger-item").map((el) => [text(el).trim(), String(el.props.className).includes("ek-burger-sub")]);
    expect(items).toEqual([["Explore", false], ["Studio", false], ["Moonlight", true], ["Spring drop", true], ["Create project", true], ["Hall of Fame", false]]);
  });
});

describe("Create in a project: the strip over the composer", () => {
  const strip = (text: string, setText: (t: string) => void, over: Partial<StudioScopeValue> = {}, tool: "image" | "video" = "image") => {
    ui.scope = scope(over);
    return { tree: draw(StudioStrip, { tool, text, setText }), setText };
  };
  /** The strip's own row, rendered (StudioStrip hands its scope to its inner row). */
  const row = (text: string, setText: (t: string) => void, over: Partial<StudioScopeValue> = {}, tool: "image" | "video" = "image") => {
    const outer = strip(text, setText, over, tool).tree as El;
    ui.s = 0; ui.r = 0; ui.effects = [];
    return (outer.type as (p: unknown) => ReactNode)(outer.props);
  };

  it("is nothing outside a project", () => {
    ui.scope = null;
    expect(draw(StudioStrip, { tool: "image", text: "", setText: vi.fn() })).toBeNull();
  });

  it("says where it is and where Image's renders go; Video's has no such line", () => {
    const setText = vi.fn();
    const tree = row("", setText);
    expect(text(byClass(tree, "st-strip-name")[0]).replace(/\s+/g, " ")).toBe("Moonlight › Launch teaser");
    expect(text(byClass(tree, "st-strip-note")[0])).toBe("New images go to Launch teaser");
    expect(byClass(row("", setText, {}, "video"), "st-strip-note")).toHaveLength(0);
  });

  it("fills an empty composer with the piece's master prompt and style once, never over words", () => {
    const setText = vi.fn();
    row("", setText);
    run();
    expect(setText).toHaveBeenCalledWith("Moonlight, calm\n\nwarm film grain\nColour palette: #7d1d33");
    row("", setText);
    run();
    expect(setText).toHaveBeenCalledTimes(1);
    fresh();
    const kept = vi.fn();
    row("my own words", kept);
    run();
    expect(kept).not.toHaveBeenCalled();
  });

  it("adds a master prompt or a style after the words with a chip; × leaves the project", () => {
    const setText = vi.fn();
    const tree = row("a fox", setText);
    const [master, style] = of(tree, PillMenu);
    expect([master.props.title, style.props.title]).toEqual(["Add a master prompt", "Add a style"]);
    (master.props.onPick as (k: string) => void)("m1");
    (style.props.onPick as (k: string) => void)("s1");
    expect(setText.mock.calls).toEqual([["a fox\n\nMoonlight, calm"], ["a fox\n\nwarm film grain\nColour palette: #7d1d33"]]);
    (button(tree, "Leave the project")!.props.onClick as () => void)();
    expect(ui.replace).toHaveBeenCalledWith("/home?create=image");
  });
});

describe("the project's pictures in the reference picker (StudioRefTiles)", () => {
  const model = (over: object = {}) => ({ uploads: [], library: [], deletedRefs: [], myImages: [], refs: [], room: 2, toggleRef: vi.fn(), deleteRef: vi.fn(), addNfts: vi.fn(), ...over });
  it("is nothing outside a project", () => {
    ui.scope = null;
    expect(draw(StudioRefTiles, { model: model(), kind: "assets" })).toBeNull();
  });

  it("puts its assets under its name, a switch each: on while in the prompt, nothing added by itself", () => {
    ui.scope = scope();
    const m = model({ refs: [{ id: "https://s/a1.png" }] });
    const tree = draw(StudioRefTiles, { model: m, at: 3, kind: "assets" });
    expect(text(byClass(tree, "st-rt-head")[0])).toBe("Moonlight");
    const tile = byClass(tree, "iv-rp-item")[0];
    expect(tile.props).toMatchObject({ "aria-pressed": true, "data-on": true, disabled: false });
    expect(m.toggleRef).not.toHaveBeenCalled();
    (tile.props.onClick as () => void)();
    expect(m.toggleRef).toHaveBeenCalledWith("https://s/a1.png", 3);
  });

  // Review 2026-10-30: every read of Studio signs its assets anew; matched by the whole address the tile read OFF for a
  // picture in the prompt, and a second press added a copy.
  it("knows its picture in the prompt after Studio signed it anew, and takes that one out instead of adding a copy", () => {
    ui.scope = scope({ project: project({ assets: [{ ...project().assets[0], url: "https://s/a1.png?token=new" }] }) });
    const m = model({ refs: [{ id: "https://s/a1.png?token=old" }] });
    const tile = byClass(draw(StudioRefTiles, { model: m, at: 2, kind: "assets" }), "iv-rp-item")[0];
    expect(tile.props).toMatchObject({ "aria-pressed": true, "data-on": true });
    (tile.props.onClick as () => void)();
    expect(m.toggleRef).toHaveBeenCalledWith("https://s/a1.png?token=old", 2);
  });

  it("greys a tile out once the generator takes no more, and shows the characters with a picture, named", () => {
    ui.scope = scope();
    const full = draw(StudioRefTiles, { model: model({ room: 0 }), kind: "assets" });
    expect(byClass(full, "iv-rp-item")[0].props).toMatchObject({ disabled: true, "aria-pressed": false });
    const chars = draw(StudioRefTiles, { model: model(), kind: "characters" });
    expect(byClass(chars, "st-rt-name").map((el) => text(el))).toEqual(["Mira"]);
    expect((chars as El).props["data-kind"]).toBe("characters");
  });
});

describe("Keep in <Project> in the viewer (KeepInStudio)", () => {
  const record = (over: object = {}) => ({ id: "g9", image_url: "u", image_urls: ["u"], thumbnail_url: null, isUploaded: false, visibility: "private", prompt_id: null, created_at: "", ...over });
  const shot = (over: Partial<Shot> = {}): Shot => ({ key: "history:g9", kind: "history", ratio: null, record: record() as Shot["record"], ...over });
  const keep = (s: Shot, guest = false, promptId: string | null = "sheet-1") => draw(KeepInStudio, { shot: s, promptId, guest });

  it("is for the viewer's own render, signed in, in a project: never an upload, a guest, someone else's or outside one", () => {
    ui.scope = scope();
    expect(keep(shot())).not.toBeNull();
    expect(keep(shot({ record: record({ isUploaded: true }) as Shot["record"] }))).toBeNull();
    expect(keep(shot(), true)).toBeNull();
    expect(keep(shot({ record: undefined, kind: "community", publicId: "x" }))).toBeNull();
    ui.scope = null;
    expect(keep(shot())).toBeNull();
  });

  it("waits, dimmed, while a finished job's row is not read yet", () => {
    ui.scope = scope();
    const job = { id: "j", createdAt: 1, status: "ready", setup: {}, seen: true } as unknown as Shot["job"];
    const tree = keep(shot({ record: undefined, kind: "job", job }));
    expect(button(tree, "As a character")!.props.disabled).toBe(true);
    expect(text(byClass(tree, "st-note")[0])).toBe("Saving your render…");
  });

  it("keeps it as a character, named, with the sheet it was made on", async () => {
    ui.scope = scope();
    (button(keep(shot()), "As a character")!.props.onClick as () => void)();
    ui.state[1] = "Mira";
    const form = byClass(keep(shot()), "st-keep-name")[0];
    await (form.props.onSubmit as (e: object) => Promise<void>)({ preventDefault: () => {} });
    await Promise.resolve();
    expect(ui.api.addCharacter).toHaveBeenCalledWith(P, { name: "Mira", imageId: "g9", sheetPromptId: "sheet-1" });
    expect(ui.notify).toHaveBeenCalledWith("Mira is one of Moonlight's characters.");
  });

  it("files it in the piece by hand, and says so once it is there", async () => {
    ui.scope = scope();
    await (button(keep(shot()), "In Launch teaser")!.props.onClick as () => Promise<void>)();
    expect(ui.api.fileImages).toHaveBeenCalledWith(C, ["g9"]);
    expect(ui.notify).toHaveBeenCalledWith("Filed in Launch teaser.");
    ui.scope = scope({ filed: new Set(["g9"]) });
    expect(button(keep(shot()), "In Launch teaser ✓")!.props.disabled).toBe(true);
  });
});

describe("renders filed from Create > Image (StudioFiling, useFiling)", () => {
  const job = (id: string, status = "ready") => ({ id, createdAt: 1, status, imageUrl: `https://x/${id}.png`, setup: {}, seen: true }) as never;
  const row = (id: string, url: string) => ({ id, image_url: url, image_urls: [url], thumbnail_url: null, isUploaded: false, visibility: "private", prompt_id: null, created_at: "" }) as never;
  // A render of Create > Image's filing, its effect run as React runs it after the render.
  const file = (jobs: never[], rows: never[]) => { ui.s = 0; ui.r = 0; ui.effects = []; StudioFiling({ jobs, rows }); run(); };

  it("files a render started in the piece once its row is in, once; one there before Create opened never", async () => {
    ui.scope = scope();
    file([job("old")], [row("r-old", "https://x/old.png")]);
    file([job("new"), job("old")], []);
    expect(ui.api.fileImages).not.toHaveBeenCalled();
    file([job("new"), job("old")], [row("r-new", "https://x/new.png"), row("r-old", "https://x/old.png")]);
    file([job("new"), job("old")], [row("r-new", "https://x/new.png"), row("r-old", "https://x/old.png")]);
    expect(ui.api.fileImages.mock.calls).toEqual([[C, ["r-new"]]]);
  });

  it("says a failed filing once per piece", async () => {
    ui.scope = scope();
    ui.api.fileImages = vi.fn(async () => { throw new Error("boom"); });
    file([], []);
    file([job("a")], [row("r-a", "https://x/a.png")]);
    file([job("b"), job("a")], [row("r-b", "https://x/b.png"), row("r-a", "https://x/a.png")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(ui.notify.mock.calls).toEqual([["Couldn't file that image in Launch teaser", { tone: "error" }]]);
  });
});

describe("the project wizard (Kev, 2026-10-30: \"beim click auf Next wird nach assets gefragt\")", () => {
  const wizard = (over: object = {}) => draw(ProjectWizard, { onClose: vi.fn(), onOpen: vi.fn(), ...over } as Parameters<typeof ProjectWizard>[0]) as El;
  const primary = (tree: El) => byClass(tree.props.foot as ReactNode, "st-btn--cta")[0];
  const type = (name: string) => { ui.state[1] = { name, description: "", link: "" }; };

  it("asks for the details first, Next dimmed until there is a name", () => {
    const tree = wizard();
    expect(tree.type).toBe(StudioDialog);
    expect(tree.props.title).toBe("New project.");
    expect(text(tree.props.marks as ReactNode)).toBe("1 Details · 2 Assets");
    const on = (t: El) => all(t.props.marks as ReactNode).filter((el) => el.type === "span").map((el) => el.props["data-on"] ?? false);
    expect(on(tree)).toEqual([true, false]);
    expect(primary(tree).props["aria-disabled"]).toBe(true);
    expect(text(primary(tree))).toBe("Next →");
  });

  it("creates the project on Next, so step 2 has a place for its pictures; leaving then keeps it and says so", async () => {
    const onClose = vi.fn();
    wizard({ onClose });
    type(" Moonlight ");
    await (primary(wizard({ onClose })).props.onClick as () => Promise<void>)();
    await Promise.resolve();
    expect(ui.api.createProject).toHaveBeenCalledWith({ name: "Moonlight", description: null, link: null });
    const step2 = wizard({ onClose });
    expect(step2.props.title).toBe("Assets & characters.");
    expect(all(step2.props.marks as ReactNode).filter((el) => el.type === "span").map((el) => el.props["data-on"] ?? false)).toEqual([false, true]);
    expect(text(primary(step2))).toBe("Open project");
    (step2.props.onClose as () => void)();
    expect(ui.notify).toHaveBeenCalledWith("Moonlight is in Studio.");
    expect(onClose).toHaveBeenCalled();
  });

  it("saves the edits after Back instead of making a second project", async () => {
    wizard();
    type("Moonlight");
    await (primary(wizard()).props.onClick as () => Promise<void>)();
    await Promise.resolve();
    (button(wizard().props.foot as ReactNode, "← Back")!.props.onClick as () => void)();
    type("Moonlight II");
    await (primary(wizard()).props.onClick as () => Promise<void>)();
    await Promise.resolve();
    expect(ui.api.createProject).toHaveBeenCalledTimes(1);
    expect(ui.api.updateProject).toHaveBeenCalledWith(P, { name: "Moonlight II", description: null, link: null });
  });

  it("puts the server's refusal under the field it concerns, any other as a toast", async () => {
    ui.api.createProject = vi.fn(async () => { throw new Error(PROJECT_NAME_TAKEN); });
    wizard();
    type("Moonlight");
    await (primary(wizard()).props.onClick as () => Promise<void>)();
    await Promise.resolve();
    expect(ui.state[2]).toEqual({ field: "name", message: PROJECT_NAME_TAKEN });
    ui.api.createProject = vi.fn(async () => { throw new Error(STUDIO_NOT_READY); });
    await (primary(wizard()).props.onClick as () => Promise<void>)();
    await Promise.resolve();
    expect(ui.notify).toHaveBeenCalledWith(STUDIO_NOT_READY, { tone: "error" });
  });

  it("edits a project in one step, saving", async () => {
    const onClose = vi.fn();
    const tree = wizard({ edit: project().project, onClose });
    expect([tree.props.title, tree.props.marks, text(primary(tree))]).toEqual(["Edit project.", false, "Save"]);
    await (primary(tree).props.onClick as () => Promise<void>)();
    await Promise.resolve();
    expect(ui.api.updateProject).toHaveBeenCalledWith(P, { name: "Moonlight", description: null, link: null });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes its drop zone once the project holds its 20 pictures", async () => {
    wizard();
    type("Moonlight");
    (primary(wizard()).props.onClick as () => void)();
    await settle();
    const tiles = (n: number) => Array.from({ length: n }, (_, i) => ({ ...project().assets[0], id: `a${i}`, hash: `h${i}` }));
    const drop = () => byClass(wizard().props.children as ReactNode, "st-drop")[0].props.disabled;
    ui.project = project({ assets: tiles(MAX_PROJECT_ASSETS - 1) });
    expect(drop()).toBe(false);
    ui.project = project({ assets: tiles(MAX_PROJECT_ASSETS) });
    expect(drop()).toBe(true);
  });
});

describe("+ Content (ContentDialog)", () => {
  // Kev, 2026-10-30: "style oder master prompts wähle ich da noch nicht aus. diese leiste da ist eher die ganze zeit sichtbar".
  it("asks for no style or master prompt: a new piece has none, Create's strip offers them", async () => {
    const onDone = vi.fn();
    const open = () => draw(ContentDialog, { project: project(), onClose: vi.fn(), onDone }) as El;
    const tree = open();
    expect(of(tree.props.children as ReactNode, PillMenu)).toEqual([]);
    expect(text(tree.props.children as ReactNode)).not.toMatch(/Style|Master prompt/);
    expect(text(byClass(tree.props.children as ReactNode, "st-line")[0])).toBe("Brings along 1 asset, 2 characters.");
    ui.state[0] = { name: "Launch teaser", description: "", link: "" };
    await (byClass(open().props.foot as ReactNode, "st-btn--cta")[0].props.onClick as () => Promise<void>)();
    await Promise.resolve();
    expect(ui.api.addContent).toHaveBeenCalledWith(P, { name: "Launch teaser", description: null, link: null });
    expect(onDone).toHaveBeenCalledWith(piece);
  });

  it("edits a piece's details and leaves its own style and master prompt as they are", async () => {
    const two = project({ styles: [project().styles[0], { ...project().styles[0], id: "s2", name: "Cold" }] });
    const open = () => draw(ContentDialog, { project: two, content: { ...piece, styleId: "s2", masterPromptId: null }, onClose: vi.fn(), onDone: vi.fn() }) as El;
    const tree = open();
    expect(tree.props.title).toBe("Edit content.");
    expect(of(tree.props.children as ReactNode, PillMenu)).toEqual([]);
    (byClass(open().props.foot as ReactNode, "st-btn--cta")[0].props.onClick as () => void)();
    await settle();
    // A PATCH without them keeps them (app/api/studio/contents/[id]: "an absent field stays").
    expect(ui.api.updateContent).toHaveBeenCalledWith(C, { name: "Launch teaser", description: null, link: null });
  });
});

describe("Studio's pages (StudioPanel)", () => {
  const props = (place: object = {}) => ({ place, onPlace: vi.fn(), onBack: vi.fn(), onWizard: vi.fn(), onReplace: vi.fn() });
  /** The page StudioPanel picks for the place, rendered. */
  const page = (p: ReturnType<typeof props>) => inner(draw(StudioPanel, p));
  const summary = (i: number): ProjectSummary => ({ ...project().project, id: `p${i}`, name: `P${i}`, counts: { assets: 0, characters: 0, contents: 0 }, cover: [] });
  const detail = (over: Partial<ContentDetail> = {}): ContentDetail => ({ content: piece, project: { id: P, name: "Moonlight" }, images: [], ...over });

  // Kev, 2026-10-30: "i also wanna add a project inside of the studio, show it as a +create folder basically".
  const create = (tree: ReactNode) => all(tree).find((el) => el.props.label === "Create project");

  it("opens with a Create project folder first among the projects, the wizard on a press, greyed at the cap", () => {
    ui.projects = { projects: [summary(0), summary(1)] };
    const p = props();
    const tree = page(p);
    const grid = all(tree).find((el) => el.props.className === "st-grid")!;
    const [first, ...rest] = (grid.props.children as [El, El[]]).flat() as El[];
    expect([first.props.label, first.props.className, first.props.disabled]).toEqual(["Create project", "st-add--folder", false]);
    expect(rest.map((el) => el.props.name)).toEqual(["P0", "P1"]);
    (first.props.onClick as () => void)();
    expect(p.onWizard).toHaveBeenCalledWith();
    // One way to a new project: the folder (the head's New project went).
    expect(button(tree, "New project")).toBeUndefined();
    ui.projects = { projects: Array.from({ length: MAX_PROJECTS }, (_, i) => summary(i)) };
    expect(create(page(props()))!.props.disabled).toBe(true);
  });

  // Kev, 2026-10-30: "Studio is not available yet. remove that".
  it("shows the Create project folder before SQL 53 and while the projects load, with no line about either", () => {
    for (const notReady of [true, false]) {
      ui.notReady = notReady;
      ui.projects = undefined;
      const tree = page(props());
      expect(create(tree)).toBeDefined();
      expect(all(tree).some((el) => el.props.title === STUDIO_NOT_READY)).toBe(false);
      expect(text(tree)).not.toContain("Loading your projects");
    }
  });

  // Kev, 2026-10-30: "i want these to be in one line that i can then responsively open and see all of them. content is
  // the main area where i will create new content pieces through which i will access all of the things above".
  it("puts Assets, Characters, Styles and Master prompts in one line, each with its count and a glance, Content under it", () => {
    ui.project = project();
    const tree = page(props({ project: P }));
    const tabs = byClass(tree, "st-kit-tab");
    expect(tabs.map((t) => text(byClass(t, "kit-label")[0]))).toEqual(["Assets", "Characters", "Styles", "Master prompts"]);
    expect(tabs.map((t) => text(byClass(t, "st-kit-count")[0]))).toEqual(["1 / 20", "2 / 12", "1 / 6", "1 / 6"]);
    expect(tabs.map((t) => t.props["aria-expanded"])).toEqual([false, false, false, false]);
    // A glance: the pictures (a character without one shows none), the first style's colours, the first master prompt.
    const peek = (i: number) => byClass(tabs[i], "st-kit-peek")[0];
    expect([all(peek(0)).filter((el) => el.type === "img").map((el) => el.props.src), all(peek(1)).filter((el) => el.type === "img").map((el) => el.props.src)])
      .toEqual([["https://s/a1.tile.webp"], ["https://s/mira.tile.webp"]]);
    expect([all(peek(2)).filter((el) => Array.isArray(el.props.palette)).map((el) => el.props.palette), text(peek(3))]).toEqual([[["#7d1d33"]], "Launch voice"]);
    // Shut: the panel is folded and out of reach; Content is the page's own area under the line.
    const panel = byClass(tree, "st-kit-panel")[0];
    expect([panel.props["data-open"], byClass(tree, "st-kit-in")[0].props.inert]).toEqual([undefined, true]);
    const at = (pred: (el: El) => boolean) => all(tree).findIndex(pred);
    const kitAt = at((el) => el.props.className === "st-kit");
    const contentAt = at((el) => el.props.label === "Content" && "count" in el.props);
    expect([kitAt > -1, contentAt > kitAt]).toEqual([true, true]);
  });

  it("opens one part below the line with all it holds, another in its place, and folds it on a second press", () => {
    ui.project = project();
    const tabs = () => byClass(page(props({ project: P })), "st-kit-tab");
    const open = () => {
      const tree = page(props({ project: P }));
      return { expanded: byClass(tree, "st-kit-tab").map((t) => t.props["aria-expanded"]), panel: byClass(tree, "st-kit-panel")[0].props["data-open"],
        inert: byClass(tree, "st-kit-in")[0].props.inert, adds: all(byClass(tree, "st-kit-in")[0]).filter((el) => typeof el.type === "function" && typeof el.props.label === "string" && "onClick" in el.props).map((el) => el.props.label as string).filter((l) => !l.startsWith("Delete ")) };
    };
    (tabs()[1].props.onClick as () => void)();
    expect(open()).toMatchObject({ expanded: [false, true, false, false], panel: "", inert: false, adds: ["Character"] });
    (tabs()[2].props.onClick as () => void)();
    expect(open()).toMatchObject({ expanded: [false, false, true, false], adds: ["Style"] });
    (tabs()[2].props.onClick as () => void)();
    // Folding keeps the part drawn under the fold, out of reach.
    expect(open()).toMatchObject({ expanded: [false, false, false, false], panel: undefined, inert: true, adds: ["Style"] });
  });

  it("shows a content piece only under its own project's address", () => {
    ui.project = project();
    ui.content = detail({ project: { id: "elsewhere", name: "Elsewhere" } });
    const there = page(props({ project: P, content: C }));
    expect(of(there, PanelHead)).toHaveLength(0);
    expect(all(there).some((el) => el.props.title === "Not found")).toBe(true);
    ui.content = detail();
    expect(of(page(props({ project: P, content: C })), PanelHead)[0].props.title).toBe("Launch teaser.");
  });

  it("puts the overview in place of a deleted project, never the page before it", async () => {
    ui.project = project();
    const p = props({ project: P });
    const more = of(page(p), PillMenu).find((el) => el.props.ariaLabel === "More")!;
    (more.props.onPick as (k: string) => void)("delete");
    const confirm = of(page(p), ConfirmDialog)[0];
    expect(confirm.props).toMatchObject({ title: "Delete Moonlight?", confirmLabel: "Delete project" });
    (confirm.props.onConfirm as () => void)();
    await settle();
    expect(ui.api.deleteProject).toHaveBeenCalledWith(P);
    expect(p.onReplace).toHaveBeenCalledWith({});
    expect(p.onBack).not.toHaveBeenCalled();
  });

  it("puts its project in place of a deleted content piece", async () => {
    ui.project = project();
    ui.content = detail();
    const p = props({ project: P, content: C });
    (button(page(p), "Delete")!.props.onClick as () => void)();
    (of(page(p), ConfirmDialog)[0].props.onConfirm as () => void)();
    await settle();
    expect(ui.api.deleteContent).toHaveBeenCalledWith(C);
    expect(p.onReplace).toHaveBeenCalledWith({ project: P });
    expect(p.onBack).not.toHaveBeenCalled();
  });
});

describe("Studio's popups (StudioDialog): keys and focus", () => {
  /* The document as a key reaches it: its capture listeners on the way down, then its bubbling ones on the way up,
     unless one stopped it on the way (listeners on the same node in the same phase all run). */
  const doc = { listeners: [] as Array<{ fn: (e: unknown) => void; capture: boolean }>, activeElement: null as unknown };
  const press = (key: string, shiftKey = false) => {
    let stopped = false;
    let prevented = false;
    const e = { key, shiftKey, get cancelBubble() { return stopped; }, stopPropagation: () => { stopped = true; }, preventDefault: () => { prevented = true; } };
    for (const capture of [true, false]) {
      if (stopped) break;
      for (const l of doc.listeners.filter((x) => x.capture === capture)) l.fn(e);
    }
    return prevented;
  };
  const field = (name: string) => { const f = { name, isConnected: true, focus: vi.fn(() => { doc.activeElement = f; }) }; return f; };
  const fields = [field("name"), field("description"), field("save")];
  const opener = field("opener");
  function open(onClose = vi.fn()) {
    doc.listeners = [];
    vi.stubGlobal("document", {
      get activeElement() { return doc.activeElement; },
      addEventListener: (_t: string, fn: (e: unknown) => void, capture?: boolean) => doc.listeners.push({ fn, capture: !!capture }),
      removeEventListener: (_t: string, fn: (e: unknown) => void, capture?: boolean) => { doc.listeners = doc.listeners.filter((l) => l.fn !== fn || l.capture !== !!capture); },
    });
    // A layer open under the dialog first, heard on the document as it bubbles (an image view, EnkiDetailPanel).
    const under = vi.fn();
    doc.listeners.push({ fn: (e) => { const k = e as { key: string; cancelBubble: boolean }; if (k.key === "Escape" && !k.cancelBubble) under(); }, capture: false });
    doc.activeElement = opener;
    draw(StudioDialog, { title: "New project.", foot: null, onClose, children: null });
    ui.refs[0].current = { querySelectorAll: () => fields, querySelector: (sel: string) => (sel === "[data-autofocus]" ? null : fields[0]) };
    const cleanups = run();
    return { onClose, under, unmount: () => cleanups.forEach((c) => c?.()) };
  }

  // Kev, 2026-10-30: "when clicking \"new content\" dann soll ruhig die linke sidebar auch ausgegraut sein".
  it("is drawn on the page itself, so its scrim covers the menu and not only the panel it opened in", () => {
    const body = { nodeType: 1 };
    vi.stubGlobal("document", { body, activeElement: null, addEventListener: () => {}, removeEventListener: () => {} });
    const out = draw(StudioDialog, { title: "New content.", foot: null, onClose: vi.fn(), children: null }) as unknown as { containerInfo?: unknown; children?: El };
    expect(out.containerInfo).toBe(body);
    expect(String(out.children?.props.className)).toContain("st-scrim");
  });

  it("closes alone on Esc: a layer under it hears nothing of it", () => {
    const { onClose, under } = open();
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
  });

  it("takes the focus to its first field, keeps Tab inside, and hands the focus back to what opened it", () => {
    const { unmount } = open();
    expect(doc.activeElement).toBe(fields[0]);
    doc.activeElement = fields[2];
    expect(press("Tab")).toBe(true);
    expect(doc.activeElement).toBe(fields[0]);
    expect(press("Tab", true)).toBe(true);
    expect(doc.activeElement).toBe(fields[2]);
    doc.activeElement = fields[1];
    expect(press("Tab")).toBe(false);
    unmount();
    expect(opener.focus).toHaveBeenCalled();
    expect(doc.listeners).toHaveLength(1);
  });
});

describe("a project's styles, master prompts and character sheets", () => {
  const save = (tree: ReactNode) => { (byClass((tree as El).props.foot as ReactNode, "st-btn--cta")[0].props.onClick as () => void)(); return settle(); };

  it("keeps a style's colours as the server does, lower-case", async () => {
    const onClose = vi.fn();
    draw(StyleDialog, { project: P, onClose });
    ui.state[0] = "Warm film";
    ui.state[2] = ["#7D1D33", "#CBA24A"];
    await save(draw(StyleDialog, { project: P, onClose }));
    expect(ui.api.addStyle).toHaveBeenCalledWith(P, { name: "Warm film", words: "", palette: ["#7d1d33", "#cba24a"] });
    expect(onClose).toHaveBeenCalled();
  });

  it("sends no master prompt without its words, and says so under the field", async () => {
    draw(MasterPromptDialog, { project: P, onClose: vi.fn() });
    ui.state[0] = "Launch voice";
    ui.state[1] = "   ";
    await save(draw(MasterPromptDialog, { project: P, onClose: vi.fn() }));
    expect(ui.api.addMasterPrompt).not.toHaveBeenCalled();
    expect(ui.state[2]).toEqual({ field: "prompt", message: PROMPT_NEEDED });
    ui.state[1] = "Moonlight, calm";
    await save(draw(MasterPromptDialog, { project: P, onClose: vi.fn() }));
    expect(ui.api.addMasterPrompt).toHaveBeenCalledWith(P, { name: "Launch voice", prompt: "Moonlight, calm" });
  });

  it("uses a character sheet only once one is picked", () => {
    const press = (picked: string | null) => {
      const onUse = vi.fn();
      const use = button(draw(SheetFoot, { picked, onBack: vi.fn(), onUse }), "Use this sheet →")!;
      (use.props.onClick as () => void)();
      return { onUse, dimmed: use.props["aria-disabled"] };
    };
    expect(press(null)).toMatchObject({ dimmed: true });
    expect(press(null).onUse).not.toHaveBeenCalled();
    expect(press("sheet-1").onUse).toHaveBeenCalledTimes(1);
  });
});

describe("pictures into a project (useAssetUpload)", () => {
  const png = (name: string) => new File(["x"], name, { type: "image/png" });
  const upload = () => { ui.s = 0; return useAssetUpload(P); };

  it("stores them one after another and stops at a full project, saying why once; another failure goes on", async () => {
    ui.api.addAsset = vi.fn().mockRejectedValueOnce(new StudioError(PROJECT_ASSETS_FULL, 409)).mockResolvedValue({});
    await upload().add([png("a.png"), png("b.png"), png("c.png")]);
    expect(ui.api.addAsset).toHaveBeenCalledTimes(1);
    expect(ui.notify.mock.calls).toEqual([[PROJECT_ASSETS_FULL, { tone: "error" }]]);
    expect(ui.state[0]).toEqual([]);
    ui.api.addAsset = vi.fn().mockRejectedValueOnce(new StudioError(NOT_SAVED, 500)).mockResolvedValue({});
    await upload().add([png("a.png"), png("b.png")]);
    expect(ui.api.addAsset).toHaveBeenCalledTimes(2);
  });
});

describe("Create in a project: the scope and the character sheet's view", () => {
  const SHEET = "33333333-3333-4333-8333-333333333333";
  const at = { project: P, content: C, sheet: null };

  it("takes a content piece only of the project the address names (useCreateScope)", () => {
    ui.project = project();
    const image = { imageId: "g1", promptId: null, addedAt: "", url: "u", thumb: "t" };
    ui.content = { content: piece, project: { id: P, name: "Moonlight" }, images: [image] };
    expect(useCreateScope(at)).toMatchObject({ content: piece, filed: new Set(["g1"]) });
    ui.content = { content: { ...piece, projectId: "elsewhere" }, project: { id: "elsewhere", name: "Elsewhere" }, images: [image] };
    expect(useCreateScope(at)).toMatchObject({ content: null, filed: new Set() });
  });

  /* The browser's history around the sheet: the entry it shows, and the pages the tab showed before (`length`). */
  const browser = (state: unknown, length: number) => {
    const href = `http://enki.test/home?create=image&project=${P}&sheet=${SHEET}&prompt=${SHEET}`;
    const history = { state, length, replaceState: vi.fn((s: unknown) => { history.state = s; }), go: vi.fn() };
    vi.stubGlobal("window", { history, location: { href } });
    return { history, href };
  };
  const sheet = () => { ui.s = 0; ui.effects = []; const s = useSheet(); run(); return s!; };

  it("closes a sheet's link opened fresh in place, in Enki, whatever the tab showed before it", () => {
    ui.scope = scope({ sheet: SHEET });
    const { history } = browser({ __NA: true }, 3);
    sheet().close();
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(history.go).not.toHaveBeenCalled();
    expect(ui.replace).toHaveBeenCalledWith(`/home?create=image&project=${P}`);
  });

  it("marks the entry of a sheet picked in Studio once it shows, so its Back is the browser's, to the page it was picked on", () => {
    ui.scope = scope({ sheet: SHEET });
    const { history, href } = browser({ __NA: true }, 2);
    useOpenSheet(P)(SHEET);
    expect(ui.push).toHaveBeenCalledWith(sheetLink(P, SHEET));
    sheet().close();
    expect(history.replaceState).toHaveBeenCalledWith({ [PANEL_BACK]: 1 }, "", href);
    expect(history.go).toHaveBeenCalledWith(-1);
    expect(ui.replace).not.toHaveBeenCalled();
    // Shown again (a reload of that entry, its Forward), it is not marked again.
    history.replaceState.mockClear();
    sheet();
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});

// Kev, 2026-10-30: "gimme auch eine suche beim character sheet auswahl, damit es fix ist".
describe("the character sheet search (SheetGrid)", () => {
  const sheets = [
    { id: "a", title: "Basic character sheet", image: "https://s/a.webp" },
    { id: "b", title: "Anime turnaround SHEET", image: null },
    { id: "c", title: "Chibi expressions", image: null },
  ];
  it("keeps the sheets whose title holds every word typed, in any order and case; nothing typed keeps all", () => {
    expect(sheetsMatching(sheets, "sheet").map((x) => x.id)).toEqual(["a", "b"]);
    expect(sheetsMatching(sheets, "  SHEET   anime ").map((x) => x.id)).toEqual(["b"]);
    expect(sheetsMatching(sheets, "").map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(sheetsMatching(sheets, "dragon")).toEqual([]);
  });

  it("filters the grid as one types, with a line when nothing matches", () => {
    ui.query = () => ({ data: sheets, error: null, isLoading: false });
    ui.state = [];
    const grid = () => draw(SheetGrid, { picked: null, onPick: vi.fn() });
    const field = all(grid()).find((el) => el.type === "input")!;
    expect(field.props).toMatchObject({ type: "search", placeholder: "Search character sheets", "aria-label": "Search character sheets" });
    expect(all(grid()).filter((el) => el.props.role === "radio")).toHaveLength(3);
    (field.props.onChange as (e: unknown) => void)({ target: { value: "chibi" } });
    expect(all(grid()).filter((el) => el.props.role === "radio").map((el) => el.key)).toEqual(["c"]);
    (all(grid()).find((el) => el.type === "input")!.props.onChange as (e: unknown) => void)({ target: { value: "dragon" } });
    expect(text(grid())).toContain("No sheet matches");
  });
});

describe("Studio's reads (useStudio)", () => {
  it("reads a 503 before SQL 53 as not ready, any other failure as its sentence", async () => {
    const real = await vi.importActual<typeof import("@/hooks/useStudio")>("@/hooks/useStudio");
    let asked: { queryFn: () => Promise<unknown> } | null = null;
    let error: unknown = null;
    ui.query = (o) => { asked = o; return { data: undefined, error }; };
    const answer = (status: number, body: object) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
    real.useStudioProjects(true);
    answer(503, { error: STUDIO_NOT_READY });
    error = await asked!.queryFn().catch((e: unknown) => e);
    expect(real.useStudioProjects(true)).toEqual({ data: undefined, notReady: true, error: null });
    answer(500, { error: NOT_READ });
    error = await asked!.queryFn().catch((e: unknown) => e);
    expect(real.useStudioProjects(true)).toEqual({ data: undefined, notReady: false, error: NOT_READ });
  });

  // Kev, 2026-10-30: "wenn studio aufgeklappt und ich drücke auf studio erneut, so klappt sich das zu und öffnet sich
  // erneut". query-core drops a failed read's error while it is read again (fetchState), so the menu's projects emptied.
  it("keeps a failed read's answer while it is read again, and a page opening reads a failed one not again", async () => {
    const real = await vi.importActual<typeof import("@/hooks/useStudio")>("@/hooks/useStudio");
    const failed = new real.StudioError(STUDIO_NOT_READY, 503);
    let opts: Record<string, unknown> = {};
    let state: { data?: unknown; error: unknown; isFetching: boolean } = { error: failed, isFetching: false };
    ui.query = (o) => { opts = o as unknown as Record<string, unknown>; return state; };
    ui.state = [];
    const read = () => { ui.s = 0; return real.useStudioProjects(true); };
    expect(read()).toEqual({ data: undefined, notReady: true, error: null });
    expect(opts).toMatchObject({ retry: false, retryOnMount: false });
    // Read again (the window's focus, the interval): the error is gone while it runs, the answer stays.
    state = { error: null, isFetching: true };
    expect(read().notReady).toBe(true);
    state = { error: failed, isFetching: false };
    expect(read().notReady).toBe(true);
    // Answered at last: the projects, and the old failure is not brought back by a later read again.
    state = { data: { projects: [] }, error: null, isFetching: false };
    expect(read()).toEqual({ data: { projects: [] }, notReady: false, error: null });
    state = { error: null, isFetching: true };
    expect(read().notReady).toBe(false);
  });
});

describe("the look", () => {
  const studio = readSource(join(__dirname, "..", "..", "components", "studio", "studio.css"));
  it("lays the kit in one line of four, two by two on a phone, folding by its height, no heading twice", () => {
    expect(studio).toContain(".st-kit { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 24px; }");
    expect(studio).toContain("  .st-kit { grid-template-columns: repeat(2, minmax(0, 1fr)); }");
    expect(studio).toContain(".st-kit-panel { display: grid; grid-template-rows: 0fr;");
    expect(studio).toContain(".st-kit-panel[data-open] { grid-template-rows: 1fr; }");
    expect(studio).toContain(".st-kit-in .st-sec-head { display: none; }");
    expect(studio).toContain("  .st-kit-panel, .st-kit-top svg { transition: none; }");
  });
  const shell = readSource(join(__dirname, "..", "..", "components", "enki-shell", "enki-shell.css"));
  it("folds the submenu open by its height, and not at all under reduced motion", () => {
    expect(shell).toContain(".ek-sub { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.22s cubic-bezier(0.4, 0, 0.2, 1); }");
    expect(shell).toContain(".ek-sub[data-open] { grid-template-rows: 1fr; }");
    expect(shell).toContain("@media (prefers-reduced-motion: reduce) { .ek-sub, .ek-sub-toggle svg { transition: none; } }");
  });
  it("puts the popups full screen on a phone, their foot clear of the home bar", () => {
    expect(studio).toMatch(/@media \(max-width: 767\.98px\) \{\n {2}\.st-scrim \{ padding: 0; \}\n {2}\.st-dialog \{ max-width: none; max-height: none; height: 100dvh; border: 0; border-radius: 0; \}/);
    expect(studio).toContain(".st-dialog-foot { padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px)); }");
  });
});
