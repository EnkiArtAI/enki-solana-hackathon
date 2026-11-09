import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Kev, 2026-11-02: "wenn ich esc drücke so soll nur das bild geschlossen werden, stattdessen führt es mich einfach aufs
 * letzte menü ... merze diese funktion strikt aus". Esc closes the top layer only. The shell's panel (and, behind it,
 * history.go(-n)) hears Esc last on the window, so a layer over it must hear it in the capture phase and stop it. A
 * layer heard on the bubble reaches the panel as well, and the person lands on the page before.
 *
 * Review 2026-11-03: a stop does not hold back a second listener on the same node, and the first to register hears
 * first. So a layer that stays open while others open over it must not hear in the window's capture: one Esc closed the
 * NFT menu and cleared the Gallery's marks. It hears on the document's bubble: after every layer that took the Esc,
 * before the panel on the window.
 */
const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "__tests__") yield* sources(path); }
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

/** Every keydown listener on the window or the document whose handler reads Esc, with the phase it hears in. */
function escListeners() {
  const found: { file: string; on: string; capture: boolean; stops: boolean; leavesUsed: boolean }[] = [];
  for (const dir of ["components", "app", "hooks", "providers"]) {
    for (const path of sources(join(ROOT, dir))) {
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/(window|document)\.addEventListener\("keydown", (\w+)(, true)?\)/g)) {
        const start = text.lastIndexOf(`const ${m[2]} = `, m.index);
        const handler = start < 0 ? "" : text.slice(start, m.index);
        if (!handler.includes('"Escape"')) continue;
        found.push({ file: relative(ROOT, path).replace(/\\/g, "/"), on: m[1], capture: !!m[3], stops: handler.includes("stopPropagation"), leavesUsed: handler.includes("defaultPrevented") });
      }
    }
  }
  return found;
}

describe("Esc closes the top layer only", () => {
  // The bottom layer itself, the view that hears after its layers, and two pages with nothing under them.
  const LAST = ["app/page.tsx", "app/reset-password/page.tsx", "components/enki-shell/EnkiPanel.tsx", "components/enki/EnkiDetailPanel.tsx"];
  // Layers that stay open under others. Nothing a scan can tell: a new one belongs here, and hears as these do.
  // Settings' sheet stays open under the step-up dialog ("Confirm it's you", DEC-2026-11-08-43).
  const UNDER = ["components/gallery/GalleryWall.tsx", "components/profile/ProfileView.tsx", "components/settings/PaymentPanel.tsx", "components/settings/SettingsSheet.tsx"];

  it("finds the listeners it speaks of", () => {
    expect(escListeners().length).toBeGreaterThan(20);
  });

  it("no layer over the panel hears Esc on the bubble", () => {
    expect(escListeners().filter((l) => !l.capture).map((l) => l.file).sort()).toEqual([...LAST, ...UNDER].sort());
  });

  it.each(UNDER)("%s stays open under other layers: it hears after them, leaves a used Esc, and keeps it from the panel", (file) => {
    expect(escListeners().filter((l) => l.file === file && !l.capture)).toEqual([{ file, on: "document", capture: false, stops: true, leavesUsed: true }]);
  });

  it("every layer that hears it first keeps it from the layers under it", () => {
    expect(escListeners().filter((l) => l.capture && !l.stops).map((l) => l.file)).toEqual([]);
  });

  it("the panel and the image view leave an Esc a dialog on top already used", () => {
    expect(read("components/enki-shell/EnkiPanel.tsx")).toContain('if (e.key === "Escape" && !e.defaultPrevented) onClose();');
    expect(read("components/enki/EnkiDetailPanel.tsx")).toContain('if (e.key !== "Escape" || hidden || e.cancelBubble || e.defaultPrevented) return;');
  });
});
