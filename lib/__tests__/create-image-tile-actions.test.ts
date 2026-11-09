import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Copy } from "lucide-react";

/**
 * A finished picture's actions on Create > Image's wall (Kev, 2026-10-30: "bei higgsfield zb haste oben rechts zb herz,
 * bei uns gibts rechts daneben bookmark wo wir dann die gruppe einfügen, darunter ist download, dieses copy symbol ist
 * dann recreate ... dann Create prompt auch so klein. und dann diese 3 dots die dann a responsive dropdown menü aufzeigen
 * mit: Add to Studio ...; Share ...; Delete ... und dann auch ganz unten das bild und video, bedeuten: Reference ... und
 * Animate"). The views are called with their hooks answered, as React would render them; the measured look and the real
 * hover, keyboard and phone sheet are in the headless-Edge bench.
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, refs: [] as Array<{ current: unknown }>, r: 0, effects: false, cleanups: [] as unknown[],
  projects: null as null | Record<string, unknown>, project: null as null | Record<string, unknown>, scope: null as unknown,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T | (() => T)) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = typeof start === "function" ? (start as () => T)() : start;
    return [ui.state[i] as T, (next: T | ((t: T) => T)) => { ui.state[i] = typeof next === "function" ? (next as (t: T) => T)(ui.state[i] as T) : next; }];
  },
  useRef: <T>(start: T) => {
    const i = ui.r++;
    ui.refs[i] ??= { current: start };
    return ui.refs[i];
  },
  useEffect: (fn: () => unknown) => { if (ui.effects) ui.cleanups.push(fn()); },
  useLayoutEffect: (fn: () => unknown) => { if (ui.effects) ui.cleanups.push(fn()); },
  useEffectEvent: <T>(fn: T) => fn,
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/components/enki/BookmarkPicker", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/kit/BottomSheet", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/kit/ConfirmDialog", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/kit/notify", () => ({ notify: vi.fn() }));
vi.mock("@/components/kit/share", () => ({ downloadImage: vi.fn(async () => {}), shareImage: vi.fn(async () => {}), shareWithLink: vi.fn(async () => {}) }));
vi.mock("@/components/image-view/useImageViewModel", () => ({ copyText: vi.fn() }));
vi.mock("@/lib/openLogin", () => ({ openLogin: vi.fn() }));
vi.mock("@/components/studio/KeepInStudio", () => ({ default: vi.fn(() => null) }));
// Communities' own parts as markers (lib/__tests__/communities-ui.test.ts renders them).
vi.mock("@/components/communities/CommunityLinks", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/communities/CommunityAsk", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/studio/StudioScope", () => ({ StudioScope: vi.fn(() => null), useStudioScope: () => ui.scope }));
vi.mock("@/hooks/useStudio", () => ({ useStudioProjects: vi.fn(() => ui.projects), useStudioProject: vi.fn(() => ui.project) }));

import TileActions, { ViewerActs, type TileActs } from "@/components/create/image/TileActions";
import TileMenu from "@/components/create/image/TileMenu";
import StudioPick from "@/components/create/image/StudioPick";
import BookmarkPicker from "@/components/enki/BookmarkPicker";
import BottomSheet from "@/components/kit/BottomSheet";
import ConfirmDialog from "@/components/kit/ConfirmDialog";
import KeepInStudio from "@/components/studio/KeepInStudio";
import CommunityLinks from "@/components/communities/CommunityLinks";
import CommunityAsk from "@/components/communities/CommunityAsk";
import { PRIVATE_RENDERS_LINE } from "@/lib/communities/types";
import { StudioScope } from "@/components/studio/StudioScope";
import { useStudioProjects } from "@/hooks/useStudio";
import { notify } from "@/components/kit/notify";
import { downloadImage, shareImage, shareWithLink } from "@/components/kit/share";
import { copyText } from "@/components/image-view/useImageViewModel";
import { openLogin } from "@/lib/openLogin";
import { wallItems, type OwnRow, type WallItem } from "@/lib/ui/create/image";
import { tileFacts } from "@/lib/ui/create/tile-actions";
import { STUDIO_NOT_READY } from "@/lib/studio/types";
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
const press = (el: El, e: unknown = { currentTarget: { getBoundingClientRect: () => BOX, focus: vi.fn() } }) => (el.props.onClick as (e: unknown) => void)(e);
const BOX = { left: 900, right: 928, top: 100, bottom: 128 } as DOMRect;

const row = (id: string, over: Partial<OwnRow> = {}): OwnRow => ({
  id, image_url: `https://cdn/${id}.png`, image_urls: [`https://cdn/${id}.webp`], thumbnail_url: `https://cdn/${id}-t.webp`, isUploaded: false,
  visibility: "private", prompt_id: "p1", settings: null, prompt_text: `words of ${id}`, created_at: "x", ...over,
});
const job = (id: string): Job<ImageSetup> =>
  ({ id, createdAt: 1, status: "ready", sent: true, setup: { prompt: `words ${id}`, aspectRatio: "1:1" } as unknown as ImageSetup, seen: false, imageUrl: `https://cdn/${id}.png` });
const ITEM = wallItems([], [row("r1")])[0];
const acts = (over: Partial<TileActs> = {}): TileActs => ({
  guest: false, marks: new Map([["p1", [{ bookmarkId: "b1", categoryId: "c1" }]]]), recreate: vi.fn(), prompt: vi.fn(), reference: vi.fn(), animate: vi.fn(), remove: vi.fn(), ...over,
});
/** The window as the tile reads it: below 1024 px or not, a pointer that hovers or a touch screen. */
const screen = ({ narrow = false, touch = false, share = false } = {}) => {
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({ matches: q.includes("1023.98") ? narrow : q.includes("hover: hover") ? !touch : false }),
    location: { origin: "https://enki.gallery" }, addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 1440, innerHeight: 900,
  });
  vi.stubGlobal("navigator", share ? { share: vi.fn(async () => {}) } : {});
  vi.stubGlobal("document", { activeElement: null });
};
type P = { item: WallItem; width: number; height: number; acts: TileActs };
/** A render with the state as it stands; the hooks start from the top again. */
const draw = (p: P) => {
  ui.s = 0;
  ui.r = 0;
  return TileActions(p) as ReactNode;
};
const tile = (over: Partial<P> = {}) => ({ item: ITEM, width: 300, height: 300, acts: acts(), ...over });
const labels = (els: El[]) => els.map((b) => b.props["aria-label"]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  ui.state = [];
  ui.refs = [];
  ui.effects = false;
  ui.cleanups = [];
  screen();
});

describe("the tile", () => {
  it("carries the rail (Bookmark, Download, Recreate, Make it a prompt, ⋯), Reference and Animate named, and the touch screen's ⋯", () => {
    const tree = draw(tile());
    expect(labels(byClass(byClass(tree, "ci-rail")[0].props.children as ReactNode, "ci-act"))).toEqual(["Bookmark", "Download", "Recreate", "Make it a prompt", "More"]);
    const pair = byClass(byClass(tree, "ci-pair")[0].props.children as ReactNode, "ci-act");
    expect(pair.map((b) => [b.props["aria-label"], text(b.props.children as ReactNode)])).toEqual([["Reference", "Reference"], ["Animate", "Animate"]]);
    expect(labels(byClass(tree, "ci-dots"))).toEqual(["Image actions"]);
    expect(byClass(tree, "ci-rail")[0].props).toMatchObject({ role: "group", "aria-label": "Image actions" });
  });

  it("moves what a short, narrow tile cannot hold under ⋯", () => {
    const tree = draw(tile({ width: 100, height: 108 }));
    expect(labels(byClass(byClass(tree, "ci-rail")[0].props.children as ReactNode, "ci-act"))).toEqual(["Bookmark", "Download", "More"]);
    expect(byClass(tree, "ci-pair")).toHaveLength(0);
    press(byClass(tree, "ci-act").find((b) => b.props["aria-label"] === "More")!);
    const menu = of(draw(tile({ width: 100, height: 108 })), TileMenu)[0];
    expect(of(menu.props.children as ReactNode, "button").map((b) => text(b.props.children as ReactNode)))
      .toEqual(["Recreate", "Make it a prompt", "Reference", "Animate", "Add to Studio", "Communities", "Share", "Delete"]);
  });

  it("has nothing on a picture still rendering or failed", () => {
    const [busy] = wallItems([{ ...job("b"), status: "rendering", imageUrl: undefined }], []);
    expect(draw(tile({ item: busy }))).toBeNull();
  });

  it("fills Bookmark once the picture's prompt is kept", () => {
    const fill = (a: TileActs) => (byClass(draw(tile({ acts: a })), "ci-act")[0].props.children as El[])[0].props.fill;
    expect(fill(acts())).toBe("currentColor");
    expect(fill(acts({ marks: new Map() }))).toBe("none");
  });
});

describe("the rail's own actions", () => {
  const rail = (p = tile()) => Object.fromEntries(byClass(draw(p), "ci-act").map((b) => [b.props["aria-label"], b]));

  it("Download saves the original, named by its words; Recreate, Make it a prompt, Reference and Animate go to the page", () => {
    const p = tile();
    const f = tileFacts(ITEM)!;
    press(rail(p).Download);
    expect(downloadImage).toHaveBeenCalledWith("https://cdn/r1.png", "words of r1");
    press(rail(p).Recreate);
    expect(p.acts.recreate).toHaveBeenCalledWith(ITEM);
    press(rail(p)["Make it a prompt"]);
    expect(p.acts.prompt).toHaveBeenCalledWith("words of r1");
    press(rail(p).Reference);
    expect(p.acts.reference).toHaveBeenCalledWith(f);
    press(rail(p).Animate);
    expect(p.acts.animate).toHaveBeenCalledWith(f);
  });

  it("dims what cannot run and says why on a press: Bookmark without a prompt, Make it a prompt on someone's words", () => {
    const own = wallItems([], [row("o", { prompt_id: null })])[0];
    const b = rail(tile({ item: own })).Bookmark;
    expect(b.props["aria-disabled"]).toBe(true);
    expect(b.props.title).toBe("Bookmarks keep prompts. This image was made from your own words: Make it a prompt to keep it.");
    press(b);
    expect(notify).toHaveBeenCalledWith("Bookmarks keep prompts. This image was made from your own words: Make it a prompt to keep it.");
    expect(of(draw(tile({ item: own })), BookmarkPicker)).toHaveLength(0);
    const market = tile({ item: wallItems([], [row("m", { prompt_kind: "market" })])[0] });
    expect(rail(market)["Make it a prompt"].props["aria-disabled"]).toBe(true);
    press(rail(market)["Make it a prompt"]);
    expect(market.acts.prompt).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith("Its words belong to the prompt's creator.");
    expect(rail().Download.props["aria-disabled"]).toBeUndefined();
  });

  it("Bookmark opens the bookmark picker at the button with the prompt's groups (making a new one is the picker's)", () => {
    const p = tile();
    press(rail(p).Bookmark);
    const picker = of(draw(p), BookmarkPicker)[0];
    expect(picker.props).toMatchObject({ promptId: "p1", imageUrl: "https://cdn/r1.png", anchor: BOX, memberships: [{ bookmarkId: "b1", categoryId: "c1" }] });
    expect(rail(p).Bookmark.props["aria-expanded"]).toBe(true);
    (picker.props.onChange as (k: string, n: string) => void)("added", "Moodboard");
    expect(notify).toHaveBeenCalledWith("Saved to Moodboard");
    // A second press closes it.
    press(rail(p).Bookmark);
    expect(of(draw(p), BookmarkPicker)).toHaveLength(0);
  });

  it("below 1024 px Bookmark opens the sheet with the picker in it; a guest signs in first", () => {
    screen({ narrow: true });
    const p = tile();
    press(rail(p).Bookmark);
    const sheet = of(draw(p), BottomSheet)[0];
    expect(sheet.props).toMatchObject({ open: true, title: "Save to" });
    const inSheet = of(sheet.props.children as ReactNode, BookmarkPicker)[0].props;
    expect([inSheet.promptId, inSheet.anchor]).toEqual(["p1", undefined]);
    expect(byClass(sheet.props.children as ReactNode, "iv-sheet-bmp")).toHaveLength(1);
    const guest = tile({ acts: acts({ guest: true }) });
    press(rail(guest).Bookmark);
    expect(openLogin).toHaveBeenCalledTimes(1);
  });

  it("Bookmark from the keyboard opens as the menu's page (its first row takes the focus there), and gives the focus back", () => {
    const p = tile();
    const focus = vi.fn();
    press(rail(p).Bookmark, { detail: 0, currentTarget: { getBoundingClientRect: () => BOX, focus } });
    const tree = draw(p);
    const menu = of(tree, TileMenu)[0];
    expect(menu.props).toMatchObject({ anchor: BOX, label: "Save to", page: "bookmark" });
    const inMenu = of(menu.props.children as ReactNode, BookmarkPicker);
    expect(inMenu.map((b) => [b.props.promptId, b.props.anchor])).toEqual([["p1", undefined]]);
    // No float beside it, and the button that opened it says so (⋯ does not).
    expect(of(tree, BookmarkPicker).filter((b) => b.props.anchor)).toHaveLength(0);
    expect(rail(p).Bookmark.props["aria-expanded"]).toBe(true);
    expect(rail(p).More.props["aria-expanded"]).toBe(false);
    (menu.props.onClose as () => void)();
    ui.effects = true;
    draw(p);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("the float at the button gives the focus back to Bookmark once it closes", () => {
    const p = tile();
    const focus = vi.fn();
    press(rail(p).Bookmark, { detail: 1, currentTarget: { getBoundingClientRect: () => BOX, focus } });
    expect(of(draw(p), TileMenu)).toHaveLength(0);
    (of(draw(p), BookmarkPicker)[0].props.onClose as () => void)();
    expect(of(draw(p), BookmarkPicker)).toHaveLength(0);
    ui.effects = true;
    draw(p);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("Recreate wears the copy symbol (Kev: \"dieses copy symbol ist dann recreate\")", () => {
    expect((rail().Recreate.props.children as El[])[0].type).toBe(Copy);
  });
});

describe("⋯", () => {
  const more = (p: P) => byClass(draw(p), "ci-act").find((b) => b.props["aria-label"] === "More")!;
  const rows = (tree: ReactNode) => of(tree, "button").filter((b) => b.props.role === "menuitem");

  it("opens Add to Studio, Communities, Share and Delete as a popover from 1024 px, the button marked open; a second press closes it", () => {
    const p = tile();
    press(more(p));
    const menu = of(draw(p), TileMenu)[0];
    expect(menu.props).toMatchObject({ anchor: BOX, label: "This image", page: "main" });
    expect(rows(menu.props.children as ReactNode).map((b) => text(b.props.children as ReactNode))).toEqual(["Add to Studio", "Communities", "Share", "Delete"]);
    expect(more(p).props["aria-expanded"]).toBe(true);
    expect(of(draw(p), BottomSheet)[0].props.open).toBe(false);
    press(more(p));
    expect(of(draw(p), TileMenu)).toHaveLength(0);
  });

  it("opens a sheet below 1024 px", () => {
    screen({ narrow: true });
    const p = tile();
    press(more(p));
    expect(of(draw(p), TileMenu)).toHaveLength(0);
    expect(of(draw(p), BottomSheet)[0].props).toMatchObject({ open: true, title: "This image" });
  });

  it("on a touch screen ⋯ alone opens a sheet holding every action", () => {
    const p = tile();
    press(byClass(draw(p), "ci-dots")[0]);
    const sheet = of(draw(p), BottomSheet)[0];
    expect(sheet.props.open).toBe(true);
    expect(rows(sheet.props.children as ReactNode).map((b) => text(b.props.children as ReactNode)))
      .toEqual(["Bookmark", "Download", "Recreate", "Make it a prompt", "Reference", "Animate", "Add to Studio", "Communities", "Share", "Delete"]);
    expect(byClass(draw(p), "ci-dots")[0].props["aria-expanded"]).toBe(true);
    // A row that runs closes the sheet first.
    press(rows(sheet.props.children as ReactNode).find((b) => text(b.props.children as ReactNode) === "Animate")!);
    expect(p.acts.animate).toHaveBeenCalledTimes(1);
    expect(of(draw(p), BottomSheet)[0].props.open).toBe(false);
  });

  it("Bookmark in the sheet opens the picker there; Delete asks first, then deletes", () => {
    const p = tile();
    press(byClass(draw(p), "ci-dots")[0]);
    const find = (label: string) => rows(of(draw(p), BottomSheet)[0].props.children as ReactNode).find((b) => text(b.props.children as ReactNode) === label)!;
    press(find("Bookmark"));
    expect(of(of(draw(p), BottomSheet)[0].props.children as ReactNode, BookmarkPicker)[0].props.promptId).toBe("p1");
    press(byClass(draw(p), "ci-dots")[0]);
    press(find("Delete"));
    expect(of(draw(p), BottomSheet)[0].props.open).toBe(false);
    const ask = of(draw(p), ConfirmDialog)[0];
    expect(ask.props).toMatchObject({ title: "Delete this image?", text: "It is removed from your gallery and from anywhere it was shown. This cannot be undone." });
    expect(p.acts.remove).not.toHaveBeenCalled();
    (ask.props.onConfirm as () => void)();
    expect(p.acts.remove).toHaveBeenCalledWith(ITEM);
    expect(of(draw(p), ConfirmDialog)).toHaveLength(0);
  });

  it("Delete waits for the render's row; Cancel deletes nothing", () => {
    const p = tile({ item: wallItems([job("j")], [])[0] });
    press(byClass(draw(p), "ci-dots")[0]);
    const del = rows(of(draw(p), BottomSheet)[0].props.children as ReactNode).find((b) => text(b.props.children as ReactNode) === "Delete")!;
    expect(del.props["aria-disabled"]).toBe(true);
    press(del);
    expect(notify).toHaveBeenCalledWith("Saving your render… It can be deleted once it is saved.");
    expect(of(draw(p), ConfirmDialog)).toHaveLength(0);
    const q = tile();
    press(more(q));
    press(rows(of(draw(q), TileMenu)[0].props.children as ReactNode).find((b) => text(b.props.children as ReactNode) === "Delete")!);
    (of(draw(q), ConfirmDialog)[0].props.onCancel as () => void)();
    expect(q.acts.remove).not.toHaveBeenCalled();
    expect(of(draw(q), ConfirmDialog)).toHaveLength(0);
  });

  it("Add to Studio and Share open their page with a way back; the opener takes the focus back once it is all closed", () => {
    const p = tile();
    const focus = vi.fn();
    press(more(p), { currentTarget: { getBoundingClientRect: () => BOX, focus } });
    press(rows(of(draw(p), TileMenu)[0].props.children as ReactNode)[0]);
    let menu = of(draw(p), TileMenu)[0];
    expect(menu.props).toMatchObject({ label: "Add to Studio", page: "studio" });
    expect(of(menu.props.children as ReactNode, StudioPick)[0].props).toMatchObject({ promptId: "p1", shot: expect.objectContaining({ key: "row:r1" }) });
    const back = byClass(menu.props.children as ReactNode, "ci-menu-back")[0];
    expect(text(back.props.children as ReactNode)).toBe("Add to Studio");
    press(back);
    press(rows(of(draw(p), TileMenu)[0].props.children as ReactNode)[2]);
    menu = of(draw(p), TileMenu)[0];
    expect(menu.props).toMatchObject({ label: "Share", page: "share" });
    (menu.props.onClose as () => void)();
    ui.effects = true;
    draw(p);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("the opener leaves the focus where something else took it (Recreate's prompt), and takes it back from nowhere", () => {
    const p = tile();
    const focus = vi.fn();
    press(more(p), { currentTarget: { getBoundingClientRect: () => BOX, focus } });
    (of(draw(p), TileMenu)[0].props.onClose as () => void)();
    const body = {};
    vi.stubGlobal("document", { activeElement: { id: "prompt" }, body });
    ui.effects = true;
    draw(p);
    expect(focus).not.toHaveBeenCalled();
    vi.stubGlobal("document", { activeElement: body, body });
    draw(p);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  // The agreed shape, 2026-10-30: "the tile ⋯ menu / viewer of an own render ("Communities")".
  it("Communities opens its page: the render's own communities by its row, then Post to Showroom; each dialog in the menu's place", () => {
    const p = tile();
    press(more(p));
    press(rows(of(draw(p), TileMenu)[0].props.children as ReactNode).find((b) => text(b.props.children as ReactNode) === "Communities")!);
    const menu = of(draw(p), TileMenu)[0];
    expect(menu.props).toMatchObject({ label: "Communities", page: "communities" });
    const links = of(menu.props.children as ReactNode, CommunityLinks)[0].props;
    // A private render: its picks show once it is public.
    expect(links).toMatchObject({ kind: "image", id: "r1", note: PRIVATE_RENDERS_LINE });
    (links.onCreate as (n: string) => void)("Gundam 2");
    expect(of(draw(p), TileMenu)).toHaveLength(0);
    expect(of(draw(p), CommunityAsk)[0].props).toMatchObject({ ask: { create: "Gundam 2" }, id: "r1" });
    (of(draw(p), CommunityAsk)[0].props.onClose as () => void)();
    expect(of(draw(p), CommunityAsk)).toHaveLength(0);
    press(more(p));
    press(rows(of(draw(p), TileMenu)[0].props.children as ReactNode).find((b) => text(b.props.children as ReactNode) === "Communities")!);
    const foot = of(of(draw(p), TileMenu)[0].props.children as ReactNode, CommunityLinks)[0].props.foot as El;
    press(foot);
    expect(of(draw(p), CommunityAsk)[0].props).toMatchObject({ ask: { post: { id: "r1", public: false } }, id: "r1" });
  });

  it("Communities waits for the render's row, and asks a guest to sign in", () => {
    const p = tile({ item: wallItems([job("j")], [])[0] });
    press(byClass(draw(p), "ci-dots")[0]);
    const row0 = rows(of(draw(p), BottomSheet)[0].props.children as ReactNode).find((b) => text(b.props.children as ReactNode) === "Communities")!;
    expect(row0.props["aria-disabled"]).toBe(true);
    press(row0);
    expect(notify).toHaveBeenCalledWith("Saving your render… It can join communities once it is saved.");
    const g = tile({ acts: acts({ guest: true }) });
    press(byClass(draw(g), "ci-dots")[0]);
    press(rows(of(draw(g), BottomSheet)[0].props.children as ReactNode).find((b) => text(b.props.children as ReactNode) === "Communities")!);
    expect(openLogin).toHaveBeenCalledTimes(1);
    expect(of(of(draw(g), BottomSheet)[0].props.children as ReactNode, CommunityLinks)).toHaveLength(0);
  });

  it("a guest's Add to Studio asks to sign in and opens no projects", () => {
    const p = tile({ acts: acts({ guest: true }) });
    press(byClass(draw(p), "ci-dots")[0]);
    press(rows(of(draw(p), BottomSheet)[0].props.children as ReactNode).find((b) => text(b.props.children as ReactNode) === "Add to Studio")!);
    expect(openLogin).toHaveBeenCalledTimes(1);
    const sheet = of(draw(p), BottomSheet)[0];
    expect(sheet.props.title).toBe("This image");
    expect(of(sheet.props.children as ReactNode, StudioPick)).toHaveLength(0);
  });
});

describe("Share", () => {
  const shareRows = (f = tileFacts(ITEM)!, onDone = vi.fn()) => {
    const p = tile();
    press(byClass(draw(p), "ci-dots")[0]);
    press(of(of(draw(p), BottomSheet)[0].props.children as ReactNode, "button").find((b) => text(b.props.children as ReactNode) === "Share")!);
    const el = [...walk(of(draw(p), BottomSheet)[0].props.children as ReactNode)].find((e) => typeof e.type === "function" && "onDone" in e.props)!;
    expect(el.props.f).toEqual(tileFacts(ITEM));
    return (el.type as (p: unknown) => ReactNode)({ f, onDone });
  };
  const items = (tree: ReactNode) => [...walk(tree)].filter((e) => e.props.role === "menuitem");

  it("with a pointer: Copy link, then the platforms, each opening its own share address", () => {
    const onDone = vi.fn();
    const tree = shareRows(undefined, onDone);
    const all = items(tree);
    expect(all.map((e) => text(e.props.children as ReactNode))).toEqual(["Copy link", "X", "Facebook", "Reddit", "WhatsApp", "Telegram", "Email"]);
    expect(all[1].props).toMatchObject({ href: expect.stringMatching(/^https:\/\/x\.com\/intent\/tweet\?url=https%3A%2F%2Fcdn%2Fr1\.png/), target: "_blank", rel: "noopener noreferrer" });
    expect(all[6].props.target).toBeUndefined();
    expect(text(byClass(tree, "ci-menu-note")[0].props.children as ReactNode)).toBe("Anyone with the link can open this image.");
    press(all[0]);
    expect(copyText).toHaveBeenCalledWith("https://cdn/r1.png", "Link copied");
    expect(onDone).toHaveBeenCalled();
  });

  it("a desktop browser with a share sheet still gets the platforms (the device's sheet is a phone's)", () => {
    screen({ share: true });
    expect(items(shareRows()).map((e) => text(e.props.children as ReactNode))).toEqual(["Copy link", "X", "Facebook", "Reddit", "WhatsApp", "Telegram", "Email"]);
  });

  it("a public picture shares its page on Enki", () => {
    const f = { ...tileFacts(ITEM)!, page: "/i/r1" };
    const tree = shareRows(f);
    press(items(tree)[0]);
    expect(copyText).toHaveBeenCalledWith("https://enki.gallery/i/r1", "Link copied");
    expect(text(byClass(tree, "ci-menu-note")[0].props.children as ReactNode)).toBe("Its page on Enki: the image with Enki's card.");
  });

  it("on a touch screen with a share sheet: the device's own, through the viewer's Share (the file, its page once public)", () => {
    screen({ touch: true, share: true });
    const onDone = vi.fn();
    const all = items(shareRows(undefined, onDone));
    expect(all.map((e) => text(e.props.children as ReactNode))).toEqual(["Copy link", "Share to an app…"]);
    press(all[1]);
    expect(onDone).toHaveBeenCalled();
    expect(shareImage).toHaveBeenCalledWith("https://cdn/r1.png");
    expect(shareWithLink).not.toHaveBeenCalled();
    press(items(shareRows({ ...tileFacts(ITEM)!, page: "/i/r1" }))[1]);
    expect(shareWithLink).toHaveBeenCalledWith("https://cdn/r1.png", "https://enki.gallery/i/r1", "An image");
    expect(shareImage).toHaveBeenCalledTimes(1);
    expect(copyText).not.toHaveBeenCalled();
  });

  it("a picture not stored yet has no link", () => {
    const tree = shareRows({ ...tileFacts(ITEM)!, url: "data:image/png;base64,AA" });
    expect(items(tree)).toHaveLength(0);
    expect(text(tree)).toBe("This image has no link yet.");
  });
});

describe("Add to Studio", () => {
  const shot = { key: "row:r1", kind: "history" as const, ratio: null };
  const pick = () => {
    ui.s = 0;
    return StudioPick({ shot, promptId: "p1" }) as ReactNode;
  };

  it("says Studio is not available yet before SQL 53, as the wizard does; then loading, then none yet", () => {
    ui.state = [];
    ui.projects = { data: undefined, notReady: true, error: null };
    expect(text(pick())).toBe(STUDIO_NOT_READY);
    expect(useStudioProjects).toHaveBeenCalledWith(true);
    ui.projects = { data: undefined, notReady: false, error: null };
    expect(text(pick())).toBe("Loading your projects…");
    ui.projects = { data: { projects: [] }, notReady: false, error: null };
    expect(text(pick())).toBe("No projects yet. Start one in Studio.");
    ui.projects = { data: undefined, notReady: false, error: "Could not read your projects." };
    expect(text(pick())).toBe("Could not read your projects.");
  });

  it("lists the projects; the one picked keeps the render with the viewer's own Keep, in that project's scope", () => {
    ui.state = [];
    ui.projects = { data: { projects: [{ id: "pa", name: "Mira" }, { id: "pb", name: "Harbour" }] }, notReady: false, error: null };
    const list = of(pick(), "button");
    expect(list.map((b) => text(b.props.children as ReactNode))).toEqual(["Mira", "Harbour"]);
    press(list[1]);
    const keep = [...walk(pick())][0];
    expect(keep.props).toEqual({ id: "pb", shot, promptId: "p1" });
    const Keep = keep.type as (p: unknown) => ReactNode;
    ui.project = { data: undefined, notReady: true, error: null };
    expect(text(Keep(keep.props))).toBe(STUDIO_NOT_READY);
    const detail = { project: { id: "pb", name: "Harbour" } };
    ui.project = { data: detail, notReady: false, error: null };
    ui.scope = null;
    const scope = of(Keep(keep.props), StudioScope)[0];
    expect(scope.props.value).toEqual({ project: detail, content: null, filed: new Set(), sheet: null });
    expect(of(scope.props.children as ReactNode, KeepInStudio)[0].props).toEqual({ shot, promptId: "p1", guest: false });
    // Create already works in that project: its content piece goes along.
    const filed = new Set(["r9"]);
    ui.scope = { project: { project: { id: "pb" } }, content: { id: "c1", name: "Ep 1" }, filed };
    expect(of(Keep(keep.props), StudioScope)[0].props.value).toMatchObject({ content: { id: "c1", name: "Ep 1" }, filed });
  });
});

describe("the popover", () => {
  const panel = () => {
    const rowEl = { focus: vi.fn() };
    return {
      offsetWidth: 220, scrollHeight: 180, style: {} as Record<string, string>, rowEl,
      contains: (t: unknown) => t === "inside", querySelector: vi.fn(() => rowEl),
    };
  };
  const mount = (onClose = vi.fn(), page = "main") => {
    const el = panel();
    const on: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900, addEventListener: (k: string, f: (e: unknown) => void) => { on[k] = f; }, removeEventListener: vi.fn() });
    vi.stubGlobal("document", { body: {} });
    ui.refs = [{ current: el }];
    ui.r = 0;
    ui.effects = true;
    const tree = TileMenu({ anchor: BOX, label: "This image", page, onClose, children: "rows" }) as El;
    return { el, on, tree, onClose };
  };

  it("stands under its button, right-aligned to it, inside the window, and its first row takes the focus", () => {
    const { el, tree } = mount();
    expect(el.style).toMatchObject({ left: `${928 - 220}px`, top: "132px", bottom: "" });
    expect(el.rowEl.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(tree.props).toMatchObject({ className: "kit-menu-panel kit-focus ci-menu", role: "dialog", "aria-label": "This image" });
  });

  it("closes on Esc, a press outside it or a scroll outside it, not on a press on its own button or inside it", () => {
    const { on, onClose } = mount();
    const stop = vi.fn();
    on.keydown({ key: "Escape", stopPropagation: stop });
    expect(stop).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    on.pointerdown({ target: "inside", clientX: 0, clientY: 0 });
    on.pointerdown({ target: "page", clientX: 910, clientY: 110 });
    expect(onClose).toHaveBeenCalledTimes(1);
    on.pointerdown({ target: "page", clientX: 10, clientY: 10 });
    expect(onClose).toHaveBeenCalledTimes(2);
    on.scroll({ target: "inside" });
    expect(onClose).toHaveBeenCalledTimes(2);
    on.scroll({ target: "page" });
    on.resize({});
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});

describe("the viewer", () => {
  it("offers Recreate, Reference and Animate; each closes the viewer first", () => {
    const a = acts();
    const onClose = vi.fn();
    const btns = ViewerActs({ item: ITEM, acts: a, onClose }) as El[];
    expect(btns.map((b) => [b.props.className, text(b.props.children as ReactNode)])).toEqual([
      ["iv-vact kit-hit", "Recreate"], ["iv-vact kit-hit", "Reference"], ["iv-vact kit-hit", "Animate"],
    ]);
    press(btns[0]);
    expect(a.recreate).toHaveBeenCalledWith(ITEM);
    press(btns[1]);
    expect(a.reference).toHaveBeenCalledWith(tileFacts(ITEM));
    press(btns[2]);
    expect(a.animate).toHaveBeenCalledWith(tileFacts(ITEM));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(a.recreate).mock.invocationCallOrder[0]);
  });
});

describe("the shared pieces it adds to", () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, "..", "..", ...p), "utf8").split("\r\n").join("\n");
  it("ViewerPanel shows a surface's own actions after its own, in its grid (its one hunk)", () => {
    const src = read("components", "image-view", "ViewerPanel.tsx");
    expect(src).toContain("export default function ViewerPanel({ model: m, shot, onAgain, phone = false, more }: {");
    expect(src).toContain("Share + prompt\n          </button>\n        )}\n        {more}\n      </div>");
  });

  it("keeps Reference's and Animate's icon whole while they are closed (an icon that shrinks leaves its name's first letters)", () => {
    const css = read("components", "enki", "feed.css");
    expect(css).toContain(".feed-create-image .ci-pair .ci-act > * { flex: none; }");
    expect(css).toContain(".feed-create-image .ci-pair .ci-act { justify-content: flex-start; width: auto; max-width: 28px; padding: 0 0 0 6.5px; overflow: hidden; }");
  });
});
