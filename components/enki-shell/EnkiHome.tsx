"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useActiveAccount } from "thirdweb/react";
import { useTheme } from "../../providers/ThemeProvider";
import { useHoldings } from "@/hooks/useHoldings";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useViewerWallets } from "@/hooks/useViewerWallets";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useSolanaAuth } from "@/hooks/useSolanaAuth";
import { useLogoff } from "@/hooks/useLogoff";
import { useBetaAccess } from "@/components/BetaGate";
import UsernameOnboard from "./UsernameOnboard";
import AnalyticsPanel from "./AnalyticsPanel";
import NotificationsPanel from "./NotificationsPanel";
import MessagesPanel from "./MessagesPanel";
import { useRecoveryStatus } from "@/hooks/useRecoveryStatus";
import { useNeeds2fa } from "@/hooks/useSecondFactor";
import { useNotifications } from "@/hooks/useNotifications";
import { useMessages } from "@/hooks/useMessages";
import EnkiFeedPage from "@/components/enki/EnkiFeedPage";
import CreateView from "@/components/enki/CreateView";
import { toolLink, toolOf } from "@/lib/ui/feed/world";
import { dropAfterLogin, openLogin } from "@/lib/openLogin";
import { notify } from "@/components/kit/notify";
import { navFor, readStoredNav, widestNav, type NavState } from "@/lib/ui/kit/breakpoints";
import { balanceView } from "@/lib/ui/kit/price";
import { tuckScroll, tuckScroller } from "@/lib/ui/kit/tuck";
import {
  GENERATION_START_EVENT, INBOX_TABS, PANEL_BACK, STUDIO_TABS, communityParent, foldScroller, foldStep, folded, panelLink, panelOf, studioParent, unfolded,
  type MenuPick, type PanelAt,
} from "@/lib/ui/kit/shell-nav";
import { OPEN_COMMUNITY_EVENT } from "@/lib/ui/communities/links";
import CommunitiesPanel from "@/components/communities/CommunitiesPanel";
import { useStudioProjects } from "@/hooks/useStudio";
import { MAX_PROJECTS, type Project } from "@/lib/studio/types";
import { byRecent, readOpen, readRecent, rememberRecent, writeOpen } from "@/lib/ui/studio/recent";
import { createAt } from "@/lib/ui/studio/links";
import StudioPanel, { type StudioPlace } from "@/components/studio/StudioPanel";
import ProjectWizard from "@/components/studio/ProjectWizard";
import EnkiSidebar, { type NavItem } from "./EnkiSidebar";
import PanelTabs from "./PanelTabs";
import FeedbackModal from "./FeedbackModal";
import ReferModal from "./ReferModal";
import { promptPage } from "@/lib/ui/image-view/open-link";
import EnkiPanel from "./EnkiPanel";
import PanelHead from "./PanelHead";
import LoginModal from "@/components/LoginModal";
import { Icon } from "./icons";
import SettingsView from "@/components/settings/SettingsView";
import ProfileView from "@/components/profile/ProfileView";
import LeaderboardPage from "../../app/leaderboard/page";
import "./enki-shell.css";

const PANEL_TITLES: Record<string, string> = {
  billing: "Payment", settings: "Settings", profile: "My Profile", creator: "Creator", studio: "Studio", fame: "Hall of Fame", inbox: "Inbox",
  communities: "Communities",
};

/* Five places (Kev, 2026-10-30, on an icon rail with Explore, Create, Studio and Inbox: "explore und create links ist
   super. Studio = projektordner ok, da werden dann generierungen später auftauchen ... analytics unter inbox"; then
   "Hall of Fame must be listed not INSIDE studio, but unter studio als eigener punkt vor inbox"): Explore is the feed
   (the old Home, id "home"), Create its own view, Studio the projects and the analytics ("Analytics gehört doch eher zu
   Studio"), the Hall of Fame its own panel, Inbox the notifications and the messages. Settings went to the account
   row's menu; Create Prompt, Refer a prompt
   and Feedback stay where they were. No Search entry (Kev, 2026-10-13): the field lives in the feed's filter bar.
   Bookmarks live in the owner's Profile as a tab (Kev, 2026-10-13), like History and Likes. */
const NAV: NavItem[] = [
  { id: "home", label: "Explore", icon: "grid" },
  // Create second, Communities after it (Kev, 2026-10-30: "swap communities with create, create is the 2nd strongest
  // moat"); Communities is open to guests too.
  { id: "create", label: "Create", icon: "sparkles" },
  { id: "communities", label: "Communities", icon: "users", soon: true },
  { id: "studio", label: "Studio", icon: "folder" },
  { id: "fame", label: "Hall of Fame", icon: "trophy" },
  { id: "inbox", label: "Inbox", icon: "inbox" },
];

// Personal areas: hidden from (and blocked for) visitors who aren't signed in.
// (Matters post-beta, when guests may browse the feed again.) History moved
// to the owner's own Profile as a tab. Studio holds an account's projects; the
// Hall of Fame, its own item now, stays open to all.
const AUTHED_ONLY = new Set(["settings", "inbox", "studio"]);

// Same safe-wrapper pattern the old Navbar used: these wallet hooks throw if a
// provider is momentarily absent, so swallow and fall back to "not connected".
function useSafeActiveAccount() {
  try { return useActiveAccount(); } catch { return null; }
}

/* The user's own menu choice. Read during render through a store, so the
   server and the hydrating client agree (none) and the stored answer
   follows without an effect. Before the three states only the rail was
   stored, under ek-menu-collapsed; its "1" still reads as icons. */
const MENU_KEY = "ek-nav";
/** The menu's account while no session is confirmed. */
const GUEST = { name: "Guest", handle: "guest" };
const noSubscribe = () => () => {};
const readMenuPref = () => { try { return readStoredNav(localStorage.getItem(MENU_KEY), localStorage.getItem("ek-menu-collapsed")); } catch { return null; } };
/* The window as the widest menu it fits: that snapshot changes only at 1180
   and 1360 px, so a resize re-renders the shell only there. The server
   renders the full menu, as before. */
const onResize = (onChange: () => void) => { window.addEventListener("resize", onChange); return () => window.removeEventListener("resize", onChange); };
const readWidest = () => widestNav(window.innerWidth);
const serverWidest = (): NavState => "full";

/** The shell. `children` take the feed's place, so a route can keep the
 *  shell (menu, login, billing panel) around its own page. */
export default function EnkiHome({ children }: { children?: React.ReactNode }) {
  const router = useRouter();
  const search = useSearchParams();
  // The Create tool the address opens (?create=), none on Explore and on another route's page.
  const tool = toolOf(search);
  const { theme, setTheme } = useTheme();

  const account = useSafeActiveAccount();
  
  const { isAuthed: emailAuthed, email } = useEmailAuth();
  const { address: cdpAddress } = useCdpAddress();
  const { isAuthenticated: solanaAuthed, walletAddress: solanaAddress } = useSolanaAuth();
  const walletAddress = account?.address ?? cdpAddress ?? (solanaAuthed ? solanaAddress : null);
  const { payer } = useViewerWallets();
  const { balance, ready } = useHoldings(payer);
  // The balance once a wallet pays ("…" while it loads); without one, the way to add funds.
  const held = balanceView({ payer, ready, balance, free: false, quote: null })?.text ?? null;
  const balanceText = held ?? "Add funds";

  // Access + username come from the root BetaGate (it already verified the
  // session server-side before this shell could even mount).
  const { access, role, handle: myHandle, handleAuto, setHandle: setMyHandle, trial } = useBetaAccess();
  /* Team-cookie browsing is NOT authed: the cookie opens looking around,
     never the personal areas — so Inbox disappears from the menu entirely
     for it and Settings from the account row's menu, the earn buttons
     deactivate, and the prompt creator explains itself (Kev, 2026-08-23). */
  const authed = access === "ok" && role !== "team";

  const emailName = emailAuthed && email ? email.split("@")[0] : null;
  const handle = myHandle ?? (walletAddress ? walletAddress.replace(/^0x/, "").slice(0, 8).toLowerCase() : emailName?.toLowerCase() ?? "guest");
  const name = myHandle ?? (walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : emailName ?? "Guest");

  /* The menu is the 256 px column from 1360 px, the 72 px icon rail from
     1180 px and a 10 px strip below (Kev's image UI v2 handoff, README §2).
     The user's pick holds while the window fits it and comes back once it
     fits again. A phone shows the full menu as its drawer. */
  const widest = useSyncExternalStore(onResize, readWidest, serverWidest);
  const phone = useMediaQuery("(max-width: 767.98px)"); // the shell's phone edge, enki-shell.css
  const storedNav = useSyncExternalStore(noSubscribe, readMenuPref, () => null);
  const [pick, setPick] = useState<MenuPick>(null);
  // Explore or Create coming on screen opens the shell's fold whichever way it came: the menu, the browser's Back, the
  // composer's own Back (review 2026-10-30: a Generate's fold stayed on the feed's very top after Back).
  const view = tool ? "create" : "home";
  const [shownView, setShownView] = useState(view);
  if (shownView !== view) { setShownView(view); setPick(unfolded(pick)); }
  const nav = navFor(widest, pick?.nav ?? storedNav);
  const rail = nav === "icons" && !phone;
  const closed = nav === "closed" && !phone;
  /* The menu stays wide as Explore or Create opens and folds into its rail only once the reader gets going (Kev,
     2026-10-30: "die schmale leiste muss nur dann erst schmal werden, wenn ich anfange zu scrollen oder zu
     generieren"): an endless area (marked data-menu-autohide: the feed, Create, the walls) scrolled about six wheel
     steps down, or to its end when it ends sooner, on the page or in its own scroller (Create's composer), so more of
     it shows (Kev, 2026-10-15 and 10-16); or a generation's start. Back at the very top it opens again. Not remembered
     as a preference, and it fires once, re-arming near the top or as the shell drops its fold mid-page (Explore or
     Create opening there; review 2026-10-30: it never folded again after). The user's own toggle of this visit wins:
     after it nothing folds or opens by itself (lib/ui/kit/shell-nav). */
  const autoFold = useEffectEvent(() => {
    if (!phone) setPick(folded(pick, nav));
  });
  const autoOpen = useEffectEvent(() => setPick(unfolded(pick)));
  const noFold = useEffectEvent(() => pick === null);
  useEffect(() => {
    let armed = true;
    const lasts = new WeakMap<Element, number>();
    const onScroll = (e: Event) => {
      const page = document.scrollingElement ?? document.documentElement;
      const area = document.querySelector(".ek-main [data-menu-autohide]");
      // Caught at the document: an element's scroll does not bubble.
      const s = foldScroller<Element>(e.target instanceof Element ? e.target : null, page, area);
      if (!s) return;
      const step = foldStep(s, lasts.get(s) ?? 0, armed || noFold(), area !== null);
      lasts.set(s, s.scrollTop);
      armed = step.armed;
      if (step.open) autoOpen();
      if (step.fold) autoFold();
    };
    const onGenerate = () => autoFold();
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener(GENERATION_START_EVENT, onGenerate);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener(GENERATION_START_EVENT, onGenerate);
    };
  }, []);
  /* Which menu item shows in the right panel, on which tab: the address's (lib/ui/kit/shell-nav, panelOf), so Back is
     the browser's (closePanel); a guest gets none of the personal ones. Which creator the "creator" panel shows comes
     with it. Opened via the cancelable "enki:open-creator" event: cards and artist links dispatch it, and a consumed
     event (preventDefault) tells them the shell took over — only surfaces OUTSIDE the shell fall back to the /creators
     route. */
  const at = panelOf(search);
  const panel = at && (authed || !AUTHED_ONLY.has(at.id)) ? at.id : null;
  const panelTab = at?.tab;
  const creatorHandle = at?.handle ?? null;
  // The Studio page the address names: the overview, a project, a content piece (shell-nav panelOf).
  const studioPlace: StudioPlace | null = panel === "studio" ? { project: at?.project, content: at?.content } : null;
  /* Studio's projects in the menu (Kev, 2026-10-30: "wenn ich studio clicke, so klappt sich links darunter dynamisch ein
     untermenü meiner projekte auf FALLS ich welche hab"): this browser's order, the projects opened last first (kept as
     a project's page opens, openPanel), and its open or closed (lib/ui/studio/recent). The list is the client's read
     only, so the server's render and the hydrating one both have none. Before SQL 53 it stays empty and the submenu
     offers "Create project"; while it loads, or when the read failed, it is undefined and the submenu lists nothing. */
  const studioRead = useStudioProjects(authed);
  const studioList = studioRead.data?.projects ?? (studioRead.notReady ? [] : undefined);
  /* They open with Studio and close as it is left, unless the chevron opened them: then they stay open everywhere, also
     on the next visit (Kev, 2026-10-30: "wenn ich studio clicke, so sollen sich die projekte unten aufklappen. wenn ich
     aus studio rausclicke so sollen die wieder sich zuklappen. wenn ich diese selbst aufklappe, so sollen sie zu jeder
     zeit aufgeklappt bleiben. wenn studio aufgeklappt ist und ich auf studio clicke, so soll einfach nur studio sich
     öffnen"). The chevron shutting them over Studio holds until Studio is pressed again. */
  const storedPin = useSyncExternalStore(noSubscribe, readOpen, () => false);
  const [pinPick, setPinPick] = useState<boolean | null>(null);
  const pinned = pinPick ?? storedPin;
  const [shut, setShut] = useState(false);
  const studioOpen = pinned || (panel === "studio" && !shut);
  const toggleStudio = () => {
    setPinPick(!studioOpen);
    writeOpen(!studioOpen);
    setShut(studioOpen);
  };
  // The project wizard (ProjectWizard), new or editing one: from the menu's "Create project" and Studio's pages.
  const [wizard, setWizard] = useState<{ edit?: Project } | null>(null);
  /* The login popup, IN the shell (Kev, 2026-08-24): profile gate and
     creator notice raise enki:open-login and the LANDING'S auth modal —
     embedded, not rebuilt — opens right here. */
  const [loginOpen, setLoginOpen] = useState(false);
  useEffect(() => {
    const onOpenLogin = (e: Event) => { e.preventDefault(); setLoginOpen(true); };
    window.addEventListener("enki:open-login", onOpenLogin);
    return () => window.removeEventListener("enki:open-login", onOpenLogin);
  }, []);
  useEffect(() => {
    const onOpenCreator = (e: Event) => {
      const h = (e as CustomEvent<{ handle?: string }>).detail?.handle;
      if (!h) return;
      e.preventDefault();
      // One creator's page to the next is a page of its own; openPanel drops the last page's tuck, which must not hide
      // the new one's header.
      openPanel("creator", undefined, String(h));
    };
    window.addEventListener("enki:open-creator", onOpenCreator);
    return () => window.removeEventListener("enki:open-creator", onOpenCreator);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A community chip anywhere opens its page here, as a creator's link does (lib/ui/communities/links openCommunity).
  useEffect(() => {
    const onOpenCommunity = (e: Event) => {
      const h = (e as CustomEvent<{ handle?: string }>).detail?.handle;
      if (!h) return;
      e.preventDefault();
      openPanel("communities", undefined, undefined, { community: String(h) });
    };
    window.addEventListener(OPEN_COMMUNITY_EVENT, onOpenCommunity);
    return () => window.removeEventListener(OPEN_COMMUNITY_EVENT, onOpenCommunity);
    // openPanel reads the address, not this render: mounted once, the listener stays right.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* Deep links need no reading here: the address is the panel (panelOf). /home?creator=<handle> opens a creator's
     page (the old /creators/[id] URLs redirect here so the shell, and its menu, is always around the page); a login
     Settings asked for lands back on its tab (openLogin(next); DEC-501), Inbox on its own (/home?inbox=messages), the
     Hall of Fame's links from its time as Studio's tab on it (?studio=fame), and a reload stays on the panel it showed. */
  /* "Prompt creator needs a login" notice — pops in and LEAVES with an
     animation (open -> closing -> gone), closes on ESC and free-space
     clicks. */
  const [creatorNotice, setCreatorNotice] = useState<"open" | "closing" | null>(null);
  const closeCreatorNotice = () => setCreatorNotice((s) => (s === "open" ? "closing" : s));
  useEffect(() => {
    if (creatorNotice !== "open") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closeCreatorNotice(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [creatorNotice]);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [referOpen, setReferOpen] = useState(false);
  // Balance chip → Payment panel, scrolled to "Add money" with a heartbeat.
  const [payFocus, setPayFocus] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  /* Scrolling down tucks the phone header away, its burger left small at the top left; scrolling up brings it back
     (Kev, 2026-10-26), and a tap on that burger opens the menu, the header with it (Kev, 2026-10-27: "wenn ich ... auf
     bürger erneut drücke, so soll auch das menü links aufkommen"); closed, the menu leaves it tucked. The feed tucks on
     the page, a panel on its own scroll (tuckScroller), an open image on its frame's (Kev, 2026-10-27: "die topleiste
     sollte bitte auch verschwinden in JEDEM MENÜ, also auch bei image ui mobile"), and each names itself, so moving
     from one to the other shows the header again (enki-shell.css). */
  const [tucked, setTucked] = useState<string | false>(false);
  useEffect(() => {
    if (!phone) { setTucked(false); return; }
    const page = document.scrollingElement ?? document.documentElement;
    const box = panel ? document.querySelector(".ek-panel") : null;
    // Each scroller measures from its own last offset.
    const lasts = new WeakMap<Element, number>([[page, page.scrollTop]]);
    const onScroll = (e: Event) => {
      const el = e.target instanceof Element ? e.target : null;
      // An open image scrolls in its own frame: that tucks the image's header, never the panel or the feed under it
      // (review 2026-10-27), and a hidden one's scrolls count for nothing. Only the view's own scroller counts there,
      // not its History column or a settings row sliding sideways (review 2026-10-27).
      const frame = document.querySelector(".iv-frame:not(.is-hidden)");
      if (!frame && el?.closest(".iv-frame")) return;
      const view = frame && { contains: (n: Element) => frame.contains(n) && n.matches("[data-scroll]") };
      const s = tuckScroller<Element>(el, page, view || box);
      if (!s) return;
      // The page ends where the window does: on iOS its layout height stays short of that while the toolbar hides, and
      // a bounce in between read as a scroll up (review 2026-10-27).
      const step = tuckScroll(s, lasts.get(s), s === page ? window.innerHeight : undefined);
      lasts.set(s, step.last);
      if (step.tucked !== null) setTucked(step.tucked && (frame ? "image" : panel ?? "feed"));
    };
    // Caught at the document: an element's scroll does not bubble.
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    // Every image opens with the header showing (EnkiDetailPanel raises it per prompt).
    const onImage = () => setTucked((t) => (t === "image" ? false : t));
    window.addEventListener("enki:detail-open", onImage);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("enki:detail-open", onImage);
    };
  }, [phone, panel]);
  /* A menu panel covering the image view HIDES it (kept mounted) — its scrim (z 160) sits under the detail panel (z 162),
     so without this the leaderboard opened invisibly beneath the image (Kev, 2026-08-22). Whatever the panel covered
     comes back once it is gone, however it went (its Back, the browser's, Explore) — a detail hidden by openPanel stayed
     invisibly mounted when the panel closed via X/scrim/ESC, and every card click after that opened into the hidden
     panel: dead feed (found by review, 2026-08-22). */
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(panel ? "enki:hide-detail" : "enki:show-detail"));
  }, [panel, creatorHandle]);
  /* The panel into the address: a page of its own (push), one step back from the page before, or this one changed
     (replace), the shell's mark (PANEL_BACK) kept. Not spread from history.state: Next's patched history copies its own
     state in and hears the new address only for state without it. */
  const writePanel = (next: PanelAt | null, push: boolean) =>
    window.history[push ? "pushState" : "replaceState"]({ [PANEL_BACK]: push ? 1 : window.history.state?.[PANEL_BACK] }, "", panelLink(window.location.href, next));
  /* Back, the panel's own and Esc, is the browser's (Kev, 2026-10-30: "wenn ich von profile auf settings auf back
     clicke komme ich in ein leeres image ui ... ich sollte immer auf die letzte seite kommen"): on a panel the shell
     opened it lands on the page before, a panel on its tab or the view under it, past an image opened and closed on the
     panel (backState), as the browser's Back and the phone's back gesture do. A panel's link opened fresh has no page of
     the shell's behind it: it closes in place, on Explore. */
  const closePanel = () => {
    setPayFocus(false);
    const steps = Number(window.history.state?.[PANEL_BACK]) || 0;
    if (steps) window.history.go(-steps);
    else {
      // A Studio page opened fresh goes up one level in place: a content piece to its project, a project to the overview;
      // a community's page to the directory.
      const now = panelOf(new URLSearchParams(window.location.search));
      const up = studioParent(now) ?? communityParent(now);
      window.history.replaceState(null, "", panelLink(window.location.href, up, !up));
    }
  };
  // A press on Explore or Create over a panel: the view, a page of its own, so Back brings the panel back.
  const leavePanel = () => writePanel(null, true);
  // Bumped when the open panel is asked for again: its content REMOUNTS, so re-clicking Settings always starts back on
  // its first page instead of keeping the tab you were on.
  const [panelNonce, setPanelNonce] = useState(0);
  /* Each panel is a page of its own, so Back comes back to it; `tab` lets a caller (the recovery banner, the phone's
     bell) open it on a specific tab. The panel open already (a second press of its item, the bell over Inbox) starts
     over in place. Read from the address, as the listeners mounted once call this too. A declaration, as those listeners'
     effects sit above it and moving them would change the effects' order (react-hooks/immutability). */
  function openPanel(id: string, tab?: string, handle?: string, place?: StudioPlace & { community?: string }) {
    setMobileDrawerOpen(false);
    setTucked(false);
    const now = panelOf(new URLSearchParams(window.location.search));
    // A Studio page is its place too: one project to the next is a page of its own, and the menu lists it first.
    if (place?.project) rememberRecent(place.project);
    // So is a community's page: one community to the next.
    const again = now?.id === id && now.handle === handle && now.project === place?.project && now.content === place?.content
      && now.community === place?.community;
    writePanel({ id, tab, handle, ...place }, !again);
    if (again) setPanelNonce((n) => n + 1);
  }
  // A tab picked is in the address, in place: Back from a page opened on it comes back to it.
  // A community's page keeps its community.
  const pickTab = (tab: string) => writePanel({ id: panel!, tab, ...(at?.community && { community: at.community }) }, false);
  // Guardians get the focus only when the recovery banner asked; the 2FA bar
  // opens the same tab, whose top section is the 2FA itself.
  const [guardianFocus, setGuardianFocus] = useState(false);
  const openRecoverySettings = () => { setGuardianFocus(true); openPanel("settings", "recovery"); };

  // Unseen notifications and unread messages → one badge on Inbox, their sum. The shared stores poll + refresh on
  // focus (near-realtime) and clear optimistically on open, so the badge here just follows them — no local fetch/race.
  const { unseen } = useNotifications(authed);
  const { unreadTotal: dmUnread } = useMessages(authed);

  // No recovery set up → thin red banner across the top. The X hides it on
  // this device; Settings shows its own non-dismissible copy regardless.
  const recovery = useRecoveryStatus(authed);
  const [bannerDismissed, setBannerDismissed] = useState(true);
  useEffect(() => {
    try { setBannerDismissed(localStorage.getItem("ek-recovery-banner") === "1"); } catch { /* stays hidden */ }
  }, []);
  const dismissBanner = () => {
    setBannerDismissed(true);
    try { localStorage.setItem("ek-recovery-banner", "1"); } catch { /* session-only then */ }
  };
  // One 30 px slot at the top: the permanent 2FA bar or a tester's trial line
  // (SecondFactorBar, at the root) wins; the recovery warning then shows inside
  // Settings instead.
  const needs2fa = useNeeds2fa();
  const showRecoveryBanner = authed && recovery !== null && recovery.confirmed === 0 && !bannerDismissed && !needs2fa && !trial;
  // The shell moves its own layers under that slot (.ek-with-banner); a page
  // outside it starts below the 2FA bar instead (globals.css, html.ek-in-shell).
  // Before paint, so a move between the shell and a page never jumps.
  useLayoutEffect(() => {
    document.documentElement.classList.add("ek-in-shell");
    return () => document.documentElement.classList.remove("ek-in-shell");
  }, []);
  // Log off: the confirm below, and the sign-out across every auth surface (hooks/useLogoff.ts, shared with Settings).
  const { logoffOpen, setLogoffOpen, logoffBusy, logoffDrafts, askLogoff, doLogoff } = useLogoff();
  useEffect(() => {
    if (!logoffOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setLogoffOpen(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [logoffOpen, setLogoffOpen]);
  /* A finished render's notice leads to its prompt (RenderNotices): its push of the prompt's address names no panel, so
     an open panel gives way to the view behind it, and Back brings it back. */
  // The 2FA bar (SecondFactorBar) opens the 2FA settings here, in place.
  useEffect(() => {
    const onOpen2fa = (e: Event) => {
      e.preventDefault();
      setGuardianFocus(false);
      openPanel("settings", "recovery");
    };
    window.addEventListener("enki:open-2fa", onOpen2fa);
    return () => window.removeEventListener("enki:open-2fa", onOpen2fa);
    // openPanel reads the address, not this render: mounted once, the listener stays right.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // "Add funds" from any surface opens Payment here. Consumed, so a page
  // outside the shell knows to open the settings page itself.
  const openBilling = useEffectEvent(() => { setPayFocus(true); openPanel("billing"); });
  useEffect(() => {
    const onOpenBilling = (e: Event) => { e.preventDefault(); openBilling(); };
    window.addEventListener("enki:open-billing", onOpenBilling);
    return () => window.removeEventListener("enki:open-billing", onOpenBilling);
  }, []);

  /* Ctrl/Cmd+K and the query itself live with the field, in SearchChip: it
     writes ?q=, EnkiFeedPage reads it and asks the server. */

  const showToast = (msg: string) => notify(msg);

  // A menu toggle (labels, icons, hide, show) → remember the pick.
  const setMenu = (next: NavState) => {
    setPick({ nav: next });
    try { localStorage.setItem(MENU_KEY, next); } catch { /* noop */ }
  };

  /* Create Prompt from anywhere. On /editor a panel over the editor (Hall of
     Fame) closes, as a page of its own and with the editor's address kept,
     or the click looked dead. From any other route the panel stays up until the
     editor is on screen: this shell leaves with its route, and closing the
     panel first showed the feed for a moment (Kev, 2026-10-13). */
  const createPrompt = () => {
    if (!authed) { setCreatorNotice("open"); return; }
    setMobileDrawerOpen(false);
    if (window.location.pathname !== "/editor") router.push("/editor");
    else if (panel) leavePanel();
  };

  const onNav = (id: string, tab?: string) => {
    setMobileDrawerOpen(false);
    // Guests can browse, but personal areas need an account.
    if (!authed && AUTHED_ONLY.has(id)) { showToast("Sign in to use this."); return; }
    // Explore and Create open with the menu wide: a fold the shell made goes (Kev, 2026-10-30), a user's toggle stays.
    if (id === "home" || id === "create") setPick(unfolded(pick));
    if (id === "create") {
      // Create is its own view (/home?create=image): an open panel and an open image give way; already there, it stays
      // on its tool.
      window.dispatchEvent(new CustomEvent("enki:close-detail"));
      if (!tool) router.push(toolLink("image"));
      else if (panel) leavePanel();
      return;
    }
    if (id === "home") {
      // Home always ends on the feed, never on the panel an image was opened from (Kev, 2026-10-29: "the home button
      // took me to another previous menu"; DEC-500), nor on Create. The way back to that panel is the view's own Back,
      // or Esc, and the browser's Back.
      const hadPanel = panel !== null;
      /* Home is the feed where the reader left it (Kev, 2026-10-13: "in the
         same line I left, so I can continue scrolling"): an image view
         closes, hidden behind a panel or not (closing puts the scroll offset
         back), a panel closes, and the feed stays as it was. Only from the
         plain feed does Home go back to All at the top. */
      const detailEl = document.querySelector(".iv-frame");
      window.dispatchEvent(new CustomEvent("enki:close-detail"));
      if (detailEl || hadPanel) {
        if (window.location.pathname !== "/home" || tool) router.push("/home");
        else if (hadPanel) leavePanel();
        return;
      }
      // Nothing open: back to the whole feed (no search, All) at the top.
      router.push("/home");
      window.dispatchEvent(new CustomEvent("enki:home"));
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    // Studio opens its overview with its submenu open: a shut the chevron made over Studio goes.
    if (id === "studio") setShut(false);
    // Every other menu item opens in the standalone right-side panel, on its first tab unless one is asked for. Inbox's
    // badge counts the unread messages too: with only those, a press opens on Messages, where they are (review 2026-10-30).
    openPanel(id, tab ?? (id === "inbox" && unseen === 0 && dmUnread > 0 ? "messages" : undefined));
  };
  const renderPanel = (key: string) => {
    switch (key) {
      // Balance chip + billing entries render the EXACT Settings → Payment
      // view (same container, same scale), scrolled to "Add money".
      case "billing": return <SettingsView initialTab="payment" focusRamp={payFocus} onBack={closePanel} />;
      // Every panel page opens in the same frame (.ek-page) with the same PanelHead (DEC-499).
      /* Studio: the projects alone (Kev, 2026-10-30: "Studio = projektordner ok, da werden dann generierungen später
         auftauchen"), a page each for the overview, a project and a content piece; a delete puts the level above in its
         place. The Hall of Fame left it for its own item ("Hall of Fame must be listed not INSIDE studio"); Analytics
         came from Inbox to the overview's second tab ("Analytics gehört doch eher zu Studio"). */
      case "studio": {
        const projects = (
          <StudioPanel place={studioPlace ?? {}} onPlace={(place) => openPanel("studio", undefined, undefined, place)} onBack={closePanel}
            onWizard={(project) => setWizard({ edit: project })} onReplace={(place) => writePanel({ id: "studio", ...place }, false)} />
        );
        return studioPlace?.project ? projects : (
          <PanelTabs tabs={STUDIO_TABS} tab={panelTab} onTab={pickTab} label="Projects or analytics">
            {(tab) => (tab === "analytics" ? <AnalyticsPanel /> : projects)}
          </PanelTabs>
        );
      }
      case "fame": return <LeaderboardPage />;
      /* Communities (Kev, 2026-10-30: "wo sehe ich denn die communities, in welcher menüleiste"): the directory, or one
         community's page by its handle; a card pressed is a page of its own, a sort, a tab or a redirect in place. */
      case "communities": return (
        <CommunitiesPanel at={at ?? { id: "communities" }} onOpen={(h) => openPanel("communities", undefined, undefined, { community: h })}
          onTab={pickTab} onBack={closePanel}
          // A redirect keeps the tab (a shared link to a merged handle's Works lands on Works); the directory after a
          // delete starts on its own default.
          onReplace={(h) => writePanel({ id: "communities", ...(h && { community: h, ...(at?.tab && { tab: at.tab }) }) }, false)} />
      );
      // Inbox: the notifications and the messages, each as it was on its own; Analytics went to Studio (Kev, 2026-10-30).
      case "inbox": return (
        <PanelTabs tabs={INBOX_TABS} tab={panelTab} onTab={pickTab} label="Notifications or messages">
          {(tab) => tab === "messages" ? <MessagesPanel toast={showToast} /> : (
            <div className="ek-page">
              <PanelHead title="Notifications." sub="What happened around your work: comments, ratings, generations and guardian answers." />
              <NotificationsPanel onOpenRecovery={openRecoverySettings} />
            </div>
          )}
        </PanelTabs>
      );
      case "settings": return <SettingsView initialTab={panelTab} globalBannerVisible={showRecoveryBanner} focusGuardians={panelTab === "recovery" && guardianFocus} onBack={closePanel} />;
      // Its Back is its only way out since the X went (DEC-459): closePanel brings back the image it covered (DEC-463).
      case "profile": return <ProfileView onBack={closePanel} />;
      /* A CREATOR's page, in the SAME right-side panel area as everything
         else — the left menu never leaves the screen (Kev, 2026-08-24:
         "IT SHOULD BE PLACED IN THE RIGHT AREA NEXT TO THE LEFT SIDE
         MENÜ"). Same ProfileView, foreign mode. */
      case "creator": return creatorHandle
        // Keyed by handle: one creator's page never shows the last one's
        // hero, gallery or Report target while the next one loads.
        ? <ProfileView key={creatorHandle} handle={creatorHandle} isOwnProfile={false} onBack={closePanel} />
        : null;
      default: return (
        <div className="ek-page">
          <PanelHead title={`${PANEL_TITLES[key] || key}.`} />
          <div className="ek-panel-stub" style={{ height: "auto", padding: "80px 40px" }}>
            <Icon name="sparkles" size={26} stroke={1.6} />
            <p>This space is coming soon.</p>
          </div>
        </div>
      );
    }
  };

  /* Tucked only over what tucked it: the feed's tuck never shows over a panel, one panel's never over another, and none
     with the drawer open (a scroll behind either reached the page and tucked the header over them; review 2026-10-26).
     An image's tuck is its own class: it holds only while an image shows, the others only while none does (CSS). */
  const shownTucked = phone && !mobileDrawerOpen && (tucked === (panel ?? "feed") || tucked === "image");
  const rootClass = "ek-app" + (rail ? " ek-root--rail" : closed ? " ek-root--closed" : "")
    // The top slot holds the recovery warning, the 2FA bar or a tester's trial line (SecondFactorBar): the shell moves
    // under it for each, or the trial line covered its top 30 px (review 2026-10-26).
    + (showRecoveryBanner || needs2fa || trial ? " ek-with-banner" : "")
    + (shownTucked ? (tucked === "image" ? " ek-tucked-image" : " ek-tucked") : "");

  return (
    <div className={rootClass}>
      {showRecoveryBanner && (
        <div className="ek-recovery-banner" role="alert">
          <button className="ek-recovery-banner-msg" onClick={openRecoverySettings}>
            No recovery set up. Lose this login and the account is gone — set up a guardian.
          </button>
          <button
            className="ek-recovery-banner-x"
            aria-label="Dismiss"
            onClick={dismissBanner}
          >
            <Icon name="x" size={14} stroke={2.4} />
          </button>
        </div>
      )}
      {/* Mobile Top Header (≤ 768px) */}
      {/* Open, the drawer hangs below this header, so the burger that opened it stays where it was and closes it, no
          X elsewhere (Kev, 2026-10-26: "statt das x ... dass das burger menü an der gleichen stelle bleibt"). */}
      <header className={"ek-mobile-header" + (mobileDrawerOpen ? " ek-mobile-header--menu" : "")}>
        {/* The menu on the left, before the logo, on the side its drawer opens from (Kev, 2026-10-26). */}
        <div className="ek-mobile-header-left">
          <button
            type="button"
            className="ek-mobile-burger-btn kit-hit"
            onClick={() => setMobileDrawerOpen((o) => !o)}
            aria-label={mobileDrawerOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileDrawerOpen}
          >
            <Icon name="menu" size={18} stroke={2.2} />
            {/* Notifications have their own bell now; the menu still carries what it hides, the unread messages. */}
            {authed && dmUnread > 0 && !mobileDrawerOpen && (
              <span className="ek-mobile-burger-badge">{dmUnread}</span>
            )}
          </button>
          <button type="button" className="ek-mobile-header-home" onClick={() => onNav("home")} aria-label="Home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="ek-mobile-header-logo" src="/enki-wordmark.svg" alt="Enki Art" />
          </button>
        </div>
        <div className="ek-mobile-header-right">
          {/* No balance and no seal at the top right (Kev, 2026-10-29: "remove bitte doch the profile image and the
              dollar on the top right corner wo auch immer das so auftaucht"; before, 2026-10-27: "i want the profile
              logo on the top right"): the menu's account row holds both. The notifications stay (Kev, 2026-10-26),
              opening Inbox on them (Kev, 2026-10-30). */}
          {authed && (
            <button type="button" className="ek-mobile-bell kit-hit" onClick={() => onNav("inbox", "notifications")}
              aria-label={unseen > 0 ? `Notifications, ${unseen} new` : "Notifications"}>
              <Icon name="bell" size={18} stroke={2} />
              {unseen > 0 && <span className="ek-mobile-burger-badge">{unseen}</span>}
            </button>
          )}
          {/* A guest signs in at the corner. */}
          {!authed && (
            <button type="button" className="ek-mobile-account kit-hit" aria-label="Log in" onClick={() => openLogin()}>
              <Icon name="user" size={16} stroke={2} />
            </button>
          )}
        </div>
      </header>

      {/* Mobile Drawer Scrim */}
      {mobileDrawerOpen && (
        <div className="ek-mobile-drawer-scrim" onClick={() => setMobileDrawerOpen(false)} />
      )}

      <div className="ek-shell">
        <EnkiSidebar
          nav={(authed ? NAV : NAV.filter((n) => !AUTHED_ONLY.has(n.id))).map((n) =>
            n.id === "inbox" && unseen + dmUnread > 0 ? { ...n, badge: unseen + dmUnread } : n
          )}
          // A panel marks its own item (none for Settings, a profile, a creator's page, Payment); without one the view on
          // screen does: Create while the address opens it, else Explore.
          active={panel ? (["studio", "communities", "fame", "inbox"].includes(panel) ? panel : "") : tool ? "create" : "home"}
          onNav={onNav}
          rail={rail}
          onCreate={createPrompt}
          guest={!authed}
          onRefer={() => setReferOpen(true)}
          onFeedback={() => setFeedbackOpen(true)}
          // Named only once the server confirmed the session, as every page decides: a stored email or a
          // connected wallet alone named someone the pages treated as signed out (Kev, 2026-10-21).
          account={authed ? { name, handle } : GUEST}
          closed={closed}
          canFull={widest === "full"}
          onMenu={setMenu}
          balance={balanceText}
          onProfile={() => openPanel("profile")}
          onTopUp={() => { setPayFocus(true); openPanel("billing"); }}
          onSettings={authed ? () => onNav("settings") : undefined}
          onLogoff={authed ? askLogoff : undefined}
          theme={theme}
          setTheme={setTheme}
          mobileOpen={mobileDrawerOpen}
          phone={phone}
          // Marked: the project a Studio page or Create's context names.
          studio={authed ? {
            projects: studioList && byRecent(studioList, readRecent()),
            open: studioOpen,
            atCap: (studioList?.length ?? 0) >= MAX_PROJECTS,
            current: studioPlace?.project ?? createAt(search)?.project ?? null,
            onToggle: toggleStudio,
            onProject: (id) => openPanel("studio", undefined, undefined, { project: id }),
            onAll: () => openPanel("studio"),
            onCreate: () => { setMobileDrawerOpen(false); setWizard({}); },
          } : undefined}
        />

        <main className="ek-main">
          {/* No top bar. It held only the search input, which is now a glyph
              in the category bar, and an empty 56px strip with a border and a
              background is not "nothing" — it is a band of unused screen above
              the first thing the reader wants (Kev, 2026-08-13). */}
          {children ?? (tool ? <CreateView tool={tool} /> : <EnkiFeedPage />)}
        </main>
      </div>

      {/* No bottom bar on a phone (Kev, 2026-10-27: "i really dont like the bottom menü at all"): Home is the logo and
          the menu's Home, Create prompt the menu's, the account the header's corner, Quick Create the feed's round
          button (GenerateLauncher). */}

      {panel && (
        // A panel with its own Back at the top left gets no second way out: a profile (Kev, 2026-10-27: "das back
        // button links reicht vollständig"; DEC-459; its login door has none, DEC-464), Settings and Payment (DEC-468).
        // Hall of Fame, Messages, Analytics and Notifications have none at all (Kev, 2026-10-29, DEC-497), nor Inbox,
        // which holds two of them, nor Studio's overview, which holds Analytics: the menu, the logo and Esc leave them.
        // Studio draws its own on a project's and a content piece's page (StudioPanel).
        <EnkiPanel title={PANEL_TITLES[panel] || panel} onClose={closePanel} full
          hideClose={(panel === "profile" && authed) || ["creator", "settings", "billing", "studio", "communities", "fame", "inbox"].includes(panel)}>
          {/* The key remounts only the CONTENT (fresh state per menu click);
              the panel shell stays mounted, so its fade-in doesn't replay and
              the home feed never flashes through between panels. */}
          <div key={`${panel}:${panelNonce}`} style={{ display: "contents" }}>
            {renderPanel(panel)}
          </div>
        </EnkiPanel>
      )}

      {creatorNotice && (
        <div
          className={"ek-modal-scrim ek-notice-scrim" + (creatorNotice === "closing" ? " leaving" : "")}
          style={{ zIndex: 1450 }}
          onClick={closeCreatorNotice}
          onAnimationEnd={() => { if (creatorNotice === "closing") setCreatorNotice(null); }}
        >
          <div className="ek-modal ek-notice" style={{ maxWidth: 330 }} onClick={(e) => e.stopPropagation()}>
            <p className="ek-notice-text">The prompt creator is for logged in users. Sign in and it opens right up.</p>
            <button type="button" className="ek-btn" style={{ minHeight: 36, width: "100%" }} onClick={() => { setCreatorNotice(null); openLogin(); }}>
              Sign in
            </button>
          </div>
        </div>
      )}
      {wizard && (
        <ProjectWizard key={wizard.edit?.id ?? "new"} edit={wizard.edit} onClose={() => setWizard(null)}
          onOpen={(id) => openPanel("studio", undefined, undefined, { project: id })} />
      )}
      <LoginModal open={loginOpen} prewarm={!authed} onClose={() => { setLoginOpen(false); dropAfterLogin(); }} />
      {referOpen && (
        <ReferModal guest={!authed} onClose={() => setReferOpen(false)}
          onPublished={(id) => { setReferOpen(false); router.push(promptPage(id)); }} />
      )}
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} onToast={showToast} guest={!authed} />}

      {logoffOpen && (
        <div className="ek-modal-scrim" onClick={() => !logoffBusy && setLogoffOpen(false)}>
          <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="ek-modal-head">
              <span className="ek-sheet-bolt"><Icon name="logout" size={16} stroke={2} /></span>
              <span className="ek-modal-title">Log off?</span>
              <button className="ek-modal-x" onClick={() => setLogoffOpen(false)} disabled={logoffBusy}>
                <Icon name="x" size={17} stroke={2} />
              </button>
            </div>
            <div className="ek-modal-body">
              <p style={{ fontSize: 13.5, color: "var(--enki-ink-3)", lineHeight: 1.55, marginBottom: 18 }}>
                You&apos;ll be signed out on this device and land back on the front page.
              </p>
              {logoffDrafts > 0 && (
                <p className="ek-logoff-drafts" role="alert" style={{ fontSize: 13.5, color: "var(--enki-ember)", fontWeight: 600, lineHeight: 1.5, marginTop: -8, marginBottom: 18 }}>
                  {logoffDrafts === 1 ? "Your draft in the editor" : `Your ${logoffDrafts} drafts in the editor`} will be deleted from this device. What you released stays on Enki; release a draft first to keep its changes.
                </p>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button className="ek-btn" style={{ minHeight: 44 }} onClick={doLogoff} disabled={logoffBusy}>
                  <Icon name="logout" size={15} stroke={2} /> {logoffBusy ? "Logging off…" : "Yes, log me off"}
                </button>
                <button
                  onClick={() => setLogoffOpen(false)}
                  disabled={logoffBusy}
                  style={{ minHeight: 36, border: "none", background: "transparent", color: "var(--enki-ink-3)", fontSize: 12.5, cursor: "pointer" }}
                >
                  Stay signed in
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* First login with no username yet, or only the one Enki picked (SQL 46) → the big name picker (no skip —
          a free adjective_artist default is prefilled). */}
      {(myHandle === null || handleAuto) && (
        <UsernameOnboard email={email} wallet={walletAddress} onDone={(h) => setMyHandle(h, true)} />
      )}
    </div>
  );
}
