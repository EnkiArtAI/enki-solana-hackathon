import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Quick Create (GenerateLauncher → EnkiMobileGenerateModal, styled by
 * app/editor/mobile-modal.css) kept the old warm cream palette and an orange
 * Generate in the bright theme while the rest of the app moved to the v2
 * white tokens (Kev, 2026-10-21). Its live rules now read the theme tokens;
 * dark and purple keep their own `.dark` overrides.
 */
const ROOT = join(__dirname, "..", "..");
const CSS = readSource(join(ROOT, "app", "editor", "mobile-modal.css"));
const MODAL = readSource(join(ROOT, "components", "EnkiMobileGenerateModal.tsx"));

/** The old palette: sheet, fields, hairlines, inks, the orange CTA and the green variable pill. */
const OLD = ["#FCFBF8", "#F6F3EC", "#EBE5DB", "#F2EFEA", "#F0E9DF", "#1C1A18", "#5A5550", "#8A7F72", "#8A847C", "#B8B0A6", "#C4BDB5", "#D8D0C4", "#E07045", "#C85E35", "#EAF0EC", "#376C54"];
/** What the Quick Create sheet renders (the Generate tab in a fixed sheet; the Release tab never shows there). */
const LIVE = [
  ".mobile-modal-sheet", ".mobile-modal-close", ".mobile-modal-label", ".mobile-modal-prompt-box", ".mobile-modal-hl-textarea",
  ".mobile-modal-hl-backdrop", ".mobile-modal-hl-textarea::placeholder", ".mobile-modal-hl-textarea::selection", ".mobile-modal-prompt-text",
  ".mobile-modal-pill", ".mobile-modal-var-input", ".mobile-modal-var-input::placeholder", ".mobile-modal-select", ".mobile-modal-footer",
  ".mobile-modal-var-remove", ".mobile-modal-pay-inline", ".mobile-modal-pay-inline-price",
  ".mobile-modal-result-thumb", ".mobile-modal-result-thumb--loading",
  ".mobile-modal-generate-btn", ".mobile-modal-generate-btn:hover", ".mobile-modal-add-var-btn", ".mobile-modal-ref-btn", ".mobile-modal-ref-btn:hover",
  ".mobile-modal-ref-btn:disabled", ".mobile-modal-ref-note", ".mobile-modal-ref-chip", ".mobile-modal-ref-pop", ".mobile-modal-ref-popcard",
  ".mobile-modal-ref-insert", ".mobile-modal-handle-title",
];
const rules = [...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, sel, body]) => ({ sels: sel.split(",").map((s) => s.trim()), body }));
/** The rule with exactly these selectors. */
const block = (...sels: string[]) => rules.find((r) => r.sels.length === sels.length && sels.every((x) => r.sels.includes(x)))?.body ?? "";

describe("Quick Create in the bright theme", () => {
  it("names no colour of the old cream palette in a rule the sheet renders, outside the dark overrides", () => {
    const live = rules.filter((r) => !r.sels.some((s) => s.includes(".dark")) && r.sels.some((s) => LIVE.includes(s)));
    expect(live.length).toBeGreaterThanOrEqual(LIVE.length);
    const left = live.flatMap((r) => OLD.filter((hex) => r.body.toUpperCase().includes(hex)).map((hex) => `${r.sels.join(", ")}: ${hex}`));
    expect(left).toEqual([]);
  });

  it("gives Generate the app's call-to-action colours, as the launcher pill and the kit's Generate have", () => {
    expect(block(".mobile-modal-generate-btn")).toContain("background: var(--cta-bg);");
    expect(block(".mobile-modal-generate-btn")).toContain("color: var(--cta-ink);");
    expect(block(".mobile-modal-generate-btn:hover")).toContain("background: var(--enki-accent-hover);");
  });

  it("puts the sheet and its fields on the v2 paper with v2 hairlines and inks", () => {
    expect(block(".mobile-modal-sheet")).toContain("background: var(--enki-paper);");
    expect(block(".mobile-modal-hl-backdrop")).toContain("background: var(--enki-paper);");
    expect(block(".mobile-modal-hl-backdrop", ".mobile-modal-hl-textarea")).toContain("border: 1px solid var(--enki-rule);");
    // The one label's quiet tone since DEC-2026-11-08-28 (ink-3 in light, ink-2 in dark and purple).
    expect(block(".mobile-modal-label")).toContain("color: var(--enki-label-quiet);");
  });

  it("draws the footer's icons in the theme's quiet ink", () => {
    expect(MODAL).not.toContain('style={{ color: "#8A7F72", flexShrink: 0 }}');
    // Its settings are the kit's pills since 2026-10-27 (GenerateLauncher), with the kit's own icons and inks.
    expect(MODAL).toContain("{settings?.(genCountNum, (n) => setGenCount(`x ${n}`))}");
  });
});
