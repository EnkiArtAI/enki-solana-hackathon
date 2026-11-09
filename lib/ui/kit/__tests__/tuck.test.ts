import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { TUCK_STEP, TUCK_TOP, tuckScroll, tuckScroller, tuckStep, type Scroller } from "../tuck";

// Absolute, so the in-memory mutant runner reaches what these pins read.
const src = (p: string) => readSource(join(__dirname, "..", "..", "..", "..", p));

describe("the phone header tucking away (Kev, 2026-10-26)", () => {
  it("tucks on a scroll down past the step, shows on a scroll up past it, keeps still in between", () => {
    expect(tuckStep(100, 100 + TUCK_STEP + 1)).toEqual({ tucked: true, last: 109 });
    expect(tuckStep(300, 300 - TUCK_STEP - 1)).toEqual({ tucked: false, last: 291 });
    expect(tuckStep(300, 300 + TUCK_STEP)).toEqual({ tucked: null, last: 300 });
    expect(tuckStep(300, 300 - TUCK_STEP)).toEqual({ tucked: null, last: 300 });
  });

  it("always shows near the top", () => {
    expect(tuckStep(0, TUCK_TOP - 1)).toEqual({ tucked: false, last: TUCK_TOP - 1 });
    expect(tuckStep(0, TUCK_TOP + TUCK_STEP + 1).tucked).toBe(true);
  });

  it("is wired to every scroll on a phone, measured per scroller; a tap on the small burger opens the menu (Kev, 2026-10-27)", () => {
    const home = src("components/enki-shell/EnkiHome.tsx");
    expect(home).toContain('document.addEventListener("scroll", onScroll, { capture: true, passive: true });');
    expect(home).toContain('return () => {\n      document.removeEventListener("scroll", onScroll, { capture: true });');
    expect(home).toContain("const el = e.target instanceof Element ? e.target : null;");
    // An open image scrolls in its own frame: it tucks as "image", never as the panel or the feed under it (review and Kev, 2026-10-27).
    // Only the view's own scroller counts, not its History column or a settings row (review 2026-10-27).
    expect(home).toContain('const frame = document.querySelector(".iv-frame:not(.is-hidden)");\n      if (!frame && el?.closest(".iv-frame")) return;\n      const view = frame && { contains: (n: Element) => frame.contains(n) && n.matches("[data-scroll]") };\n      const s = tuckScroller<Element>(el, page, view || box);');
    expect(home).toContain('if (step.tucked !== null) setTucked(step.tucked && (frame ? "image" : panel ?? "feed"));');
    // Every image opens untucked, and a closed one leaves no tuck behind: EnkiDetailPanel raises enki:detail-open both
    // times (review 2026-10-27), the shell drops an image's tuck.
    expect(home).toContain('const onImage = () => setTucked((t) => (t === "image" ? false : t));\n    window.addEventListener("enki:detail-open", onImage);');
    expect(home).toContain('window.removeEventListener("enki:detail-open", onImage);');
    expect(src("components/enki/EnkiDetailPanel.tsx")).toMatch(/useEffect\(\(\) => \{\n\s+const drop = \(\) => \{ window\.dispatchEvent\(new Event\("enki:detail-open"\)\); \};\n\s+drop\(\);\n\s+return drop;\n\s+\}, \[id\]\);/);
    // The composer's sticky head stays while tucked (Kev, 2026-10-27; DEC-455), and reduced motion keeps the frame still.
    expect(src("components/image-view/Composer.tsx")).toContain('<div ref={head} className="iv-mode-head">');
    expect(src("components/image-view/image-view-frame.css")).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s+\.iv-frame, \.ek-app \.iv-frame \{ transition: none; \}\s+\}/);
    expect(home).toContain('const box = panel ? document.querySelector(".ek-panel") : null;');
    // The page ends where the window does (iOS toolbar; review 2026-10-27).
    expect(home).toContain("const step = tuckScroll(s, lasts.get(s), s === page ? window.innerHeight : undefined);\n      lasts.set(s, step.last);");
    // One creator's page to the next keeps the panel's name, so the tuck resets (review 2026-10-27).
    expect(home).toContain('openPanel("creator", undefined, String(h));');
    expect(home).toContain("const lasts = new WeakMap<Element, number>([[page, page.scrollTop]]);");
    expect(home).toContain("}, [phone, panel]);");
    // "wenn ich runter scrolle und dann das menü oben weg ist, und ich auf bürger erneut drücke, so soll auch das menü
    // links aufkommen": tucked or not, the burger only ever toggles the menu; the open menu shows the header (shownTucked).
    expect(home).toContain("onClick={() => setMobileDrawerOpen((o) => !o)}");
    expect(home).toContain('aria-label={mobileDrawerOpen ? "Close menu" : "Open menu"}');
    expect(home).not.toContain("Show the header");
    // Only over what tucked it, never over the drawer (review 2026-10-26).
    expect(home).toContain('const shownTucked = phone && !mobileDrawerOpen && (tucked === (panel ?? "feed") || tucked === "image");');
    expect(home).toContain('+ (shownTucked ? (tucked === "image" ? " ek-tucked-image" : " ek-tucked") : "");');
    expect(home).toMatch(/function openPanel\(id: string, tab\?: string, handle\?: string, place\?: StudioPlace & \{ community\?: string \}\) \{\n\s+setMobileDrawerOpen\(false\);\n\s+setTucked\(false\);/);
  });

  it("hides the header but its small burger, and moves the category bar up beside it; over an open image only the image's own tuck counts", () => {
    const css = src("components/enki-shell/enki-shell.css");
    const phone = css.slice(css.indexOf("@media (max-width: 767.98px)"));
    const T = ":is(.ek-tucked:not(:has(.iv-frame:not(.is-hidden))), .ek-tucked-image:has(.iv-frame:not(.is-hidden)))";
    expect(phone).toContain(`${T} { --ek-head: 0px; --ek-slot: 0px; }`);
    expect(phone).toContain(`${T} :is(.ek-mobile-header-home, .ek-mobile-header-right) { opacity: 0; visibility: hidden; }`);
    expect(phone).toContain(`${T} .ek-mobile-burger-btn { pointer-events: auto; transform: translateY(-5px) scale(0.78);`);
    expect(phone).toContain(`${T} .ek-mobile-header { background: transparent; border-bottom-color: transparent; pointer-events: none; }`);
    // The image tuck: the view moves up into the header's place, the small burger stays above it (z 163 over 162).
    expect(phone).toContain("  .ek-app.ek-tucked-image:has(.iv-frame:not(.is-hidden)) .ek-mobile-header:not(.ek-mobile-header--menu) { z-index: 163; }");
    // The composer's head stays over the image and, stuck, stops under the small burger (5 to 30 px; DEC-455).
    expect(phone).toContain("  .ek-app.ek-tucked-image:has(.iv-frame:not(.is-hidden)) .iv-mode-head { top: 14px; }");
    const feed = src("components/enki/feed.css");
    // Image | Video | Remix sits under the header, the categories under it (Kev, 2026-10-30).
    expect(feed).toContain(".feed-world { top: calc(var(--ek-head, 46px) + var(--ek-banner-h, 0px));");
    expect(feed).toContain(".feed-bar { top: calc(var(--ek-head, 46px) + var(--ek-banner-h, 0px) + var(--feed-world-h));");
    // The worlds, the categories, the filter and the search go up with the header (Kev, 2026-10-27).
    expect(feed).toContain(".ek-tucked .feed-world { transform: translateY(calc(-100% - var(--ek-banner-h, 0px))); }");
    expect(feed).toContain(".ek-tucked .feed-bar { transform: translateY(calc(-100% - var(--ek-banner-h, 0px) - var(--feed-world-h))); }");
    expect(feed).toMatch(/\.feed-bar \{ top: calc\(var\(--ek-head, 46px\) \+ var\(--ek-banner-h, 0px\) \+ var\(--feed-world-h\)\); transition: top 0\.2s ease, transform 0\.2s ease; \}/);
  });
});

describe("the header tucking in every menu (Kev, 2026-10-27: \"when scrolling through ANY menü, this goes also for profile\")", () => {
  const box = (h: number, ch: number): Scroller => ({ scrollTop: 0, scrollHeight: h, clientHeight: ch });
  const page = box(4000, 800);
  const body = box(3000, 760);
  const strip = box(40, 40); // scrolls only sideways
  const behind = box(900, 300); // on the page, not in the panel
  const panel = { contains: (n: Scroller) => n === body || n === strip };

  it("follows the page while no panel is up, and nothing else on it", () => {
    expect(tuckScroller(null, page, null)).toBe(page);
    expect(tuckScroller(page, page, null)).toBe(page);
    expect(tuckScroller(behind, page, null)).toBeNull();
  });

  it("follows what runs up and down inside an open panel, never the page behind it nor a sideways strip", () => {
    expect(tuckScroller(body, page, panel)).toBe(body);
    expect(tuckScroller(null, page, panel)).toBeNull();
    expect(tuckScroller(page, page, panel)).toBeNull();
    expect(tuckScroller(behind, page, panel)).toBeNull();
    expect(tuckScroller(strip, page, panel)).toBeNull();
  });

  it("ignores a page too short to scroll", () => {
    expect(tuckScroller(null, box(800, 800), null)).toBeNull();
  });

  it("measures inside the scroller: a bounce past either end is no scroll back", () => {
    const at = (scrollTop: number): Scroller => ({ scrollTop, scrollHeight: 2000, clientHeight: 800 });
    // Past the end (1200) and the spring back from there: no move.
    expect(tuckScroll(at(1300), 1200)).toEqual({ tucked: null, last: 1200 });
    expect(tuckScroll(at(1200), 1200)).toEqual({ tucked: null, last: 1200 });
    expect(tuckScroll(at(1100), 1000)).toEqual({ tucked: true, last: 1100 });
    expect(tuckScroll(at(-40), 10)).toEqual({ tucked: false, last: 0 });
  });

  it("takes no tuck's own growth for a scroll up: a panel just taller than the screen stays tucked", () => {
    // 853 px of profile in a 738 px panel, scrolled to its end; tucked, the panel is 784 px and its end 69.
    expect(tuckScroll({ scrollTop: 115, scrollHeight: 853, clientHeight: 738 }, 100)).toEqual({ tucked: true, last: 115 });
    expect(tuckScroll({ scrollTop: 69, scrollHeight: 853, clientHeight: 784 }, 115)).toEqual({ tucked: null, last: 69 });
    // A browser settles a fraction short of the end (the pane: 68.x of 69).
    expect(tuckScroll({ scrollTop: 68.4, scrollHeight: 853, clientHeight: 784 }, 115)).toEqual({ tucked: null, last: 68.4 });
    // The reader then scrolling up does count, from where the growth left it.
    expect(tuckScroll({ scrollTop: 59, scrollHeight: 853, clientHeight: 784 }, 69)).toEqual({ tucked: false, last: 59 });
  });

  it("takes a bounce at a tucked end short of TUCK_TOP for no move (review 2026-10-27)", () => {
    // 830 px in a 738 px body: tucked at 784 px its end is 46, under TUCK_TOP, and iOS bounces there.
    expect(tuckScroll({ scrollTop: 66, scrollHeight: 830, clientHeight: 784 }, 46)).toEqual({ tucked: null, last: 46 });
    expect(tuckScroll({ scrollTop: 46, scrollHeight: 830, clientHeight: 784 }, 46)).toEqual({ tucked: null, last: 46 });
    // Leaving the end upwards still shows it.
    expect(tuckScroll({ scrollTop: 30, scrollHeight: 830, clientHeight: 784 }, 46)).toEqual({ tucked: false, last: 30 });
  });

  it("ends the page where the window does, not its shorter layout height (iOS toolbar; review 2026-10-27)", () => {
    const page = { scrollTop: 1290, scrollHeight: 2000, clientHeight: 700 };
    // The window shows 750 px: the end is 1250, so a bounce to 1290 and back is no move.
    expect(tuckScroll(page, 1250, 750)).toEqual({ tucked: null, last: 1250 });
    expect(tuckScroll({ ...page, scrollTop: 1250 }, 1250, 750)).toEqual({ tucked: null, last: 1250 });
    // A window taller than the page: the end is its top, never above it.
    expect(tuckScroll({ scrollTop: 0, scrollHeight: 800, clientHeight: 780 }, 0, 812)).toEqual({ tucked: null, last: 0 });
  });

  it("starts measuring where a scroller is on its first scroll", () => {
    expect(tuckScroll({ scrollTop: 500, scrollHeight: 2000, clientHeight: 800 }, undefined)).toEqual({ tucked: null, last: 500 });
  });

  it("moves the open panel up into the header's place and keeps the small burger above it; the open menu stays on top", () => {
    const css = src("components/enki-shell/enki-shell.css");
    const phone = css.slice(css.indexOf("@media (max-width: 767.98px)"));
    expect(phone).toMatch(/  \.ek-panel-scrim \{[^}]*top: calc\(var\(--ek-head\) \+ var\(--ek-slot\)\) !important;[^}]*transition: top 0\.2s ease;/);
    // Only while tucked: shown, the header stays under the panel's own lightbox and modals (review 2026-10-27).
    expect(phone).toContain("  .ek-app.ek-tucked:has(.ek-panel-scrim) .ek-mobile-header:not(.ek-mobile-header--menu) { z-index: 161; }");
    expect(phone).not.toContain("  .ek-app:has(.ek-panel-scrim) .ek-mobile-header");
    expect(phone).toMatch(/  \.ek-panel-scrim \{[^}]*z-index: 160 !important;/);
  });
});

describe("every top row giving way (Kev, 2026-10-27: \"the entire top rows ... disappears with only the burger menu staying\")", () => {
  const css = src("components/enki-shell/enki-shell.css");
  const phone = css.slice(css.indexOf("@media (max-width: 767.98px)"));
  const T = ":is(.ek-tucked:not(:has(.iv-frame:not(.is-hidden))), .ek-tucked-image:has(.iv-frame:not(.is-hidden)))";

  it("sends the top slot up (the 2FA bar, a trial line, the recovery warning) and the header to the very top", () => {
    expect(phone).toContain("  .ek-app { --ek-head-h: 46px; --ek-head: var(--ek-head-h); --ek-slot: var(--ek-banner-h, 0px); }");
    expect(phone).toContain(`  ${T} { --ek-head: 0px; --ek-slot: 0px; }`);
    expect(phone).toContain("  html:is(:has(.ek-tucked):not(:has(.iv-frame:not(.is-hidden))), :has(.ek-tucked-image .iv-frame:not(.is-hidden))) :is(.ek-top-slot, .ek-recovery-banner) { transform: translateY(-100%); }");
    expect(phone).toMatch(/  \.ek-mobile-header \{[^}]*position: fixed;\n\s+top: var\(--ek-slot\);/);
    const bar = src("components/SecondFactorBar.tsx");
    expect(bar).toContain('if (trial) return <div className="ek-top-slot" style={{ ...BAR, background: "#7d1d33", cursor: "default" }}>');
    expect(bar).toMatch(/<button\n\s+type="button"\n\s+className="ek-top-slot"\n\s+onClick=\{open\}/);
  });

  it("fades every row a panel marks: its arrow, Settings' Back, the profile's name bar; the profile's tabs stay", () => {
    expect(phone).toContain(`  ${T} .ek-tuck-hide { opacity: 0; visibility: hidden; }`);
    expect(src("components/enki-shell/EnkiPanel.tsx")).toContain('<button type="button" className="ek-panel-back kit-hit ek-tuck-hide" onClick={onClose}');
    expect(src("components/settings/SettingsLayout.tsx")).toContain('<button type="button" className="set-back ek-tuck-hide" onClick={onBack}>');
    const profile = src("components/profile/ProfileView.tsx");
    expect(profile).toMatch(/<div className="ek-tuck-hide" style=\{\{\n\s+position: "sticky", top: "var\(--ek-page-top, 0px\)", zIndex: 60,/);
    // Its tabs stay (Kev, 2026-10-27; DEC-458): stuck while tucked, they stop under the small burger (5 to 30 px).
    expect(profile).toMatch(/\n\s+<div className="pf-tabs" style=\{\{\n\s+borderTop: "1px solid var\(--enki-rule\)",[\s\S]{0,200}position: "sticky",\n\s+top: "var\(--pf-tabs-top, calc\(52px \+ var\(--ek-page-top, 0px\)\)\)"/);
    expect(phone).toContain("  .ek-app.ek-tucked { --pf-tabs-top: 14px; }");
  });

  // DEC-466 (Kev, 2026-10-27: "that weird bar above released gallery"): the pictures showed through above the stuck rows.
  it("fills the strip above the stuck rows with paper that takes a tap, no taller than the empty room above them", () => {
    expect(phone).toContain('  .ek-app.ek-tucked .pf-tabs::before { content: ""; position: absolute; left: 0; right: 0; bottom: calc(100% + 1px); height: 28px; background: var(--enki-paper); }');
    expect(src("components/profile/ProfileView.tsx")).toContain('marginBottom: "clamp(28px, 5vw, 60px)" }}>');
    expect(phone).toContain('  .ek-app.ek-tucked-image:has(.iv-frame:not(.is-hidden)) .iv-mode-head::before { content: ""; position: absolute; left: 0; right: 0; bottom: 100%; height: 14px; background: var(--enki-paper); }');
    expect(src("components/image-view/image-view-mobile.css")).toMatch(/\.iv-mscroll \{[^}]*gap: 14px;/);
  });

  it("lets a short shelf scroll far enough for the tabs to reach that place", () => {
    expect(phone).toContain("  .ek-panel .pf-tabs + .pf-wrap { min-height: calc(100dvh - 80px); }");
  });
});

// DEC-500 (Kev, 2026-10-29: "the home button took me not to home but to another previous menu"): Home closes the
// panel an image was opened from too; it supersedes the 2026-10-26 rule that closed only the image.
it("ends on the feed from an image opened in a panel: Home closes the panel and every view", () => {
  const home = src("components/enki-shell/EnkiHome.tsx");
  // The panel is in the address since 2026-10-30: Explore writes it out as a page of its own (shell-menu.test.ts, Back).
  expect(home).toMatch(/if \(id === "home"\) \{[\s\S]*?const hadPanel = panel !== null;[\s\S]*?if \(detailEl \|\| hadPanel\) \{\n\s+if \(window\.location\.pathname !== "\/home" \|\| tool\) router\.push\("\/home"\);\n\s+else if \(hadPanel\) leavePanel\(\);/);
  expect(home).not.toContain('if (panel && document.querySelector(".iv-frame:not(.is-hidden)"))');
});
