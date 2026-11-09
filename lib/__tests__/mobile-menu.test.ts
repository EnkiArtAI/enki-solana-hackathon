import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

// Absolute, so the in-memory mutant runner reaches what these pins read (__bench-mutant.setup.mjs matches on the path).
const src = (p: string) => readSource(join(__dirname, "..", "..", p));

/**
 * The phone's menu (Kev, 2026-10-26): "the burger menu on the top right doesnt
 * make sense, it has to be on the left, on the left to the Enki logo" and
 * "links möchte ich dann die menüfelder sehen und nicht nochmal Menü".
 */
const HOME = src("components/enki-shell/EnkiHome.tsx");
const CSS = src("components/enki-shell/enki-shell.css");

describe("the phone's menu", () => {
  it("opens from the left of the header, before the logo, and the logo goes home", () => {
    const head = HOME.slice(HOME.indexOf('<header className={"ek-mobile-header"'), HOME.indexOf("</header>"));
    expect(head.indexOf('<div className="ek-mobile-header-left">')).toBeGreaterThan(-1);
    expect(head.indexOf('className="ek-mobile-burger-btn kit-hit"')).toBeGreaterThan(head.indexOf('<div className="ek-mobile-header-left">'));
    expect(head.indexOf('className="ek-mobile-burger-btn kit-hit"')).toBeLessThan(head.indexOf('className="ek-mobile-header-logo"'));
    expect(head.indexOf('className="ek-mobile-burger-btn kit-hit"')).toBeLessThan(head.indexOf('<div className="ek-mobile-header-right">'));
    expect(head).toContain('<button type="button" className="ek-mobile-header-home" onClick={() => onNav("home")} aria-label="Home">');
    // One menu button in the header, the left one.
    expect(head.split('className="ek-mobile-burger-btn kit-hit"')).toHaveLength(2);
  });

  it("lists every item in its drawer, never a Menu button inside the menu, whatever the window's height", () => {
    const phone = CSS.slice(CSS.indexOf("@media (max-width: 767.98px)"));
    expect(phone).toContain("  .ek-sidebar .ek-burger-wrap { display: none; }\n  .ek-sidebar .ek-nav { display: flex; }");
    expect(phone).toContain("  .ek-sidebar .ek-earn-lab, .ek-sidebar .ek-earn-row { display: flex; }\n  .ek-sidebar .ek-rail-rule { display: block; }");
  });
});

describe("the closed drawer", () => {
  // Kev, 2026-10-26: "warum habe ich links so ne komische leiste in der mobile view?" (its shadow, 40 px into the page).
  it("casts no shadow into the page; only the open one does", () => {
    const phone = CSS.slice(CSS.indexOf("@media (max-width: 767.98px)"));
    const drawer = phone.slice(phone.indexOf("  .ek-sidebar {"), phone.indexOf("  .ek-sidebar.ek-sidebar--mobile-open {"));
    expect(drawer).toContain("box-shadow: none;");
    expect(drawer).not.toMatch(/box-shadow: \d/);
    expect(phone).toContain("  .ek-sidebar.ek-sidebar--mobile-open {\n    transform: translateX(0) !important;\n    box-shadow: 8px 0 32px rgba(0, 0, 0, 0.35);\n  }");
  });
});

describe("the open menu (Kev, 2026-10-26: \"statt das x ... dass das burger menü an der gleichen stelle bleibt\")", () => {
  const SIDEBAR = src("components/enki-shell/EnkiSidebar.tsx");
  const phone = CSS.slice(CSS.indexOf("@media (max-width: 767.98px)"));

  it("keeps the burger where it was, a burger, and it closes the menu", () => {
    const head = HOME.slice(HOME.indexOf('<header className={"ek-mobile-header"'), HOME.indexOf("</header>"));
    expect(head).toContain('<header className={"ek-mobile-header" + (mobileDrawerOpen ? " ek-mobile-header--menu" : "")}>');
    // Tucked or not, the burger toggles the menu (Kev, 2026-10-27; tuck.test.ts).
    expect(head).toContain("onClick={() => setMobileDrawerOpen((o) => !o)}");
    expect(head).toContain('aria-label={mobileDrawerOpen ? "Close menu" : "Open menu"}');
    expect(head).toContain('<Icon name="menu" size={18} stroke={2.2} />');
    expect(head).not.toContain('"x"');
  });

  it("lifts the header over the drawer and its scrim while open, and hangs the drawer below it", () => {
    expect(phone).toContain("  .ek-mobile-header.ek-mobile-header--menu { z-index: 167; }");
    expect(phone).toMatch(/\.ek-mobile-drawer-scrim \{[^}]*z-index: 164;/);
    expect(phone).toMatch(/  \.ek-sidebar \{[^}]*z-index: 166 !important;[^}]*top: calc\(var\(--ek-head-h\) \+ var\(--ek-banner-h, 0px\)\) !important;/);
    expect(phone).toContain("  .ek-sidebar .ek-logo { display: none; }");
  });

  it("has no close button of its own any more", () => {
    expect(SIDEBAR).not.toContain("ek-sidebar-mobile-close");
    expect(SIDEBAR).not.toContain("onCloseMobile");
    expect(HOME).not.toContain("onCloseMobile");
    expect(CSS).not.toContain("ek-sidebar-mobile-close");
  });
});

describe("the drawer's account row (Kev, 2026-10-26: \"zu hoch und füllt zu viel aus\")", () => {
  it("is lower on a phone: smaller seal, tighter padding, the balance and log off stacked closer", () => {
    const phone = CSS.slice(CSS.indexOf("@media (max-width: 767.98px)"));
    expect(phone).toContain("  .ek-sidebar .ek-account { padding: 5px 8px; gap: 10px; }\n  .ek-sidebar .ek-avatar { width: 34px; height: 34px; }\n  .ek-sidebar .ek-account-side { gap: 3px; }\n  .ek-sidebar .ek-balance { height: 21px; }\n  .ek-sidebar .ek-logoff { width: 21px; height: 21px; }");
  });

  it("still gives the balance and log off a 24 px press each, so a near miss is not the profile", () => {
    const phone = CSS.slice(CSS.indexOf("@media (max-width: 767.98px)"));
    expect(phone).toContain('  .ek-sidebar :is(.ek-balance, .ek-logoff) { position: relative; }\n  .ek-sidebar :is(.ek-balance, .ek-logoff)::after { content: ""; position: absolute; inset: -2.5px; }');
  });
});

describe("the phone header's right side (Kev, 2026-10-26: \"oben rechts notifications. neben funds\")", () => {
  const head = () => HOME.slice(HOME.indexOf('<header className={"ek-mobile-header"'), HOME.indexOf("</header>"));

  // It opens Inbox on its Notifications since 2026-10-30 (shell-menu.test.ts).
  it("has the notifications bell at the top right, with the unseen count; signed in only", () => {
    const right = head().slice(head().indexOf('<div className="ek-mobile-header-right">'));
    expect(right).toMatch(/\{authed && \(\n\s+<button type="button" className="ek-mobile-bell kit-hit" onClick=\{\(\) => onNav\("inbox", "notifications"\)\}/);
    expect(right).toContain('{unseen > 0 && <span className="ek-mobile-burger-badge">{unseen}</span>}');
  });

  // Kev, 2026-10-29: "remove bitte doch the profile image and the dollar on the top right corner wo auch immer das so
  // auftaucht" (it had been put there 2026-10-27); the menu's account row holds both.
  it("shows no funds and no seal there; a guest signs in at the corner", () => {
    const right = head().slice(head().indexOf('<div className="ek-mobile-header-right">'));
    expect(right).not.toContain("ek-mobile-balance");
    expect(right).not.toContain("<Seal");
    expect(right).not.toContain('openPanel("profile")');
    const account = right.slice(right.indexOf('className="ek-mobile-account kit-hit"'));
    expect(right).toMatch(/\{!authed && \(\n\s+<button type="button" className="ek-mobile-account kit-hit" aria-label="Log in" onClick=\{\(\) => openLogin\(\)\}>/);
    expect(account).toContain('<Icon name="user" size={16} stroke={2} />');
    const phone = CSS.slice(CSS.indexOf("@media (max-width: 767.98px)"));
    expect(phone).toContain("  .ek-mobile-burger-btn,\n  .ek-mobile-bell,\n  .ek-mobile-account {");
    // The account row in the menu keeps the balance and the profile.
    expect(HOME).toContain("balance={balanceText}");
    expect(HOME).toContain('onProfile={() => openPanel("profile")}');
  });

  it("leaves the menu's badge to the unread messages, so no count shows twice", () => {
    expect(head()).toContain('{authed && dmUnread > 0 && !mobileDrawerOpen && (\n              <span className="ek-mobile-burger-badge">{dmUnread}</span>');
    expect(head()).not.toContain("unseen + dmUnread");
  });

  it("keeps that header over an open image: the view starts below it and hides its own phone header", () => {
    const frame = src("components/image-view/image-view-frame.css");
    const phone = frame.slice(frame.indexOf("@media (max-width: 767.98px)"));
    // Under the header, or in its place while the image's own scroll has it tucked (tuck.test.ts).
    expect(phone).toContain("  .ek-app .iv-frame { top: calc(var(--ek-slot, var(--ek-banner-h, 0px)) + var(--ek-head, 46px)); transition: top 0.2s ease; }\n  .ek-app .iv-frame .iv-top--phone { display: none; }");
    expect(CSS).toMatch(/\.ek-mobile-header \{[^}]*height: var\(--ek-head-h\);/);
  });
});

describe("the phone header's background (Kev, 2026-10-26: images showed through it)", () => {
  it("is solid paper, nothing blurred through it", () => {
    const phone = CSS.slice(CSS.indexOf("@media (max-width: 767.98px)"));
    const head = phone.match(/  \.ek-mobile-header \{[^}]*\}/)![0];
    expect(head).toContain("background: var(--enki-paper);");
    expect(head).not.toMatch(/backdrop-filter|header-bg/);
  });
});

describe("the phone header's height (Kev, 2026-10-27: \"the top menü a bit thinner\")", () => {
  const phone = CSS.slice(CSS.indexOf("@media (max-width: 767.98px)"));

  it("is 46 px, named once, and everything under it starts there", () => {
    expect(phone).toContain("  .ek-app { --ek-head-h: 46px; --ek-head: var(--ek-head-h); --ek-slot: var(--ek-banner-h, 0px); }");
    // The header, the drawer and the page; the open panel follows the tuck's --ek-head (tuck.test.ts).
    expect(phone.match(/var\(--ek-head-h\)/g)).toHaveLength(4);
    expect(phone).toMatch(/  \.ek-main \{[^}]*padding-top: calc\(var\(--ek-head-h\) \+ var\(--ek-banner-h, 0px\)\);/);
  });

  it("holds 32 px round buttons and a 24 px logo", () => {
    expect(phone).toContain("  .ek-mobile-account {\n    flex-shrink: 0;\n    width: 32px;\n    height: 32px;");
    expect(phone).toMatch(/  \.ek-mobile-header-logo \{\n    height: 24px;/);
  });

  it("spaces the right side's buttons so their 44 px presses never overlap (review 2026-10-27)", () => {
    // 32 px drawn + 12 px gap = 44 px: each press ends where the next begins.
    expect(phone).toMatch(/  \.ek-mobile-header-right \{\n    display: flex;\n    align-items: center;\n    gap: 12px;\n  \}/);
  });
});
