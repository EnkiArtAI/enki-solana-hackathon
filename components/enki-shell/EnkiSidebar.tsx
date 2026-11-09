"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import Seal from "@/components/kit/Seal";
import type { NavState } from "@/lib/ui/kit/breakpoints";
import { MAX_SUBMENU_PROJECTS } from "@/lib/studio/types";
import { submenuRows, type SubRow } from "@/lib/ui/studio/submenu";

export type ThemeId = "light" | "dark" | "purple";

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  badge?: number;
  /** Shown greyed and not clickable: not built out yet (Kev, 2026-11-09: Communities). */
  soon?: boolean;
}

/** The Studio item's projects (Kev, 2026-10-30: "wenn ich studio clicke, so klappt sich links darunter dynamisch ein
 *  untermenü meiner projekte auf FALLS ich welche hab. direkt im menü rechts von studio soll daher auch ein
 *  auf/zuklapppfeil sein"): this browser's order, open or closed, and what a row does. */
export interface StudioMenu {
  /** Undefined until the first answer, and after a failed read: no rows then, never a lone "Create project" for an
   *  account that may have projects (review 2026-10-30). */
  projects: ReadonlyArray<{ id: string; name: string }> | undefined;
  open: boolean;
  /** At MAX_PROJECTS: no "Create project" row. */
  atCap: boolean;
  /** The project the address names, marked. */
  current: string | null;
  onToggle: () => void;
  onProject: (id: string) => void;
  onAll: () => void;
  onCreate: () => void;
}
/** One submenu row's height (enki-shell.css .ek-sub-row). */
const SUB_ROW_H = 32;

/* Sidebar shows at most 10 characters of the name — the row stays tidy. */
const clip10 = (s: string) => (s.length > 10 ? s.slice(0, 10) + "…" : s);

const THEME_OPTS: { id: ThemeId; name: string; sw: string }[] = [
  { id: "light", name: "Bright", sw: "linear-gradient(135deg,#ffffff,#ecebe9)" },
  { id: "dark", name: "Dark", sw: "linear-gradient(135deg,#0a1825,#16303f)" },
  { id: "purple", name: "Purple", sw: "linear-gradient(135deg,#1a1228,#6d28d9)" },
];

interface SidebarProps {
  nav: NavItem[];
  active: string;
  onNav: (id: string) => void;
  rail: boolean;
  onCreate: () => void;
  onRefer?: () => void;
  onFeedback?: () => void;
  /** Team-cookie browsing: earn buttons deactivate and say so. */
  guest?: boolean;
  account: { name: string; handle: string };
  /** The menu is hidden to its 10 px strip. */
  closed: boolean;
  /** The full column fits the window; narrower, the rail cannot widen. */
  canFull: boolean;
  onMenu: (next: NavState) => void;
  /** "$4.20", "…" while it loads, or "Add funds" with no Solana wallet. */
  balance: string;
  onProfile: () => void;
  onTopUp: () => void;
  /** Settings, in the account's menu since it left the main list (signed in only). */
  onSettings?: () => void;
  onLogoff?: () => void;
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
  mobileOpen?: boolean;
  /** The phone's drawer: it scrolls, so the submenu lists as many rows as it ever does. */
  phone?: boolean;
  /** Studio's projects, signed in only. */
  studio?: StudioMenu;
}

export default function EnkiSidebar({
  nav, active, onNav, rail, onCreate, onRefer, onFeedback, guest = false,
  account, closed, canFull, onMenu, balance, onProfile, onTopUp, onSettings, onLogoff, theme, setTheme,
  mobileOpen = false, phone = false, studio,
}: SidebarProps) {
  const [colorOpen, setColorOpen] = useState(false);
  const colorRef = useRef<HTMLDivElement>(null);
  /* Short viewports fold the nav into this. It is rendered unconditionally and
     revealed by a media query rather than by a resize listener: a listener
     cannot know the height during the server render, so the first paint would
     always be the wrong one and then correct itself in front of the reader. */
  const [burgerOpen, setBurgerOpen] = useState(false);
  const burgerRef = useRef<HTMLDivElement>(null);
  /* Folding the list away would also fold away its unread counts, so they are
     summed onto the burger itself — otherwise a short window silently hides
     the one signal the menu exists to carry. */
  const totalBadge = nav.reduce((n, i) => n + (i.badge ?? 0), 0);
  /* The submenu's rows fit the column's room, so the account row is never pushed off it: the spacer and the submenu
     measured together (one grows as the other shrinks, so the sum holds still), less anything already hanging over the
     column's foot, in rows. The phone's drawer scrolls instead. */
  const side = useRef<HTMLElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(MAX_SUBMENU_PROJECTS + 1);
  const measured = !!studio && !rail && !phone && !closed;
  useEffect(() => {
    const els = [side.current, spacer.current, sub.current];
    if (!measured || els.some((e) => !e)) return;
    const [aside, gap, list] = els as HTMLElement[];
    const ro = new ResizeObserver(() => {
      const over = Math.max(0, aside.scrollHeight - aside.clientHeight);
      setRoom(Math.max(1, Math.floor((gap.getBoundingClientRect().height + list.getBoundingClientRect().height - over) / SUB_ROW_H)));
    });
    for (const e of els as HTMLElement[]) ro.observe(e);
    return () => ro.disconnect();
  }, [measured]);
  const subRows = (fits: number) => (studio?.projects ? submenuRows(studio.projects, fits, studio.atCap) : []);
  // A project row, "All projects" or "Create project", in the column or the short window's Menu.
  const subRow = (r: SubRow, className: string, after?: () => void) => {
    const go = () => { if (r.kind === "project") studio!.onProject(r.id); else if (r.kind === "all") studio!.onAll(); else studio!.onCreate(); after?.(); };
    const on = r.kind === "project" && studio!.current === r.id;
    return (
      <button key={r.kind === "project" ? r.id : r.kind} type="button" className={className} onClick={go} aria-current={on ? "page" : undefined}
        role={className.startsWith("ek-burger") ? "menuitem" : undefined}>
        {r.kind === "project" ? <span className="ek-sub-dot" aria-hidden /> : <Icon name={r.kind === "all" ? "more" : "plus"} size={13} stroke={1.9} />}
        <span className="ek-sub-label">{r.kind === "project" ? r.name : r.kind === "all" ? `All projects · ${r.count}` : "Create project"}</span>
      </button>
    );
  };

  useEffect(() => {
    if (!colorOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (colorRef.current && !colorRef.current.contains(e.target as Node)) setColorOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [colorOpen]);

  useEffect(() => {
    if (!burgerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (burgerRef.current && !burgerRef.current.contains(e.target as Node)) setBurgerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setBurgerOpen(false); } };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDoc); window.removeEventListener("keydown", onKey, true); };
  }, [burgerOpen]);

  /* Hidden: a 10 px strip. It and its tab open the icon rail (README §5.1). */
  if (closed) {
    return (
      <aside className="ek-sidebar ek-sidebar--closed" onClick={() => onMenu("icons")}>
        <button className="ek-show-menu" type="button" aria-label="Show menu" title="Show menu">›</button>
      </aside>
    );
  }

  // data-studio: signed in, the menu of five with Studio's projects, which folds into the short window's Menu sooner.
  return (
    <aside ref={side} className={"ek-sidebar" + (mobileOpen ? " ek-sidebar--mobile-open" : "")} data-studio={studio ? "" : undefined}>
      {/* Labels ↔ icons where the full column fits, and hide to the strip (README §5.1). */}
      <div className="ek-toggles">
        {canFull && (
          <button
            className="ek-collapse-btn"
            type="button"
            onClick={() => onMenu(rail ? "full" : "icons")}
            aria-label={rail ? "Show labels" : "Icons only"}
            title={rail ? "Show labels" : "Icons only"}
          >
            <Icon name={rail ? "chevronRight" : "chevronLeft"} size={13} stroke={1.5} />
          </button>
        )}
        <button className="ek-collapse-btn" type="button" onClick={() => onMenu("closed")} aria-label="Hide menu" title="Hide menu">
          <Icon name="sidebar" size={12} stroke={1.5} />
        </button>
      </div>

      <a className="ek-logo" onClick={() => onNav("home")}>
        {rail ? (
          <span className="ek-logo-mark"><img className="ek-logo-mark-img" src="/favicon.svg" alt="Enki Art" /></span>
        ) : (
          <img className="ek-logo-img" src="/enki-wordmark.svg" alt="Enki Art" />
        )}
      </a>

      {/* ── Burger: the whole nav, for viewports too short to stand it up ──
          Below the breakpoint the rail simply ran out of room and the list
          scrolled with a hidden scrollbar, so the last items were gone with
          nothing on screen saying so. */}
      <div className="ek-burger-wrap" ref={burgerRef}>
        <button
          className={"ek-burger" + (burgerOpen ? " on" : "")}
          type="button"
          onClick={() => setBurgerOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={burgerOpen}
          aria-label="Menu"
          title="Menu"
        >
          <Icon name="menu" size={18} stroke={2.2} />
          {!rail && <span className="ek-burger-btn-label">Menu</span>}
          {totalBadge > 0 && !burgerOpen && <span className="ek-nav-badge ek-burger-badge">{totalBadge}</span>}
        </button>
        {burgerOpen && (
          <div className="ek-burger-menu" role="menu">
            {nav.map((item) => [
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={"ek-burger-item" + (active === item.id ? " active" : "")}
                disabled={item.soon} title={item.soon ? "Coming soon" : undefined}
                onClick={() => { onNav(item.id); setBurgerOpen(false); }}
              >
                <Icon name={item.icon} size={16} stroke={active === item.id ? 2.4 : 1.9} />
                <span className="ek-burger-label">{item.label}</span>
                {item.badge ? <span className="ek-nav-badge">{item.badge}</span> : null}
              </button>,
              // Studio's projects under it, indented; the popover scrolls.
              item.id === "studio" && subRows(MAX_SUBMENU_PROJECTS + 1).map((r) => subRow(r, "ek-burger-item ek-burger-sub", () => setBurgerOpen(false))),
            ])}
            <div className="ek-burger-sep" />
            {onRefer && (
              <button type="button" role="menuitem" className="ek-burger-item" onClick={() => { onRefer(); setBurgerOpen(false); }}>
                <Icon name="link" size={16} stroke={1.9} />
                <span className="ek-burger-label">Refer a prompt</span>
                <span className="ek-earn-chip">$</span>
              </button>
            )}
            {onFeedback && (
              <button type="button" role="menuitem" className="ek-burger-item" onClick={() => { onFeedback(); setBurgerOpen(false); }}>
                <Icon name="message" size={16} stroke={1.9} />
                <span className="ek-burger-label">Feedback</span>
                <span className="ek-earn-chip">$100</span>
              </button>
            )}
          </div>
        )}
      </div>

      <nav className="ek-nav" aria-label="Main">
        {nav.map((item) => {
          const button = (
            <button key={item.id} className={"ek-nav-item" + (active === item.id ? " active" : "")} onClick={() => onNav(item.id)} type="button"
              disabled={item.soon} title={item.soon ? "Coming soon" : undefined}
              aria-current={active === item.id ? "page" : undefined}>
              <span className="ek-nav-ico"><Icon name={item.icon} size={21} stroke={1.5} /></span>
              {!rail && <span className="ek-nav-label">{item.label}{item.soon && <span className="ek-nav-soon"> · soon</span>}</span>}
              {item.badge ? <span className="ek-nav-badge">{item.badge}</span> : null}
              {rail && <span className="ek-nav-tip">{item.label}</span>}
            </button>
          );
          // The rail keeps Studio a plain icon: its projects wait in the column (their open state kept for it).
          if (item.id !== "studio" || !studio || rail) return button;
          return (
            <div key={item.id} className="ek-nav-group">
              <div className="ek-nav-row">
                {button}
                {/* The chevron only opens and closes; the item itself opens the overview. Siblings, never nested. */}
                <button type="button" className="ek-sub-toggle kit-hit" onClick={studio.onToggle} aria-expanded={studio.open}
                  aria-controls="ek-studio-sub" aria-label={studio.open ? "Hide projects" : "Show projects"} title={studio.open ? "Hide projects" : "Show projects"}>
                  <Icon name="chevronRight" size={14} stroke={2} />
                </button>
              </div>
              <div ref={sub} className="ek-sub" data-open={studio.open || undefined}>
                <div id="ek-studio-sub" className="ek-sub-in" role="group" aria-label="Projects" inert={!studio.open}>
                  {subRows(phone ? MAX_SUBMENU_PROJECTS + 1 : room).map((r) => subRow(r, "ek-sub-row"))}
                </div>
              </div>
            </div>
          );
        })}
      </nav>

      {/* ── Earn money: refer a prompt, then feedback; both pay out ── */}
      {!rail ? (
        <div className="ek-earn-lab">
          <span>Earn money</span>
          <span className="ek-earn-rule" />
        </div>
      ) : <span className="ek-rail-rule" />}
      {/* Open for everyone — guests get the popup and a greyed submit
          inside it, so they SEE what there is to earn (Kev, 2026-08-23). */}
      {onRefer && (
        <button className="ek-earn-row" onClick={onRefer} type="button" title="Refer a prompt — paste a post, it opens in the editor">
          <Icon name="link" size={18} stroke={1.5} />
          {!rail && <span className="ek-earn-label">Refer a prompt</span>}
          <span className={"ek-earn-chip" + (rail ? " ek-earn-chip--rail" : "")}>$</span>
          {rail && <span className="ek-nav-tip">Refer a prompt</span>}
        </button>
      )}
      {onFeedback && (
        <button className="ek-earn-row" onClick={onFeedback} type="button" title="Feedback — win $100 if we build your change">
          <Icon name="message" size={18} stroke={1.5} />
          {!rail && <span className="ek-earn-label">Feedback</span>}
          <span className={"ek-earn-chip" + (rail ? " ek-earn-chip--rail" : "")}>{rail ? "$" : "$100"}</span>
          {rail && <span className="ek-nav-tip">Feedback · win $100</span>}
        </button>
      )}

      <button className="ek-create" onClick={onCreate} type="button" title="Create Prompt">
        <Icon name="pen" size={20} stroke={1.5} />
        {!rail && <span className="ek-create-label">Create Prompt</span>}
        {rail && <span className="ek-nav-tip">Create Prompt</span>}
      </button>

      <div ref={spacer} className="ek-side-spacer" />

      <div className="ek-account" role="button" onClick={onProfile} title="View profile" ref={colorRef}>
        {/* The account's seal: no profile pictures on Enki (Kev, 2026-10-26). */}
        <span className="ek-avatar"><Seal handle={account.handle} /></span>
        {!rail && (
          <>
            <span className="ek-account-info">
              <span className="ek-account-nametext">{clip10(account.name)}</span>
              <span className="ek-account-handle">@{clip10(account.handle)}</span>
            </span>
            {/* money + log off stacked at the far right — long names stay clear.
                No balance chip for guests: $0 opened the payment settings for
                someone who cannot pay yet — login comes first (Kev,
                2026-08-24). */}
            <span className="ek-account-side">
              {!guest && (
                <span className="ek-balance" onClick={(e) => { e.stopPropagation(); onTopUp(); }} title="Add funds">
                  {balance}
                </span>
              )}
              {onLogoff && (
                <button
                  className="ek-logoff"
                  type="button"
                  title="Log off"
                  aria-label="Log off"
                  onClick={(e) => { e.stopPropagation(); onLogoff(); }}
                >
                  <Icon name="logout" size={13} stroke={2.2} />
                </button>
              )}
            </span>
          </>
        )}
        {/* 3-dot menu (hover to reveal; always shown on touch): Settings and the color theme live here. Settings came
            from the main list, which holds four places now (Kev, 2026-10-30: Explore, Create, Studio, Inbox). */}
        <button
          className={"ek-kebab" + (colorOpen ? " on" : "") + (rail ? " ek-kebab--rail" : "")}
          type="button"
          title="Options"
          aria-haspopup="menu"
          aria-expanded={colorOpen}
          onClick={(e) => { e.stopPropagation(); setColorOpen((o) => !o); }}
        >
          <Icon name="dots" size={14} stroke={2.2} />
        </button>
        {colorOpen && (
          <div className="ek-color-dd ek-color-dd--up" onClick={(e) => e.stopPropagation()}>
            {onSettings && (
              <button type="button" className="ek-color-opt ek-settings-opt" onClick={() => { setColorOpen(false); onSettings(); }}>
                <Icon name="settings" size={16} stroke={1.9} />
                Settings
              </button>
            )}
            <div className="ek-color-dd-h">Color theme</div>
            {THEME_OPTS.map((t) => (
              <button key={t.id} type="button" className={"ek-color-opt" + (theme === t.id ? " active" : "")} onClick={() => setTheme(t.id)}>
                <span className="ek-color-sw" style={{ background: t.sw }} />
                {t.name}
                {theme === t.id && <span className="ek-color-check"><Icon name="check" size={16} stroke={2.4} /></span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
