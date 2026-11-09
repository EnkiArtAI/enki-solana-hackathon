import { describe, it, expect } from "vitest";
import { generatorCopy, formatCopy, resolutionCopy, qualityCopy } from "../option-copy";

/** Lookups that must never answer for an inherited key. */
const INHERITED = ["constructor", "toString", "__proto__", "hasOwnProperty"];

describe("generatorCopy", () => {
  it.each([
    ["nano-banana-pro", "Best all-rounder: lifelike faces and skin, keeps your people recognisable."],
    ["gpt-image-2", "Follows long, detailed prompts closely and can write text into the image."],
    ["flux", "Fast and cheap: good for quick drafts and trying ideas."],
    ["gpt-image-2-5-flare", "The fastest GPT model: high quality for everyday images and many quick tries."],
    ["gpt-image-2-5-sunburst", "The most capable GPT model: precise edits of your photos, slower than Flare."],
    ["nano-banana-2", "Quick all-rounder: sharp images, keeps several reference photos consistent."],
  ])("gives %s its line", (family, copy) => {
    expect(generatorCopy(family)).toBe(copy);
  });

  it("reads a catalogue name through its model family", () => {
    expect(generatorCopy("Nano Banana Pro")).toBe(generatorCopy("nano-banana-pro"));
    expect(generatorCopy("GPT-Image-2 (coming soon)")).toBe(generatorCopy("gpt-image-2"));
    expect(generatorCopy("Flux (free)")).toBe(generatorCopy("flux"));
  });

  it("is null for a family without a line", () => {
    for (const bad of ["Nano Banana 3", "gpt-image-2.5", "flux-free", "Flux Dev", "", ...INHERITED]) expect(generatorCopy(bad), bad).toBeNull();
  });

  // Kev, 2026-10-26: "bei flare und sunburst steht auch nichts". The live models table's active generators, by name.
  it("has a line for every active generator", () => {
    for (const name of ["Flux (free)", "Nano Banana Pro", "GPT-Image-2", "Nano Banana 2", "GPT-Image-2.5 Flare", "GPT-Image-2.5 Sunburst"]) expect(generatorCopy(name), name).not.toBeNull();
  });
});

describe("formatCopy", () => {
  it.each([
    ["1:1", "Square · Instagram feed, profile pictures"],
    ["4:5", "Portrait · Instagram feed posts"],
    ["3:4", "Portrait · classic photo prints"],
    ["2:3", "Tall · Pinterest, posters"],
    ["16:9", "Wide · YouTube, desktop screens"],
    ["9:16", "Full phone screen · Instagram Stories, Reels, TikTok"],
    ["3:2", "Landscape · camera photos, postcards"],
    ["4:3", "Landscape · tablets, presentation slides"],
    ["5:4", "Landscape · 8×10 prints, framed art"],
    ["21:9", "Cinematic · film stills, website banners"],
    ["auto", "Auto · the model picks the shape to fit your media and words"],
  ])("gives %s its name and use", (ratio, copy) => {
    expect(formatCopy(ratio)).toBe(copy);
  });

  it("is null for any other ratio", () => {
    for (const bad of ["1:4", "4:1", "7:4", "4/5", " 4:5", "Any", "Auto", "adaptive", "", ...INHERITED]) expect(formatCopy(bad), bad).toBeNull();
  });

  // The live models table (read 2026-10-26): every ratio any active generator offers.
  it("has a line for every ratio a generator offers", () => {
    for (const r of ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]) expect(formatCopy(r), r).not.toBeNull();
  });
});

describe("resolutionCopy", () => {
  it.each([
    ["1K", "Fast preview, smallest file"],
    ["2K", "Sharp on any screen"],
    ["4K", "Print quality, the most detail"],
  ])("gives %s the prototype's line", (tier, copy) => {
    expect(resolutionCopy(tier)).toBe(copy);
  });

  it("is null for any other tier, the lower-case host spelling included", () => {
    for (const bad of ["1k", "4k", "8K", "", ...INHERITED]) expect(resolutionCopy(bad), bad).toBeNull();
  });
});

describe("qualityCopy", () => {
  it.each([
    ["low", "Quick drafts, lowest cost"],
    ["medium", "Good for everyday images"],
    ["high", "Finest detail, best for portraits"],
  ])("gives %s the prototype's line", (quality, copy) => {
    expect(qualityCopy(quality)).toBe(copy);
  });

  it("is null for any other quality, the menu's labels included", () => {
    for (const bad of ["Low", "Mid", "auto", "", ...INHERITED]) expect(qualityCopy(bad), bad).toBeNull();
  });
});
