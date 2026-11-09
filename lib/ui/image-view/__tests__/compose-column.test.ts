import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The compose column takes only its own height (Kev, 2026-10-14), so
 * Generate sits right under the references instead of at the bottom of a
 * tall window with a gap above it; a long prompt still scrolls while the
 * foot stays put.
 */
const CSS = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");

describe("the compose column", () => {
  it("takes its own height, so the foot follows the references", () => {
    expect(CSS).toMatch(/\.iv-left-scroll \{\n  flex: 0 1 auto;\n  min-height: 0;\n  overflow-y: auto;/);
  });

  // Kev, 2026-10-29: "beim wechsel von variable to full prompt sehe ich kurz die horizontale scrollbar".
  it("never scrolls sideways, so the words sliding in from the right draw no scrollbar", () => {
    expect(CSS).toMatch(/\.iv-left-scroll \{[^}]*overflow-y: auto;[^}]*overflow-x: hidden;/);
    expect(CSS).toContain("animation: iv-in-r 0.3s");
  });

  // v2 keeps that: the photo box is only as tall as its squares (DEC-331), so a filled column left a gap above
  // the foot again; the squares grow into the column's rest instead. A plain prompt's words fill it.
  it("keeps its own height in v2, and fills the column only under a plain prompt's words", () => {
    expect(CSS).toContain(".iv-v2 .iv-left-scroll { margin-left: -9px; padding: 0 10px 10px 9px; }");
    expect(CSS).toContain(".iv-v2 .iv-left-scroll:has(> .iv-plain) { flex-grow: 1; }");
    expect(CSS).not.toMatch(/\.iv-v2 \.iv-left-scroll \{[^}]*flex:/);
    const deck = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "PhotoDeck.tsx"), "utf8");
    // The content's extent: scrollHeight never drops below clientHeight, so it shrank the deck 4 px per measure.
    expect(deck).toContain("const kids = [...scroller.children].map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0);");
    expect(deck).toContain("const free = scroller.clientHeight - pad - (content - deck.offsetHeight) - 4 + slack;");
    expect(deck).not.toContain("scroller.scrollHeight");
  });
});
