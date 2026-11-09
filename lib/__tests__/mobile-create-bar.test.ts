import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

// Absolute, so the in-memory mutant runner reaches what these pins read (__bench-mutant.setup.mjs matches on the path).
const src = (p: string) => readSource(join(__dirname, "..", "..", p));

/**
 * The phone's ways to make something. Kev, 2026-10-27: "i really dont like the bottom menü at all. get rid of that
 * ... quick create als diese bubble zurück on the bottom right und home ist basically clickbar auf enki logo oder auf
 * home im menü"; before that (2026-10-26) "von quick create rüber zu prompt creation problemlos wechseln".
 */
const HOME = src("components/enki-shell/EnkiHome.tsx");
const CSS = src("components/enki-shell/enki-shell.css");
const LAUNCHER = src("components/GenerateLauncher.tsx");
const MODAL = src("components/EnkiMobileGenerateModal.tsx");

describe("a phone without the bottom bar", () => {
  const phone = CSS.slice(CSS.indexOf("@media (max-width: 767.98px)"));

  it("renders no bar; Home is the header's logo and the menu's Home, Create prompt the menu's", () => {
    expect(HOME).not.toMatch(/<nav className="ek-mobile-bottom-nav"|ek-mobile-nav-btn|const quickCreate/);
    expect(CSS).not.toMatch(/ek-mobile-bottom-nav|ek-mobile-nav-/);
    expect(HOME).toContain('<button type="button" className="ek-mobile-header-home" onClick={() => onNav("home")} aria-label="Home">');
    // The feed's menu item is Explore since 2026-10-30 (shell-menu.test.ts).
    expect(HOME).toContain('{ id: "home", label: "Explore", icon: "grid" },');
    expect(HOME).toContain("onCreate={createPrompt}");
  });

  it("shows Quick Create's round button, never hidden on a phone, placed by the stylesheet alone", () => {
    expect(CSS).not.toMatch(/\.ek-generate-launcher \{[^}]*display: none/);
    expect(LAUNCHER).toContain('<div className="ek-generate-launcher">');
  });

  // Kev, 2026-10-27: "bisschen smaller and make the durchmesser ähnlich klein wie halt the burger menü icon", then
  // "quick create button sollte unten rechts sein" and "mach quick create button slightly larger at mobile".
  it("puts it at the bottom right on a phone, 16 px in, at 40 px (a little over the burger's 32) with a 44 px press; the sheet pops from that corner", () => {
    const qc = src("app/editor/mobile-modal.css");
    const phone = qc.slice(qc.indexOf("@media (max-width: 767.98px)"));
    expect(phone).toMatch(/^@media \(max-width: 767\.98px\) \{\n  \.ek-generate-launcher \{ right: 16px; bottom: calc\(16px \+ env\(safe-area-inset-bottom, 0px\)\); \}\n  \.ek-generate-fab \{ width: 40px; height: 40px;/);
    expect(phone).toContain("  .ek-generate-fab svg { width: 19px; height: 19px; }\n}");
    expect(qc).not.toMatch(/left: 16px|qcPopLeft/);
    expect(qc).toMatch(/\.qc-pop \.mobile-modal-sheet \{ animation: qcPop[^}]*transform-origin: 100% 100%; \}/);
    expect(LAUNCHER).toContain('className="ek-generate-fab kit-hit"');
    // The header's burger is 32 px (mobile-menu.test.ts); the desktop's button stays 56 px.
    expect(CSS).toMatch(/  \.ek-mobile-burger-btn,\n  \.ek-mobile-bell,\n  \.ek-mobile-account \{\n    flex-shrink: 0;\n    width: 32px;/);
    expect(qc).toMatch(/^\.ek-generate-fab \{\n  width: 56px; height: 56px;/m);
  });

  it("keeps no room for the bar: the page, the panels and the Hall of Fame reach the bottom", () => {
    expect(phone).not.toMatch(/58px \+ env|64px \+ env|70px \+ env/);
    expect(phone).toMatch(/  \.ek-main \{[^}]*padding-bottom: env\(safe-area-inset-bottom, 0px\);/);
    expect(phone).toMatch(/  \.ek-panel-scrim \{[^}]*\}/);
    expect(phone.match(/  \.ek-panel-scrim \{[^}]*\}/)![0]).not.toContain("bottom:");
    expect(phone).toContain("    padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px)) !important;");
  });
});


describe("Make it a prompt", () => {
  it("carries Quick Create's words into the editor; a guest signs in first", () => {
    const fn = LAUNCHER.slice(LAUNCHER.indexOf("const makePrompt = () => {"), LAUNCHER.indexOf("const closeModal = () => {"));
    expect(fn).toContain("if (!signedIn) return openLogin();");
    expect(fn).toContain("const seed = librarySeed({ name: prompt.trim().split(/\\s+/).slice(0, 6).join(\" \").slice(0, 60), prompt_text: prompt });");
    expect(fn).toContain("if (seed) stashEditorSeed(seed, userId);");
    expect(fn.indexOf("stashEditorSeed(")).toBeLessThan(fn.indexOf('router.push("/editor");'));
  });

  it("is offered in Quick Create, and the sheet shows it only when offered", () => {
    expect(LAUNCHER).toContain("onMakePrompt={makePrompt}");
    expect(MODAL).toMatch(/\{onMakePrompt && \(\n\s+<button type="button" className="mobile-modal-add-var-btn" onClick=\{onMakePrompt\}>\n\s+Make it a prompt →/);
  });
});

describe("Quick Create's sheet holds still (Kev, 2026-10-26)", () => {
  const MODAL_CSS = src("app/editor/mobile-modal.css");
  it("locks the page behind while open, with the kit's lock, and lets go when it closes", () => {
    expect(MODAL).toContain('import { lockScroll } from "@/lib/ui/kit/controls";');
    expect(MODAL).toMatch(/useEffect\(\(\) => \{\n\s+if \(!isOpen\) return;\n\s+return lockScroll\(document\.documentElement, window\.innerWidth\);\n\s+\}, \[isOpen\]\);/);
  });
  it("scrolls only up and down, and never hands its scroll on to the page", () => {
    const content = MODAL_CSS.match(/\.mobile-modal-content \{[^}]*\}/)![0];
    expect(content).toContain("overflow-y: auto;");
    expect(content).toContain("overflow-x: hidden;");
    expect(content).toContain("overscroll-behavior: contain;");
  });
});

describe("Quick Create's settings are the Image View's pills (Kev, 2026-10-27: \"das gleiche verhalten, wie bei create prompt\")", () => {
  it("builds the generator, format, resolution and count pills, each priced by the server", () => {
    expect(LAUNCHER).toContain("const offerable = forViewer(core.catalogue, role).filter((m) => m.mediaType === \"image\");");
    expect(LAUNCHER).toContain("const pricedQuotes = useServerQuotes(pricedModels.map((m) => ({ modelId: m.id, resolution: fitTier(m), boost: false, referenceImageCount: refCount })));");
    expect(LAUNCHER).toContain('<GeneratorPill models={offerable} value={core.entry?.id ?? null} onChange={setModel}');
    expect(LAUNCHER).toContain('look="logo-name" describe direction="up" />');
    expect(LAUNCHER).toContain("<RatioPill core={core} value={ratio} onChange={setRatio} describe />");
    expect(LAUNCHER).toContain("<ResolutionPill core={core} value={resolution} onChange={setResolution} prices={paidEntry ? quoteTiers.map((_, i) => quotes[i + 1] ?? null) : []} describe />");
    expect(LAUNCHER).toContain('value={String(count)} onPick={(k) => setCount(Number(k))} sheetHint="Several takes in one go" sheetColumns={4} typed="Or type a number" />');
    expect(LAUNCHER).toContain("settings={settings}");
  });

  it("takes them in place of its own drop-downs, the count kept where Generate sends it", () => {
    expect(MODAL).toContain("{settings?.(genCountNum, (n) => setGenCount(`x ${n}`))}");
    expect(MODAL).not.toMatch(/<MiniSelect/);
  });
});
