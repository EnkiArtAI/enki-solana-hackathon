import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * The account's three-dot menu (the color theme) is 158px wide and anchored to
 * the account's right edge, so it grows to the left. On the 72px rail that
 * pushed it off the screen's left edge (Kev, 2026-10-15): there it opens beside
 * the avatar instead, over the page.
 */
const CSS = readFileSync(join(__dirname, "..", "..", "components", "enki-shell", "enki-shell.css"), "utf8");

describe("the account menu on the rail", () => {
  it("opens beside the avatar, growing right, never off the left edge", () => {
    expect(CSS).toContain(".ek-root--rail .ek-color-dd--up { bottom: 0; left: calc(100% + 10px); right: auto; }");
    expect(CSS).toContain(".ek-color-dd--up { bottom: calc(100% + 8px); right: 0; left: auto; }");
  });
});
