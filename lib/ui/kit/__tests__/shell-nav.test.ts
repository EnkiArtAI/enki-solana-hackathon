import { describe, expect, it } from "vitest";
import {
  INBOX_TABS, MENU_FOLD_Y, STUDIO_TABS, MENU_REARM_Y, PANEL_BACK, backState, foldScroller, foldStep, folded, linkedPanel, panelLink, panelOf, studioParent, tabOf,
  unfolded, type MenuPick, COMMUNITY_TABS, DIRECTORY_SORT_TABS, communityParent,
} from "../shell-nav";

/**
 * The shell menu's rules (Kev, 2026-10-30: "ok build aber die schmale leiste muss nur dann erst schmal werden, wenn ich
 * anfange zu scrollen oder zu generieren ... analytics unter inbox"; then "Hall of Fame must be listed not INSIDE studio,
 * but unter studio als eigener punkt vor inbox"). EnkiHome applies them (lib/__tests__/shell-menu.test.ts,
 * menu-autohide.test.ts).
 */
const P = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const box = (scrollTop: number, scrollHeight = 5000, clientHeight = 900) => ({ scrollTop, scrollHeight, clientHeight });

// Kev, 2026-10-30: "Analytics gehört doch eher zu Studio oder? ich würd das eher dort hin packen statt zur Inbox".
describe("Inbox's and Studio's tabs", () => {
  it("are Notifications | Messages, and Projects | Analytics", () => {
    expect(INBOX_TABS.map((t) => [t.key, t.label])).toEqual([["notifications", "Notifications"], ["messages", "Messages"]]);
    expect(STUDIO_TABS.map((t) => [t.key, t.label])).toEqual([["projects", "Projects"], ["analytics", "Analytics"]]);
  });

  it("open on the tab asked for when there is one, else on the first", () => {
    expect(tabOf(STUDIO_TABS, "analytics")).toBe("analytics");
    expect([tabOf(STUDIO_TABS, undefined), tabOf(INBOX_TABS, "analytics")]).toEqual(["projects", "notifications"]);
    expect(tabOf(INBOX_TABS, "messages")).toBe("messages");
    expect([tabOf(INBOX_TABS, undefined), tabOf(INBOX_TABS, null), tabOf(INBOX_TABS, "nope")]).toEqual(["notifications", "notifications", "notifications"]);
  });
});

describe("the panel an address opens", () => {
  it("is ?settings=, ?inbox= or ?studio= with its tab, the first the address names", () => {
    expect(linkedPanel(new URLSearchParams("settings=recovery"))).toEqual({ id: "settings", tab: "recovery" });
    expect(linkedPanel(new URLSearchParams("q=cats&inbox=messages"))).toEqual({ id: "inbox", tab: "messages" });
    expect(linkedPanel(new URLSearchParams("studio=fame"))).toEqual({ id: "studio", tab: "fame" });
    expect(linkedPanel(new URLSearchParams("studio=fame&settings=profile"))).toEqual({ id: "settings", tab: "profile" });
  });

  it("is none without one, or with an empty one", () => {
    expect(linkedPanel(new URLSearchParams(""))).toBeNull();
    expect(linkedPanel(new URLSearchParams("inbox=&creator=ann&prompt=p1"))).toBeNull();
  });
});

describe("the panel in the address (Back is the browser's)", () => {
  const of = (q: string) => panelOf(new URLSearchParams(q));
  it("is ?panel= on its ?tab=, a creator's page ?creator=, or a linked form; none for an unknown panel", () => {
    expect(of("panel=settings")).toEqual({ id: "settings", tab: undefined });
    expect(of("q=cats&panel=inbox&tab=messages")).toEqual({ id: "inbox", tab: "messages" });
    for (const id of ["billing", "profile", "studio"]) expect(of(`panel=${id}`)).toEqual({ id, tab: undefined });
    expect(of("creator=ann&panel=settings")).toEqual({ id: "creator", handle: "ann" });
    expect(of("settings=recovery")).toEqual({ id: "settings", tab: "recovery" });
    expect(of("panel=settings&inbox=messages")).toEqual({ id: "settings", tab: undefined });
    expect([of(""), of("panel=nope"), of("panel=creator"), of("q=cats&prompt=p1")]).toEqual([null, null, null, null]);
  });

  it("is the Hall of Fame on its own, and its links from its time as Studio's tab open it; any other ?studio= is Studio", () => {
    expect(of("panel=fame")).toEqual({ id: "fame" });
    expect(of("studio=fame")).toEqual({ id: "fame" });
    expect(of("panel=studio&tab=fame")).toEqual({ id: "fame" });
    expect(of("studio=projects")).toEqual({ id: "studio", tab: "projects" });
    expect(of("panel=studio&tab=projects")).toEqual({ id: "studio", tab: "projects" });
    // The linked forms keep their order: Settings' wins over Studio's.
    expect(of("studio=fame&settings=profile")).toEqual({ id: "settings", tab: "profile" });
  });

  it("opens Studio on Analytics, from its own links and from Analytics' links of its time in Inbox; a project's page has no tab", () => {
    expect(of("panel=studio&tab=analytics")).toEqual({ id: "studio", tab: "analytics" });
    expect(of("studio=analytics")).toEqual({ id: "studio", tab: "analytics" });
    expect(of("q=cats&inbox=analytics")).toEqual({ id: "studio", tab: "analytics" });
    expect(of("panel=inbox&tab=analytics")).toEqual({ id: "studio", tab: "analytics" });
    expect(of(`panel=studio&project=${P}&tab=analytics`)).toEqual({ id: "studio", project: P });
    // Inbox's own tabs stay Inbox's.
    expect([of("inbox=messages"), of("panel=inbox&tab=notifications")]).toEqual([{ id: "inbox", tab: "messages" }, { id: "inbox", tab: "notifications" }]);
  });

  it("is Studio at the project and content piece it names, each only as an id", () => {
    expect(of(`panel=studio&project=${P}`)).toEqual({ id: "studio", project: P });
    expect(of(`panel=studio&project=${P}&content=${C}`)).toEqual({ id: "studio", project: P, content: C });
    expect(of(`panel=studio&project=nope&content=${C}`)).toEqual({ id: "studio" });
    expect(of(`panel=studio&project=${P}&content=../x`)).toEqual({ id: "studio", project: P });
    // A content piece without its project is the overview.
    expect(of(`panel=studio&content=${C}`)).toEqual({ id: "studio" });
    // Another panel's address takes no Studio place.
    expect(of(`panel=settings&project=${P}`)).toEqual({ id: "settings", tab: undefined });
  });

  it("goes up one level from a Studio page: a piece to its project, a project to the overview; nowhere from the rest", () => {
    expect(studioParent({ id: "studio", project: P, content: C })).toEqual({ id: "studio", project: P });
    expect(studioParent({ id: "studio", project: P })).toEqual({ id: "studio" });
    expect([studioParent({ id: "studio" }), studioParent({ id: "fame" }), studioParent({ id: "settings", tab: "x" }), studioParent(null)]).toEqual([null, null, null, null]);
  });

  it("is written over the last one, every other part of the address kept; none leaves only the rest", () => {
    const at = "http://enki.test/home?q=cats&creator=ann&prompt=p1#x";
    expect(panelLink(at, { id: "studio", tab: "analytics" })).toBe("/home?q=cats&prompt=p1&panel=studio&tab=analytics#x");
    expect(panelLink("http://enki.test/home?panel=studio&tab=analytics", { id: "settings" })).toBe("/home?panel=settings");
    expect(panelLink("http://enki.test/home?panel=inbox", { id: "creator", handle: "bo" })).toBe("/home?creator=bo");
    expect(panelLink("http://enki.test/editor?id=7&settings=recovery&studio=fame&inbox=messages&tab=x", null)).toBe("/editor?id=7");
    expect(panelLink("http://enki.test/home?create=image&panel=settings", null)).toBe("/home?create=image");
  });

  it("writes a Studio place; any panel written drops the last one's place and Create's project, piece and sheet", () => {
    expect(panelLink("http://enki.test/home?q=cats", { id: "studio", project: P, content: C })).toBe(`/home?q=cats&panel=studio&project=${P}&content=${C}`);
    expect(panelLink(`http://enki.test/home?panel=studio&project=${P}&content=${C}`, { id: "studio", project: P })).toBe(`/home?panel=studio&project=${P}`);
    expect(panelLink(`http://enki.test/home?create=image&project=${P}&content=${C}&sheet=${C}`, { id: "inbox" })).toBe("/home?create=image&panel=inbox");
    expect(panelLink(`http://enki.test/home?panel=studio&project=${P}`, null)).toBe("/home");
    expect(panelLink("http://enki.test/home?studio=fame", { id: "fame" })).toBe("/home?panel=fame");
  });

  // Kev, 2026-10-30: "wo sehe ich denn die communities, in welcher menüleiste".
  it("is Communities' directory on its sort, or one community's page by its handle, only in a handle's shape", () => {
    expect(of("panel=communities")).toEqual({ id: "communities" });
    expect(of("panel=communities&tab=az")).toEqual({ id: "communities", tab: "az" });
    expect(of("panel=communities&c=gundam&tab=works")).toEqual({ id: "communities", tab: "works", community: "gundam" });
    // Lower-cased; anything not a handle is the directory.
    expect(of("panel=communities&c=Gundam_Wing")).toEqual({ id: "communities", community: "gundam_wing" });
    for (const bad of ["../x", "_a", "a__b", "a b", "a_"]) expect(of(`panel=communities&c=${encodeURIComponent(bad)}`)).toEqual({ id: "communities" });
    // Another panel takes no community.
    expect(of("panel=settings&c=gundam")).toEqual({ id: "settings", tab: undefined });
  });

  it("goes up from a community's page to the directory, and nowhere from the directory or another panel", () => {
    expect(communityParent({ id: "communities", community: "gundam", tab: "works" })).toEqual({ id: "communities" });
    expect([communityParent({ id: "communities" }), communityParent({ id: "studio", project: P }), communityParent(null)]).toEqual([null, null, null]);
  });

  it("writes a community's page; any panel written drops it", () => {
    expect(panelLink("http://enki.test/home?q=cats&community=apu", { id: "communities", community: "gundam", tab: "works" }))
      .toBe("/home?q=cats&community=apu&panel=communities&tab=works&c=gundam");
    expect(panelLink("http://enki.test/home?panel=communities&c=gundam&tab=works", { id: "inbox" })).toBe("/home?panel=inbox");
    expect(panelLink("http://enki.test/home?panel=communities&c=gundam", null)).toBe("/home");
  });

  it("has a community's tabs Showroom | Works | Prompts | Members, and the directory's sorts Trending | New | A–Z", () => {
    expect(COMMUNITY_TABS.map((t) => [t.key, t.label])).toEqual([["showroom", "Showroom"], ["works", "Works"], ["prompts", "Prompts"], ["members", "Members"]]);
    expect(DIRECTORY_SORT_TABS.map((t) => [t.key, t.label])).toEqual([["trending", "Trending"], ["new", "New"], ["az", "A–Z"]]);
    expect([tabOf(COMMUNITY_TABS, undefined), tabOf(DIRECTORY_SORT_TABS, "nope")]).toEqual(["showroom", "trending"]);
  });

  it("leaves Create too for a panel's link opened fresh: its Back lands on Explore", () => {
    expect(panelLink("http://enki.test/home?create=image&panel=settings&q=cats", null, true)).toBe("/home?q=cats");
  });

  it("keeps the shell's mark through another writer: a replace keeps its steps back, a push over it is one more", () => {
    const next = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: [] };
    expect(backState(false, { ...next, [PANEL_BACK]: 2 })).toEqual({ [PANEL_BACK]: 2 });
    expect(backState(true, { ...next, [PANEL_BACK]: 2 })).toEqual({ [PANEL_BACK]: 3 });
    // An entry marked before the steps were counted is one step back.
    expect(backState(true, { [PANEL_BACK]: true })).toEqual({ [PANEL_BACK]: 2 });
    // No mark (a link opened fresh, the feed): none, as before; Next copies its own keys in either way.
    expect([backState(true, next), backState(false, next), backState(true, null), backState(false, undefined)]).toEqual([null, null, null, null]);
  });
});

describe("the menu's fold", () => {
  const own: MenuPick = { nav: "full" };
  it("folds the full menu to the shell's own rail, never over a toggle of this visit (the user's wins)", () => {
    expect(folded(null, "full")).toEqual({ nav: "icons", auto: true });
    expect(folded(own, "full")).toBe(own);
    const ownIcons: MenuPick = { nav: "icons" };
    expect(folded(ownIcons, "icons")).toBe(ownIcons);
    // Already narrower (the window, a stored pick): nothing to fold.
    expect(folded(null, "icons")).toBeNull();
    expect(folded(null, "closed")).toBeNull();
    const auto: MenuPick = { nav: "icons", auto: true };
    expect(folded(auto, "icons")).toBe(auto);
  });

  it("opens only a fold it made itself, back to what was there; a toggle stays", () => {
    expect(unfolded({ nav: "icons", auto: true })).toBeNull();
    expect(unfolded(own)).toBe(own);
    expect(unfolded(null)).toBeNull();
  });
});

describe("what a scroll counts on", () => {
  const page = box(0);
  const inside = box(0, 1200, 400);
  const sideways = box(0, 400, 400);
  const elsewhere = box(0, 3000, 800);
  const area = { contains: (n: object) => n === inside || n === sideways };

  it("is the page, for the window's own scroll", () => {
    expect(foldScroller(null, page, area)).toBe(page);
    expect(foldScroller(page, page, area)).toBe(page);
    expect(foldScroller(null, page, null)).toBe(page);
  });

  it("is a scroller inside the endless area that runs up and down (Create's composer)", () => {
    expect(foldScroller(inside, page, area)).toBe(inside);
  });

  it("is nothing for one outside it (an open image, a panel), one that only slides sideways, or any without an area", () => {
    expect(foldScroller(elsewhere, page, area)).toBeNull();
    expect(foldScroller(sideways, page, area)).toBeNull();
    expect(foldScroller(inside, page, null)).toBeNull();
  });

  it("is nothing for a field's own scroll: a long prompt's textarea following the caret, its mirror, an editable run", () => {
    // Inside the area and running up and down (measured: 1395 tall, 298 shown, at 1082 after 60 typed lines).
    const field = (match: string) => ({ ...box(1082, 1395, 298), closest: (s: string) => (s.split(", ").includes(match) ? {} : null) });
    const fields = ["textarea", "input", "[contenteditable]", ".kit-pm-mirror"].map(field);
    const column = { ...box(0, 1200, 400), closest: () => null };
    const inArea = { contains: (n: object) => fields.includes(n as never) || n === column };
    expect(fields.map((f) => foldScroller(f, page, inArea))).toEqual([null, null, null, null]);
    // The column holding the field still counts.
    expect(foldScroller(column, page, inArea)).toBe(column);
  });
});

describe("one scroll", () => {
  it("folds about six wheel steps down, going down, on an endless area, once", () => {
    expect(MENU_FOLD_Y).toBe(600);
    expect(foldStep(box(MENU_FOLD_Y - 1), 500, true, true)).toEqual({ fold: false, open: false, armed: true });
    expect(foldStep(box(MENU_FOLD_Y), 500, true, true)).toEqual({ fold: true, open: false, armed: false });
    // Fired: not again until back near the top.
    expect(foldStep(box(900), 600, false, true)).toEqual({ fold: false, open: false, armed: false });
  });

  it("never folds going up, off an endless area, or once fired", () => {
    expect(foldStep(box(700), 800, true, true).fold).toBe(false);
    expect(foldStep(box(700), 700, true, true).fold).toBe(false);
    expect(foldStep(box(700), 600, true, false)).toEqual({ fold: false, open: false, armed: true });
    expect(foldStep(box(700), 600, false, true).fold).toBe(false);
  });

  it("folds at a scroller's end when it ends before the six steps (a composer's column)", () => {
    // 630 tall, 476 shown: it ends at 154.
    expect(foldStep(box(100, 630, 476), 0, true, true).fold).toBe(false);
    expect(foldStep(box(153, 630, 476), 100, true, true).fold).toBe(true);
    expect(foldStep(box(154, 630, 476), 100, true, true).fold).toBe(true);
  });

  it("re-arms near the top and opens at the very top", () => {
    expect(MENU_REARM_Y).toBe(40);
    expect(foldStep(box(MENU_REARM_Y - 1), 300, false, true)).toEqual({ fold: false, open: false, armed: true });
    expect(foldStep(box(MENU_REARM_Y), 300, false, true)).toEqual({ fold: false, open: false, armed: false });
    expect(foldStep(box(0), 300, false, true)).toEqual({ fold: false, open: true, armed: true });
    expect(foldStep(box(0), 0, true, false).open).toBe(true);
  });
});
