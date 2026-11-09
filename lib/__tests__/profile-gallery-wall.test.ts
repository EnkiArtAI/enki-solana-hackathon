import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";
import { toGalleryItem, rowsOf, GALLERY_PAGE } from "@/components/gallery/GalleryWall";
import { justifyRows, ROW_GAP, rowTarget } from "@/components/gallery/justify";

/**
 * The profile's Gallery tab (Kev, 2026-10-14): the images alone, in rows
 * that span the full width, one height per row and that height free to vary,
 * no dates or numbers on them, loading on as the end scrolls into view. A
 * click opens the image near full screen, with the prompt, what it was made
 * with, Download, Share, and for the owner Publish and Remove beside it.
 */
const ROOT = join(__dirname, "..", "..");
const WALL = readSource(join(ROOT, "components", "gallery", "GalleryWall.tsx"));
const CSS = readFileSync(join(ROOT, "components", "gallery", "gallery-wall.css"), "utf8");
const PROFILE = readSource(join(ROOT, "components", "profile", "ProfileView.tsx"));

const r = (ratio: number, id = String(ratio)) => ({ id, ratio });
const rowWidth = (row: { items: { ratio: number }[]; height: number }, gap: number) =>
  row.items.reduce((w, i) => w + i.ratio * row.height, 0) + gap * (row.items.length - 1);

describe("justified rows", () => {
  it("fills each full row exactly to the width, gaps included, with one height per row", () => {
    const rows = justifyRows([r(1.5, "a"), r(0.75, "b"), r(1, "c"), r(1.33, "d"), r(0.6, "e"), r(1.78, "f"), r(1, "g")], 1000, 280, 4);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(0, -1)) {
      expect(rowWidth(row, 4)).toBeCloseTo(1000, 6);
      expect(row.height).toBeLessThanOrEqual(280);
    }
    expect(rows.flatMap((row) => row.items.map((i) => i.id))).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("varies the height from row to row: two wide images make a lower row than seven tall ones", () => {
    const tallOnes = ["s", "t", "u", "v", "w", "x", "y", "z"].map((id) => r(0.5, id));
    const [wide, tall, rest] = justifyRows([r(2, "a"), r(2, "b"), ...tallOnes], 1000, 300, 0);
    expect(wide.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(wide.height).toBeCloseTo(250, 6);
    expect(tall.items).toHaveLength(7);
    expect(tall.height).toBeCloseTo(1000 / 3.5, 6);
    expect(tall.height).not.toBeCloseTo(wide.height, 6);
    expect(rest).toEqual({ items: [r(0.5, "z")], height: 300 });
  });

  it("keeps a short last row at the target height instead of stretching it", () => {
    const rows = justifyRows([r(1, "a")], 1000, 280, 4);
    expect(rows).toEqual([{ items: [r(1, "a")], height: 280 }]);
    // A last row that nearly fills the width is justified like the rest.
    const nearly = justifyRows([r(1.5, "a"), r(1.5, "b")], 1000, 280, 4);
    expect(nearly[0].height).toBeCloseTo((1000 - 4) / 3, 6);
  });

  it("gives nothing for no width and nothing for no images", () => {
    expect(justifyRows([r(1)], 0, 280, 4)).toEqual([]);
    expect(justifyRows([], 1000, 280, 4)).toEqual([]);
  });
});

describe("the wall", () => {
  it("shows each image alone: no date, no prompt, no buttons on the tile", () => {
    const tile = WALL.slice(WALL.indexOf('className="gw-shot-open"'), WALL.indexOf("</button>", WALL.indexOf('className="gw-shot-open"')));
    expect(tile).toContain('<img src={c.thumbUrl ?? c.imageUrl} alt={c.isUploaded ? "Uploaded" : "Generated"} loading="lazy" />');
    expect(tile).not.toContain("createdAt");
    expect(tile).not.toContain("prompt");
    expect(WALL).not.toContain("toLocaleDateString");
  });

  it("reads each image's aspect ratio once it loads, measures its own width, and lays rows edge to edge", () => {
    expect(WALL).toContain("setRatios((r) => ({ ...r, [c.id]: img.naturalWidth / img.naturalHeight }))");
    expect(WALL).toContain("new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))");
    expect(WALL).toContain("justifyRows(items.map((c) => ({ item: c, ratio: ratios[c.id] ?? 1 })), width, target, GAP)");
    expect(WALL).toContain('<div key={i} className="gw-row" style={{ height: row.height }}>');
    expect(WALL).toContain("style={{ width: row.height * ratio }}");
    expect(CSS).toMatch(/\.gw-rows \{ display: flex; flex-direction: column; gap: 2px; \}/);
    expect(CSS).toMatch(/\.gw-row \{ display: flex; gap: 2px; \}/);
    expect(WALL).toContain('import { justifyRows, ROW_GAP as GAP, rowTarget } from "./justify";');
    expect(CSS).toMatch(/\.gw-shot-open img \{[^}]*width: 100%; height: 100%; object-fit: cover/);
  });

  it("asks for the next page once when the end scrolls into view, while there is more", () => {
    expect(WALL).toContain("if (!el || !hasMore || loadingMore) return;");
    expect(WALL).toContain("new IntersectionObserver(([entry]) => {\n      if (!entry.isIntersecting) return;\n      io.disconnect();\n      onMore();");
  });

  it("maps a generations row to a wall item: preview to show, original to download, settings as chips", () => {
    expect(GALLERY_PAGE).toBe(60);
    expect(toGalleryItem({ id: 1 as unknown as string, image_url: "o.png", image_urls: ["p.webp"], prompt: "a cat", prompt_id: "pr", created_at: "2026-10-14T00:00:00Z",
      visibility: "public", settings: { modelId: "m", aspectRatio: "1:1", resolution: "2K" } }))
      .toMatchObject({ id: "1", imageUrl: "p.webp", originalUrl: "o.png", prompt: "a cat", createdAt: "2026-10-14T00:00:00Z", isUploaded: false, visibility: "public", promptId: "pr",
        made: { model: "m", ratio: "1:1", resolution: "2K" } });
    expect(toGalleryItem({ id: "2", created_at: "x" })).toBeNull();
    expect(toGalleryItem({ id: "3", image_url: "u.png", created_at: "x", settings: { origin: "uploaded" } })).toMatchObject({ isUploaded: true, made: null, visibility: "private" });
    expect(rowsOf({ data: { generations: [{ id: "a" }] } })).toEqual([{ id: "a" }]);
    expect(rowsOf({ generations: "no" })).toEqual([]);
  });
});

describe("the viewer", () => {
  it("opens near full screen over the wall, not beside it, and closes on Escape, the backdrop or the X", () => {
    expect(WALL).toContain('<div className="gw-viewer" role="dialog" aria-label="Image" onClick={() => setSelectedId(null)}>');
    // The dark beside the image (the body and the stage themselves) closes it; the image and the details do not.
    expect(WALL).toContain('<div className="gw-viewer-body" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setSelectedId(null); }}>');
    expect(WALL).toContain('<div className="gw-stage" onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}>');
    expect(WALL).toContain('if (e.key === "Escape") { e.stopPropagation(); setSelectedId(null); }');
    expect(WALL).not.toContain("gw-panel");
    // Starts below the shell's banner and sits above the menu, so the X is never covered.
    expect(CSS).toMatch(/\.gw-viewer \{\s*position: fixed; inset: var\(--ek-banner-h, 0px\) 0 0 0; z-index: 250;/);
    expect(CSS).toMatch(/\.gw-viewer-body \{[^}]*height: min\(100%, 92vh\)/);
    expect(CSS).toMatch(/\.gw-viewer-img \{[^}]*object-fit: contain/);
  });

  it("shows the WebP preview, steps through the wall with the arrows, and keeps the page from scrolling behind", () => {
    expect(WALL).toContain('<img className="gw-viewer-img" src={selected.imageUrl} alt="" />');
    expect(WALL).not.toContain("gw-viewer-img\" src={selected.originalUrl");
    expect(WALL).toContain('if (e.key === "ArrowLeft") step(-1);');
    expect(WALL).toContain('if (e.key === "ArrowRight") step(1);');
    expect(WALL).toContain("const step = (by: number) => setSelectedId(items[index + by]?.id ?? selectedId);");
    expect(WALL).toContain('document.body.style.overflow = "hidden";');
  });

  it("shows the prompt and what it was made with, then Download, Share, and the owner's Publish and Remove", () => {
    const details = WALL.slice(WALL.indexOf('<aside className="gw-details">'), WALL.indexOf("</aside>"));
    expect(details).toContain('<CopyBox text={selected.text} className="gw-copybox--prompt" />');
    expect(details).toContain("[selected.modelName ?? selected.made.model, selected.made.ratio, selected.made.resolution].filter(Boolean)");
    expect(details).toContain('onClick={() => void downloadImage(selected.originalUrl ?? selected.imageUrl, selected.promptTitle ?? "")}');
    expect(details).toContain("onClick={() => void shareImage(selected.originalUrl ?? selected.imageUrl)}");
    expect(details).toContain("{onVisibility && selected.visibility && !selected.isUploaded && (");
    expect(details).toContain("{onRemove && (");
    expect(details).toContain("onClick={() => { setSelectedId(null); setConfirm({ ids: [selected.id] }); }}");
    // The prompt link is only shared once the image is public and came from a prompt.
    expect(details).toContain('{selected.promptId && selected.visibility === "public" && (');
  });
});

describe("where the wall is used", () => {
  it("is the profile's Gallery tab: the owner gets Remove and Publish, a visitor does not", () => {
    expect(PROFILE).toContain("onRemove={own ? removeFromGallery : undefined} onVisibility={own ? setGalleryVisibility : undefined}");
    expect(PROFILE).toContain("setGalleryNext(gens.length < GALLERY_PAGE ? null : galleryNext + gens.length);");
    expect(PROFILE).toContain("return [...prev, ...more.filter((c) => !seen.has(c.id))];");
    expect(PROFILE).toContain("setGalleryItems((prev) => prev.filter((c) => c.id !== id));");
    expect(PROFILE).not.toContain("toLocaleDateString()}\n                    </span>");
  });
});

/** The profile now spans the banner's width; rows aim 300 px high so the wider wall shows larger images, not lower ones (Kev, 2026-10-21). */
describe("the wall's row height", () => {
  it("aims for 300 px rows from a 900 px wall, 180 below", () => {
    expect([rowTarget(1116), rowTarget(900), rowTarget(899), ROW_GAP]).toEqual([300, 300, 180, 2]);
    expect(WALL).toContain("const target = rowTarget(width);");
  });
});
