import { UUID_RE } from "@/lib/dm";
import { handleParam } from "@/lib/ui/communities/links";
import type { NavState } from "./breakpoints";
import type { Scroller } from "./tuck";

/**
 * The shell menu's rules (Kev, 2026-10-30, on an icon rail with Explore, Create, Studio and Inbox: "ok build aber die
 * schmale leiste muss nur dann erst schmal werden, wenn ich anfange zu scrollen oder zu generieren ... Studio =
 * projektordner ok, da werden dann generierungen später auftauchen. analytics und hall of fame brauche ich auch ...
 * analytics unter inbox"). Then the Hall of Fame left Studio for an item of its own (Kev, 2026-10-30: "Hall of Fame must
 * be listed not INSIDE studio, but unter studio als eigener punkt vor inbox"): Studio holds the projects alone.
 */

/** Studio's tabs on its overview: the projects, then how your prompts do (Kev, 2026-10-30: "Analytics gehört doch eher
 *  zu Studio oder? ich würd das eher dort hin packen statt zur Inbox"). A project's and a content piece's page have none. */
export const STUDIO_TABS = [{ key: "projects", label: "Projects" }, { key: "analytics", label: "Analytics" }] as const;
/** Inbox's tabs: what reached you. Analytics moved to Studio (above); its old links open it there (panelOf). */
export const INBOX_TABS = [
  { key: "notifications", label: "Notifications" },
  { key: "messages", label: "Messages" },
] as const;

/** A community's page's tabs (the agreed shape, 2026-10-30: "Showroom | Works | Prompts | Members"), Showroom first. */
export const COMMUNITY_TABS = [
  { key: "showroom", label: "Showroom" }, { key: "works", label: "Works" }, { key: "prompts", label: "Prompts" }, { key: "members", label: "Members" },
] as const;
/** The directory's order, in its panel's ?tab= so Back brings it back: the works of the last 7 days, the newest, A to Z. */
export const DIRECTORY_SORT_TABS = [{ key: "trending", label: "Trending" }, { key: "new", label: "New" }, { key: "az", label: "A–Z" }] as const;

/** The tab `asked` for when `tabs` has it, else the first. */
export function tabOf<K extends string>(tabs: ReadonlyArray<{ key: K }>, asked: string | null | undefined): K {
  return tabs.find((t) => t.key === asked)?.key ?? tabs[0].key;
}

const LINKED = ["settings", "inbox", "studio"] as const;
/** The panel an address opens on arrival, on its tab: ?settings=recovery (a login's way back, DEC-501), ?inbox=messages,
 *  ?studio=fame (the Hall of Fame's link from when it was Studio's tab; panelOf opens it). The first of them the address
 *  names. */
export function linkedPanel(search: { get(name: string): string | null }): { id: (typeof LINKED)[number]; tab: string } | null {
  for (const id of LINKED) {
    const tab = search.get(id);
    if (tab) return { id, tab };
  }
  return null;
}

/**
 * The open panel is in the address, so Back walks the browser's history, one stack for the panel's own Back, the
 * browser's and the phone's back gesture (Kev, 2026-10-30: "wenn ich von profile auf settings auf back clicke komme ich
 * in ein leeres image ui ... ich sollte immer auf die letzte seite kommen"; before, a panel was the shell's state alone
 * and its Back showed whatever lay under it). ?panel=<id>, on ?tab=<tab>; a creator's page is ?creator=<handle> (the old
 * /creators/[id] links land there); the linked forms above open their panel too. A Studio page is its place in Studio:
 * ?panel=studio&project=<id>&content=<id>, the overview without them.
 */
export type PanelAt = { id: string; tab?: string; handle?: string; project?: string; content?: string; community?: string };
const PANELS = ["billing", "settings", "profile", "studio", "fame", "inbox", "communities"];
/* A panel written drops them all: a Studio place, a community's page, and the project, content piece and character sheet
   Create works in (lib/ui/studio/links). Back brings them back from the history. */
const PANEL_PARAMS = ["panel", "tab", "creator", "project", "content", "sheet", "c", ...LINKED];

/** An address's id param, or null when it is none (Studio's places here, Create's in lib/ui/studio/links). */
export const uuidParam = (v: string | null) => (v && UUID_RE.test(v) ? v : null);
/** Studio at the project and content piece the address names, each only as an id (anything else is the level above). */
function studioAt(search: { get(name: string): string | null }): PanelAt {
  const project = uuidParam(search.get("project"));
  const content = project && uuidParam(search.get("content"));
  return { id: "studio", ...(project && { project }), ...(content && { content }) };
}

/** The panel an address shows, or none. The Hall of Fame's links from its time as Studio's tab (?studio=fame,
 *  ?panel=studio&tab=fame) open it, Analytics' from its time in Inbox (?inbox=analytics, ?panel=inbox&tab=analytics)
 *  open Studio on it; Studio's overview keeps its tab, a project's page has none. */
export function panelOf(search: { get(name: string): string | null }): PanelAt | null {
  const handle = search.get("creator");
  if (handle) return { id: "creator", handle };
  const id = search.get("panel");
  const tab = search.get("tab") ?? undefined;
  if (id === "studio") {
    if (tab === "fame") return { id: "fame" };
    const at = studioAt(search);
    return at.project || !tab ? at : { ...at, tab };
  }
  if (id === "inbox" && tab === "analytics") return { id: "studio", tab };
  // Communities: the directory, or one community's page by its handle (?c=, only in a handle's shape).
  if (id === "communities") {
    const community = handleParam(search.get("c"));
    return { id, ...(tab && { tab }), ...(community && { community }) };
  }
  if (id && PANELS.includes(id)) return { id, tab };
  const linked = linkedPanel(search);
  if (linked?.id === "studio") return linked.tab === "fame" ? { id: "fame" } : { id: "studio", tab: linked.tab };
  if (linked?.id === "inbox" && linked.tab === "analytics") return { id: "studio", tab: "analytics" };
  return linked;
}

/** One level up from a Studio page: a content piece's project, a project's overview; null on the overview and on any
 *  other panel. Back from a Studio page opened fresh goes there, one level at a time (DEC-543's rule). */
export function studioParent(at: PanelAt | null): PanelAt | null {
  if (at?.id !== "studio" || !at.project) return null;
  return at.content ? { id: "studio", project: at.project } : { id: "studio" };
}

/** One level up from a community's page: the directory; null on the directory and on any other panel. Back from a
 *  community's page opened fresh (/c/<handle>, a shared link) goes there first, then to Explore (DEC-543's rule). */
export function communityParent(at: PanelAt | null): PanelAt | null {
  return at?.id === "communities" && at.community ? { id: "communities" } : null;
}

/** `href` showing `at`, or no panel; every other part of the address stays. `explore` also leaves Create: a panel's
 *  link opened fresh has no page of its own behind it, and its Back lands on Explore, never on an empty view. */
export function panelLink(href: string, at: PanelAt | null, explore = false): string {
  const url = new URL(href);
  for (const key of explore ? [...PANEL_PARAMS, "create"] : PANEL_PARAMS) url.searchParams.delete(key);
  if (at?.handle) url.searchParams.set("creator", at.handle);
  else if (at) {
    url.searchParams.set("panel", at.id);
    if (at.tab) url.searchParams.set("tab", at.tab);
    if (at.project) url.searchParams.set("project", at.project);
    if (at.content) url.searchParams.set("content", at.content);
    if (at.community) url.searchParams.set("c", at.community);
  }
  return url.pathname + url.search + url.hash;
}

/** Marks a history entry the shell opened a panel on with the steps back to the page before it: its Back is the
 *  browser's. An entry without it (a link opened fresh, a reload of one) has no page of the shell's behind it. */
export const PANEL_BACK = "ekPanelBack";

/**
 * The state another history write over a shell entry carries (an image's ?prompt= opened and closed on a profile,
 * EnkiDetailPanel), so the mark outlives it: a replace keeps it, a push over it is one step more back, which the panel's
 * Back takes in one go (review 2026-10-30: after an image on a profile, its Back closed in place, on Explore, and the
 * page under it, Create, was gone). Never Next's own keys: its patched history copies them in, and hears the new address
 * only for state without them. Null over an unmarked entry, as before.
 */
export function backState(push: boolean, state: unknown): { [PANEL_BACK]: number } | null {
  const steps = Number((state as Record<string, unknown> | null)?.[PANEL_BACK]) || 0;
  return steps ? { [PANEL_BACK]: steps + (push ? 1 : 0) } : null;
}

/** Raised when the image composer starts a job, in Create or over the feed (useImageViewModel): the menu folds as on a
 *  scroll. Remix's Generate starts none yet. */
export const GENERATION_START_EVENT = "enki:generation-start";

/** About six wheel steps down (Kev, 2026-10-15; two were too soon, 10-16). */
export const MENU_FOLD_Y = 600;
/** Back near the top, the next scroll down may fold it again. */
export const MENU_REARM_Y = 40;

/** This visit's menu pick: the user's own toggle, or a fold the shell made (auto). None: the stored pick shows. */
export type MenuPick = { nav: NavState; auto?: true } | null;

/** The pick after a fold (a scroll down an endless area, a generation's start): the rail, marked as the shell's, while
 *  the full menu shows and no toggle of this visit holds. The user's own toggle wins. Never stored. */
export function folded(pick: MenuPick, nav: NavState): MenuPick {
  return nav === "full" && pick === null ? { nav: "icons", auto: true } : pick;
}

/** The pick after an unfold (the very top, Explore or Create opening): the shell's own fold goes, a toggle stays. */
export function unfolded(pick: MenuPick): MenuPick {
  return pick?.auto ? null : pick;
}

/** A field's own scroll: a prompt's textarea following the caret as it fills, the mirror kept in step with it, the image
 *  view's editable runs. That is typing, not the reader scrolling (review 2026-10-30: a long prompt typed into Create's
 *  composer folded the menu). */
export const FIELD_SCROLLERS = "textarea, input, [contenteditable], .kit-pm-mirror";

/**
 * What a scroll counts on: the page, or a scroller running up and down inside the endless area (Create's composer and
 * Remix's column scroll in their own boxes). Never one outside it (an open image, a panel), one that only slides
 * sideways (the categories) or a field (FIELD_SCROLLERS). Null: the scroll does not count.
 */
export function foldScroller<T extends Scroller & { closest?(selectors: string): unknown }>(
  target: T | null, page: T, area: { contains(n: T): boolean } | null,
): T | null {
  if (target === null || target === page) return page;
  return area?.contains(target) && !target.closest?.(FIELD_SCROLLERS) && target.scrollHeight > target.clientHeight ? target : null;
}

/**
 * One scroll of `s`, down from `last` or not: it folds once, on an endless area, about six wheel steps down, or at its
 * end when it ends sooner (a composer's column), and re-arms only back near the top, where at the very top it opens.
 */
export function foldStep(s: Scroller, last: number, armed: boolean, endless: boolean): { fold: boolean; open: boolean; armed: boolean } {
  const y = s.scrollTop;
  if (y < MENU_REARM_Y) return { fold: false, open: y <= 0, armed: true };
  const fold = endless && armed && y > last && y >= Math.min(MENU_FOLD_Y, s.scrollHeight - s.clientHeight - 1);
  return { fold, open: false, armed: armed && !fold };
}
