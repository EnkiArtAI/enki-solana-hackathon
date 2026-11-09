import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The shell menu has three states (Kev's image UI v2 handoff, README §2 and §5.1):
 * the full column from 1360 px, the icon rail from 1180 px, a 10 px strip below.
 * The rule itself is navFor/widestNav (lib/ui/kit/__tests__/nav.test.ts); these
 * pin how the shell applies it.
 */
const ROOT = join(__dirname, "..", "..");
const SHELL = readSource(join(ROOT, "components", "enki-shell", "EnkiHome.tsx"));
const SIDEBAR = readSource(join(ROOT, "components", "enki-shell", "EnkiSidebar.tsx"));
const CSS = readFileSync(join(ROOT, "components", "enki-shell", "enki-shell.css"), "utf8");

describe("the shell's menu states", () => {
  it("reads the window as the widest menu it fits, the full menu on the server", () => {
    expect(SHELL).toContain("const readWidest = () => widestNav(window.innerWidth);");
    expect(SHELL).toContain('const serverWidest = (): NavState => "full";');
    expect(SHELL).toContain("const widest = useSyncExternalStore(onResize, readWidest, serverWidest);");
  });

  it("shows the pick of this visit, else the stored one, while the window fits it", () => {
    expect(SHELL).toContain("const nav = navFor(widest, pick?.nav ?? storedNav);");
    expect(SHELL).toContain('const MENU_KEY = "ek-nav";');
    expect(SHELL).toContain('readStoredNav(localStorage.getItem(MENU_KEY), localStorage.getItem("ek-menu-collapsed"))');
  });

  it("marks the root per state, and a phone keeps its drawer", () => {
    expect(SHELL).toContain('const rail = nav === "icons" && !phone;');
    expect(SHELL).toContain('const closed = nav === "closed" && !phone;');
    expect(SHELL).toContain('(rail ? " ek-root--rail" : closed ? " ek-root--closed" : "")');
  });

  it("gives the page the width the menu leaves: 256, 72 or 10 px", () => {
    expect(CSS).toContain("--ek-sw: 256px;");
    expect(CSS).toContain(".ek-app.ek-root--rail { --ek-sw: 72px; }");
    expect(CSS).toContain(".ek-app.ek-root--closed { --ek-sw: 10px; }");
    expect(CSS).toContain(".ek-main { flex: 1; min-width: 0; margin-left: var(--ek-sw);");
    expect(CSS).toContain(".ek-sidebar--closed { width: 10px; padding: 0; cursor: pointer; }");
  });

  it("offers labels only where the full column fits; the strip and its tab open the icons", () => {
    expect(SHELL).toContain('canFull={widest === "full"}');
    expect(SIDEBAR).toContain('{canFull && (');
    expect(SIDEBAR).toContain('onClick={() => onMenu(rail ? "full" : "icons")}');
    expect(SIDEBAR).toContain('onClick={() => onMenu("closed")} aria-label="Hide menu"');
    expect(SIDEBAR).toContain('<aside className="ek-sidebar ek-sidebar--closed" onClick={() => onMenu("icons")}>');
  });
});
