import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Endless areas fold the left menu into its rail once scrolled about six wheel
 * steps down, so more of the wall shows (Kev, 2026-10-15; two steps were too
 * soon, 10-16), and open it again at the very top. Since 2026-10-30 it stays
 * wide as Explore or Create opens and folds only once the reader scrolls or
 * generates ("die schmale leiste muss nur dann erst schmal werden, wenn ich
 * anfange zu scrollen oder zu generieren"). It is not stored as a preference,
 * fires once, re-arms back near the top or as the shell drops its fold, and gives way to the user's own
 * toggle. The rules are lib/ui/kit/shell-nav (shell-nav.test.ts), the shell's
 * behaviour shell-menu.test.ts; these pin the wiring.
 */
const ROOT = join(__dirname, "..", "..");
const SHELL = readSource(join(ROOT, "components", "enki-shell", "EnkiHome.tsx"));
const src = (...p: string[]) => readSource(join(ROOT, ...p));

describe("the menu folds on endless areas", () => {
  it("hears every scroll at the document: the page's, or a scroller's inside the marked area in the shell's main", () => {
    expect(SHELL).toContain('const area = document.querySelector(".ek-main [data-menu-autohide]");');
    expect(SHELL).toContain("const s = foldScroller<Element>(e.target instanceof Element ? e.target : null, page, area);");
    expect(SHELL).toContain('document.addEventListener("scroll", onScroll, { capture: true, passive: true });');
    expect(SHELL).toContain('document.removeEventListener("scroll", onScroll, { capture: true });');
  });

  it("measures each scroller from its own last offset, fires once and re-arms near the top or once no fold stands", () => {
    expect(SHELL).toContain("const lasts = new WeakMap<Element, number>();");
    expect(SHELL).toContain("const noFold = useEffectEvent(() => pick === null);");
    expect(SHELL).toContain("const step = foldStep(s, lasts.get(s) ?? 0, armed || noFold(), area !== null);\n      lasts.set(s, s.scrollTop);\n      armed = step.armed;\n      if (step.open) autoOpen();\n      if (step.fold) autoFold();");
  });

  it("folds on a generation's start too", () => {
    expect(SHELL).toContain("window.addEventListener(GENERATION_START_EVENT, onGenerate);");
    expect(SHELL).toContain("window.removeEventListener(GENERATION_START_EVENT, onGenerate);");
    // As the image composer's start of a job (a Generate, a Regenerate, a retry), in Create and over the feed.
    expect(src("components", "image-view", "useImageViewModel.ts")).toMatch(/else runBatch\(Array\.from\(\{ length: n \}, \(\) => job\)\);\s+window\.dispatchEvent\(new Event\(GENERATION_START_EVENT\)\);\n {2}\};/);
  });

  it("folds to the rail without storing a preference, and never on a phone", () => {
    const fold = SHELL.slice(SHELL.indexOf("const autoFold"), SHELL.indexOf("useEffect(() => {\n    let armed"));
    expect(fold).toContain("if (!phone) setPick(folded(pick, nav));");
    expect(fold).toContain("const autoOpen = useEffectEvent(() => setPick(unfolded(pick)));");
    expect(fold).not.toContain("localStorage");
  });

  it("a toggle is the user's: it carries no auto mark", () => {
    expect(SHELL).toContain("setPick({ nav: next });\n    try { localStorage.setItem(MENU_KEY");
  });

  it("marks the endless areas: the feed, Create, the prompt wall and the gallery", () => {
    expect(src("components", "enki", "EnkiFeedPage.tsx")).toContain('<div className="feed kit-focus" data-menu-autohide>');
    expect(src("components", "enki", "CreateView.tsx")).toContain('<div className="feed feed--create kit-focus" data-menu-autohide>');
    expect(src("components", "enki", "PromptWall.tsx")).toContain('<div className="feed-wall" data-menu-autohide>');
    expect(src("components", "gallery", "GalleryWall.tsx")).toContain('<div className="gw" ref={wall} data-menu-autohide>');
  });
});
