import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * A free prompt runs on every generator, whatever list it stored (Kev,
 * 2026-10-14: "for all free images, always allow all available generators"),
 * on every free prompt there is, since the rule is read-time.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const MODEL = readSource(join(ROOT, "components", "image-view", "useImageViewModel.ts"));
const DIALOG = readSource(join(ROOT, "components", "enki-shell", "ReferModal.tsx"));

describe("a free prompt", () => {
  it("offers every generator, whatever its stored list says; a premium one offers its list", () => {
    expect(MODEL).toContain("const offered = premium ? offeredModels(prompt?.ai_settings) : [];");
    expect(MODEL).toContain("const models = modelOptions(catalogue, premium, offered);");
    expect(DIALOG).toContain('Offered on every generator · from @{shown.source.handle || "the post"}');
    expect(DIALOG).not.toContain("as the post says");
  });
});
