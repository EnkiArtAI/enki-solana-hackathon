import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "./_read-source";

/**
 * DEC-514 (Kev, 2026-10-29: "auf dem bild ... above the 'creator example' als mini bild ... click auf das kleine bild
 * macht es normal groß wie bei image ui behavior und wenn ich hover over mache, wird es nur auf 2x größer
 * responsively und wenn ich meine maus da entferne wird es wieder fix klein").
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], s: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
}));
vi.mock("@/components/image-view/Zoom", () => ({ default: () => null }));

import RefThumbs from "@/components/image-view/RefThumbs";
import Zoom from "@/components/image-view/Zoom";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const REFS = ["https://blob/r1.webp", "https://blob/r2.webp"];
const draw = (over: Partial<Parameters<typeof RefThumbs>[0]> = {}) => { ui.s = 0; return [...walk(RefThumbs({ refs: REFS, phone: false, className: "iv-refs", ...over }) as El)]; };
const ROOT = join(__dirname, "..", "..", "components", "image-view");

describe("a public image's references", () => {
  it("are small squares of the pictures, none without references", () => {
    const tiles = draw().filter((el) => el.props.className === "iv-ref");
    expect(tiles.map((t) => [t.props["aria-label"], (t.props.style as { backgroundImage: string }).backgroundImage])).toEqual([
      ["Reference image 1", 'url("https://blob/r1.webp")'], ["Reference image 2", 'url("https://blob/r2.webp")'],
    ]);
    ui.state = [];
    expect(RefThumbs({ refs: [], phone: false, className: "iv-refs" })).toBeNull();
  });

  it("open large from the square that was clicked, above the viewer when inside it", () => {
    ui.state = [];
    const rect = { left: 1, top: 2, width: 40, height: 40 };
    (draw().filter((el) => el.props.className === "iv-ref")[1].props.onClick as (e: unknown) => void)({ currentTarget: { getBoundingClientRect: () => rect } });
    const zoom = draw({ phone: true, overViewer: true }).find((el) => el.type === Zoom);
    expect(zoom?.props).toMatchObject({ src: REFS[1], n: 2, from: rect, phone: true, overViewer: true });
    (zoom?.props.onClose as () => void)();
    expect(draw().some((el) => el.type === Zoom)).toBe(false);
  });

  it("sit above the stage's label, grow twice their size under a pointer only, and the large one lies above the viewer", () => {
    const css = readFileSync(join(ROOT, "image-view.css"), "utf8");
    expect(css).toContain(".iv-refs { position: absolute; left: 10px; bottom: 40px; display: flex; gap: 6px; z-index: 1; }");
    expect(css).toContain("@media (hover: hover) { .iv-ref:hover { position: relative; z-index: 1; transform: scale(2); } }");
    expect(css).toMatch(/\.iv-ref \{\n\s+--s: clamp\(30px, 9cqmin, 46px\);[\s\S]+?transform-origin: left bottom;\n\s+transition: transform 0\.18s ease;\n\}/);
    expect(css).toContain(".iv-zoom[data-over-viewer] { z-index: 10010; }");
    const zoom = readSource(join(ROOT, "Zoom.tsx"));
    expect(zoom).toContain("if (overViewer) img.current?.focus({ preventScroll: true });");
    expect(zoom).toContain('data-over-viewer={overViewer || undefined}');
    expect(zoom).toContain('<button ref={img} type="button" className="iv-zoom-img"');
  });

  // Once public, a second switch and its hint; someone else's public image shows what its owner shares.
  it("offer the owner a switch once a render with references is public, and show someone else's below the prompt", () => {
    const panel = readSource(join(ROOT, "ViewerPanel.tsx"));
    const view = readSource(join(ROOT, "useImageViewModel.ts"));
    expect(panel).toMatch(/\{record && record\.visibility === "public" && \(record\.settings\?\.references\?\.length \?\? 0\) > 0 && \(\n\s+<label className="iv-public">\n\s+<input type="checkbox" role="switch" checked=\{record\.referencesPublic === true\}\n\s+onChange=\{\(e\) => void m\.setReferencesPublic\(record, e\.target\.checked\)\} \/>/);
    expect(panel).toMatch(/Show the references\n\s+<span>Helps others learn your process<\/span>/);
    expect(panel).toContain('<RefThumbs refs={shot.references} phone={phone} overViewer className="iv-vrefs-row" />');
    expect(view).toContain("body: JSON.stringify({ references: on }),");
    expect(view).toContain("ratio: null, publicId: im.id, maker: im.maker, references: im.references }");
    const list = readSource(join(__dirname, "..", "..", "app", "api", "generations", "route.ts"));
    expect(list).toContain('.from("generated_images").select("id").in("id", rows.map((r) => String(r.id))).eq("references_public", true);');
    expect(list).toContain("referencesPublic: refsShown.has(String(row.id)),");
  });

  it("show on the stage for someone else's public image, the phone's large photo sized for a phone", () => {
    const hero = readSource(join(ROOT, "MainImage.tsx"));
    expect(hero).toMatch(/\{s\?\.references && <RefThumbs refs=\{s\.references\} phone=\{phone\} className="iv-refs" \/>\}\n\s+\{meta && <span className="iv-meta">\{meta\}<\/span>\}/);
    const phone = readSource(join(ROOT, "ImageViewMobile.tsx"));
    expect(phone).toContain("<MainImage model={m} onOpen={open} onClose={onClose} phone />");
    expect(phone).toContain("<ViewerPanel model={m} shot={items[at]} onAgain={() => setViewer(null)} phone />");
  });
});
