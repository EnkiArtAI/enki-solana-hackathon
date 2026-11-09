import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * A release takes at least the minimum (1 for Free, 4 for Premium) and as
 * many more images as the creator stars (Kev, 2026-10-15). toggleStar and
 * releaseBody are covered in variations.test.ts and release.test.ts; this
 * pins the bar and the editor around them.
 */
const ROOT = join(__dirname, "..", "..", "..");
const src = (...p: string[]) => readSource(join(ROOT, ...p));
const BAR = src("components", "prompt-editor", "ReleaseBar.tsx");
const ED = src("components", "prompt-editor", "PromptEditor.tsx");

describe("the release bar", () => {
  it("shows the minimum's slots, one more for every extra star, and the count past the minimum", () => {
    expect(BAR).toContain("{Array.from({ length: Math.max(need, photos.length) }, (_, i) => {");
    expect(BAR).toContain("photos.length > need ? `${photos.length} starred` : `${photos.length}/${need} starred`");
  });
});

describe("the editor", () => {
  it("stars without a most, and keeps every star when the mode changes", () => {
    expect(ED).toContain("const r = toggleStar(state.stars, jobs, jobId, Date.now());");
    expect(ED).toContain('dispatch({ type: "set", patch: { listing: { ...listing, mode } } });');
    expect(ED).not.toContain("starsForFree");
  });

  it("says the minimum is a minimum", () => {
    expect(src("components", "prompt-editor", "VerifyPane.tsx")).toContain("star at least {need === 1 ? `1 ${noun}` : `${need} ${noun}s`} and release.");
  });
});
