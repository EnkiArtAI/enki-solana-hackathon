import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * An opened picture fills the room it has (Kev, 2026-11-01: "the image must ABSOLUTELY fill in either the heights or
 * full width sofern the ui rechts das ermöglicht"), and the viewer's thumb strip loads the small rendition: it loaded
 * every 2048 px preview at once, about 0.9 MB each, ahead of the picture in view ("die example images brauchen länger zu
 * laden").
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const CSS = readSource(join(ROOT, "components", "kit", "kit-media.css"));
const VIEWER = readSource(join(ROOT, "components", "kit", "FullscreenViewer.tsx"));
const DESKTOP = readSource(join(ROOT, "components", "image-view", "ImageViewDesktop.tsx"));

describe("the opened picture", () => {
  it("takes both rows left of the panel with no padding, the count and close over it", () => {
    expect(CSS).toContain('.kit-viewer[data-layout="side"] .kit-viewer-stage { grid-area: 1 / 1 / 3 / 2; min-height: 0; container-type: size; }');
    expect(CSS).toContain('.kit-viewer[data-layout="side"] .kit-viewer-top { grid-area: 1 / 1; z-index: 1; padding: 20px 28px 0; }');
    expect(CSS).toContain('.kit-viewer[data-layout="side"] .kit-viewer-box { height: min(100cqh, calc(100cqw / var(--r))); }');
  });

  it("takes the whole width on a phone or tablet, not 560 px of it", () => {
    expect(CSS).toContain('.kit-viewer[data-layout="stacked"] > .kit-viewer-stage { max-width: none; }');
    expect(CSS).toContain("height: min(56dvh, calc((100vw - 32px) / var(--r)));");
    expect(CSS).not.toContain("min(100vw - 32px, 560px)");
  });
});

describe("the viewer's thumb strip", () => {
  it("loads each picture's small rendition", () => {
    expect(VIEWER).toContain('<img src={it.thumb ?? it.src} alt="" loading="lazy"');
    expect(DESKTOP).toContain("items={items.map((x) => ({ key: x.key, src: x.src, thumb: x.thumb, ratio: x.ratio }))}");
  });
});
