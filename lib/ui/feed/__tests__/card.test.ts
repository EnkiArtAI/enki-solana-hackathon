import { describe, expect, it } from "vitest";
import { openVideoChip, priceChipLabel, seedFromFeedCard, toFeedCard } from "../card";
import { RATES } from "@/lib/video/__tests__/rates";

const row = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  title: "  Brass  ",
  priceUsdCents: 40,
  category: "Photography",
  showcaseImages: [{ url: "https://a/1.webp" }, { url: "https://a/2.webp" }],
  previewImages: [{ url: "https://a/1.webp" }, { url: "https://a/3.webp" }],
  aspectRatio: "16:9",
  creator: { id: "u1", handle: "mara", displayName: "Mara K" },
  promptType: "premium",
  isFreeShowcase: false,
  ...over,
});

describe("priceChipLabel", () => {
  it("says Open at 0 cents (an open prompt) and dollars from cents otherwise", () => {
    expect(priceChipLabel(0)).toBe("Open");
    expect(priceChipLabel(40)).toBe("$0.40");
    expect(priceChipLabel(1)).toBe("$0.01");
    expect(priceChipLabel(125)).toBe("$1.25");
    expect(priceChipLabel(2000)).toBe("$20.00");
  });
  it("shows no chip for a price that is not whole cents", () => {
    for (const bad of [null, undefined, -5, 1.5, Number.NaN, "40"]) expect(priceChipLabel(bad)).toBeNull();
  });
});

describe("toFeedCard", () => {
  it("maps the payload and invents nothing", () => {
    expect(toFeedCard(row())).toEqual({
      id: "p1",
      title: "Brass",
      priceCents: 40,
      category: "photography",
      images: [
        { url: "https://a/1.webp", preview: null, thumb: null },
        { url: "https://a/2.webp", preview: null, thumb: null },
        { url: "https://a/3.webp", preview: null, thumb: null },
      ],
      ratio: 16 / 9,
      creator: { id: "u1", handle: "mara", name: "Mara K" },
      publicText: false,
      stats: null,
      video: null,
      openVideo: null,
    });
  });
  it("carries a prompt's numbers when all three are whole counts, a 0 as a 0", () => {
    expect(toFeedCard(row({ stats: { uses: 3, likes: 0, views: 27 } }))!.stats).toEqual({ uses: 3, likes: 0, views: 27 });
  });
  it("has no numbers at all when one is missing or no count, so nothing shows a 0 nobody counted", () => {
    for (const stats of [null, undefined, {}, { uses: 1, likes: 2 }, { uses: 1, views: 2 }, { likes: 1, views: 2 }, { uses: -1, likes: 0, views: 0 }, { uses: 0, likes: 1.5, views: 0 }, { uses: 0, likes: 0, views: "9" }]) {
      expect(toFeedCard(row({ stats }))!.stats).toBeNull();
    }
  });
  it("has no image, title or price when the payload has none", () => {
    const c = toFeedCard({ id: "p2" })!;
    expect(c.images).toEqual([]);
    expect(c.title).toBe("");
    expect(c.priceCents).toBeNull();
    expect(c.category).toBe("");
    expect(c.creator).toBeNull();
    expect(Object.keys(c)).not.toContain("promptTemplate");
  });
  it("drops empty and non-string image entries, showcase first", () => {
    const c = toFeedCard(row({ showcaseImages: [{ url: "" }, { url: 7 }, "https://a/s.webp"], previewImages: [null, { url: " https://a/p.webp " }] }))!;
    expect(c.images.map((i) => i.url)).toEqual(["https://a/s.webp", "https://a/p.webp"]);
  });
  it("keeps each image's WebP renditions, and the first entry of a repeated original", () => {
    const c = toFeedCard(row({
      showcaseImages: [{ url: "https://a/1.png", preview: "https://a/1.preview.webp", thumb: "https://a/1.thumb.webp" }],
      previewImages: [{ url: "https://a/1.png", preview: null, thumb: null }, { url: "https://a/2.png", preview: "", thumb: "https://a/2.thumb.webp" }],
    }))!;
    expect(c.images).toEqual([
      { url: "https://a/1.png", preview: "https://a/1.preview.webp", thumb: "https://a/1.thumb.webp" },
      { url: "https://a/2.png", preview: null, thumb: "https://a/2.thumb.webp" },
    ]);
  });
  it("keeps only whole, non-negative cents", () => {
    expect(toFeedCard(row({ priceUsdCents: 0 }))!.priceCents).toBe(0);
    expect(toFeedCard(row({ priceUsdCents: 1.5 }))!.priceCents).toBeNull();
    expect(toFeedCard(row({ priceUsdCents: -1 }))!.priceCents).toBeNull();
  });
  it("names the creator by display name, else by handle", () => {
    expect(toFeedCard(row({ creator: { id: "u1", handle: "mara", displayName: "" } }))!.creator).toEqual({ id: "u1", handle: "mara", name: "mara" });
    expect(toFeedCard(row({ creator: null }))!.creator).toBeNull();
  });
  it("sizes the box from the prompt's ratio, 4:5 when it has none", () => {
    expect(toFeedCard(row({ aspectRatio: "1:1" }))!.ratio).toBe(1);
    expect(toFeedCard({ id: "p2" })!.ratio).toBe(0.8);
  });
  it("marks the words public for free and showcase prompts only", () => {
    expect(toFeedCard(row({ promptType: "free" }))!.publicText).toBe(true);
    expect(toFeedCard(row({ promptType: "showcase" }))!.publicText).toBe(true);
    expect(toFeedCard(row({ isFreeShowcase: true }))!.publicText).toBe(true);
    expect(toFeedCard(row())!.publicText).toBe(false);
  });
  it("drops a row without an id", () => {
    expect(toFeedCard(row({ id: "" }))).toBeNull();
    expect(toFeedCard(null)).toBeNull();
  });
});

describe("a card's video", () => {
  const files = { preview: "https://v/p.mp4", v720: "https://v/7.mp4", v1080: "https://v/10.mp4", poster: "https://v/p.webp", width: 720, height: 1280, durationMs: 6000 };

  it("carries the stored files, and its own shape over the prompt's", () => {
    const c = toFeedCard(row({ aspectRatio: "auto", video: files }))!;
    expect(c.video).toEqual(files);
    expect(c.ratio).toBeCloseTo(720 / 1280);
    expect(toFeedCard(row({ video: { ...files, width: null } }))!.ratio).toBeCloseTo(16 / 9);
    expect(toFeedCard(row({ video: { ...files, height: 0 } }))!.video!.height).toBeNull();
  });

  it("is null for an image, and a card without it is what it was", () => {
    expect(toFeedCard(row())!.video).toBeNull();
    expect(toFeedCard(row({ video: null }))!.ratio).toBe(toFeedCard(row())!.ratio);
    for (const bad of ["https://v/p.mp4", 7, [], {}]) expect(toFeedCard(row({ video: bad }))!.video).toBeNull();
  });

  it("takes https addresses only: without its three files there is no video, and the poster stays", () => {
    for (const key of ["preview", "v720", "poster"]) {
      for (const bad of ["http://v/x", "javascript:alert(1)", "data:video/mp4;base64,AAAA", "//v/x", "https://v/a b", 7, null, undefined]) {
        expect(toFeedCard(row({ video: { ...files, [key]: bad } }))!.video).toBeNull();
      }
    }
    expect(toFeedCard(row({ video: { ...files, v1080: "http://v/x" } }))!.video).toEqual({ ...files, v1080: null });
    expect(toFeedCard(row({ video: { ...files, v1080: undefined } }))!.video!.v1080).toBeNull();
    expect(toFeedCard(row({ video: { ...files, preview: " https://v/p.mp4 " } }))!.video!.preview).toBe("https://v/p.mp4");
    for (const width of [-1, 0, "720", Number.NaN, Infinity]) expect(toFeedCard(row({ video: { ...files, width } }))!.video!.width).toBeNull();
    expect(toFeedCard(row({ video: { ...files, durationMs: "6000" } }))!.video!.durationMs).toBeNull();
  });
});

describe("seedFromFeedCard", () => {
  it("hands the Image View what the card knows, and nothing it does not", () => {
    expect(seedFromFeedCard(toFeedCard(row())!)).toEqual({
      promptId: "p1",
      title: "Brass",
      artist: { handle: "mara", name: "Mara K", id: "u1" },
      imageUrl: "https://a/1.webp",
      showcase: ["https://a/1.webp", "https://a/2.webp", "https://a/3.webp"],
      isFree: false,
    });
    // The stage paints the preview while the prompt loads; the showcase keeps the originals, the Image View's keys.
    const withPreview = toFeedCard(row({ showcaseImages: [{ url: "https://a/1.png", preview: "https://a/1.preview.webp", thumb: null }] }))!;
    expect(seedFromFeedCard(withPreview)).toMatchObject({ imageUrl: "https://a/1.preview.webp", showcase: ["https://a/1.png", "https://a/1.webp", "https://a/3.webp"] });
    const bare = seedFromFeedCard(toFeedCard({ id: "p2", promptType: "free" })!);
    expect(bare).toEqual({ promptId: "p2", title: undefined, artist: undefined, imageUrl: undefined, showcase: [], isFree: true });
  });
});

describe("an Open video's chip (Kev, 2026-11-04: \"videos sind nicht umsonst. die kosten alle.\")", () => {
  const FILES = { preview: "https://v/p.mp4", v720: "https://v/7.mp4", v1080: null, poster: "https://v/p.webp", width: 854, height: 480, durationMs: 6000 };
  const open = { id: "p", priceUsdCents: 0, isVideo: true, video: FILES, model: "Seedance 2.5", aspectRatio: "16:9", resolution: "480p" };
  const chip = (raw: object, rateOf: (id: string) => (typeof RATES)[string] | null = (id) => RATES[id] ?? null) => openVideoChip(toFeedCard(raw)!, rateOf);
  it("is what its generator costs at the prompt's own length and resolution", () => {
    expect(chip(open)).toBe("$0.68");
    expect(chip({ ...open, resolution: "720p" })).toBe("$1.53");
    expect(chip({ ...open, video: { ...FILES, durationMs: 10_000 } })).toBe("$1.13");
  });
  it("with no rate known, or a generator not in the list, the card keeps Open: never a $0", () => {
    expect(chip(open, () => null)).toBeNull();
    expect(chip(open, () => ({ cost: { "480p": 1 }, clipsAdded: false }))).toBeNull();
    expect(chip({ ...open, model: "Unknown" })).toBeNull();
  });
  it("an image, and a video with an artist's price, keep their chip", () => {
    expect(toFeedCard({ ...open, isVideo: false, video: null })!.openVideo).toBeNull();
    expect(chip({ ...open, isVideo: false, video: null })).toBeNull();
    expect(chip({ ...open, priceUsdCents: 40 })).toBeNull();
    expect(priceChipLabel(40)).toBe("$0.40");
  });
});
