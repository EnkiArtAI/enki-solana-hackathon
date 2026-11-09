import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { knownRatio, ratioKey, rememberRatio } from "../known-ratio";

// Absolute, so the in-memory mutant runner reaches what these pins read.
const src = (f: string) => readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", f));

describe("a picture's known ratio (review 2026-10-26: the phone hero drew square, then took its shape)", () => {
  it("is remembered by shot key once an image of it loaded, and ignored when the image has no size", () => {
    expect(knownRatio("example:a")).toBeUndefined();
    rememberRatio("example:a", 309, 384);
    expect(knownRatio("example:a")).toBeCloseTo(0.8047, 4);
    rememberRatio("example:b", 0, 384);
    expect(knownRatio("example:b")).toBeUndefined();
  });

  it("is the hero's shape before its own image loads, after its loaded ratio and before the asked one", () => {
    const main = src("MainImage.tsx");
    expect(main).toContain("const ratio = (src && natural[src]) || (s && knownRatio(ratioKey(s))) || parseRatio(s ? s.ratio : m.ratio) || 1;");
    expect(main).toContain("rememberRatio(ratioKey(s), w, h);");
  });

  it("is learnt from the strip's tiles and the phone's History tiles as they load", () => {
    const learn = "onLoad={(e) => rememberRatio(ratioKey(s), e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />";
    expect(src("PreviewStrip.tsx")).toContain(learn);
    expect(src("ImageViewMobile.tsx")).toContain(learn);
  });
});

it("is kept by the picture's address, so two prompts' first examples (example:0 each) never share a shape (review 2026-10-26)", () => {
  expect(ratioKey({ key: "example:0", src: "https://a/1.png" })).toBe("https://a/1.png");
  expect(ratioKey({ key: "example:0", src: "https://b/1.png" })).toBe("https://b/1.png");
  expect(ratioKey({ key: "job:7", src: null })).toBe("job:7");
});
