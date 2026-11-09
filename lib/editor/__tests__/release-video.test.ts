import { describe, expect, it } from "vitest";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { Job } from "@/lib/ui/kit/render-queue";
import type { EditorSetup } from "../generate-checks";
import { librarySeed, seedDoc, stashSeed, takeSeed } from "../editor-seed";
import { loadPrompt, type ServerPrompt } from "../load-prompt";
import { MAKE_VIDEO_FIRST, listingOnly, mediaOf, releaseBlock, releaseBody, starsNeeded, updateBody, type Listing } from "../release";

/**
 * A video prompt in the editor's release (Kev, 2026-11-03: "allow also only the creation of 1 video for premium prompts"):
 * exactly one video, on premium as on open; an old draft reads as an image; the body names the render's row.
 */
const VIDEO_ROW: CatalogueEntry = { id: "m-v", name: "Seedance 2.5", price: 0, mediaType: "video", supportsQuality: false, maxResolution: "2K", ratios: ["1:1"], free: false };
const setup: EditorSetup = { prompt: "Rain over [city]", vars: { city: "Rome" }, kinds: { city: "text" }, refIds: [], modelId: "m-v", modelName: "Seedance 2.5", ratio: "16:9", resolution: "2K", boost: false };
const job = (id: string, over: Partial<Job<EditorSetup>> = {}): Job<EditorSetup> => ({ id, createdAt: 1, status: "ready", setup, imageUrl: "https://v/720.mp4", imageId: `row-${id}`, seen: true, ...over });
const listing = (over: Partial<Listing> = {}): Listing => ({ title: "Rain", mode: "premium", price: 0.4, category: "Portrait", modelIds: ["m-v"], testId: null, media: "video", ...over });

describe("what a release takes", () => {
  it("one video on premium and on open; an image prompt what its mode asks; an old draft is an image", () => {
    expect([starsNeeded({ mode: "premium", media: "video" }), starsNeeded({ mode: "free", media: "video" })]).toEqual([1, 1]);
    expect([starsNeeded({ mode: "premium", media: "image" }), starsNeeded({ mode: "free" }), starsNeeded({ mode: "premium" })]).toEqual([4, 1, 4]);
    expect([mediaOf({}), mediaOf({ media: "video" })]).toEqual(["image", "video"]);
  });

  it("no video: says to make it first, on either mode", () => {
    for (const mode of ["premium", "free"] as const) {
      expect(releaseBlock({ listing: listing({ mode }), starred: [], busy: false })).toEqual({ check: "stars", message: MAKE_VIDEO_FIRST });
    }
    expect(MAKE_VIDEO_FIRST).toBe("Make the video first");
  });

  it("two videos: refused, one lets it go", () => {
    expect(releaseBlock({ listing: listing(), starred: [job("a"), job("b")], busy: false })).toEqual({ check: "stars", message: "A video prompt shows one video: leave one starred" });
    expect(releaseBlock({ listing: listing(), starred: [job("a")], busy: false })).toBeNull();
    expect(releaseBlock({ listing: listing({ mode: "free" }), starred: [job("a")], busy: false })).toBeNull();
  });

  it("an image prompt's stars are as they were", () => {
    expect(releaseBlock({ listing: listing({ media: undefined }), starred: [job("a")], busy: false })?.message).toBe("Star 3 more images from one variation");
    expect(releaseBlock({ listing: listing({ media: "image", mode: "free" }), starred: [], busy: false })?.message).toBe("Star 1 more image from one variation");
  });

  it("an update of what is live needs no new video", () => {
    expect(releaseBlock({ listing: listing(), starred: [], loaded: { prompt: "x", vars: {} }, busy: false })).toBeNull();
  });
});

describe("the body", () => {
  it("names the render's row and the medium, no photos, the generators by name", () => {
    const made = releaseBody({ listing: listing(), starred: [job("a")], refs: {}, catalogue: [VIDEO_ROW] });
    expect("body" in made && made.body).toMatchObject({ mediaType: "video", showcaseVideoImageId: "row-a", uploadedPhotos: [], aiModel: "Seedance 2.5", aiModels: ["Seedance 2.5"], price: 0.4, promptType: "premium-prompt" });
  });

  it("a video job without its row says to make it first", () => {
    expect(releaseBody({ listing: listing(), starred: [job("a", { imageId: undefined })], refs: {}, catalogue: [VIDEO_ROW] })).toEqual({ error: MAKE_VIDEO_FIRST });
  });

  it("an image prompt's body names neither, as it was", () => {
    const made = releaseBody({ listing: listing({ media: undefined, mode: "free" }), starred: [job("a")], refs: {}, catalogue: [VIDEO_ROW] });
    const body = "body" in made ? made.body : null;
    expect(body && "mediaType" in body).toBe(false);
    expect(body && "showcaseVideoImageId" in body).toBe(false);
    expect(body?.uploadedPhotos).toEqual(["https://v/720.mp4"]);
  });

  it("a listing-only update of a video prompt says it is one, and keeps its poster", () => {
    const saved = { content: "c", variables: [], referenceImages: [], uploadedPhotos: ["https://v/poster.webp"], aspectRatio: "16:9", resolution: "720p", aiModel: "Seedance 2.5" };
    const body = updateBody({ listing: listing(), saved, id: "p", catalogue: [VIDEO_ROW] });
    expect(body).toMatchObject({ mediaType: "video", uploadedPhotos: ["https://v/poster.webp"], aiModel: "Seedance 2.5" });
    expect("showcaseVideoImageId" in body).toBe(false);
  });
});

describe("a released video prompt back in the editor", () => {
  const server = (over: Partial<ServerPrompt> = {}): ServerPrompt => ({
    id: "p", title: "Rain", content: "Rain", category: "Portrait", aiModel: "Seedance 2.5", aiModels: ["Seedance 2.5"], price: 0.4, aspectRatio: "16:9", promptType: "paid-prompt",
    uploadedPhotos: ["https://v/poster.webp"], referenceImages: [], resolution: "720p", variables: [], ...over,
  });

  it("is a video; an image prompt or one from before SQL 52 has no such field", () => {
    expect(loadPrompt(server({ mediaType: "video" }), [VIDEO_ROW]).listing.media).toBe("video");
    expect("media" in loadPrompt(server({ mediaType: "image" }), [VIDEO_ROW]).listing).toBe(false);
    expect("media" in loadPrompt(server(), [VIDEO_ROW]).listing).toBe(false);
  });

  it("a mode switch on its one poster stays a listing-only update: premium asks no four of a video", () => {
    const loaded = loadPrompt(server({ mediaType: "video", promptType: "free" }), [VIDEO_ROW]);
    expect(listingOnly(loaded.doc, listing({ mode: "premium" }), loaded, 0)).toBe(true);
    const image = loadPrompt(server({ promptType: "free" }), [VIDEO_ROW]);
    expect(listingOnly(image.doc, listing({ mode: "premium", media: undefined }), image, 0)).toBe(false);
  });
});

describe("the hand-over from Create > Video", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };

  it("carries the medium, across the store, and the words", () => {
    const seed = librarySeed({ name: "Rain", prompt_text: "Rain", media: "video" })!;
    expect(seed).toEqual({ kind: "library", title: "Rain", promptText: "Rain", media: "video" });
    const store = memory();
    expect(stashSeed(store, "me", seed)).toBe(true);
    expect(takeSeed(store, "me")).toEqual(seed);
  });

  it("goes on no words too: Video's switch is what it hands over; an image's blank seed stays none", () => {
    expect(librarySeed({ name: "New prompt", prompt_text: "", media: "video" })).toEqual({ kind: "library", title: "New prompt", promptText: "", media: "video" });
    expect(librarySeed({ name: "x", prompt_text: " " })).toBeNull();
    const store = memory();
    stashSeed(store, "me", librarySeed({ name: "New prompt", prompt_text: "", media: "video" })!);
    expect(takeSeed(store, "me")?.media).toBe("video");
    expect(seedDoc(librarySeed({ name: "New prompt", prompt_text: "", media: "video" })!).prompt).toBe("");
  });

  it("an image's seed names no medium, as it was", () => {
    expect(librarySeed({ name: "A", prompt_text: "A" })).toEqual({ kind: "library", title: "A", promptText: "A" });
  });
});
