import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * The shell's menu (Kev, 2026-10-30, on an icon rail with Explore, Create, Studio and Inbox: "ok build aber die schmale
 * leiste muss nur dann erst schmal werden, wenn ich anfange zu scrollen oder zu generieren. explore und create links ist
 * super. Studio = projektordner ok, da werden dann generierungen später auftauchen. analytics und hall of fame brauche
 * ich auch. hall of fame pls unter studio. analytics unter inbox. keep that refer prompt and feedback ofc. Create Prompt
 * must be there as a standalone button on the left page as on the left side menu."). Then the Hall of Fame became its own
 * item (Kev, 2026-10-30: "Hall of Fame must be listed not INSIDE studio, but unter studio als eigener punkt vor inbox")
 * and Studio holds the projects alone. The shell is called as React would render it: its state kept between calls, its
 * effects run once on mount, an effect event always the latest.
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, effects: [] as (() => unknown)[], events: [] as unknown[], stable: [] as unknown[], e: 0,
  params: new URLSearchParams(), push: vi.fn(), phone: false, role: "user", unseen: 0, unread: 0, toast: vi.fn(),
  projects: [] as Array<{ id: string; name: string }> | undefined, notReady: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T | (() => T)) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = typeof start === "function" ? (start as () => T)() : start;
    return [ui.state[i], (next: unknown) => { ui.state[i] = typeof next === "function" ? (next as (p: unknown) => unknown)(ui.state[i]) : next; }];
  },
  useEffect: (fn: () => unknown) => { ui.effects.push(fn); },
  useLayoutEffect: () => {},
  useEffectEvent: (fn: (...a: unknown[]) => unknown) => {
    const i = ui.e++;
    ui.events[i] = fn;
    return (ui.stable[i] ??= (...a: unknown[]) => (ui.events[i] as (...b: unknown[]) => unknown)(...a));
  },
  useSyncExternalStore: (_subscribe: unknown, _read: unknown, server: () => unknown) => server(),
  useRef: <T>(current: T) => ({ current }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: ui.push }), useSearchParams: () => ui.params }));
vi.mock("thirdweb/react", () => ({ useActiveAccount: () => null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ connected: false, disconnect: vi.fn() }) }));
vi.mock("@/providers/ThemeProvider", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
vi.mock("@/hooks/useHoldings", () => ({ useHoldings: () => ({ ready: false, balance: 0 }) }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => ui.phone }));
vi.mock("@/hooks/useViewerWallets", () => ({ useViewerWallets: () => ({ payer: null }) }));
vi.mock("@/hooks/useEmailAuth", () => ({ useEmailAuth: () => ({ isAuthed: false }) }));
vi.mock("@/hooks/useCdpAddress", () => ({ useCdpAddress: () => ({ address: null }) }));
vi.mock("@/hooks/useSolanaAuth", () => ({ useSolanaAuth: () => ({ isAuthenticated: false }) }));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({ access: "ok", role: ui.role, handle: "kev" }) }));
vi.mock("@/hooks/useRecoveryStatus", () => ({ useRecoveryStatus: () => null }));
vi.mock("@/hooks/useSecondFactor", () => ({ useNeeds2fa: () => false }));
vi.mock("@/hooks/useNotifications", () => ({ useNotifications: () => ({ unseen: ui.unseen }) }));
vi.mock("@/hooks/useMessages", () => ({ useMessages: () => ({ unreadTotal: ui.unread }) }));
vi.mock("@/components/kit/notify", () => ({ notify: ui.toast }));
vi.mock("@/components/enki-shell/UsernameOnboard", () => ({ default: function UsernameOnboard() { return null; } }));
vi.mock("@/components/enki-shell/AnalyticsPanel", () => ({ default: function AnalyticsPanel() { return null; } }));
vi.mock("@/components/enki-shell/NotificationsPanel", () => ({ default: function NotificationsPanel() { return null; } }));
vi.mock("@/components/enki-shell/MessagesPanel", () => ({ default: function MessagesPanel() { return null; } }));
vi.mock("@/components/enki/EnkiFeedPage", () => ({ default: function EnkiFeedPage() { return null; } }));
vi.mock("@/components/enki/CreateView", () => ({ default: function CreateView() { return null; } }));
vi.mock("@/components/enki-shell/EnkiSidebar", () => ({ default: function EnkiSidebar() { return null; } }));
vi.mock("@/components/enki-shell/FeedbackModal", () => ({ default: function FeedbackModal() { return null; } }));
vi.mock("@/components/enki-shell/ReferModal", () => ({ default: function ReferModal() { return null; } }));
vi.mock("@/components/enki-shell/EnkiPanel", () => ({ default: function EnkiPanel() { return null; } }));
vi.mock("@/components/LoginModal", () => ({ default: function LoginModal() { return null; } }));
vi.mock("@/components/settings/SettingsView", () => ({ default: function SettingsView() { return null; } }));
vi.mock("@/components/profile/ProfileView", () => ({ default: function ProfileView() { return null; } }));
vi.mock("../../app/leaderboard/page", () => ({ default: function LeaderboardPage() { return null; } }));
// Studio's projects as the server lists them (GET /api/studio/projects), its pages and its wizard as markers.
// Undefined projects: the read has not answered (or failed); notReady: 503, SQL 53 not run.
vi.mock("@/hooks/useStudio", () => ({ useStudioProjects: () => ({ data: ui.projects && { projects: ui.projects }, notReady: ui.notReady, error: null }) }));
vi.mock("@/components/studio/StudioPanel", () => ({ default: function StudioPanel() { return null; } }));
vi.mock("@/components/studio/ProjectWizard", () => ({ default: function ProjectWizard() { return null; } }));
// Communities' panel as a marker: its pages are lib/__tests__/communities-ui.test.ts's.
vi.mock("@/components/communities/CommunitiesPanel", () => ({ default: function CommunitiesPanel() { return null; } }));
// The image's view itself: EnkiDetailPanel runs as it is, its history writes with it.
vi.mock("next/dynamic", () => ({ default: () => function ImageView() { return null; } }));

import EnkiHome from "@/components/enki-shell/EnkiHome";
import EnkiSidebar from "@/components/enki-shell/EnkiSidebar";
import EnkiPanel from "@/components/enki-shell/EnkiPanel";
import PanelTabs from "@/components/enki-shell/PanelTabs";
import PanelHead from "@/components/enki-shell/PanelHead";
import EnkiFeedPage from "@/components/enki/EnkiFeedPage";
import CreateView from "@/components/enki/CreateView";
import SettingsView from "@/components/settings/SettingsView";
import ProfileView from "@/components/profile/ProfileView";
import AnalyticsPanel from "@/components/enki-shell/AnalyticsPanel";
import NotificationsPanel from "@/components/enki-shell/NotificationsPanel";
import MessagesPanel from "@/components/enki-shell/MessagesPanel";
import FeedbackModal from "@/components/enki-shell/FeedbackModal";
import ReferModal from "@/components/enki-shell/ReferModal";
import LeaderboardPage from "../../app/leaderboard/page";
import EnkiDetailPanel from "@/components/enki/EnkiDetailPanel";
import Segmented from "@/components/kit/Segmented";
import { readSource } from "./_read-source";
import { join } from "node:path";
import StudioPanel from "@/components/studio/StudioPanel";
import ProjectWizard from "@/components/studio/ProjectWizard";
import CommunitiesPanel from "@/components/communities/CommunitiesPanel";
import { OPEN_COMMUNITY_EVENT } from "@/lib/ui/communities/links";
import type { StudioMenu } from "@/components/enki-shell/EnkiSidebar";
import { GENERATION_START_EVENT, INBOX_TABS, STUDIO_TABS } from "@/lib/ui/kit/shell-nav";
import { OPEN_KEY } from "@/lib/ui/studio/recent";
import { MAX_PROJECTS } from "@/lib/studio/types";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const of = (tree: ReactNode, type: unknown) => [...walk(tree)].filter((el) => el.type === type);
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("") : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);

/* The browser around the shell: what it listens to, a page and an endless area that scroll. */
class Node0 { scrollTop = 0; scrollHeight = 0; clientHeight = 0; constructor(o: Partial<Node0> = {}) { Object.assign(this, o); } }
const web = {
  win: {} as Record<string, ((e: unknown) => void)[]>, doc: {} as Record<string, ((e: unknown) => void)[]>, sent: [] as string[],
  page: new Node0(), column: new Node0(), area: true as boolean, replace: vi.fn(),
};
const listen = (into: Record<string, ((e: unknown) => void)[]>) => (type: string, fn: (e: unknown) => void) => { (into[type] ??= []).push(fn); };
/* The browser's history as Next keeps it: an entry per page, the search params following the address (Next's patched
   pushState and replaceState, its popstate on Back). The router's push is a page of its own, without the shell's mark. */
const hist = { entries: [] as Array<{ state: unknown; url: string }>, at: 0 };
const location0 = { search: "", pathname: "/home", hash: "", get href() { return `http://enki.test${this.pathname}${this.search}${this.hash}`; } };
const arrive = (url: string) => {
  const u = new URL(url, location0.href);
  location0.pathname = u.pathname; location0.search = u.search;
  ui.params = new URLSearchParams(u.search);
};
const history0 = {
  get state() { return hist.entries[hist.at].state; },
  pushState: (state: unknown, _: string, url: string) => { hist.entries.splice(hist.at + 1, Infinity, { state, url }); hist.at++; arrive(url); },
  replaceState: (state: unknown, t: string, url: string) => { web.replace(state, t, url); hist.entries[hist.at] = { state, url }; arrive(url); },
  // The browser's Back, the phone's back gesture: the entry before, its address read again.
  back: () => { if (hist.at > 0) arrive(hist.entries[--hist.at].url); },
  go: (by: number) => { if (hist.at + by >= 0) { hist.at += by; arrive(hist.entries[hist.at].url); } },
};
function browser(search = "") {
  web.win = {}; web.doc = {}; web.sent = []; web.replace = vi.fn();
  web.page = new Node0({ scrollHeight: 5000, clientHeight: 900 });
  web.column = new Node0({ scrollHeight: 630, clientHeight: 476 });
  web.area = true;
  location0.pathname = "/home"; location0.search = search ? `?${search}` : "";
  hist.entries = [{ state: null, url: `/home${location0.search}` }]; hist.at = 0;
  ui.push.mockImplementation((url: string) => history0.pushState({ __NA: true }, "", url));
  vi.stubGlobal("Element", Node0);
  vi.stubGlobal("window", {
    addEventListener: listen(web.win), removeEventListener: () => {},
    dispatchEvent: (e: Event) => { web.sent.push(e.type); return true; },
    location: location0,
    history: history0, scrollTo: vi.fn(), scrollY: 0, innerWidth: 1440, innerHeight: 900,
  });
  vi.stubGlobal("document", {
    addEventListener: listen(web.doc), removeEventListener: () => {},
    querySelector: (sel: string) => (sel === ".ek-main [data-menu-autohide]" && web.area ? { contains: (n: unknown) => n === web.column } : null),
    scrollingElement: web.page, documentElement: { classList: { add: () => {}, remove: () => {} } }, body: { style: {} },
  });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("CustomEvent", class extends Event { detail: unknown; constructor(t: string, o?: { detail?: unknown }) { super(t); this.detail = o?.detail; } });
}
const render = () => { ui.s = 0; ui.e = 0; const tree = EnkiHome({}) as ReactNode; ui.effects = []; return tree; };
/** A first render on `search`, its effects run (the shell mounted). */
function mount(search = "") {
  ui.state = []; ui.events = []; ui.stable = []; ui.params = new URLSearchParams(search);
  browser(search);
  ui.s = 0; ui.e = 0;
  const tree = EnkiHome({}) as ReactNode;
  for (const fn of ui.effects.splice(0)) fn();
  return tree;
}
const sidebar = (tree = render()) => of(tree, EnkiSidebar)[0].props;
const panel = (tree = render()) => of(tree, EnkiPanel)[0]?.props;
const content = (tree = render()) => of(tree, EnkiPanel)[0]?.props.children as El | undefined;
const tabs = (tree = render()) => of(content(tree), PanelTabs)[0]?.props;
const nav = (id: string, tab?: string) => (sidebar().onNav as (i: string, t?: string) => void)(id, tab);
const rail = () => sidebar().rail;
const scroll = (target: unknown, y: number) => {
  (target as Node0).scrollTop = y;
  for (const fn of web.doc.scroll ?? []) fn({ target: target === web.page ? {} : target });
};
const fire = (type: string, e: unknown = { preventDefault: () => {} }) => { for (const fn of web.win[type] ?? []) fn(e); };
const browserBack0 = () => window.history.back();

beforeEach(() => {
  ui.push.mockClear(); ui.toast.mockClear();
  ui.phone = false; ui.role = "user"; ui.unseen = 0; ui.unread = 0; ui.projects = []; ui.notReady = false;
});
afterEach(() => vi.unstubAllGlobals());

describe("the menu's items", () => {
  // Create second (Kev, 2026-10-30: "swap communities with create, create is the 2nd strongest moat"), Communities after it.
  it("are Explore, Create, Communities, Studio, Hall of Fame and Inbox, in that order, with their icons; Settings is not one", () => {
    mount();
    expect((sidebar().nav as Array<{ id: string; label: string; icon: string }>).map((n) => [n.id, n.label, n.icon]))
      .toEqual([["home", "Explore", "grid"], ["create", "Create", "sparkles"], ["communities", "Communities", "users"], ["studio", "Studio", "folder"], ["fame", "Hall of Fame", "trophy"], ["inbox", "Inbox", "inbox"]]);
  });

  it("leave Studio and Inbox out for a guest, who keeps Explore, Create, Communities and the Hall of Fame (open to all)", () => {
    ui.role = "team";
    mount();
    expect((sidebar().nav as Array<{ id: string }>).map((n) => n.id)).toEqual(["home", "create", "communities", "fame"]);
    expect(sidebar().studio).toBeUndefined();
    for (const id of ["inbox", "studio"]) {
      ui.toast.mockClear();
      nav(id);
      expect(ui.toast).toHaveBeenCalledWith("Sign in to use this.");
      expect(panel()).toBeUndefined();
    }
    nav("fame");
    expect(panel()).toMatchObject({ title: "Hall of Fame" });
  });

  it("put one badge on Inbox: the unseen notifications and the unread messages together", () => {
    const badge = () => (sidebar().nav as Array<{ id: string; badge?: number }>).map((n) => n.badge ?? null);
    ui.unseen = 2; ui.unread = 3;
    mount();
    expect(badge()).toEqual([null, null, null, null, null, 5]);
    ui.unseen = 4; ui.unread = 0;
    expect(badge()).toEqual([null, null, null, null, null, 4]);
    ui.unseen = 0; ui.unread = 1;
    expect(badge()).toEqual([null, null, null, null, null, 1]);
    ui.unread = 0;
    expect(badge()).toEqual([null, null, null, null, null, null]);
  });

  it("keep Create Prompt, Refer a prompt, Feedback and the account row (seal, name, balance, Add funds, log off, theme)", () => {
    mount();
    const s = sidebar();
    expect(s).toMatchObject({ account: { name: "kev", handle: "kev" }, balance: "Add funds", theme: "light", guest: false });
    expect(typeof s.onLogoff).toBe("function");
    (s.onCreate as () => void)();
    expect(ui.push).toHaveBeenCalledWith("/editor");
    (s.onRefer as () => void)();
    (s.onFeedback as () => void)();
    const tree = render();
    expect([of(tree, ReferModal).length, of(tree, FeedbackModal).length]).toEqual([1, 1]);
    (sidebar(tree).onTopUp as () => void)();
    expect(of(content(), SettingsView)[0].props).toMatchObject({ initialTab: "payment", focusRamp: true });
  });
});

describe("Settings, out of the list", () => {
  it("opens from the account row's menu, on its first page, marked as its own (no main item), signed in only", () => {
    mount();
    nav("inbox");
    (panel()!.onClose as () => void)();
    (sidebar().onSettings as () => void)();
    expect(sidebar().active).toBe("");
    expect(panel()).toMatchObject({ title: "Settings", hideClose: true });
    expect(of(content(), SettingsView)[0].props).toMatchObject({ initialTab: undefined, focusGuardians: false });
    ui.role = "team";
    mount();
    expect(sidebar().onSettings).toBeUndefined();
  });

  it("still opens from the 2FA bar, on Recovery & 2FA; the account menu's press after it opens on the first page", () => {
    mount();
    const e = { preventDefault: vi.fn() };
    fire("enki:open-2fa", e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(of(content(), SettingsView)[0].props).toMatchObject({ initialTab: "recovery", focusGuardians: false });
    (sidebar().onSettings as () => void)();
    expect(of(content(), SettingsView)[0].props.initialTab).toBeUndefined();
  });

  it("still opens from the recovery warning (inside Inbox's Notifications too), with the guardians in focus", () => {
    mount();
    nav("inbox");
    const notifications = (tabs()!.children as (t: string) => ReactNode)("notifications");
    (of(notifications, NotificationsPanel)[0].props.onOpenRecovery as () => void)();
    expect(panel()).toMatchObject({ title: "Settings" });
    expect(of(content(), SettingsView)[0].props).toMatchObject({ initialTab: "recovery", focusGuardians: true });
  });

  it("still opens from Add funds anywhere, on Payment", () => {
    mount();
    fire("enki:open-billing");
    expect(panel()).toMatchObject({ title: "Payment" });
    expect(of(content(), SettingsView)[0].props).toMatchObject({ initialTab: "payment", focusRamp: true });
  });

  it("still opens from a login's way back (?settings=recovery), kept in the address, so a reload stays on it", () => {
    mount("settings=recovery&q=cats");
    expect(of(content(), SettingsView)[0].props).toMatchObject({ initialTab: "recovery" });
    expect(web.replace).not.toHaveBeenCalled();
  });
});

describe("Studio: the projects alone (Kev, 2026-10-30: \"Hall of Fame must be listed not INSIDE studio\")", () => {
  const P1 = "11111111-1111-4111-8111-111111111111";
  const P2 = "22222222-2222-4222-8222-222222222222";
  const C1 = "33333333-3333-4333-8333-333333333333";
  const studio = () => sidebar().studio as StudioMenu;
  // The overview's Projects tab, or a project's and a content piece's page, which have no tabs.
  const page = () => {
    const t = tabs();
    return of(t ? (t.children as (k: string) => ReactNode)("projects") : content(), StudioPanel)[0]?.props;
  };

  // Kev, 2026-10-30: "Analytics gehört doch eher zu Studio oder? ich würd das eher dort hin packen statt zur Inbox".
  it("is a panel of Projects | Analytics on its overview, none on a project's page, no Back of the shell's, its item marked", () => {
    mount();
    nav("studio");
    expect(panel()).toMatchObject({ title: "Studio", hideClose: true });
    expect(sidebar().active).toBe("studio");
    expect(tabs()).toMatchObject({ tabs: STUDIO_TABS, tab: undefined, label: "Projects or analytics" });
    expect(page()).toMatchObject({ place: {} });
    const analytics = (tabs()!.children as (k: string) => ReactNode)("analytics");
    expect([of(analytics, AnalyticsPanel).length, of(analytics, StudioPanel).length]).toEqual([1, 0]);
    expect(of(content(), LeaderboardPage)).toHaveLength(0);
    expect(location0.search).toBe("?panel=studio");
    mount("panel=studio&project=11111111-1111-4111-8111-111111111111");
    expect([of(content(), PanelTabs).length, page()?.place]).toEqual([0, { project: "11111111-1111-4111-8111-111111111111" }]);
  });

  // Kev, 2026-10-30: "wenn ich studio clicke, so sollen sich die projekte unten aufklappen. wenn ich aus studio
  // rausclicke so sollen die wieder sich zuklappen. wenn ich diese selbst aufklappe, so sollen sie zu jeder zeit
  // aufgeklappt bleiben. wenn studio aufgeklappt ist und ich auf studio clicke, so soll einfach nur studio sich öffnen".
  it("opens its submenu with Studio, keeps it on Studio's pages, a press of Studio over it only Studio; shuts it as Studio is left", () => {
    ui.projects = [{ id: P1, name: "Moonlight" }];
    mount();
    expect(studio().open).toBe(false);
    nav("studio");
    expect(studio().open).toBe(true);
    nav("studio");
    expect([studio().open, panel()?.title]).toEqual([true, "Studio"]);
    studio().onProject(P1);
    expect(studio().open).toBe(true);
    nav("inbox");
    expect(studio().open).toBe(false);
    nav("home");
    expect(studio().open).toBe(false);
    // Back to a Studio page is Studio again.
    nav("studio");
    expect(studio().open).toBe(true);
    // Before SQL 53 too: Create project shows under it.
    ui.projects = undefined;
    ui.notReady = true;
    mount();
    nav("studio");
    expect([studio().open, studio().projects]).toEqual([true, []]);
  });

  it("keeps it open everywhere and on the next visit once the chevron opened it; shut by the chevron over Studio, until Studio is pressed", () => {
    ui.projects = [{ id: P1, name: "Moonlight" }];
    mount("q=cats");
    // After the mount, which stubs a storage of its own.
    const kept: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => kept[k] ?? null, setItem: (k: string, v: string) => { kept[k] = v; } });
    studio().onToggle();
    // Folding opens no page and writes no address.
    expect([studio().open, panel(), location0.search, hist.at]).toEqual([true, undefined, "?q=cats", 0]);
    nav("inbox");
    expect(studio().open).toBe(true);
    nav("studio");
    nav("home");
    expect(studio().open).toBe(true);
    // Kept for the next visit (read back by readOpen, lib/ui/studio/recent; this harness renders the server's snapshot).
    expect(kept[OPEN_KEY]).toBe("1");
    // Over Studio the chevron shuts it, and Studio's pages keep it shut until Studio is pressed.
    nav("studio");
    studio().onToggle();
    expect(studio().open).toBe(false);
    studio().onProject(P1);
    expect(studio().open).toBe(false);
    nav("studio");
    expect(studio().open).toBe(true);
    // No longer kept: leaving Studio shuts it, and the next visit starts shut.
    nav("inbox");
    expect([studio().open, kept[OPEN_KEY]]).toEqual([false, "0"]);
  });

  it("lists the projects for the submenu, at the cap with no Create project; marks the one the address names", () => {
    ui.projects = [{ id: P1, name: "Moonlight" }, { id: P2, name: "Spring drop" }];
    mount(`panel=studio&project=${P2}`);
    expect(studio()).toMatchObject({ projects: ui.projects, atCap: false, current: P2 });
    ui.projects = Array.from({ length: MAX_PROJECTS }, (_, i) => ({ id: `${i}`, name: `p${i}` }));
    expect(studio().atCap).toBe(true);
    // In Create's context too, the project it works in.
    mount(`create=image&project=${P1}&content=${C1}`);
    expect(studio().current).toBe(P1);
    mount("");
    expect(studio().current).toBeNull();
  });

  // Review 2026-10-30: the list loading (or failed) read as none, so the submenu offered a lone "Create project".
  it("lists nothing while the projects load or after a failed read; before SQL 53 (503) none, so Create project shows", () => {
    ui.projects = undefined;
    mount();
    expect(studio()).toMatchObject({ projects: undefined, atCap: false });
    nav("studio");
    // Open with Studio, with no rows until the list is read.
    expect([studio().open, studio().projects]).toEqual([true, undefined]);
    ui.notReady = true;
    expect(studio().projects).toEqual([]);
  });

  it("a project row opens its page, a page of its own; All projects the overview; Create project the wizard over the page", () => {
    ui.projects = [{ id: P1, name: "Moonlight" }, { id: P2, name: "Spring drop" }];
    mount();
    // This browser's order: the projects opened last first.
    const kept: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => kept[k] ?? null, setItem: (k: string, v: string) => { kept[k] = v; } });
    expect(studio().projects!.map((p) => p.id)).toEqual([P1, P2]);
    studio().onProject(P2);
    expect(studio().projects!.map((p) => p.id)).toEqual([P2, P1]);
    browserBack0();
    studio().onProject(P1);
    expect(page()).toMatchObject({ place: { project: P1 } });
    expect([location0.search, hist.at]).toEqual([`?panel=studio&project=${P1}`, 1]);
    expect(studio().projects!.map((p) => p.id)).toEqual([P1, P2]);
    studio().onProject(P2);
    expect([location0.search, hist.at]).toEqual([`?panel=studio&project=${P2}`, 2]);
    browserBack0();
    expect(page()).toMatchObject({ place: { project: P1 } });
    studio().onAll();
    expect(page()).toMatchObject({ place: {} });
    studio().onCreate();
    const wizard = of(render(), ProjectWizard)[0].props;
    expect(wizard.edit).toBeUndefined();
    (wizard.onOpen as (id: string) => void)(P2);
    expect(location0.search).toBe(`?panel=studio&project=${P2}`);
  });

  it("walks its pages as pages: a project, a content piece, Back one at a time to the page before", () => {
    ui.projects = [{ id: P1, name: "Moonlight" }];
    mount();
    nav("studio");
    (page()!.onPlace as (p: object) => void)({ project: P1 });
    (page()!.onPlace as (p: object) => void)({ project: P1, content: C1 });
    expect(page()).toMatchObject({ place: { project: P1, content: C1 } });
    (page()!.onBack as () => void)();
    expect(page()).toMatchObject({ place: { project: P1 } });
    (page()!.onBack as () => void)();
    expect(page()).toMatchObject({ place: {} });
    (panel()!.onClose as () => void)();
    expect([panel(), hist.at]).toEqual([undefined, 0]);
  });

  it("from a page's link opened fresh, Back goes up one level in place: piece, project, overview, Explore", () => {
    mount(`q=cats&panel=studio&project=${P1}&content=${C1}`);
    expect(page()).toMatchObject({ place: { project: P1, content: C1 } });
    (page()!.onBack as () => void)();
    expect([location0.search, hist.at]).toEqual([`?q=cats&panel=studio&project=${P1}`, 0]);
    (page()!.onBack as () => void)();
    expect([location0.search, hist.at]).toEqual(["?q=cats&panel=studio", 0]);
    (panel()!.onClose as () => void)();
    expect([panel(), location0.search, hist.at]).toEqual([undefined, "?q=cats", 0]);
  });

  it("puts the level above in place of a deleted page, and opens the wizard on a project to edit it", () => {
    mount();
    nav("studio");
    (page()!.onPlace as (p: object) => void)({ project: P1 });
    (page()!.onReplace as (p: object) => void)({});
    expect([location0.search, hist.at]).toEqual(["?panel=studio", 2]);
    const project = { id: P1, name: "Moonlight", description: null, link: null, createdAt: "", updatedAt: "" };
    (page()!.onWizard as (p: object) => void)(project);
    expect(of(render(), ProjectWizard)[0].props.edit).toBe(project);
  });
});

describe("Communities, under Explore (Kev, 2026-10-30: \"wo sehe ich denn die communities, in welcher menüleiste\")", () => {
  const page = (tree = render()) => of(content(tree), CommunitiesPanel)[0]?.props as Record<string, unknown> | undefined;
  const call = (name: string, ...a: unknown[]) => (page()![name] as (...b: unknown[]) => void)(...a);

  it("opens the directory as a panel of its own, marked, without the panel's Back (its pages draw their own), for guests too", () => {
    ui.role = "team";
    mount();
    nav("communities");
    expect(panel()).toMatchObject({ title: "Communities", hideClose: true });
    expect(page()).toMatchObject({ at: { id: "communities" } });
    expect(sidebar().active).toBe("communities");
    expect(location0.search).toBe("?panel=communities");
  });

  it("walks its pages as pages: a card is a page of its own, a sort or a tab stays in place, Back one at a time", () => {
    mount();
    nav("communities");
    call("onTab", "new");
    expect([location0.search, hist.at]).toEqual(["?panel=communities&tab=new", 1]);
    call("onOpen", "gundam");
    expect([location0.search, hist.at]).toEqual(["?panel=communities&c=gundam", 2]);
    expect(page()).toMatchObject({ at: { id: "communities", community: "gundam" } });
    call("onTab", "works");
    expect([location0.search, hist.at]).toEqual(["?panel=communities&tab=works&c=gundam", 2]);
    call("onBack");
    expect([location0.search, hist.at]).toEqual(["?panel=communities&tab=new", 1]);
    expect(page()).toMatchObject({ at: { id: "communities", tab: "new" } });
  });

  it("puts a redirect in place of the page (Back never lands on a merged handle), and the directory after a delete", () => {
    mount();
    nav("communities");
    call("onOpen", "gundam_fans");
    call("onReplace", "gundam");
    expect([location0.search, hist.at]).toEqual(["?panel=communities&c=gundam", 2]);
    call("onReplace", null);
    expect([location0.search, hist.at]).toEqual(["?panel=communities", 2]);
  });

  // Review 2026-10-30: a shared link to a merged handle's Works landed on the Showroom of the one it was merged into.
  it("keeps the tab through a redirect; a delete leaves it", () => {
    mount("panel=communities&c=gundam_fans&tab=works");
    call("onReplace", "gundam");
    expect([location0.search, hist.at]).toEqual(["?panel=communities&tab=works&c=gundam", 0]);
    call("onReplace", null);
    expect([location0.search, hist.at]).toEqual(["?panel=communities", 0]);
  });

  it("from a community's link opened fresh, Back goes to the directory in place, then to Explore", () => {
    mount("q=cats&panel=communities&c=gundam");
    expect(page()).toMatchObject({ at: { id: "communities", community: "gundam" } });
    call("onBack");
    expect([location0.search, hist.at]).toEqual(["?q=cats&panel=communities", 0]);
    (panel()!.onClose as () => void)();
    expect([panel(), location0.search, hist.at]).toEqual([undefined, "?q=cats", 0]);
  });

  it("opens a community's page from a chip anywhere (enki:open-community) and takes the event; one page to the next is a page", () => {
    mount();
    const e = { preventDefault: vi.fn(), detail: { handle: "pepe" } };
    fire(OPEN_COMMUNITY_EVENT, e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect([location0.search, hist.at]).toEqual(["?panel=communities&c=pepe", 1]);
    fire(OPEN_COMMUNITY_EVENT, { preventDefault: () => {}, detail: { handle: "pepe" } });
    expect(hist.at).toBe(1);
    fire(OPEN_COMMUNITY_EVENT, { preventDefault: () => {}, detail: { handle: "apu" } });
    expect([location0.search, hist.at]).toEqual(["?panel=communities&c=apu", 2]);
  });
});

describe("the Hall of Fame, its own item before Inbox", () => {
  it("is today's leaderboard in a panel of its own, marked, without a Back (DEC-497)", () => {
    mount();
    nav("fame");
    expect(panel()).toMatchObject({ title: "Hall of Fame", hideClose: true });
    expect(of(content(), LeaderboardPage)).toHaveLength(1);
    expect(sidebar().active).toBe("fame");
    expect(location0.search).toBe("?panel=fame");
  });

  it("opens from its links of the time it was Studio's tab: ?studio=fame and ?panel=studio&tab=fame", () => {
    for (const link of ["studio=fame", "panel=studio&tab=fame"]) {
      mount(link);
      expect([link, panel()?.title, of(content(), LeaderboardPage).length, sidebar().active]).toEqual([link, "Hall of Fame", 1, "fame"]);
    }
  });
});

describe("Inbox", () => {
  it("is a panel of Notifications | Messages, on Notifications, without a Back; Analytics went to Studio", () => {
    mount();
    nav("inbox");
    expect(panel()).toMatchObject({ title: "Inbox", hideClose: true });
    const t = tabs()!;
    expect(t).toMatchObject({ tabs: INBOX_TABS, tab: undefined });
    const page = (k: string) => (t.children as (k: string) => ReactNode)(k);
    expect(of(page("notifications"), NotificationsPanel)).toHaveLength(1);
    expect(of(page("notifications"), PanelHead)[0].props.title).toBe("Notifications.");
    expect([of(page("messages"), MessagesPanel).length, of(page("messages"), NotificationsPanel).length]).toEqual([1, 0]);
    for (const k of ["notifications", "messages", "analytics"]) expect(of(page(k), AnalyticsPanel)).toHaveLength(0);
  });

  it("opens on Messages when its badge counts only unread messages, else on Notifications", () => {
    ui.unread = 3;
    mount();
    nav("inbox");
    expect(tabs()!.tab).toBe("messages");
    ui.unseen = 1;
    nav("inbox");
    expect(tabs()!.tab).toBeUndefined();
    ui.unseen = 0; ui.unread = 0;
    nav("inbox");
    expect(tabs()!.tab).toBeUndefined();
  });

  it("opens on Notifications from the phone header's bell", () => {
    ui.unseen = 2;
    mount();
    const bell = [...walk(render())].find((el) => el.props.className === "ek-mobile-bell kit-hit")!;
    expect(bell.props["aria-label"]).toBe("Notifications, 2 new");
    (bell.props.onClick as () => void)();
    expect(tabs()).toMatchObject({ tabs: INBOX_TABS, tab: "notifications" });
    expect(sidebar().active).toBe("inbox");
  });

  it("opens on the tab an address names (?inbox=messages), a press after it on the first, in place; ?inbox=analytics opens Studio on it", () => {
    mount("q=cats&inbox=messages");
    expect(tabs()).toMatchObject({ tabs: INBOX_TABS, tab: "messages" });
    nav("inbox");
    expect(tabs()!.tab).toBeUndefined();
    expect(web.replace).toHaveBeenLastCalledWith({ ekPanelBack: undefined }, "", "/home?q=cats&panel=inbox");
    mount("q=cats&inbox=analytics");
    expect([panel()?.title, tabs()?.tabs, tabs()?.tab, sidebar().active]).toEqual(["Studio", STUDIO_TABS, "analytics", "studio"]);
  });
});

describe("Explore and Create", () => {
  const main = (tree = render()) => [...walk(tree)].find((el) => el.props.className === "ek-main")!.props.children as El;

  it("show the feed, or Create on the tool the address opens, each marking its item", () => {
    mount();
    expect(main().type).toBe(EnkiFeedPage);
    expect(sidebar().active).toBe("home");
    mount("create=remix");
    expect(main().type).toBe(CreateView);
    expect(main().props).toEqual({ tool: "remix" });
    expect(sidebar().active).toBe("create");
    mount("create=nope");
    expect(main().props).toEqual({ tool: "image" });
  });

  it("a closed panel hands the mark back to the view on screen", () => {
    mount();
    nav("studio");
    (panel()!.onClose as () => void)();
    expect(sidebar().active).toBe("home");
    mount("create=video");
    nav("inbox");
    expect(sidebar().active).toBe("inbox");
    (panel()!.onClose as () => void)();
    expect(sidebar().active).toBe("create");
  });

  it("Create opens on Image, and closes an open image and an open panel on the way; in Create it stays on its tool", () => {
    mount();
    nav("studio");
    nav("create");
    expect(ui.push).toHaveBeenLastCalledWith("/home?create=image");
    expect(web.sent).toContain("enki:close-detail");
    expect(panel()).toBeUndefined();
    ui.push.mockClear();
    mount("create=video");
    nav("create");
    expect(ui.push).not.toHaveBeenCalled();
  });

  it("Explore from Create goes to the feed, with or without a panel over it", () => {
    mount("create=image");
    nav("home");
    expect(ui.push).toHaveBeenLastCalledWith("/home");
    mount("create=image");
    nav("inbox");
    ui.push.mockClear();
    nav("home");
    expect(ui.push).toHaveBeenLastCalledWith("/home");
    expect(panel()).toBeUndefined();
  });
});

describe("Back (Kev, 2026-10-30: \"wenn ich von profile auf settings auf back clicke komme ich in ein leeres image ui ... ich sollte immer auf die letzte seite kommen\")", () => {
  /** What shows: the panel, on the tab its address names, else the view beside the menu. */
  const shows = () => {
    const tree = render();
    const p = of(tree, EnkiPanel)[0]?.props;
    if (p) {
      const t = of(p.children as El, PanelTabs)[0]?.props;
      return t?.tab ? `${p.title} ${t.tab}` : String(p.title);
    }
    const main = [...walk(tree)].find((el) => el.props.className === "ek-main")!.props.children as El;
    return main.type === CreateView ? `Create ${main.props.tool}` : "Explore";
  };
  // The panel's own Back (Settings', a profile's), else its close (Esc) where it has none (Studio, Inbox).
  const panelBack = () => {
    const own = [...walk(content())].find((el) => typeof el.props.onBack === "function");
    ((own?.props.onBack ?? panel()!.onClose) as () => void)();
  };
  const account = (what: "onProfile" | "onSettings") => (sidebar()[what] as () => void)();
  const browserBack = () => window.history.back();
  const pickTab = (key: string) => (tabs()!.onTab as (k: string) => void)(key);
  /** An image opened on the panel (a profile's wall: ProfileView -> PromptWall -> EnkiDetailPanel), the real view's
   *  effects run as React runs them; the returned close runs their cleanups, as its X or its unmount does. */
  const openImage = () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response())));
    ui.s = 100; ui.effects = [];
    EnkiDetailPanel({ seed: { promptId: "00000000-0000-4000-8000-000000000001" }, onClose: () => {} });
    const cleanups = ui.effects.splice(0).map((fn) => fn());
    return () => { for (const c of cleanups) if (typeof c === "function") c(); };
  };

  it("from Settings opened on Profile is Profile, then the page under both, Create's Image here", () => {
    mount("create=image");
    account("onProfile");
    account("onSettings");
    expect(shows()).toBe("Settings");
    panelBack();
    expect(shows()).toBe("My Profile");
    expect(sidebar().active).toBe("");
    panelBack();
    expect(shows()).toBe("Create image");
    expect(sidebar().active).toBe("create");
  });

  it("from a profile opened on Explore is Explore, its item marked again", () => {
    mount();
    account("onProfile");
    expect(of(content(), ProfileView)).toHaveLength(1);
    panelBack();
    expect(shows()).toBe("Explore");
    expect(sidebar().active).toBe("home");
  });

  it("from Settings opened on a panel's tab is that panel on that tab", () => {
    mount();
    nav("inbox");
    pickTab("messages");
    expect(shows()).toBe("Inbox messages");
    account("onSettings");
    panelBack();
    expect(shows()).toBe("Inbox messages");
    expect(sidebar().active).toBe("inbox");
    nav("studio");
    pickTab("analytics");
    account("onSettings");
    panelBack();
    expect([shows(), sidebar().active]).toEqual(["Studio analytics", "studio"]);
  });

  it("is the browser's Back and the phone's back gesture too, on the same stack, and the panel's Back after them", () => {
    mount();
    nav("fame");
    account("onProfile");
    account("onSettings");
    browserBack();
    expect(shows()).toBe("My Profile");
    browserBack();
    expect(shows()).toBe("Hall of Fame");
    panelBack();
    expect(shows()).toBe("Explore");
    expect(hist.at).toBe(0);
  });

  it("from one creator's page opened on another's is that one", () => {
    mount();
    const open = (handle: string) => fire("enki:open-creator", { detail: { handle }, preventDefault: () => {} });
    open("ann");
    open("bo");
    expect(of(content(), ProfileView)[0].props).toMatchObject({ handle: "bo", isOwnProfile: false });
    panelBack();
    expect(of(content(), ProfileView)[0].props).toMatchObject({ handle: "ann" });
    panelBack();
    expect(shows()).toBe("Explore");
  });

  it("from Explore or Create pressed over a panel is that panel", () => {
    mount();
    account("onSettings");
    nav("home");
    expect(shows()).toBe("Explore");
    browserBack();
    expect(shows()).toBe("Settings");
    nav("create");
    expect(shows()).toBe("Create image");
    browserBack();
    expect(shows()).toBe("Settings");
    // In Create already, Create over a panel stays on its tool, as a page of its own.
    mount("create=video");
    nav("inbox");
    nav("create");
    expect(shows()).toBe("Create video");
    browserBack();
    expect(shows()).toBe("Inbox");
  });

  it("from Create Prompt pressed over a panel on the editor is that panel, the editor's address kept", () => {
    mount();
    arrive("/editor?id=7");
    nav("studio");
    (sidebar().onCreate as () => void)();
    expect([panel(), location0.pathname + location0.search, ui.push.mock.calls.length]).toEqual([undefined, "/editor?id=7", 0]);
    browserBack();
    expect(shows()).toBe("Studio");
  });

  it("past a second press of the open item is the page before it: the press starts it over in place, on its first tab", () => {
    mount();
    nav("inbox");
    pickTab("messages");
    const before = content()!.key;
    nav("inbox");
    expect(shows()).toBe("Inbox");
    expect(content()!.key).not.toBe(before);
    expect(hist.at).toBe(1);
    browserBack();
    expect(shows()).toBe("Explore");
  });

  // Review 2026-10-30: the view writes ?prompt= into the address and took the shell's mark off with it, so the profile's
  // Back closed in place, on Explore, and the page under it was gone.
  it("past an image opened and closed on the profile is still the page before the profile, Create's Image here", () => {
    mount("create=image");
    account("onProfile");
    openImage()();
    expect(shows()).toBe("My Profile");
    panelBack();
    expect([shows(), hist.at]).toEqual(["Create image", 0]);
  });

  it("from Settings opened on a profile after an image there is the profile, then Explore, the profile behind neither", () => {
    mount();
    account("onProfile");
    openImage()();
    account("onSettings");
    panelBack();
    expect(shows()).toBe("My Profile");
    panelBack();
    expect([shows(), hist.at]).toEqual(["Explore", 0]);
  });

  it("from a creator's page opened from an image on the profile (its maker) is the profile, then Explore", () => {
    mount();
    account("onProfile");
    const close = openImage();
    fire("enki:open-creator", { detail: { handle: "ann" }, preventDefault: () => {} });
    // The creator's page takes the profile's place: its image view unmounts on the creator's entry.
    close();
    expect([shows(), location0.search]).toEqual(["Creator", "?creator=ann"]);
    panelBack();
    expect(shows()).toBe("My Profile");
    panelBack();
    expect([shows(), hist.at]).toEqual(["Explore", 0]);
  });

  it("from a panel's link opened fresh is Explore, never an empty view, and the link's other parts stay", () => {
    for (const link of ["create=image&panel=settings&q=cats", "settings=recovery&q=cats", "creator=ann&q=cats", "inbox=messages&q=cats"]) {
      mount(link);
      expect(shows()).not.toBe("Explore");
      panelBack();
      expect([link, shows(), location0.search, hist.at]).toEqual([link, "Explore", "?q=cats", 0]);
    }
  });

  it("hides an open image while a panel shows and brings it back once none does", () => {
    mount("panel=settings");
    expect(web.sent).toContain("enki:hide-detail");
    expect(web.sent).not.toContain("enki:show-detail");
    mount();
    expect(web.sent).toContain("enki:show-detail");
    expect(web.sent).not.toContain("enki:hide-detail");
  });

  it("is the panel the address names on arrival, so a reload stays on it; a guest gets no personal one", () => {
    mount("panel=inbox&tab=messages");
    expect(shows()).toBe("Inbox messages");
    // Analytics' address from its time in Inbox opens it in Studio.
    mount("panel=inbox&tab=analytics");
    expect(shows()).toBe("Studio analytics");
    mount("panel=nope");
    expect(shows()).toBe("Explore");
    ui.role = "team";
    mount("panel=inbox");
    expect(shows()).toBe("Explore");
    mount("panel=studio&tab=fame");
    expect(shows()).toBe("Hall of Fame");
  });
});

describe("the narrow rail", () => {
  it("stays wide as Explore or Create opens", () => {
    mount();
    expect(rail()).toBe(false);
    nav("create");
    expect(rail()).toBe(false);
    mount("create=image");
    expect(rail()).toBe(false);
  });

  it("folds once the page is scrolled about six wheel steps down an endless area, and opens again at the very top", () => {
    mount();
    for (const y of [100, 200, 300, 400, 500]) scroll(web.page, y);
    expect(rail()).toBe(false);
    scroll(web.page, 600);
    expect(rail()).toBe(true);
    scroll(web.page, 300);
    expect(rail()).toBe(true);
    scroll(web.page, 0);
    expect(rail()).toBe(false);
  });

  it("folds on Create's own scroller (Remix's column), at its end when it ends before six steps", () => {
    mount("create=remix");
    scroll(web.column, 100);
    expect(rail()).toBe(false);
    scroll(web.column, 154);
    expect(rail()).toBe(true);
  });

  it("does not fold as a long prompt fills its field in Create: the textarea following the caret is typing", () => {
    mount("create=image");
    // Measured on the bench: 60 typed lines left the textarea 1395 tall, 298 shown, at 1082.
    const field = new Node0({ scrollHeight: 1395, clientHeight: 298 }) as Node0 & { closest(s: string): unknown };
    field.closest = (s) => (s.split(", ").includes("textarea") ? {} : null);
    web.column = field;
    for (const y of [400, 800, 1082]) scroll(field, y);
    expect(rail()).toBe(false);
  });

  it("folds again on further scrolling once Explore widened it mid-page", () => {
    mount();
    for (const y of [300, 600]) scroll(web.page, y);
    expect(rail()).toBe(true);
    nav("studio");
    nav("home");
    expect(rail()).toBe(false);
    scroll(web.page, 700);
    expect(rail()).toBe(true);
  });

  it("opens again as the address leaves Create for Explore or back, by the browser's Back too; a toggle stays", () => {
    mount("create=image");
    fire(GENERATION_START_EVENT);
    expect(rail()).toBe(true);
    // The composer's Back (history.back()): ?create= goes. React renders again at once after a set during render.
    ui.params = new URLSearchParams("");
    render();
    expect(rail()).toBe(false);
    for (const y of [300, 600]) scroll(web.page, y);
    expect(rail()).toBe(true);
    ui.params = new URLSearchParams("create=remix");
    render();
    expect(rail()).toBe(false);
    (sidebar().onMenu as (n: string) => void)("icons");
    ui.params = new URLSearchParams("");
    render();
    expect(rail()).toBe(true);
  });

  it("does not fold where nothing endless is shown", () => {
    mount();
    web.area = false;
    for (const y of [300, 600, 900]) scroll(web.page, y);
    expect(rail()).toBe(false);
  });

  it("folds as a generation starts, and Explore or Create opening widens it again", () => {
    mount("create=image");
    fire(GENERATION_START_EVENT);
    expect(rail()).toBe(true);
    nav("create");
    expect(rail()).toBe(false);
    fire(GENERATION_START_EVENT);
    nav("home");
    expect(rail()).toBe(false);
  });

  it("gives way to the user's own toggle: after it, neither a scroll nor a generation folds the menu", () => {
    mount();
    (sidebar().onMenu as (n: string) => void)("icons");
    expect(rail()).toBe(true);
    (sidebar().onMenu as (n: string) => void)("full");
    expect(rail()).toBe(false);
    fire(GENERATION_START_EVENT);
    for (const y of [300, 600, 900]) scroll(web.page, y);
    expect(rail()).toBe(false);
    // A toggle to icons stays icons at the very top: only the shell's own fold opens there. (Rendered in between, as
    // React does before the next scroll.)
    (sidebar().onMenu as (n: string) => void)("icons");
    render();
    scroll(web.page, 0);
    expect(rail()).toBe(true);
  });

  it("never folds on a phone, where the menu is the drawer", () => {
    ui.phone = true;
    mount();
    fire(GENERATION_START_EVENT);
    for (const y of [300, 600]) scroll(web.page, y);
    ui.phone = false;
    expect(rail()).toBe(false);
  });
});

describe("the phone's drawer", () => {
  it("is the same menu: the six items, Create Prompt, Refer, Feedback and the account; it closes as an item opens", () => {
    ui.phone = true;
    mount();
    const burger = [...walk(render())].find((el) => el.props.className === "ek-mobile-burger-btn kit-hit")!;
    (burger.props.onClick as () => void)();
    const s = sidebar();
    expect(s.mobileOpen).toBe(true);
    expect((s.nav as Array<{ id: string }>).map((n) => n.id)).toEqual(["home", "create", "communities", "studio", "fame", "inbox"]);
    // Studio's projects in it, as many rows as ever: the drawer scrolls.
    expect(s.phone).toBe(true);
    expect([typeof s.onCreate, typeof s.onRefer, typeof s.onFeedback, typeof s.onSettings]).toEqual(["function", "function", "function", "function"]);
    nav("studio");
    expect(sidebar().mobileOpen).toBe(false);
  });
});

describe("a panel's tabs (PanelTabs)", () => {
  const draw = (tab?: string) => {
    const page = vi.fn((key: string) => `page:${key}`);
    const onTab = vi.fn();
    const tree = () => { ui.s = 0; return PanelTabs({ tabs: INBOX_TABS, tab, onTab, label: "Notifications or messages", children: page }) as ReactNode; };
    return { tree, page, onTab };
  };
  beforeEach(() => { ui.state = []; });

  it("draw the switch in a row that gives way with the phone's header, then the picked tab's page", () => {
    const { tree } = draw("messages");
    const [row, body] = (tree() as El).props.children as [El, string];
    expect(row.props.className).toBe("ek-panel-tabs ek-tuck-hide");
    expect(of(row, Segmented)[0].props).toMatchObject({ role: "tablist", slide: true, ariaLabel: "Notifications or messages", value: "messages", options: [...INBOX_TABS] });
    expect(body).toBe("page:messages");
  });

  it("show the first tab without one asked for, or with an unknown one, and hand a pick to the address", () => {
    expect((((draw().tree() as El).props.children as [El, string])[1])).toBe("page:notifications");
    const { tree, onTab } = draw("nope");
    expect(((tree() as El).props.children as [El, string])[1]).toBe("page:notifications");
    (of(tree(), Segmented)[0].props.onChange as (k: string) => void)("messages");
    expect(onTab).toHaveBeenCalledWith("messages");
    // The address shows it: PanelTabs keeps no tab of its own, or a second press of Inbox stayed on the last one.
    expect(((draw("messages").tree() as El).props.children as [El, string])[1]).toBe("page:messages");
    // A tab the panel no longer has (Analytics left Inbox) is its first.
    expect(((draw("analytics").tree() as El).props.children as [El, string])[1]).toBe("page:notifications");
  });
});

describe("the account row's menu (EnkiSidebar)", () => {
  const props = (over: object = {}) => ({
    nav: [], active: "home", onNav: vi.fn(), rail: false, onCreate: vi.fn(), account: { name: "kev", handle: "kev" }, closed: false, canFull: true,
    onMenu: vi.fn(), balance: "$4.20", onProfile: vi.fn(), onTopUp: vi.fn(), theme: "light", setTheme: vi.fn(), ...over,
  });
  const sidebarOf = async (p: object) => {
    const { default: Sidebar } = await vi.importActual<typeof import("@/components/enki-shell/EnkiSidebar")>("@/components/enki-shell/EnkiSidebar");
    return () => { ui.s = 0; return Sidebar(p as Parameters<typeof Sidebar>[0]) as ReactNode; };
  };
  const menuOf = (tree: ReactNode) => [...walk(tree)].find((el) => String(el.props.className).startsWith("ek-color-dd "));
  const kebab = (tree: ReactNode) => [...walk(tree)].find((el) => String(el.props.className).startsWith("ek-kebab"))!;
  beforeEach(() => { ui.state = []; browser(); });

  it("holds Settings above the color themes; a press opens it and closes the menu", async () => {
    const onSettings = vi.fn();
    const draw = await sidebarOf(props({ onSettings }));
    expect(menuOf(draw())).toBeUndefined();
    (kebab(draw()).props.onClick as (e: object) => void)({ stopPropagation: () => {} });
    const menu = menuOf(draw())!;
    const items = [...walk(menu)].filter((el) => el.type === "button" || el.props.className === "ek-color-dd-h").map((el) => text(el).trim());
    expect(items).toEqual(["Settings", "Color theme", "Bright", "Dark", "Purple"]);
    const settings = [...walk(menu)].find((el) => el.props.className === "ek-color-opt ek-settings-opt")!;
    (settings.props.onClick as () => void)();
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(menuOf(draw())).toBeUndefined();
  });

  it("has no Settings for a guest, only the themes", async () => {
    const draw = await sidebarOf(props({ guest: true }));
    (kebab(draw()).props.onClick as (e: object) => void)({ stopPropagation: () => {} });
    expect([...walk(menuOf(draw()))].filter((el) => el.type === "button").map((el) => text(el).trim())).toEqual(["Bright", "Dark", "Purple"]);
  });
});

describe("the look", () => {
  const css = readSource(join(__dirname, "..", "..", "components", "enki-shell", "enki-shell.css"));
  it("keeps a panel's tabs at its top while its page scrolls, in the row look of Explore's", () => {
    expect(css).toContain(".ek-panel-tabs {\n  position: sticky; top: 0; z-index: 5; flex-shrink: 0;\n  display: flex; align-items: center; height: 44px; padding: 0 24px;\n  background: var(--header-bg);");
    expect(css).toMatch(/@media \(max-width: 767\.98px\) \{[\s\S]*\n {2}\.ek-panel-tabs \{ padding: 0 12px; \}/);
  });
  // Measured at 390x844 with touch: opacity 1, and Settings reachable in the drawer.
  it("shows the account's menu on touch, where nothing hovers", () => {
    expect(css).toContain("@media (hover: none) { .ek-kebab { opacity: 1; } }");
  });
  // Measured in headless Edge, 2026-10-30, the menu of six (Communities under Explore), the fold switched off: signed in,
  // the labelled column with Studio's submenu at its one row holds down to 579 px, the icon rail to 596; under the top
  // slot's 30, 609 and 626. So 626 is the last window that holds every signed-in menu; at 643 the nav stands (overflow 0,
  // the account row's foot at 625 to 643, the submenu filling the rest), at 642 the Menu shows: 16 px of margin, as
  // before. A guest's four items hold down to
  // 406 in the column and 502 in the rail (490 and 532 under the slot), so a guest keeps 548, the same 16 px (review
  // 2026-10-30: at 580 a guest's menu folded with 172 px to spare). The menu of five needed 579 (595); the menu of four
  // 532 (548); the old six-item menu 714 (760).
  it("folds into the short window's Menu at 642 px of height or less signed in (the menu of six), a guest's at 548", () => {
    expect(css).toMatch(/\n@media \(max-height: 548px\) \{\s+\.ek-burger-wrap \{ display: block; \}\n {2}\.ek-nav, \.ek-earn-lab, \.ek-rail-rule, \.ek-earn-row \{ display: none; \}/);
    expect(css).toMatch(/\n@media \(max-height: 642px\) \{\n {2}:where\(\.ek-sidebar\[data-studio\]\) \.ek-burger-wrap \{ display: block; \}\n {2}:where\(\.ek-sidebar\[data-studio\]\) :is\(\.ek-nav, \.ek-earn-lab, \.ek-rail-rule, \.ek-earn-row\) \{ display: none; \}/);
    expect(css.match(/\.ek-burger-wrap \{ display: block; \}/g)).toHaveLength(2);
  });
  // The submenu's rows give way before Refer a prompt and Feedback do: with it, nothing in the column shrinks, and the
  // overflow that leaves is what EnkiSidebar counts.
  it("keeps the column's rows at their height while Studio's submenu is in it", () => {
    expect(css).toContain(".ek-sidebar:has(.ek-sub) > :not(.ek-side-spacer) { flex-shrink: 0; }");
  });
  it("shows the account's menu button under a key's focus: on a desktop it is the way to Settings", () => {
    expect(css).toContain("\n.ek-kebab:focus-visible { opacity: 1; }\n");
  });
});
