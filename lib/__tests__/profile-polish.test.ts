import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Kev, 2026-11-02, the profile: its numbers, its picture, its buttons, its bar. */
const ROOT = join(__dirname, "..", "..");
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8").replace(/\r\n/g, "\n");
const VIEW = read("components", "profile", "ProfileView.tsx");
const CSS = read("components", "enki", "enki.css");
const hero = VIEW.slice(VIEW.indexOf("const heroBtn"), VIEW.indexOf("const overlayChip"));
const bar = VIEW.slice(VIEW.indexOf("Tabs & Filter Section"), VIEW.indexOf("Content Section"));

describe("the hero's buttons", () => {
  it("keep their border in longhand: Follow and the bell change borderColor, which React refuses beside a border", () => {
    expect(hero).not.toMatch(/\bborder:/);
    expect(hero).toContain('borderWidth: 1.5, borderStyle: "solid", borderColor: "var(--enki-rule)"');
  });
});

describe("the hero's buttons, pressed", () => {
  it("show a ring around them on hover and focus, and give on a press", () => {
    expect(VIEW.match(/<div className="pf-actions" style=\{\{ display: "flex", gap: 12/g)).toHaveLength(2);
    expect(CSS).toMatch(/\.pf-actions button:hover:not\(:disabled\),\n\.pf-actions button:focus-visible \{\n\s+box-shadow: 0 0 0 3px/);
    expect(CSS).toMatch(/\.pf-actions button:active:not\(:disabled\) \{\n\s+transform: scale\(0\.96\);/);
  });
});


describe("the numbers", () => {
  it("come from the creator's profile, a dash only until they do", () => {
    expect(VIEW).toContain('{stats?.[key]?.toLocaleString("en-US") ?? "—"}');
    expect(VIEW).toContain('["Followers", "followers"]');
    expect(VIEW).toContain('queryKey: ["creator-profile", shelf],');
  });
});

describe("a picture opened", () => {
  it("lies on the body, over the menu, and the avatar and the banner both open it", () => {
    expect(VIEW).toContain("{lightbox && createPortal(");
    expect(VIEW).toMatch(/document\.body,\n\s+\)\}/);
    expect(VIEW).toContain("onClick={() => setLightbox({ src: me?.avatarUrl && !avatarFailed ? me.avatarUrl : null })}");
    expect(VIEW).toContain("setLightbox({ src: me.coverUrl })");
  });

  it("holds the page still and takes Esc for itself", () => {
    expect(VIEW).toContain('const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setLightbox(null); } };');
    expect(VIEW).toContain("const release = lockScroll(document.documentElement, window.innerWidth);");
  });
});

describe("the tab bar", () => {
  it("draws Filter by NFT in the tabs' own type and height", () => {
    expect(bar).not.toContain("enki-catbar-all");
    expect(bar.match(/padding: "20px 0"/g)).toHaveLength(1);
    const filter = read("components", "profile", "NftFilter.tsx");
    expect(filter).toContain('padding: "20px 6px"');
    expect(filter).toContain("fontSize: 14,");
  });
});

describe("the tab bar's magnifier", () => {
  it("has the magnifier right of the tabs, and its Esc closes the search only", () => {
    expect(bar.indexOf("<Search size={18}")).toBeGreaterThan(bar.indexOf("<NftFilter "));
    expect(bar).toContain('onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeSearch(); } }}');
    expect(VIEW).toContain('if (term) params.set("query", term);');
  });
});
