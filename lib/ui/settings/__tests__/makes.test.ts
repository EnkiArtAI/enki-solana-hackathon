import { describe, expect, it } from "vitest";
import { CLIP_SECONDS, countFor, imageRows, priceOf, videoRows } from "@/lib/ui/settings/makes";

// Kev, 2026-11-08: the Settings mock v64 replaces today's Settings; its "What $20 makes", the hero's "about 261 × Nano
// Banana Pro" and the empty board's "$5 is enough for about 30 ... images or 3 short videos" (DEC-2026-11-08-38).

const entry = (name: string, maxResolution: "1K" | "2K" | "4K", more: { free?: boolean; mediaType?: "image" | "video" } = {}) =>
  ({ id: `id-${name}`, name, maxResolution, free: more.free ?? false, mediaType: more.mediaType ?? ("image" as const) });

// /api/models' order: by price, the free host first.
const CATALOGUE = [
  entry("Flux (free)", "2K", { free: true }),
  entry("GPT Image 2.5 Flare", "4K"),
  entry("Nano Banana 2", "2K"),
  entry("Nano Banana Pro", "4K"),
  entry("Seedance 2.5", "1K", { mediaType: "video" }),
  entry("Imagen 9", "4K"),
];

describe("what an amount makes in images", () => {
  // Built inside each test: a row the server cannot price throws there, a red test, not a file that will not load.
  const rows = () => imageRows(CATALOGUE);

  it("lists the paid image generators the server prices, the app's default first, then the catalogue's order", () => {
    expect(rows().map((r) => r.name)).toEqual(["Nano Banana Pro", "GPT Image 2.5 Flare", "Nano Banana 2"]);
    expect(rows()[0].id).toBe("id-Nano Banana Pro");
  });

  it("prices each size as the server does for a prompt without an artist price: the host's cost, the two checks, then 10 %", () => {
    // Nano Banana Pro 2K: $0.1476 + $0.0001 prompt check + $0.0002 image check = 147 900 micro, + 10 % = 162 690.
    expect(rows()[0].sizes).toEqual([{ size: "1K", micro: 162_690 }, { size: "2K", micro: 162_690 }, { size: "4K", micro: 278_080 }]);
    // gpt-image 2.5 Flare at the quality each size runs at when nobody picks one: low, medium, high.
    expect(rows()[1].sizes).toEqual([{ size: "1K", micro: 6_930 }, { size: "2K", micro: 16_830 }, { size: "4K", micro: 111_430 }]);
  });

  it("never counts a video row as images, nor one on the free host, whatever its name", () => {
    expect(imageRows([entry("Nano Banana Pro", "4K", { mediaType: "video" })])).toEqual([]);
    expect(imageRows([entry("Nano Banana 2", "2K", { free: true })])).toEqual([]);
  });

  it("offers the sizes a generator renders and preselects 2K", () => {
    expect(rows()[2].sizes.map((s) => s.size)).toEqual(["1K", "2K"]);
    expect(rows().map((r) => r.size)).toEqual(["2K", "2K", "2K"]);
    expect(imageRows([entry("Nano Banana 2", "1K")])[0]).toMatchObject({ size: "1K", sizes: [{ size: "1K", micro: 100_760 }] });
  });

  it("matches the mock's own counts for $42.50 and $5 of Nano Banana Pro at 2K", () => {
    expect(countFor(42.5, priceOf(rows()[0]))).toBe(261);
    expect(countFor(5, priceOf(rows()[0]))).toBe(30);
  });

  it("reads a row at the size picked, its preselected one when that size is not offered", () => {
    expect(priceOf(rows()[0], "4K")).toBe(278_080);
    expect(priceOf(rows()[2], "4K")).toBe(49_830);
  });
});

describe("what an amount makes in videos", () => {
  const routes = [
    { id: "seedance-2.5", cost: { "480p": 102_800, "720p": 231_100, "1080p": 568_600 }, clipsAdded: false, available: ["480p", "720p", "1080p"] as const },
    // Sound costs more here; the count is for a clip without it.
    { id: "kling-3.0", cost: { "720p": 84_000, "1080p": 112_000 }, audioCost: { "720p": 126_000, "1080p": 168_000 }, clipsAdded: false, available: ["720p", "1080p"] as const },
    // A 480p cell Kling 4.0 does not make, and 720p priced but not available: only 1080p is offered.
    { id: "kling-4.0", cost: { "480p": 50_000, "720p": 157_000, "1080p": 235_000 }, clipsAdded: false, available: ["480p", "1080p"] as const },
    // Its words set the length: the most they can run is what is paid.
    { id: "omni-1.1-flash", cost: { "720p": 101_400, "1080p": 152_000 }, clipsAdded: false, available: ["720p", "1080p"] as const },
    // No operator yet: nothing it can make.
    { id: "wan-3.0", cost: { "720p": 100_000 }, clipsAdded: false, available: [] as const },
  ];
  const rows = () => videoRows(routes);

  it("lists the video generators that can run, in the composer's order", () => {
    expect(rows().map((r) => r.name)).toEqual(["Seedance 2.5", "Kling 4.0", "Kling 3.0", "Gemini Omni 1.1 Flash"]);
  });

  it("prices a short clip as the video route charges it: its seconds x the rate x 1.10, to the cent", () => {
    expect(CLIP_SECONDS).toBe(5);
    expect(rows()[0]).toMatchObject({ id: "seedance-2.5", seconds: 5, size: "720p", sizes: [
      { size: "480p", micro: 570_000 }, { size: "720p", micro: 1_270_000 }, { size: "1080p", micro: 3_130_000 },
    ] });
    expect(rows()[2].sizes[0]).toEqual({ size: "720p", micro: 460_000 });
    expect(rows()[3]).toMatchObject({ seconds: 10, sizes: [{ size: "720p", micro: 1_120_000 }, { size: "1080p", micro: 1_670_000 }] });
  });

  it("offers only the sizes a model makes and can run now, 720p preselected where it is one of them", () => {
    expect(rows()[1]).toMatchObject({ id: "kling-4.0", size: "1080p", sizes: [{ size: "1080p", micro: 1_290_000 }] });
  });

  it("matches the mock's three short videos for $5", () => {
    expect(countFor(5, priceOf(rows()[0]))).toBe(3);
  });
});

describe("countFor", () => {
  it("counts whole ones in integer micro-USDC, where floats would lose one", () => {
    expect(2.01 * 1_000_000).toBeLessThan(2_010_000);
    expect(countFor(2.01, 1_005_000)).toBe(2);
  });

  it("counts none for no money and none without a price, never Infinity", () => {
    expect(countFor(0, 162_690)).toBe(0);
    expect(countFor(20, 0)).toBe(0);
  });
});
