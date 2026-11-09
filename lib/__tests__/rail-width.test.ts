import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The menu folded to its rail frees width; the endless pages take it (Kev,
 * 2026-10-15): the walls get more columns, the profile's boxes (hero, tab bar,
 * tab content, so the gallery wall too) widen. Only where the full menu is a
 * choice (>= 1200px); below that the rail is forced and the pages are already
 * as wide as they get. Since DEC-456 the profile's Released is Home's wall
 * (MasonryGrid), so its old CSS masonry and that masonry's column rules are gone.
 */
const ROOT = join(__dirname, "..", "..");
const CSS = readFileSync(join(ROOT, "components", "enki", "enki.css"), "utf8");
const PROFILE = readSource(join(ROOT, "components", "profile", "ProfileView.tsx"));

describe("width freed by the rail", () => {
  /** The profile used to sit in a 1400 px column under a full-width banner (Kev, 2026-10-21). */
  it("lets the profile's boxes span the banner", () => {
    expect(CSS).not.toMatch(/\.pf-wrap \{[^}]*max-width/);
  });

  it("gives every wall columns by its own width, so a folded rail adds columns", () => {
    expect(readSource(join(ROOT, "components", "enki", "MasonryGrid.tsx"))).toContain("cols: columnsFor(size.width, GAP)");
    expect(CSS).not.toMatch(/enki-masonry/);
  });

  it("puts the profile's hero, tab bar and tab content in that one box", () => {
    expect(PROFILE.match(/className="pf-wrap"/g)).toHaveLength(3);
    expect(PROFILE).not.toContain("maxWidth: 1400");
  });
});
