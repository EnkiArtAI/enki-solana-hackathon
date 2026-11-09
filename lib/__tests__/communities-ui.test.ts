import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * Communities' UI (Kev, 2026-10-30: "propose me something, that cant be duplicated and will work as a harbour AND gallery
 * for people interested in a community"; "wo sehe ich denn die communities, in welcher menüleiste oder wo kann ich nach
 * denen suchen sodass sie mir vorgeschlagen werden?"; the shape he agreed to with "ja lass mal probieren und
 * iterieren"). The components are called as React would render them: state kept between calls, effects run when asked,
 * the API's reads and writes as stand-ins (hooks/useCommunities).
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, refs: [] as { current: unknown }[], r: 0, effects: [] as Array<() => unknown>,
  push: vi.fn(), replace: vi.fn(), notify: vi.fn(), login: vi.fn(), guarded: vi.fn(),
  api: {} as Record<string, ReturnType<typeof vi.fn>>,
  access: { access: "ok", role: "user", userId: "u1" } as Record<string, unknown>,
  typeahead: (() => ({ data: undefined, notReady: false, error: null })) as (q: string, limit?: number) => unknown,
  directory: (() => ({ items: [], loading: false, notReady: false, error: null, more: false, loadingMore: false, loadMore: () => {}, retry: () => {} })) as (sort: string) => unknown,
  community: { data: undefined, notReady: false, error: null, retry: () => {} } as unknown,
  links: { data: undefined, notReady: false, error: null } as unknown,
  list: { items: [], loading: false, error: null, more: false, loadingMore: false, loadMore: () => {} } as unknown,
  merges: { data: undefined, notReady: false, error: null, retry: () => {} } as unknown,
  own: { rows: [], loading: false, failed: false } as unknown,
  qc: { setQueryData: vi.fn(), invalidateQueries: vi.fn(async () => {}) },
  liked: undefined as { count: number; mine: boolean } | undefined,
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
  useCallback: (fn: unknown) => fn,
  useId: () => "id",
  useMemo: <T>(make: () => T) => make(),
  useSyncExternalStore: (_s: unknown, _g: unknown, server: () => unknown) => server(),
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: ui.push, replace: ui.replace }) }));
vi.mock("@/components/kit/notify", () => ({ notify: ui.notify }));
vi.mock("@/lib/openLogin", () => ({ openLogin: ui.login }));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ui.access }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("@/hooks/useViewerWallets", () => ({ useViewerWallets: () => ({ userKey: null }) }));
vi.mock("@/components/StepUpProvider", () => ({ useStepUp: () => ({ guarded: ui.guarded }) }));
vi.mock("@/components/image-view/useOwnRenders", () => ({ useOwnRenders: () => ui.own }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: ui.liked }), useQueryClient: () => ui.qc,
}));
vi.mock("@/hooks/useCommunities", () => {
  class CommunityError extends Error { constructor(m: string, readonly status: number, readonly extra: Record<string, unknown> = {}) { super(m); } }
  return {
    CommunityError,
    useCommunitiesApi: () => ui.api,
    useDebounced: <T,>(v: T) => v,
    useCommunityTypeahead: (q: string, limit?: number) => ui.typeahead(q, limit),
    useCommunityDirectory: (sort: string) => ui.directory(sort),
    useCommunity: () => ui.community,
    useItemCommunities: () => ui.links,
    useCommunityShowroom: () => ui.list,
    useCommunityWorks: () => ui.list,
    useCommunityMembers: () => ui.list,
    useCommunityPrompts: () => ui.list,
    useShowroomPost: () => ({ data: undefined, error: null }),
    useMergeQueue: () => ui.merges,
  };
});

import CommunityCard from "@/components/communities/CommunityCard";
import CommunityPicker, { CAP_LINE, CommunityPill, closeListOnEsc } from "@/components/communities/CommunityPicker";
import CommunityDialog from "@/components/communities/CommunityDialog";
import Directory from "@/components/communities/Directory";
import CommunityPage from "@/components/communities/CommunityPage";
import CommunitiesPanel from "@/components/communities/CommunitiesPanel";
import CommunityLinks from "@/components/communities/CommunityLinks";
import { CommunityLinking } from "@/components/communities/CommunityLinking";
import { useReleaseCommunities } from "@/components/communities/ReleaseCommunities";
import PostDialog, { BACK_TO_PRIVATE, STAYED_PUBLIC } from "@/components/communities/PostDialog";
import Showroom from "@/components/communities/Showroom";
import WorksGrid, { WorkPanel } from "@/components/communities/WorksGrid";
import MergeQueue from "@/components/communities/MergeQueue";
import MembersList from "@/components/communities/MembersList";
import ExploreCommunity from "@/components/communities/ExploreCommunity";
import CommunityAsk from "@/components/communities/CommunityAsk";
import StudioDialog from "@/components/studio/StudioDialog";
import ConfirmDialog from "@/components/kit/ConfirmDialog";
import PillMenu from "@/components/kit/PillMenu";
import Segmented from "@/components/kit/Segmented";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import PanelTabs from "@/components/enki-shell/PanelTabs";
import { CommunityError } from "@/hooks/useCommunities";
import {
  ALREADY_POSTED, CLOSE_MATCHES, COMMUNITIES_NOT_READY, HANDLE_RESERVED_SAID, HANDLE_TAKEN, HIDDEN_BY_MODERATOR, MAKE_PUBLIC_FIRST,
  NAME_NEEDED, PICK_A_COMMUNITY, POSTS_TODAY, TITLE_NEEDED, TOO_LONG, UNLISTED_LINE,
  type CommunityCard as Card, type CommunityDetail, type ShowroomPost, type Work,
} from "@/lib/communities/types";
import { COMMUNITY_TABS, DIRECTORY_SORT_TABS } from "@/lib/ui/kit/shell-nav";
import { handleKey, slugify } from "@/lib/communities/handle";

type El = ReactElement<Record<string, unknown>>;
const SLOTS = ["children", "foot", "marks", "panel", "face", "extra", "trigger", "note"];
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) {
    yield node;
    for (const key of SLOTS) if (typeof node.props[key] !== "function") yield* walk(node.props[key] as ReactNode);
  }
}
const all = (tree: ReactNode) => [...walk(tree)];
const of = (tree: ReactNode, type: unknown) => all(tree).filter((el) => el.type === type);
const byClass = (tree: ReactNode, name: string) => all(tree).filter((el) => String(el.props.className ?? "").split(" ").includes(name));
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("") : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);
const button = (tree: ReactNode, label: string) => all(tree).find((el) => el.type === "button" && (el.props["aria-label"] === label || text(el.props.children as ReactNode).trim() === label));
/** A render: hooks counted from the top, this render's effects kept for `run`. */
function draw<P>(component: (p: P) => unknown, props: P): ReactNode {
  ui.s = 0; ui.r = 0; ui.effects = [];
  return component(props) as ReactNode;
}
const run = () => ui.effects.splice(0).map((fn) => fn() as (() => void) | undefined);
const fresh = () => { ui.state = []; ui.refs = []; ui.effects = []; };
/** A child element rendered on its own state (fresh), as React would mount it. */
const mountEl = (el: El) => { fresh(); return draw(el.type as (p: unknown) => unknown, el.props); };
const settle = () => new Promise((r) => setTimeout(r, 0));
const press = (el: El | undefined, e: unknown = {}) => (el!.props.onClick as (e: unknown) => void)(e);

const card = (handle: string, over: Partial<Card> = {}): Card => ({ id: `id-${handle}`, handle, name: handle[0].toUpperCase() + handle.slice(1), members: 1204, works: 340, works7d: 3, listed: true, cover: null, ...over });
const chip = (handle: string) => ({ id: `id-${handle}`, handle, name: handle[0].toUpperCase() + handle.slice(1) });
const detail = (over: Partial<CommunityDetail> = {}): CommunityDetail => ({
  ...card("gundam"), description: "Mobile suits.", aliases: [], createdBy: { handle: "kev" }, createdAt: "", joined: false, canEdit: false, staff: null, ...over,
});
const found = (...cards: Card[]) => () => ({ data: { communities: cards, next: null }, notReady: false, error: null });

beforeEach(() => {
  fresh();
  vi.clearAllMocks();
  ui.access = { access: "ok", role: "user", userId: "u1" };
  ui.typeahead = () => ({ data: undefined, notReady: false, error: null });
  ui.directory = () => ({ items: [], loading: false, notReady: false, error: null, more: false, loadingMore: false, loadMore: () => {}, retry: () => {} });
  ui.community = { data: undefined, notReady: false, error: null, retry: () => {} };
  ui.links = { data: undefined, notReady: false, error: null };
  ui.list = { items: [], loading: false, error: null, more: false, loadingMore: false, loadMore: () => {} };
  ui.merges = { data: undefined, notReady: false, error: null, retry: () => {} };
  ui.own = { rows: [], loading: false, failed: false };
  ui.liked = undefined;
  ui.guarded.mockImplementation((_s: string, run0: (h: object) => Promise<Response>) => run0({}));
  ui.api = {
    create: vi.fn(async (i: { name: string; handle: string }) => ({ community: detail({ handle: i.handle, name: i.name }) })),
    patch: vi.fn(async () => ({ community: detail() })),
    remove: vi.fn(async () => ({ deleted: true })),
    join: vi.fn(async () => ({ joined: true, members: 2 })),
    leave: vi.fn(async () => ({ joined: false, members: 1 })),
    setLinks: vi.fn(async () => ({ items: [] })),
    addLink: vi.fn(async () => ({ items: [] })),
    suggest: vi.fn(async () => ({ suggestions: [chip("apu"), chip("pepe")] })),
    post: vi.fn(async () => ({ post: {} })),
    deletePost: vi.fn(async () => ({ deleted: true })),
    hide: vi.fn(async () => ({ hidden: true })),
    merge: vi.fn(async () => ({ merged: {} })),
    keep: vi.fn(async () => ({ kept: 2 })),
  };
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("a directory card (Kev: \"alle communities gleich große senkrechte karten ... von denen jeder ein bild bekommt\")", () => {
  it("is one button named whole, its cover or its seal, and \"New\" while it is not listed", () => {
    const onOpen = vi.fn();
    const tree = draw(CommunityCard, { card: card("gundam", { cover: "https://s/c.webp" }), onOpen });
    const btn = all(tree)[0];
    expect([btn.type, btn.props.className, btn.props["aria-label"]]).toEqual(["button", "cm-card", "c/gundam, Gundam, 1,204 members, 340 works"]);
    expect(all(tree).some((el) => el.type === "img" || (typeof el.type === "function" && el.props.card))).toBe(true);
    expect(byClass(tree, "cm-new")).toHaveLength(0);
    expect(text(byClass(tree, "cm-card-meta")[0].props.children as ReactNode)).toBe("1.2k members · 340 works");
    press(btn);
    expect(onOpen).toHaveBeenCalledWith("gundam");
    expect(byClass(draw(CommunityCard, { card: card("tiny", { listed: false }), onOpen }), "cm-new")).toHaveLength(1);
  });
});

describe("the directory", () => {
  const dir = (over: Partial<Parameters<typeof Directory>[0]> = {}) => draw(Directory, { sort: "trending", onSort: vi.fn(), onOpen: vi.fn(), ...over });
  const search = (tree: ReactNode) => all(tree).find((el) => el.type === "input" && el.props["aria-label"] === "Search communities")!;

  it("lists the listed ones in the sort asked for, + Create community first; a sort is a pick of Trending, New or A–Z", () => {
    ui.directory = (sort) => ({ items: sort === "az" ? [card("apu"), card("gundam")] : [], loading: false, notReady: false, error: null, more: false, loadingMore: false, loadMore: () => {}, retry: () => {} });
    const onSort = vi.fn();
    const tree = dir({ sort: "az", onSort });
    const grid = byClass(tree, "cm-grid")[0];
    const cells = (grid.props.children as ReactNode[]).flat().filter(isValidElement) as El[];
    expect(text((cells[0].type as (p: unknown) => El)(cells[0].props))).toContain("Create community");
    expect(cells.slice(1).map((c) => (c.props.card as Card).handle)).toEqual(["apu", "gundam"]);
    const seg = of(tree, Segmented)[0].props;
    expect([seg.value, seg.options]).toEqual(["az", [...DIRECTORY_SORT_TABS]]);
    (seg.onChange as (k: string) => void)("new");
    expect(onSort).toHaveBeenCalledWith("new");
  });

  it("turns the grid into suggestions as it is typed, the unlisted too, + Create c/<typed> first when none has that handle", () => {
    // As the typeahead finds them: by the start of their handle's key.
    const on = [card("gundam"), card("gundam_20"), card("gundam_2nd", { listed: false }), card("gundam_wing", { listed: false })];
    ui.typeahead = (q) => ({ data: { communities: on.filter((c) => handleKey(c.handle).startsWith(handleKey(slugify(q)))), next: null }, notReady: false, error: null });
    dir();
    (search(dir()).props.onChange as (e: object) => void)({ target: { value: "Gundam 2" } });
    let tree = dir();
    let cells = (byClass(tree, "cm-grid")[0].props.children as ReactNode[]).flat().filter(isValidElement) as El[];
    expect(cells[0].props.handle).toBe("gundam_2");
    expect(cells.slice(1).map((c) => (c.props.card as Card).handle)).toEqual(["gundam_20", "gundam_2nd"]);
    expect(of(tree, Segmented)).toHaveLength(0);
    press(cells[0]);
    expect(of(dir(), CommunityDialog)[0].props.name).toBe("Gundam 2");
    // The exact handle is there: no + Create.
    fresh();
    dir();
    (search(dir()).props.onChange as (e: object) => void)({ target: { value: "gundam" } });
    tree = dir();
    cells = (byClass(tree, "cm-grid")[0].props.children as ReactNode[]).flat().filter(isValidElement) as El[];
    expect(cells.map((c) => (c.props.card as Card | undefined)?.handle)).toEqual(["gundam", "gundam_20", "gundam_2nd", "gundam_wing"]);
  });

  // Review 2026-10-30: past 60 characters the route answers 400, and the grid became "Bad request" with a Try again.
  it("takes up to 60 characters, and Esc clears the words without closing the panel", () => {
    expect(search(dir()).props.maxLength).toBe(60);
    (search(dir()).props.onChange as (e: object) => void)({ target: { value: "gun" } });
    const e = { key: "Escape", stopPropagation: vi.fn() };
    (search(dir()).props.onKeyDown as (e: object) => void)(e);
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(search(dir()).props.value).toBe("");
    const empty = { key: "Escape", stopPropagation: vi.fn() };
    (search(dir()).props.onKeyDown as (e: object) => void)(empty);
    expect(empty.stopPropagation).not.toHaveBeenCalled();
  });

  it("asks a guest to sign in before starting one; says plainly when Communities is not there yet", () => {
    ui.access = { access: "ok", role: "team" };
    const tree = dir();
    const add = (byClass(tree, "cm-grid")[0].props.children as ReactNode[]).flat().filter(isValidElement)[0] as El;
    press(add);
    expect(ui.login).toHaveBeenCalledTimes(1);
    expect(of(dir(), CommunityDialog)).toHaveLength(0);
    ui.directory = () => ({ items: [], loading: false, notReady: true, error: null, more: false, loadMore: () => {}, retry: () => {} });
    expect(text(dir() as El)).toContain(COMMUNITIES_NOT_READY);
  });
});

describe("the picker (agreed: \"nach der community suchen ... vorgeschlagen ... eine aufmachen kann, wenn es keine dazu gibt\")", () => {
  const P = (over: Partial<Parameters<typeof CommunityPicker>[0]> = {}) => ({ value: [], onChange: vi.fn(), ...over } as Parameters<typeof CommunityPicker>[0]);
  const input = (tree: ReactNode) => all(tree).find((el) => el.props.role === "combobox")!;
  const type = (p: Parameters<typeof CommunityPicker>[0], q: string) => { (input(draw(CommunityPicker, p)).props.onChange as (e: object) => void)({ target: { value: q } }); return draw(CommunityPicker, p); };
  const key = (tree: ReactNode, k: string) => {
    const e = { key: k, preventDefault: vi.fn(), stopPropagation: vi.fn(), nativeEvent: { stopImmediatePropagation: vi.fn() } };
    (input(tree).props.onKeyDown as (e: object) => void)(e);
    return e;
  };
  const options = (tree: ReactNode) => all(tree).filter((el) => el.props.role === "option").map((el) => text(el.props.children as ReactNode));

  it("lists what the typed words find, the biggest first as the server ranks, then + Create c/<typed>; ↓ and Enter pick", () => {
    ui.typeahead = found(card("gundam"), card("gundam_wing"));
    const p = P();
    const tree = type(p, "gun");
    expect(options(tree)).toEqual(["c/gundamGundam340 works", "c/gundam_wingGundam_wing340 works", "+ Create c/guna new community"]);
    expect(input(tree).props["aria-expanded"]).toBe(true);
    key(tree, "ArrowDown");
    key(draw(CommunityPicker, p), "ArrowDown");
    key(draw(CommunityPicker, p), "Enter");
    expect(p.onChange).toHaveBeenCalledWith([chip("gundam_wing")]);
  });

  it("offers no + Create where none may open (create={false}), and hands it to the host when it has one", () => {
    ui.typeahead = found(card("gundam_2nd"));
    expect(options(type(P({ create: false }), "gundam 2"))).toEqual(["c/gundam_2ndGundam_2nd340 works"]);
    fresh();
    const onCreate = vi.fn();
    const p = P({ onCreate });
    const tree = type(p, "gundam 2");
    const row = all(tree).filter((el) => el.props.role === "option").at(-1)!;
    (row.props.onMouseDown as (e: object) => void)({ preventDefault: () => {} });
    expect(onCreate).toHaveBeenCalledWith("gundam 2");
    expect(of(draw(CommunityPicker, p), CommunityDialog)).toHaveLength(0);
    // Without a host it opens the dialog itself.
    fresh();
    const q = P();
    const t2 = type(q, "gundam 2");
    (all(t2).filter((el) => el.props.role === "option").at(-1)!.props.onMouseDown as (e: object) => void)({ preventDefault: () => {} });
    expect(of(draw(CommunityPicker, q), CommunityDialog)[0].props.name).toBe("gundam 2");
  });

  it("takes the last chip with Backspace on an empty field; Esc closes the list alone, ahead of the layer it sits in", () => {
    ui.typeahead = found(card("gundam"));
    const p = P({ value: [chip("apu"), chip("pepe")] });
    key(draw(CommunityPicker, p), "Backspace");
    expect(p.onChange).toHaveBeenCalledWith([chip("apu")]);
    const field = {};
    type(p, "gun");
    ui.refs[0].current = field;
    draw(CommunityPicker, p);
    const cleanups = run();
    const esc = (target: object, k = "Escape") => {
      const e = { key: k, target, stopImmediatePropagation: vi.fn(), preventDefault: vi.fn() };
      closeListOnEsc(e as unknown as KeyboardEvent);
      return e;
    };
    expect(esc({}).stopImmediatePropagation).not.toHaveBeenCalled();
    expect(esc(field, "ArrowDown").stopImmediatePropagation).not.toHaveBeenCalled();
    expect(input(draw(CommunityPicker, p)).props["aria-expanded"]).toBe(true);
    expect(esc(field).stopImmediatePropagation).toHaveBeenCalled();
    expect(input(draw(CommunityPicker, p)).props["aria-expanded"]).toBe(false);
    // Closed, Esc goes on to the layer under it.
    for (const c of cleanups) c?.();
    expect(esc(field).stopImmediatePropagation).not.toHaveBeenCalled();
  });

  // Review 2026-10-30: StudioDialog (document), BottomSheet, the pill and the viewer (window) all hear Esc in the capture
  // phase from when they open; the field's own handler never ran inside them.
  it("hears Esc on window from when it loads, before any layer opens", async () => {
    const add = vi.fn();
    vi.stubGlobal("window", { addEventListener: add });
    vi.resetModules();
    const again = await import("@/components/communities/CommunityPicker");
    expect(add).toHaveBeenCalledWith("keydown", again.closeListOnEsc, true);
  });

  it("closes its list when the field loses the focus, and takes up to 60 characters", () => {
    ui.typeahead = found(card("gundam"));
    const p = P();
    const tree = type(p, "gun");
    expect(input(tree).props).toMatchObject({ "aria-expanded": true, maxLength: 60 });
    (input(tree).props.onBlur as () => void)();
    expect(input(draw(CommunityPicker, p)).props["aria-expanded"]).toBe(false);
  });

  it("refuses the 19th chip: at 18 the field rests and says why", () => {
    const value = Array.from({ length: 18 }, (_, i) => chip(`c${i}`));
    const tree = draw(CommunityPicker, P({ value }));
    expect(input(tree).props).toMatchObject({ disabled: true, placeholder: CAP_LINE });
    expect(CAP_LINE).toBe("Up to 18 communities.");
    expect(all(tree).some((el) => el.props.role === "status" && text(el.props.children as ReactNode) === CAP_LINE)).toBe(true);
    expect(input(draw(CommunityPicker, P({ value: value.slice(1) }))).props.disabled).toBe(false);
  });

  it("marks the chips its prompt brings, whose × takes the render out of them", () => {
    const p = P({ value: [chip("apu"), chip("pepe")], inherited: ["id-pepe"] });
    const tree = draw(CommunityPicker, p);
    expect(text(byClass(tree, "cm-pick-from")[0].props.children as ReactNode)).toBe("from its prompt");
    expect(byClass(tree, "cm-pick-x").map((b) => b.props["aria-label"])).toEqual(["Remove c/apu", "Take it out of c/pepe"]);
    press(byClass(tree, "cm-pick-x")[1], { stopPropagation: () => {} });
    expect(p.onChange).toHaveBeenCalledWith([chip("apu")]);
  });

  it("suggests from the surface's words once it is focused, never one picked, each one press to add, never by itself", async () => {
    const p = P({ value: [chip("pepe")], text: "apu and pepe animated" });
    draw(CommunityPicker, p);
    run();
    // Review 2026-10-30: the viewer's stage asked for every render paged past, its picker never opened.
    expect(ui.api.suggest).not.toHaveBeenCalled();
    (input(draw(CommunityPicker, p)).props.onFocus as () => void)();
    draw(CommunityPicker, p);
    run();
    expect(ui.api.suggest).toHaveBeenCalledWith({ text: "apu and pepe animated", exclude: ["id-pepe"] });
    await settle();
    // The field's blur keeps them: a press on one lands after it.
    (input(draw(CommunityPicker, p)).props.onBlur as () => void)();
    const tree = draw(CommunityPicker, p);
    const row = byClass(tree, "cm-suggest")[0];
    const offered = of(row, "button");
    expect(offered.map((b) => text(b.props.children as ReactNode))).toEqual(["c/apu +"]);
    expect(p.onChange).not.toHaveBeenCalled();
    press(offered[0]);
    expect(p.onChange).toHaveBeenCalledWith([chip("pepe"), chip("apu")]);
  });

  it("says Communities is not there yet instead of a field", () => {
    ui.typeahead = () => ({ data: undefined, notReady: true, error: null });
    expect(text(draw(CommunityPicker, P()) as El)).toBe(COMMUNITIES_NOT_READY);
  });
});

describe("the picker behind a pill", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1440, innerHeight: 900 });
    vi.stubGlobal("document", { body: {} });
  });
  const pill = (over: Partial<Parameters<typeof CommunityPill>[0]> = {}) => ({ value: [], onChange: vi.fn(), face: "Communities", ariaLabel: "Communities", ...over } as Parameters<typeof CommunityPill>[0]);

  it("opens as a popover; + Create closes it and opens the dialog, whose new community is picked", () => {
    const p = pill({ value: [chip("apu")] });
    press(all(draw(CommunityPill, p)).find((el) => el.props["aria-haspopup"] === "dialog"));
    const picker = of(draw(CommunityPill, p), CommunityPicker)[0];
    expect(picker.props).toMatchObject({ value: [chip("apu")], autoFocus: true });
    (picker.props.onCreate as (n: string) => void)("Gundam 2");
    const tree = draw(CommunityPill, p);
    expect(of(tree, CommunityPicker)).toHaveLength(0);
    const dialog = of(tree, CommunityDialog)[0];
    expect(dialog.props.name).toBe("Gundam 2");
    (dialog.props.onDone as (c: object) => void)(detail({ id: "id-g2", handle: "gundam_2", name: "Gundam 2" }));
    expect(p.onChange).toHaveBeenCalledWith([chip("apu"), { id: "id-g2", handle: "gundam_2", name: "Gundam 2" }]);
  });

  it("in single mode closes as soon as one is picked", () => {
    const p = pill({ mode: "single" });
    press(all(draw(CommunityPill, p)).find((el) => el.props["aria-haspopup"] === "dialog"));
    (of(draw(CommunityPill, p), CommunityPicker)[0].props.onChange as (n: object[]) => void)([chip("pepe")]);
    expect(p.onChange).toHaveBeenCalledWith([chip("pepe")]);
    expect(of(draw(CommunityPill, p), CommunityPicker)).toHaveLength(0);
  });

  // Review 2026-10-30: a guest in Explore's filter got the whole create dialog, refused with 401 only on Create.
  it("asks a guest to sign in on + Create, as the directory does, and opens no dialog", () => {
    ui.access = { access: "ok", role: "team", userId: null };
    const p = pill();
    press(all(draw(CommunityPill, p)).find((el) => el.props["aria-haspopup"] === "dialog"));
    (of(draw(CommunityPill, p), CommunityPicker)[0].props.onCreate as (n: string) => void)("Gundam");
    const tree = draw(CommunityPill, p);
    expect([ui.login.mock.calls.length, of(tree, CommunityDialog).length, of(tree, CommunityPicker).length]).toEqual([1, 0, 0]);
  });

  it("hands its foot what closes it, and rests while disabled", () => {
    const p = pill({ foot: (close) => createElement("button", { type: "button", className: "cm-link", onClick: close }, "Open c/apu →"), disabled: true });
    expect(all(draw(CommunityPill, p)).find((el) => el.props["aria-haspopup"] === "dialog")!.props.disabled).toBe(true);
    press(all(draw(CommunityPill, { ...p, disabled: false })).find((el) => el.props["aria-haspopup"] === "dialog"));
    press(byClass(draw(CommunityPill, p), "cm-link")[0]);
    expect(of(draw(CommunityPill, p), CommunityPicker)).toHaveLength(0);
  });
});

describe("starting a community (agreed: \"Es gibt schon c/gundam (1.2k) - trotzdem neu?\")", () => {
  const D = (over: Partial<Parameters<typeof CommunityDialog>[0]> = {}) => ({ onClose: vi.fn(), onDone: vi.fn(), ...over } as Parameters<typeof CommunityDialog>[0]);
  const field = (tree: ReactNode, label: string) => all(tree).find((el) => el.type === "input" && (el.props["aria-label"] === label || el.props["data-autofocus"] !== undefined && label === "Name"))!;
  const primary = (tree: ReactNode) => byClass((tree as El).props.foot as ReactNode, "st-btn--cta")[0];

  it("asks for a name of two characters or more before it asks the server", () => {
    const d = D({ name: "G" });
    press(primary(draw(CommunityDialog, d)));
    expect(text(draw(CommunityDialog, d) as El)).toContain(NAME_NEEDED);
    expect(ui.api.create).not.toHaveBeenCalled();
  });

  it("takes the handle from the name until it is edited, and says at once why one cannot be taken", () => {
    const d = D({ name: "Gundam Wing!" });
    let tree = draw(CommunityDialog, d);
    expect(field(tree, "Handle, after c/").props.value).toBe("gundam_wing");
    (field(tree, "Handle, after c/").props.onChange as (e: object) => void)({ target: { value: "Admin" } });
    tree = draw(CommunityDialog, d);
    expect(field(tree, "Handle, after c/").props.value).toBe("admin");
    expect(byClass(tree, "st-err").map((e) => text(e.props.children as ReactNode))).toContain(HANDLE_RESERVED_SAID);
    press(primary(tree));
    expect(ui.api.create).not.toHaveBeenCalled();
    (field(tree, "Name").props.onChange as (e: object) => void)({ target: { value: "Gundam Wing Zero" } });
    expect(field(draw(CommunityDialog, d), "Handle, after c/").props.value).toBe("admin");
  });

  it("shows the close names the server found and sends again only as \"Make a new one anyway\"", async () => {
    ui.api.create = vi.fn(async (i: { confirmed?: boolean; handle: string; name: string }) => {
      if (!i.confirmed) throw new CommunityError(CLOSE_MATCHES, 409, { closest: [card("gundam")] });
      return { community: detail({ handle: i.handle, name: i.name }) };
    });
    const d = D({ name: "Gundam 2" });
    press(primary(draw(CommunityDialog, d)));
    await settle();
    let tree = draw(CommunityDialog, d);
    expect(text(primary(tree).props.children as ReactNode)).toBe("Make a new one anyway");
    expect(text(tree as El)).toContain(CLOSE_MATCHES);
    expect(all(tree).filter((el) => (el.props.card as Card | undefined)?.handle === "gundam")).toHaveLength(1);
    press(primary(tree));
    await settle();
    expect(ui.api.create.mock.calls.map((c) => c[0])).toEqual([
      { name: "Gundam 2", handle: "gundam_2", description: null, confirmed: false },
      { name: "Gundam 2", handle: "gundam_2", description: null, confirmed: true },
    ]);
    expect(d.onDone).toHaveBeenCalledWith(expect.objectContaining({ handle: "gundam_2" }));
    tree = draw(CommunityDialog, d);
    expect(ui.notify).toHaveBeenCalledWith("c/gundam_2 is on Enki");
  });

  it("says a handle is taken, with that community, and creates nothing more", async () => {
    ui.api.create = vi.fn(async () => { throw new CommunityError(HANDLE_TAKEN, 409, { existing: card("gundam") }); });
    const d = D({ name: "Gund4m" });
    press(primary(draw(CommunityDialog, d)));
    await settle();
    const tree = draw(CommunityDialog, d);
    expect(primary(tree).props.disabled).toBe(true);
    expect(text(tree as El)).toContain(HANDLE_TAKEN);
  });

  it("lists the communities already on Enki under the name as it is typed, at most three", () => {
    ui.typeahead = found(card("a1"), card("a2"), card("a3"), card("a4"));
    const tree = draw(CommunityDialog, D({ name: "a" }));
    expect(all(tree).filter((el) => (el.props.card as Card | undefined)?.handle).map((el) => (el.props.card as Card).handle)).toEqual(["a1", "a2", "a3"]);
  });

  it("edits the name, description and search words of one that exists; its handle stays", async () => {
    const d = D({ edit: detail({ aliases: ["mobile_suit"] }) });
    let tree = draw(CommunityDialog, d);
    expect(field(tree, "Handle, after c/").props.disabled).toBe(true);
    const word = all(tree).find((el) => el.props["aria-label"] === "Add a search word")!;
    (word.props.onChange as (e: object) => void)({ target: { value: "Gunpla Kits" } });
    tree = draw(CommunityDialog, d);
    (all(tree).find((el) => el.props["aria-label"] === "Add a search word")!.props.onKeyDown as (e: object) => void)({ key: "Enter", preventDefault: () => {} });
    press(primary(draw(CommunityDialog, d)));
    await settle();
    expect(ui.api.patch).toHaveBeenCalledWith("gundam", { name: "Gundam", description: "Mobile suits.", aliases: ["mobile_suit", "gunpla_kits"] });
    expect(ui.api.create).not.toHaveBeenCalled();
  });
});

describe("a community's page", () => {
  const page = (over: Partial<Parameters<typeof CommunityPage>[0]> = {}) => ({ handle: "gundam", onTab: vi.fn(), onBack: vi.fn(), onReplace: vi.fn(), ...over } as Parameters<typeof CommunityPage>[0]);
  const inner = (p: Parameters<typeof CommunityPage>[0]) => { const el = draw(CommunityPage, p) as El; return { el, tree: mountEl(el) }; };

  it("gives way to the community a merged or look-alike handle names, in place", () => {
    ui.community = { data: { redirect: "gundam" }, notReady: false, error: null, retry: () => {} };
    const p = page({ handle: "gundam_fans" });
    draw(CommunityPage, p);
    run();
    expect(p.onReplace).toHaveBeenCalledWith("gundam");
  });

  it("says when Communities is not there yet", () => {
    ui.community = { data: undefined, notReady: true, error: null, retry: () => {} };
    expect(text(draw(CommunityPage, page()) as El)).toContain(COMMUNITIES_NOT_READY);
  });

  it("joins (a guest signs in first) and leaves after asking; an unlisted one says when it shows in the directory", async () => {
    ui.community = { data: { community: detail({ listed: false }) }, notReady: false, error: null, retry: () => {} };
    const p = page();
    let { el, tree } = inner(p);
    expect(text(tree as El)).toContain(UNLISTED_LINE);
    press(button(tree, "Join"));
    await settle();
    expect(ui.api.join).toHaveBeenCalledWith("gundam");
    ui.community = { data: { community: detail({ joined: true }) }, notReady: false, error: null, retry: () => {} };
    ({ el, tree } = inner(p));
    press(byClass(tree, "cm-joined")[0]);
    tree = draw(el.type as (q: unknown) => unknown, el.props);
    const ask = of(tree, ConfirmDialog)[0];
    expect(ask.props.title).toBe("Leave c/gundam?");
    (ask.props.onConfirm as () => void)();
    await settle();
    expect(ui.api.leave).toHaveBeenCalledWith("gundam");
    ui.access = { access: "ok", role: "team" };
    ui.community = { data: { community: detail() }, notReady: false, error: null, retry: () => {} };
    ({ tree } = inner(p));
    press(button(tree, "Join"));
    expect(ui.login).toHaveBeenCalled();
  });

  it("offers Edit to its creator, Merge into… and Delete to an admin, nothing to anyone else", () => {
    const opts = (over: Partial<CommunityDetail>) => {
      ui.community = { data: { community: detail(over) }, notReady: false, error: null, retry: () => {} };
      return (of(inner(page()).tree, PillMenu)[0]?.props.options as Array<{ key: string }> | undefined)?.map((o) => o.key) ?? [];
    };
    expect(opts({})).toEqual([]);
    expect(opts({ canEdit: true })).toEqual(["edit"]);
    expect(opts({ canEdit: true, staff: "admin" })).toEqual(["edit", "merge", "delete"]);
    expect(opts({ staff: "mod" })).toEqual([]);
  });

  it("merges into the one picked after asking, then stands on it; a delete stands on the directory", async () => {
    ui.community = { data: { community: detail({ staff: "admin", canEdit: true }) }, notReady: false, error: null, retry: () => {} };
    const p = page();
    const { el } = inner(p);
    const again = () => draw(el.type as (q: unknown) => unknown, el.props);
    (of(again(), PillMenu)[0].props.onPick as (k: string) => void)("merge");
    const dialog = of(again(), StudioDialog)[0];
    const picker = of(dialog.props.children as ReactNode, CommunityPicker)[0];
    expect(picker.props).toMatchObject({ mode: "single", create: false });
    (picker.props.onChange as (n: object[]) => void)([chip("gundam"), chip("mecha")]);
    const ask = of(again(), ConfirmDialog)[0];
    expect(ask.props.title).toBe("Merge c/gundam into c/mecha?");
    expect(ui.api.merge).not.toHaveBeenCalled();
    (ask.props.onConfirm as () => void)();
    await settle();
    expect(ui.api.merge).toHaveBeenCalledWith({ from: "id-gundam", into: "id-mecha" });
    expect(p.onReplace).toHaveBeenCalledWith("mecha");
    (of(again(), PillMenu)[0].props.onPick as (k: string) => void)("delete");
    (of(again(), ConfirmDialog)[0].props.onConfirm as () => void)();
    await settle();
    expect(ui.api.remove).toHaveBeenCalledWith("gundam");
    expect(p.onReplace).toHaveBeenLastCalledWith(null);
  });

  it("has Showroom | Works | Prompts | Members under its head, the tab the address names", () => {
    ui.community = { data: { community: detail({ staff: "mod" }) }, notReady: false, error: null, retry: () => {} };
    const p = page({ tab: "works" });
    const tabs = of(inner(p).tree, PanelTabs)[0].props;
    expect([tabs.tabs, tabs.tab, tabs.onTab]).toEqual([COMMUNITY_TABS, "works", p.onTab]);
    const body = (t: string) => (tabs.children as (k: string) => El)(t);
    expect(of(body("works"), WorksGrid)[0].props).toEqual({ handle: "gundam", staff: true });
    expect(of(body("showroom"), Showroom)[0].props).toMatchObject({ community: chip("gundam"), staff: true, works: 340 });
    (of(body("showroom"), Showroom)[0].props.onWorks as () => void)();
    expect(p.onTab).toHaveBeenCalledWith("works");
  });
});

describe("the panel", () => {
  it("is the directory on its sort, or a community's page by its handle", () => {
    const props = { onOpen: vi.fn(), onTab: vi.fn(), onBack: vi.fn(), onReplace: vi.fn() };
    const dir = draw(CommunitiesPanel, { ...props, at: { id: "communities", tab: "nope" } }) as El;
    expect([dir.type, dir.props.sort, dir.props.onSort, dir.props.onOpen]).toEqual([Directory, "trending", props.onTab, props.onOpen]);
    expect((draw(CommunitiesPanel, { ...props, at: { id: "communities", tab: "az" } }) as El).props.sort).toBe("az");
    const pg = draw(CommunitiesPanel, { ...props, at: { id: "communities", community: "apu", tab: "members" } }) as El;
    expect([pg.type, pg.props.handle, pg.props.tab, pg.props.onReplace]).toEqual([CommunityPage, "apu", "members", props.onReplace]);
  });
});

describe("posting to a Showroom (Kev: \"a showroom, decoupled from prompts completely\")", () => {
  const rows = [
    { id: "r-private", image_url: "https://s/p.png", image_urls: ["https://s/p.webp"], thumbnail_url: "https://s/p-t.webp", isUploaded: false, visibility: "private" },
    { id: "r-upload", image_url: "https://s/u.png", image_urls: [], thumbnail_url: null, isUploaded: true, visibility: "public" },
  ];
  const D = (over: Partial<Parameters<typeof PostDialog>[0]> = {}) => ({ onClose: vi.fn(), ...over } as Parameters<typeof PostDialog>[0]);
  const post = (tree: ReactNode) => byClass((tree as El).props.foot as ReactNode, "st-btn--cta")[0];
  const fill = (d: Parameters<typeof PostDialog>[0], title: string) => {
    const t = all(draw(PostDialog, d)).find((el) => el.props["data-autofocus"] !== undefined)!;
    (t.props.onChange as (e: object) => void)({ target: { value: title } });
  };

  it("picks one of your own renders first (no uploads), then asks for its title", () => {
    ui.own = { rows, loading: false, failed: false };
    const d = D({ community: chip("gundam") });
    const tiles = byClass(draw(PostDialog, d), "cm-render-tile");
    expect(tiles).toHaveLength(1);
    press(tiles[0]);
    const tree = draw(PostDialog, d) as El;
    expect(tree.props.step).toBe("details");
    expect(of(tree.props.children as ReactNode, CommunityPicker)[0].props.value).toEqual([chip("gundam")]);
  });

  it("makes a private render public on the way, by the box that says so; unticked, Post waits and says why", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    const d = D({ community: chip("gundam"), render: { id: "r-private", thumb: "https://s/p-t.webp", public: false } });
    fill(d, "Night patrol");
    let tree = draw(PostDialog, d);
    const box = all(tree).find((el) => el.type === "input" && el.props.type === "checkbox")!;
    expect(box.props.checked).toBe(true);
    (box.props.onChange as (e: object) => void)({ target: { checked: false } });
    tree = draw(PostDialog, d);
    expect(post(tree).props["aria-disabled"]).toBe(true);
    expect(text(tree as El)).toContain(MAKE_PUBLIC_FIRST);
    press(post(tree));
    await settle();
    expect([ui.guarded.mock.calls.length, ui.api.post.mock.calls.length]).toEqual([0, 0]);
    (all(draw(PostDialog, d)).find((el) => el.props.type === "checkbox")!.props.onChange as (e: object) => void)({ target: { checked: true } });
    press(post(draw(PostDialog, d)));
    await settle();
    expect(ui.guarded.mock.calls[0][0]).toBe("make-public:r-private");
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(["/api/images/r-private", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ visibility: "public" }) })]);
    expect(ui.api.post).toHaveBeenCalledWith({ imageId: "r-private", title: "Night patrol", caption: null, parentId: null, communityIds: ["id-gundam"] });
    expect(d.onClose).toHaveBeenCalled();
  });

  it("asks for a title and a community first", async () => {
    const d = D({ render: { id: "r1", thumb: "t", public: true } });
    press(post(draw(PostDialog, d)));
    expect(text(draw(PostDialog, d) as El)).toContain(TITLE_NEEDED);
    fill(d, "x");
    press(post(draw(PostDialog, d)));
    expect(text(draw(PostDialog, d) as El)).toContain(PICK_A_COMMUNITY);
    expect(ui.api.post).not.toHaveBeenCalled();
  });

  it("answers a post with your version: its communities, shown, never sent", async () => {
    const parent = { id: "p1", title: "Night patrol", communities: [chip("gundam"), chip("mecha")] } as unknown as ShowroomPost;
    const d = D({ parent, render: { id: "r2", thumb: "t", public: true } });
    fill(d, "My take");
    const tree = draw(PostDialog, d);
    expect(of(tree, CommunityPicker)).toHaveLength(0);
    expect(text(tree as El)).toContain("Answers c/gundam, c/mecha · Night patrol");
    press(post(tree));
    await settle();
    expect(ui.api.post).toHaveBeenCalledWith({ imageId: "r2", title: "My take", caption: null, parentId: "p1" });
  });

  it("says a render is posted already, and Post stays down", async () => {
    ui.api.post = vi.fn(async () => { throw new CommunityError(ALREADY_POSTED, 409, { postId: "x" }); });
    const d = D({ community: chip("gundam"), render: { id: "r3", thumb: "t", public: true } });
    fill(d, "Again");
    press(post(draw(PostDialog, d)));
    await settle();
    const tree = draw(PostDialog, d);
    expect(post(tree).props.disabled).toBe(true);
    expect(text(tree as El)).toContain(ALREADY_POSTED);
  });

  it("refuses a title past 80 characters before anything is sent", () => {
    const d = D({ community: chip("gundam"), render: { id: "r5", thumb: "t", public: true } });
    fill(d, "x".repeat(81));
    press(post(draw(PostDialog, d)));
    expect(text(draw(PostDialog, d) as El)).toContain(TOO_LONG.title);
    expect(ui.api.post).not.toHaveBeenCalled();
  });

  const privateRender = () => D({ community: chip("gundam"), render: { id: "r-private", thumb: "t", public: false } });
  const sent = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], (c[1] as { body: string }).body]);
  const galleriesRead = () => ui.qc.invalidateQueries.mock.calls.map((c) => (c as unknown as [{ queryKey: string[] }])[0].queryKey[0]);

  it("posts nothing when the render could not be made public, and says why", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "Confirm it is you first." }) })));
    const d = privateRender();
    fill(d, "Night patrol");
    press(post(draw(PostDialog, d)));
    await settle();
    expect(ui.api.post).not.toHaveBeenCalled();
    expect(text(draw(PostDialog, d) as El)).toContain("Confirm it is you first.");
    expect(sent()).toEqual([["/api/images/r-private", JSON.stringify({ visibility: "public" })]]);
  });

  // Review 2026-10-30: the box makes a render public to post it; a refused post left it public with nothing posted.
  it("makes the render private again when the post is refused after the box made it public, and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    ui.api.post = vi.fn(async () => { throw new CommunityError(POSTS_TODAY, 409); });
    const d = privateRender();
    fill(d, "Night patrol");
    press(post(draw(PostDialog, d)));
    await settle();
    await settle();
    expect(sent()).toEqual([
      ["/api/images/r-private", JSON.stringify({ visibility: "public" })],
      ["/api/images/r-private", JSON.stringify({ visibility: "private" })],
    ]);
    expect(ui.guarded.mock.calls.map((c) => c[0])).toEqual(["make-public:r-private", "make-private:r-private"]);
    expect(galleriesRead()).toEqual(["user-generations", "prompt-public-images", "user-generations", "prompt-public-images"]);
    const tree = draw(PostDialog, d);
    expect(text(tree as El)).toContain(`${POSTS_TODAY} ${BACK_TO_PRIVATE}`);
    expect(all(tree).filter((el) => el.props.type === "checkbox")).toHaveLength(1);
    expect(d.onClose).not.toHaveBeenCalled();
  });

  it("says the render stayed public when making it private again fails too, and drops the box", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o: { body: string }) => ({ ok: o.body.includes("public"), json: async () => ({}) })));
    ui.api.post = vi.fn(async () => { throw new CommunityError(POSTS_TODAY, 409); });
    const d = privateRender();
    fill(d, "Night patrol");
    press(post(draw(PostDialog, d)));
    await settle();
    await settle();
    const tree = draw(PostDialog, d);
    expect(text(tree as El)).toContain(`${POSTS_TODAY} ${STAYED_PUBLIC}`);
    expect(all(tree).filter((el) => el.props.type === "checkbox")).toHaveLength(0);
  });

  it("leaves a public render as it is when its post is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    ui.api.post = vi.fn(async () => { throw new CommunityError(POSTS_TODAY, 409); });
    const d = D({ community: chip("gundam"), render: { id: "r6", thumb: "t", public: true } });
    fill(d, "Night patrol");
    press(post(draw(PostDialog, d)));
    await settle();
    expect([(fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length, text(draw(PostDialog, d) as El).includes(BACK_TO_PRIVATE)]).toEqual([0, false]);
  });

  it("opens + Create c/… in its own place and comes back with the new pick", () => {
    const d = D({ render: { id: "r4", thumb: "t", public: true } });
    (of(draw(PostDialog, d), CommunityPicker)[0].props.onCreate as (n: string) => void)("Brett");
    const create = draw(PostDialog, d) as El;
    expect([create.type, create.props.name]).toEqual([CommunityDialog, "Brett"]);
    (create.props.onDone as (c: object) => void)(detail({ id: "id-brett", handle: "brett", name: "Brett" }));
    expect(of(draw(PostDialog, d), CommunityPicker)[0].props.value).toEqual([{ id: "id-brett", handle: "brett", name: "Brett" }]);
  });
});

describe("the Showroom and the works", () => {
  it("leads an empty Showroom to the works; Post a piece asks a guest to sign in", () => {
    const onWorks = vi.fn();
    let tree = draw(Showroom, { community: chip("gundam"), staff: false, works: 12, onWorks });
    expect(text(tree as El)).toContain("No posts yet.");
    press(button(tree, "See all 12 works →"));
    expect(onWorks).toHaveBeenCalled();
    press(byClass(tree, "st-btn--cta")[0]);
    expect(of(draw(Showroom, { community: chip("gundam"), staff: false, works: 12, onWorks }), PostDialog)[0].props.community).toEqual(chip("gundam"));
    ui.access = { access: "ok", role: "team" };
    fresh();
    tree = draw(Showroom, { community: chip("gundam"), staff: false, works: 0, onWorks });
    press(byClass(tree, "st-btn--cta")[0]);
    expect(ui.login).toHaveBeenCalled();
    expect(button(tree, "See all 0 works →")).toBeUndefined();
  });

  it("lets staff take a work out of the community from the viewer, and leads to its prompt while it is listed", async () => {
    const work: Work = { imageId: "g1", kind: "video", url: "u", thumb: "t", width: 1, height: 1, owner: { handle: "mira" }, promptId: "p9", likes: 0, addedAt: "" };
    ui.list = { items: [work], loading: false, error: null, more: false, loadingMore: false, loadMore: () => {} };
    const tree = draw(WorksGrid, { handle: "gundam", staff: true });
    expect(byClass(tree, "cm-play")).toHaveLength(1);
    press(byClass(tree, "cm-work")[0]);
    const panel = of(draw(WorksGrid, { handle: "gundam", staff: true }), FullscreenViewer)[0].props.panel as El;
    (panel.props.onHide as () => void)();
    await settle();
    expect(ui.api.hide).toHaveBeenCalledWith("gundam", { kind: "image", id: "g1", hidden: true });
    expect(text(draw(WorkPanel, { work, onPrompt: vi.fn() }) as El)).toContain("Open its prompt");
    expect(text(draw(WorkPanel, { work: { ...work, promptId: null }, onPrompt: vi.fn() }) as El)).not.toContain("Open its prompt");
    // Hidden, the viewer closed; anyone but staff gets no Hide.
    expect(of(draw(WorksGrid, { handle: "gundam", staff: true }), FullscreenViewer)).toHaveLength(0);
    press(byClass(draw(WorksGrid, { handle: "gundam", staff: false }), "cm-work")[0]);
    expect((of(draw(WorksGrid, { handle: "gundam", staff: false }), FullscreenViewer)[0].props.panel as El).props.onHide).toBeUndefined();
  });

  const shot: Work = { imageId: "g1", kind: "image", url: "u", thumb: "t", width: 1, height: 1, owner: { handle: "mira" }, promptId: null, likes: 3, addedAt: "" };
  const postOf = (over: Partial<ShowroomPost> = {}): ShowroomPost => ({
    id: "p1", title: "Night patrol", caption: null, author: { handle: "mira" }, work: shot, communities: [chip("gundam")], parentId: null,
    answers: 0, latestAnswers: [], mine: false, createdAt: "", ...over,
  });
  /** One post card of the Showroom, mounted. */
  const postCard = (post: ShowroomPost, staff: boolean) => {
    ui.list = { items: [post], loading: false, error: null, more: false, loadingMore: false, loadMore: () => {} };
    fresh();
    return mountEl(all(draw(Showroom, { community: chip("gundam"), staff, works: 0, onWorks: vi.fn() })).find((el) => el.props.post)!);
  };

  it("offers Delete to its poster and to staff, Hide from c/<x> to staff on others' posts, nothing to anyone else", async () => {
    const opts = (post: ShowroomPost, staff: boolean) => (of(postCard(post, staff), PillMenu)[0]?.props.options as Array<{ key: string; label: string }> | undefined)?.map((o) => o.key) ?? [];
    expect(opts(postOf(), false)).toEqual([]);
    expect(opts(postOf({ mine: true }), false)).toEqual(["delete"]);
    expect(opts(postOf(), true)).toEqual(["hide", "delete"]);
    expect(opts(postOf({ mine: true }), true)).toEqual(["delete"]);
    (of(postCard(postOf(), true), PillMenu)[0].props.onPick as (k: string) => void)("hide");
    await settle();
    expect(ui.api.hide).toHaveBeenCalledWith("gundam", { kind: "post", id: "p1", hidden: true });
  });

  it("likes the post's render through the image's own likes route, sending the opposite of the viewer's like", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ count: 4, mine: true }) })));
    const heart = () => all(mountEl(all(postCard(postOf(), false)).find((el) => el.props.imageId === "g1")!)).find((el) => el.type === "button")!;
    expect(heart().props["aria-pressed"]).toBe(false);
    press(heart());
    await settle();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(["/api/images/g1/likes", expect.objectContaining({ method: "POST", body: JSON.stringify({ liked: true }) })]);
    expect(ui.qc.setQueryData).toHaveBeenCalledWith(["image-like", "g1"], { count: 4, mine: true });
    ui.liked = { count: 4, mine: true };
    expect(heart().props["aria-pressed"]).toBe(true);
    press(heart());
    await settle();
    expect((calls[1][1] as { body: string }).body).toBe(JSON.stringify({ liked: false }));
  });

  it("lists the members, the one who started it marked", () => {
    ui.list = { items: [{ handle: "kev", creator: true, joinedAt: "" }, { handle: "mira", creator: false, joinedAt: "" }, { handle: null, creator: false, joinedAt: "" }], loading: false, error: null, more: false, loadingMore: false, loadMore: () => {} };
    const rows = byClass(draw(MembersList, { handle: "gundam" }), "cm-member");
    expect(rows.map((r) => text(r.props.children as ReactNode))).toEqual(["@kevStarted it", "@mira", "A closed account"]);
  });
});

describe("one work's communities (a render's ⋯, its viewer)", () => {
  it("saves the whole list once the picks held still, the prompt's ones marked; says what a moderator took out", async () => {
    vi.useFakeTimers();
    ui.links = { data: { communities: [chip("apu"), chip("pepe")], inherited: ["id-pepe"], optedOut: [], hidden: [chip("brett")] }, notReady: false, error: null };
    const p = { kind: "image" as const, id: "r1" };
    let tree = draw(CommunityLinks, p);
    const picker = of(tree, CommunityPicker)[0];
    expect(picker.props).toMatchObject({ value: [chip("apu"), chip("pepe")], inherited: ["id-pepe"] });
    expect(text(tree as El)).toContain(`c/brett: ${HIDDEN_BY_MODERATOR}`);
    (picker.props.onChange as (n: object[]) => void)([chip("apu")]);
    tree = draw(CommunityLinks, p);
    expect(of(tree, CommunityPicker)[0].props.value).toEqual([chip("apu")]);
    run();
    // Once the picks held still for 400 ms, not before.
    await vi.advanceTimersByTimeAsync(399);
    expect(ui.api.setLinks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ui.api.setLinks).toHaveBeenCalledWith({ kind: "image", ids: ["r1"], communityIds: ["id-apu"] });
  });

  it("waits for a render being saved", () => {
    const tree = draw(CommunityLinks, { kind: "image", id: null });
    expect(of(tree, CommunityPicker)).toHaveLength(0);
    expect(text(tree as El)).toContain("Saving…");
  });

  const listOf = (...handles: string[]) => ({ data: { communities: handles.map(chip), inherited: [], optedOut: [], hidden: [] }, notReady: false, error: null });
  const pickOn = (p: { kind: "image"; id: string }, next: ReturnType<typeof chip>[]) => (of(draw(CommunityLinks, p), CommunityPicker)[0].props.onChange as (n: object[]) => void)(next);
  const shownOn = (p: { kind: "image"; id: string }) => of(draw(CommunityLinks, p), CommunityPicker)[0].props.value;

  // Review 2026-10-30: the viewer paged on within 400 ms of a pick; the same CommunityLinks wrote A's picks to B.
  it("sends a pick to its own render when the viewer pages on before it was sent, and shows the next one's own list", async () => {
    vi.useFakeTimers();
    ui.links = listOf("apu", "pepe");
    pickOn({ kind: "image", id: "A" }, [chip("apu")]);
    draw(CommunityLinks, { kind: "image", id: "A" });
    const cleanups = run();
    // The next image: the same component, a new id (React runs the last effects' cleanups).
    ui.links = listOf("gundam");
    draw(CommunityLinks, { kind: "image", id: "B" });
    for (const c of cleanups) c?.();
    expect(ui.api.setLinks.mock.calls).toEqual([[{ kind: "image", ids: ["A"], communityIds: ["id-apu"] }]]);
    expect(shownOn({ kind: "image", id: "B" })).toEqual([chip("gundam")]);
    run();
    await vi.advanceTimersByTimeAsync(400);
    expect(ui.api.setLinks).toHaveBeenCalledTimes(1);
  });

  it("sends a pick not sent yet when it goes (the menu closed within 400 ms)", () => {
    ui.links = listOf("apu");
    pickOn({ kind: "image", id: "r1" }, [chip("apu"), chip("pepe")]);
    draw(CommunityLinks, { kind: "image", id: "r1" });
    for (const c of run()) c?.();
    expect(ui.api.setLinks).toHaveBeenCalledWith({ kind: "image", ids: ["r1"], communityIds: ["id-apu", "id-pepe"] });
  });

  it("shows the list as it was after a failed save and says so once; a newer pick made while saving stays", async () => {
    vi.useFakeTimers();
    let fail: (e: Error) => void = () => {};
    ui.api.setLinks = vi.fn(() => new Promise((_, no) => { fail = no; }));
    ui.links = listOf("apu");
    const p = { kind: "image" as const, id: "r1" };
    pickOn(p, [chip("apu"), chip("pepe")]);
    draw(CommunityLinks, p);
    run();
    await vi.advanceTimersByTimeAsync(400);
    fail(new Error("Could not save that right now."));
    await vi.advanceTimersByTimeAsync(0);
    expect(shownOn(p)).toEqual([chip("apu")]);
    expect(ui.notify).toHaveBeenCalledWith("Could not save that right now.", { tone: "error" });
    // A pick made while the next save is out stays when that one answers.
    pickOn(p, [chip("apu"), chip("brett")]);
    draw(CommunityLinks, p);
    run();
    await vi.advanceTimersByTimeAsync(400);
    pickOn(p, [chip("apu"), chip("brett"), chip("mecha")]);
    fail(new Error("Could not save that right now."));
    await vi.advanceTimersByTimeAsync(0);
    expect(shownOn(p)).toEqual([chip("apu"), chip("brett"), chip("mecha")]);
    expect(ui.notify).toHaveBeenCalledTimes(1);
  });
});

describe("the prompt editor's Communities", () => {
  const hook = (id: string | null) => draw(() => useReleaseCommunities(id, "pepe and apu") as never, {}) as unknown as ReturnType<typeof useReleaseCommunities>;

  it("sends nothing when nothing was picked; the picks once the release has its id; the reason when they are not set", async () => {
    expect(await hook(null).save("p9")).toBeNull();
    expect(ui.api.setLinks).not.toHaveBeenCalled();
    const pill = hook(null).pill as El;
    expect(pill.props.text).toBe("pepe and apu");
    (pill.props.onChange as (n: object[]) => void)([chip("apu")]);
    expect(await hook(null).save("p9")).toBeNull();
    expect(ui.api.setLinks).toHaveBeenCalledWith({ kind: "prompt", ids: ["p9"], communityIds: ["id-apu"] });
    ui.api.setLinks = vi.fn(async () => { throw new Error("A work can be in up to 18 communities."); });
    expect(await hook(null).save("p9")).toBe("A work can be in up to 18 communities.");
  });

  it("shows a released prompt's own communities", () => {
    ui.links = { data: { communities: [chip("gundam")], inherited: [], optedOut: [], hidden: [] }, notReady: false, error: null };
    expect(hook("p1").picks).toEqual([chip("gundam")]);
  });

  // Review 2026-10-30: picks made on the empty pill before its list came (or after the read failed) replaced the list.
  it("waits for a released prompt's own communities before anything can be picked, and says why when they could not be read", async () => {
    ui.links = { data: undefined, notReady: false, error: null };
    let pill = hook("p1").pill as El;
    expect(pill.props).toMatchObject({ disabled: true, ariaLabel: "Communities: reading its communities…" });
    (pill.props.onChange as (n: object[]) => void)([chip("apu")]);
    expect(await hook("p1").save("p1")).toBeNull();
    expect(ui.api.setLinks).not.toHaveBeenCalled();
    ui.links = { data: undefined, notReady: false, error: "Could not read communities right now." };
    expect((hook("p1").pill as El).props).toMatchObject({ disabled: true, ariaLabel: "Communities: Could not read communities right now." });
    // A new prompt has none to read; Communities not there yet is said by the picker itself.
    expect((hook(null).pill as El).props.disabled).toBe(false);
    ui.links = { data: undefined, notReady: true, error: null };
    pill = hook("p1").pill as El;
    expect(pill.props.disabled).toBe(false);
  });

  it("is set after the release answered, before the editor leaves; the release stands and the editor says why not", () => {
    const EDITOR = readSource(join(__dirname, "..", "..", "components", "prompt-editor", "PromptEditor.tsx"));
    expect(EDITOR).toMatch(/const unlinked = await communities\.save\(data\.id\);\n\s*if \(unlinked\) notify\(`Released\. Communities not saved: \$\{unlinked\}`, \{ tone: "error" \}\);[\s\S]*store\.clear\(\);\n\s*if \(!mounted\.current\) return;\n\s*if \(!updating\) offerShare\(data\.id, imageValues\(starredJobs\)\);\n\s*router\.push\(promptPage\(data\.id\)\);/);
    expect(EDITOR).toContain("const communities = useReleaseCommunities(editing ? promptId : null, `${listing.title} ${doc.prompt}`);");
    expect(EDITOR).toContain("onCategory={(category) => setListing({ category })} extra={communities.pill} />");
  });
});

describe("Create > Image's picks (linked as each render's row comes in)", () => {
  const job = (id: string) => ({ id, createdAt: 1, status: "ready", imageUrl: `https://x/${id}.png`, setup: {}, seen: true }) as never;
  const row = (id: string, url: string) => ({ id, image_url: url, image_urls: [url], thumbnail_url: null, isUploaded: false, visibility: "private", prompt_id: null, created_at: "" }) as never;
  const link = (jobs: never[], rows: never[], picks: Array<ReturnType<typeof chip>>) => { draw(CommunityLinking, { jobs, rows, picks }); run(); };

  it("links a render started under picks to them once, by its row; one there before Create opened, or started with none, never", () => {
    link([job("old")], [row("r-old", "https://x/old.png")], [chip("pepe"), chip("apu")]);
    link([job("none"), job("old")], [row("r-none", "https://x/none.png")], []);
    link([job("new"), job("none"), job("old")], [], [chip("pepe"), chip("apu")]);
    expect(ui.api.setLinks).not.toHaveBeenCalled();
    const rows = [row("r-new", "https://x/new.png"), row("r-none", "https://x/none.png"), row("r-old", "https://x/old.png")];
    link([job("new"), job("none"), job("old")], rows, [chip("pepe")]);
    link([job("new"), job("none"), job("old")], rows, [chip("pepe")]);
    expect(ui.api.setLinks.mock.calls).toEqual([[{ kind: "image", ids: ["r-new"], communityIds: ["id-apu", "id-pepe"] }]]);
  });

  it("says a failed link once, however many renders fail", async () => {
    ui.api.setLinks = vi.fn(async () => { throw new Error("Could not save that right now."); });
    link([], [], [chip("pepe")]);
    link([job("a")], [], [chip("pepe")]);
    link([job("b"), job("a")], [row("r-a", "https://x/a.png")], [chip("pepe")]);
    await settle();
    link([job("b"), job("a")], [row("r-b", "https://x/b.png"), row("r-a", "https://x/a.png")], [chip("pepe")]);
    await settle();
    expect(ui.api.setLinks).toHaveBeenCalledTimes(2);
    expect(ui.notify.mock.calls).toEqual([["Couldn't link that render to its communities: Could not save that right now.", { tone: "error" }]]);
  });

  it("sits right after \"+\" in the bar, sharing its cell, with the line about private renders", () => {
    const BAR = readSource(join(__dirname, "..", "..", "components", "create", "image", "ImageBar.tsx"));
    expect(BAR).toContain('{afterPlus ? <span className="ci-plusrow">{plusButton}{afterPlus}</span> : plusButton}');
    const PAGE = readSource(join(__dirname, "..", "..", "components", "create", "image", "CreateImage.tsx"));
    expect(PAGE).toContain("afterPlus={!m.guest && <BarCommunities picks={communities} onPicks={setCommunities} text={m.text ?? \"\"} />} />");
    expect(PAGE).toContain("<CommunityLinking jobs={m.jobs} rows={mine.rows} picks={communities} />");
    const CSS = readSource(join(__dirname, "..", "..", "components", "communities", "communities.css"));
    expect(CSS).toContain(".feed-create-image .ci-plusrow { grid-area: plus; display: flex; align-items: center; gap: 8px; }");
  });
});

describe("a render's ⋯ asks, in the menu's place", () => {
  it("links the render to a community started from its picker, and posts it from Post to Showroom", async () => {
    const onClose = vi.fn();
    const create = draw(CommunityAsk, { ask: { create: "Brett" }, id: "r1", onClose }) as El;
    expect([create.type, create.props.name]).toEqual([CommunityDialog, "Brett"]);
    (create.props.onDone as (c: object) => void)(chip("brett"));
    await settle();
    expect(onClose).toHaveBeenCalled();
    expect(ui.api.addLink).toHaveBeenCalledWith("image", "r1", "id-brett");
    expect(ui.notify).toHaveBeenCalledWith("Linked to c/brett");
    const post = draw(CommunityAsk, { ask: { post: { id: "r1", thumb: "t", public: false } }, id: "r1", onClose }) as El;
    expect([post.type, post.props.render]).toEqual([PostDialog, { id: "r1", thumb: "t", public: false }]);
  });

  it("puts the viewer's own render's communities on its stage, never for an upload or a guest, with no dialog over the viewer", () => {
    const VIEWER = readSource(join(__dirname, "..", "..", "components", "image-view", "ViewerPanel.tsx"));
    expect(VIEWER).toContain("{record && !record.isUploaded && !m.guest && (\n        <CommunityLinks kind=\"image\" id={record.id} tone=\"stage\" create={false}");
  });
});

describe("Explore's Community filter", () => {
  it("picks one community into the address, reads it back as c/<handle>, its × and Open c/<handle> →", () => {
    const onPick = vi.fn();
    const tree = draw(ExploreCommunity, { handle: "apu", onPick });
    const pill = of(tree, CommunityPill)[0].props;
    expect([pill.mode, pill.face, pill.value]).toEqual(["single", "c/apu", [{ id: "apu", handle: "apu", name: "apu" }]]);
    (pill.onChange as (n: object[]) => void)([chip("pepe")]);
    expect(onPick).toHaveBeenLastCalledWith("pepe");
    press(byClass(tree, "cm-explore-x")[0]);
    expect(onPick).toHaveBeenLastCalledWith(null);
    // Its way to the community closes the popover or sheet first (review 2026-10-30: it stayed open over the panel).
    vi.stubGlobal("window", { dispatchEvent: () => false });
    const close = vi.fn();
    const open = (pill.foot as (close: () => void) => El)(close);
    expect(text(open)).toBe("Open c/apu →");
    press(open);
    expect(close).toHaveBeenCalled();
    expect(of(draw(ExploreCommunity, { handle: null, onPick }), CommunityPill)[0].props.face).toBe("Community");
  });

  it("filters the feed and the search by it, in every world, its own key", () => {
    const FEED = readSource(join(__dirname, "..", "..", "components", "enki", "EnkiFeedPage.tsx"));
    expect(FEED.split('if (community) params.set("community", community);')).toHaveLength(3);
    expect(FEED).toContain('showAdult ? "18+" : "safe", query, community ?? "", media],');
    expect(FEED).toContain("community={community} onCommunity={pickCommunity}\n");
    expect(FEED).toContain("router.push(communityFilterLink(`${pathname}?${searchParams.toString()}`, handle), { scroll: false });");
  });
});

describe("the merge queue (Kev: \"duplikate wie gundam 1, gundam 2\")", () => {
  const row = (handle: string, members: number, reviewed = false) => ({ ...card(handle, { members, works: 0 }), createdAt: "2026-10-30T10:00:00Z", createdBy: "kev", reviewed });
  const group = { core: "gundam", communities: [row("gundam_2", 1), row("gundam", 900, true), row("gundam_fans", 3)] };

  it("says when there is nothing to look at, or Communities is not there yet", () => {
    ui.merges = { data: { groups: [] }, notReady: false, error: null, retry: () => {} };
    expect(text(draw(MergeQueue, {}) as El)).toBe("No possible duplicates.");
    ui.merges = { data: undefined, notReady: true, error: null, retry: () => {} };
    expect(text(draw(MergeQueue, {}) as El)).toBe(COMMUNITIES_NOT_READY);
  });

  it("merges the others into the biggest by default, each asked first, one after another; or keeps them all apart", async () => {
    ui.merges = { data: { groups: [group] }, notReady: false, error: null, retry: () => {} };
    const g = mountEl(of(draw(MergeQueue, {}), (of(draw(MergeQueue, {}), "div")[0].props.children as El[])[0].type)[0]);
    const Group = (of(draw(MergeQueue, {}), "div")[0].props.children as El[])[0];
    const again = () => draw(Group.type as (p: unknown) => unknown, Group.props);
    expect(text(byClass(g, "st-btn--cta")[0].props.children as ReactNode)).toBe("Merge the others into c/gundam");
    expect(byClass(g, "cm-mark")).toHaveLength(2);
    press(byClass(again(), "st-btn--cta")[0]);
    let ask = of(again(), ConfirmDialog)[0];
    expect(ask.props.title).toBe("Merge c/gundam_2 into c/gundam?");
    expect(ui.api.merge).not.toHaveBeenCalled();
    (ask.props.onConfirm as () => void)();
    await settle();
    ask = of(again(), ConfirmDialog)[0];
    expect(ask.props.title).toBe("Merge c/gundam_fans into c/gundam?");
    (ask.props.onConfirm as () => void)();
    await settle();
    expect(ui.api.merge.mock.calls).toEqual([[{ from: "id-gundam_2", into: "id-gundam" }], [{ from: "id-gundam_fans", into: "id-gundam" }]]);
    expect(of(again(), ConfirmDialog)).toHaveLength(0);
    press(button(again(), "Keep all apart"));
    expect(ui.api.keep).toHaveBeenCalledWith(["id-gundam_2", "id-gundam", "id-gundam_fans"]);
  });

  // Review 2026-10-30: the target merged or deleted elsewhere, the group read anew threw on `into.handle`.
  it("falls back to the biggest left when the target it had leaves the group", async () => {
    ui.merges = { data: { groups: [group] }, notReady: false, error: null, retry: () => {} };
    const Group = (of(draw(MergeQueue, {}), "div")[0].props.children as El[])[0];
    fresh();
    const drawn = (g: typeof group) => draw(Group.type as (p: unknown) => unknown, { group: g });
    drawn(group);
    const left = { core: "gundam", communities: [row("gundam_2", 1), row("gundam_fans", 3)] };
    const tree = drawn(left);
    expect(text(byClass(tree, "st-btn--cta")[0].props.children as ReactNode)).toBe("Merge the others into c/gundam_fans");
    expect(all(tree).filter((el) => el.props.type === "radio" && el.props.checked).map((el) => el.props["aria-label"])).toEqual(["Merge into c/gundam_fans"]);
    press(byClass(tree, "st-btn--cta")[0]);
    (of(drawn(left), ConfirmDialog)[0].props.onConfirm as () => void)();
    await settle();
    expect(ui.api.merge).toHaveBeenCalledWith({ from: "id-gundam_2", into: "id-gundam_fans" });
  });

  it("is an admin's tab of the admin page, read by itself", () => {
    const ADMIN = readSource(join(__dirname, "..", "..", "app", "admin", "page.tsx"));
    expect(ADMIN).toContain('(t.id !== "communities" || role === "admin")');
    expect(ADMIN).toContain('{tab === "communities" && role === "admin" && <MergeQueue />}');
  });
});

describe("/c/<handle>", () => {
  it("is a door into the shell's Communities panel on that community", () => {
    const DOOR = readSource(join(__dirname, "..", "..", "app", "c", "[handle]", "page.tsx"));
    expect(DOOR).toContain('router.replace(panelLink(`${window.location.origin}/home`, { id: "communities", ...(h && { community: h }) }));');
  });
});

describe("the menu's icon", () => {
  it("is lucide's users, drawn by the shell's icon set", async () => {
    const { ENKI_ICONS } = await import("@/components/enki-shell/icons");
    expect(ENKI_ICONS.users).toBe('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>');
  });
});

describe("the look", () => {
  const CSS = readSource(join(__dirname, "..", "..", "components", "communities", "communities.css"));
  it("gives every directory card the grid's width at 3:4 (Kev: \"gleich große senkrechte karten\"), two a row on a phone", () => {
    expect(CSS).toContain(".cm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); gap: 14px; }");
    expect(CSS).toContain("position: relative; display: block; width: 100%; aspect-ratio: 3 / 4;");
    expect(CSS).toMatch(/@media \(max-width: 767\.98px\) \{\n {2}\.cm-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 10px; \}/);
  });
  // Measured on the bench 2026-10-30: without it, a close name's cover filled the whole dialog and took its presses.
  it("keeps a small cover inside its own frame", () => {
    expect(CSS).toContain(".cm-closest-row > span:first-child { position: relative;");
  });
});
