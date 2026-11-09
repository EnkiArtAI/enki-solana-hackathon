import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";
import { inChunks } from "@/lib/in-chunks";
import { renditionsByUrl, withRenditions } from "@/lib/marketplace/renditions";
import { enrichPromptCards, mapPromptRow, type PromptCardRow } from "@/lib/marketplace/card";

/**
 * Every shown image is a WebP rendition, the download the original (Kev,
 * 2026-10-16). Measured that day: the home feed's six cards were 16.3 MB of
 * PNG originals, because prompts.showcase_images keeps the originals and the
 * renditions live on generated_images under names of their own.
 */
const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readSource(join(ROOT, ...p));
const BLOB = "https://x.public.blob.vercel-storage.com/generations/";
const ORIGINAL = `${BLOB}1.png`;
const PREVIEW = `${BLOB}u/1.preview.webp`;
const THUMB = `${BLOB}u/1.thumb.webp`;

describe("inChunks", () => {
  it("reads in slices of the asked size, each id once", async () => {
    const seen: number[] = [];
    const ids = Array.from({ length: 90 }, (_, i) => `id-${i % 85}`);
    await inChunks(ids, async (chunk) => { seen.push(chunk.length); return { data: [] }; }, 40);
    expect(seen).toEqual([40, 40, 5]);
  });
});

describe("renditionsByUrl", () => {
  it("finds the preview and thumb behind an original, and nothing for one the store never saw", async () => {
    const db = fakePostgrest();
    db.tables.generated_images = [
      { storage_url: ORIGINAL, preview_url: PREVIEW, thumbnail_url: THUMB },
      { storage_url: `${BLOB}2.png`, preview_url: null, thumbnail_url: null },
    ];
    const found = await renditionsByUrl(db.client as never, [ORIGINAL, `${BLOB}2.png`, `${BLOB}3.png`, ""]);
    expect(found.get(ORIGINAL)).toEqual({ preview: PREVIEW, thumb: THUMB });
    expect(found.get(`${BLOB}2.png`)).toEqual({ preview: null, thumb: null });
    expect(found.has(`${BLOB}3.png`)).toBe(false);
    expect(withRenditions([{ url: ORIGINAL }, { url: `${BLOB}3.png` }], found)).toEqual([
      { url: ORIGINAL, preview: PREVIEW, thumb: THUMB },
      { url: `${BLOB}3.png`, preview: null, thumb: null },
    ]);
  });

  // SQL 60 not run: supabase-js answers with an error, not a throw, and inChunks read that as no rows at all.
  it("keeps the preview and thumb while the small renditions' columns are missing, and hands them out once they exist", async () => {
    const row = { storage_url: ORIGINAL, preview_url: PREVIEW, thumbnail_url: THUMB };
    const before = { from: () => ({ select: (cols: string) => ({ in: async () => (cols.includes(" view_url") ? { data: null, error: { message: "column does not exist" } } : { data: [row], error: null }) }) }) };
    expect((await renditionsByUrl(before as never, [ORIGINAL])).get(ORIGINAL)).toEqual({ preview: PREVIEW, thumb: THUMB });
    const after = { from: () => ({ select: () => ({ in: async () => ({ data: [{ ...row, view_url: "v.webp", tiny_url: "t.webp" }], error: null }) }) }) };
    const found = await renditionsByUrl(after as never, [ORIGINAL]);
    expect(withRenditions([{ url: ORIGINAL }], found)).toEqual([{ url: ORIGINAL, preview: PREVIEW, thumb: THUMB, view: "v.webp", tiny: "t.webp" }]);
  });

  it("asks nothing for no urls, and a failed read leaves every original alone", async () => {
    const from = vi.fn();
    expect((await renditionsByUrl({ from } as never, [])).size).toBe(0);
    expect(from).not.toHaveBeenCalled();
    const broken = { from: () => ({ select: () => ({ in: () => Promise.reject(new Error("gateway")) }) }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await renditionsByUrl(broken as never, [ORIGINAL])).size).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("the feed's cards", () => {
  const row = (id: string, images: string[]): PromptCardRow => ({
    id, title: "T", description: "", public_prompt_text: null, price_usd_cents: 40, category: "c", tags: [], ai_model: "m",
    created_at: "2026-10-16T00:00:00.000Z", creator_id: "u1", showcase_images: images, aspect_ratio: "1:1", resolution: null,
    is_free_showcase: false, prompt_type: "paid",
  } as unknown as PromptCardRow);

  it("carry each showcase image's renditions, looked up once for the page", async () => {
    const db = fakePostgrest();
    db.tables.users = [{ id: "u1", handle: "mara", display_name: "Mara", avatar_url: null, deleted_at: null, account_status: "active" }];
    db.tables.generated_images = [{ storage_url: ORIGINAL, preview_url: PREVIEW, thumbnail_url: THUMB }];
    const cards = await enrichPromptCards(db.client as never, [mapPromptRow(row("p1", [ORIGINAL, `${BLOB}9.png`])), mapPromptRow(row("p2", []))]);
    expect(cards[0].showcaseImages).toEqual([
      { url: ORIGINAL, preview: PREVIEW, thumb: THUMB },
      { url: `${BLOB}9.png`, preview: null, thumb: null },
    ]);
    expect(cards[0].previewImages).toEqual(cards[0].showcaseImages);
    expect(cards[1].showcaseImages).toEqual([]);
  });
});

describe("every surface shows the rendition and downloads the original", () => {
  it("the prompt detail", () => {
    const s = src("app", "api", "prompts", "[id]", "route.ts");
    expect(s).toContain("const showcaseImages = withRenditions(showcaseUrls.map((url) => ({ url })), await renditionsByUrl(supabase, showcaseUrls));");
    // With the references each render shows (DEC-514, shown-references.test.ts).
    expect(s).toContain("        showcaseImages: showcaseImages.map((im) => ({ ...im, references: refsByUrl.get(im.url) ?? [] })),\n");
  });

  it("the feed card: thumb or preview by its size, the original only as the fallback", () => {
    const s = src("components", "enki", "FeedCard.tsx");
    expect(s).toContain("src={original ? art.url : art.thumb ?? art.preview ?? art.url}");
    expect(s).toContain("const CARD_SIZES = `auto, (max-width: 639px) 50vw, ${CARD_MAX}px`;");
    expect(s).toContain('srcSet={renditions ? `${art.thumb} ${THUMB_W}w, ${art.preview} ${PREVIEW_W}w` : undefined} sizes={renditions ? CARD_SIZES : undefined}');
    // Their narrowest widths: a 9:16 picture inside 384 and 2048 px squares (Kev, 2026-10-31: blurry until opened).
    expect(s).toContain("const THUMB_W = 216;");
    expect(s).toContain("const PREVIEW_W = 1152;");
    expect(s).toContain('onError={() => (original || !(art.thumb || art.preview) ? setImg("error") : setOriginal(true))}');
  });

  it("the image view's creator examples", () => {
    expect(src("components", "image-view", "useImageViewModel.ts")).toContain('kind: "example", src: preview ?? url, stage: view, thumb: tiny ?? thumb ?? preview ?? url, original: url,');
  });

  it("the profile wall and its viewer", () => {
    const s = src("components", "gallery", "GalleryWall.tsx");
    expect(s).toContain("thumbUrl: g.thumbnail_url ? String(g.thumbnail_url) : undefined,");
    expect(s).toContain("<img src={c.thumbUrl ?? c.imageUrl}");
    expect(s).toContain('<img className="gw-viewer-img" src={selected.imageUrl} alt="" />');
    expect(s).toContain('downloadImage(selected.originalUrl ?? selected.imageUrl, selected.promptTitle ?? "")');
  });
});
