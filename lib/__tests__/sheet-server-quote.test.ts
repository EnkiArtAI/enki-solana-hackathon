import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The current editor, Image View and Quick Create show server quotes
 * only (Kev, 2026-10-02: "ich brauche safe überall den server-quote"), and
 * the count a sheet shows and prices is the count it generates. Before:
 * a catalogue price with a $0.10 fallback, a 5% fee against the server's 10%,
 * a 20% refill discount the server never gave, a count that multiplied the
 * price while one image was made, and per-image selects that changed nothing.
 */
const ROOT = join(__dirname, "..", "..");
const SHEET = readSource(join(ROOT, "components", "EnkiMobileGenerateModal.tsx"));
const LAUNCHER = readSource(join(ROOT, "components", "GenerateLauncher.tsx"));

describe("the mobile sheet", () => {
  it("shows the parent's server quote for exactly the count it generates", () => {
    // The price rides in the Generate button now (the kit's chip, 2026-10-26), for the count it generates.
    expect(SHEET).toContain('<GenerateButton label={generateLabel || "Generate"} chip={priceFor(genCountNum)}');
    expect(SHEET).toContain('onGenerate(genCountNum); }} size="hero" />');
    expect(SHEET).not.toMatch(/computeGenerationPrice|PLATFORM_FEE_PERCENT|pricePerSlot/);
  });

  it("has no per-image selects that change nothing", () => {
    expect(SHEET).not.toMatch(/updateVariation\(i, \{ (model|ratio|resolution):/);
  });
});

describe("Quick Create", () => {
  it("prices from server quotes and generates the count it priced", () => {
    expect(LAUNCHER).toMatch(/const quotes = useServerQuotes\(/);
    expect(LAUNCHER).toMatch(/priceFor=\{priceFor\}/);
    expect(LAUNCHER).toMatch(/const generate = async \(count: number\) => \{/);
    expect(LAUNCHER).toContain("await executeOrder(Array.from({ length: count }, () => base));");
    expect(LAUNCHER).toContain("const outcomes = await runGenerationBatch(requests, signPayment,");
    expect(LAUNCHER).toContain("const mixedTotal = quoteLabel(mixedQuotes[0], mixedPaidCount);");
    expect(LAUNCHER).toContain("model: mixedPaid, boost: false");
    expect(LAUNCHER).toContain("disabled={!mixedPaid || !mixedTotal || generating}");
    expect(LAUNCHER).not.toMatch(/t\.price|pricePerSlot/);
  });
});

describe("the marketplace tiers and the shared helpers", () => {
  const PGV = readSource(join(ROOT, "components", "image-view", "useImageViewModel.ts"));
  const CORE = readSource(join(ROOT, "hooks", "useGenerationCore.ts"));
  const LIMITS = readSource(join(ROOT, "hooks", "useModelLimits.ts"));
  const SETTINGS = readSource(join(ROOT, "components", "kit", "SettingsPills.tsx"));

  it("each tier shows the server's quote for this prompt", () => {
    expect(PGV).toMatch(/const tierPrices = useServerQuotes\(/);
    expect(PGV).toMatch(/const qualityPrices = useServerQuotes\(/);
  });

  it("no surface can compute a price in the browser any more", () => {
    expect(CORE).not.toMatch(/tierPrice|tierScale|price:/);
    expect(LIMITS).not.toMatch(/export function tierPrice|export function tierScale/);
  });

  it("the quality and resolution options label their matching server quote", () => {
    expect(SETTINGS).toContain("sub: quoteLabel(prices[i])");
    expect(SETTINGS).toContain('core.tiers.map((_, i) => (core.free ? "$0.00" : quoteLabel(prices[i])))');
    expect(SETTINGS).not.toMatch(/\d+x the price/);
  });
});

it("the current editor uses one server quote batch and never guesses a price", () => {
  const editor = readSource(join(ROOT, "components", "prompt-editor", "PromptEditor.tsx"));
  expect(editor).toContain('const quotes = useServerQuotes(signedIn ? batch : []);');
  expect(editor).toContain('quoteBatch(');
  expect(editor).not.toMatch(/getPricePerSlot|getBatchCost|getRefillCost|model\.price\.toFixed/);
});

describe("the sheet's Generate (Kev, 2026-10-26: \"mittig ... den preis dort rein, genauso wie es beim web browser\")", () => {
  const CSS = readSource(join(ROOT, "app", "editor", "mobile-modal.css"));
  it("is the Image View's button: a full-width row on a phone, beside the settings on a wide sheet", () => {
    expect(CSS).toContain(".mobile-modal-footer-actions .kit-gen--hero { width: 100%; height: 52px; padding: 0 84px; font-size: 16px; box-shadow: none; }");
    expect(CSS).toMatch(/@media \(min-width: 768px\) \{\n\s+\.mobile-modal-footer-actions \.kit-gen--hero \{ flex: 1 0 250px; width: auto; max-width: 300px; height: 48px; margin-left: auto; \}/);
    expect(SHEET).not.toContain('className="mobile-modal-pay-inline"');
  });

  // DEC-496 (Kev, 2026-10-29: "die UI oberflächen bei quick create desktop überschneiden sich"). Measured on a replica
  // with this CSS: 0 of 1560 settings widths x sheet widths under Generate, 1549 before.
  it("never runs over the settings on a wide sheet: it gives way to 250 px, then takes a row of its own", () => {
    expect(CSS).toMatch(/@media \(min-width: 768px\) \{[^@]*\n {2}\.mobile-modal-gen-left \{ flex: 0 1 auto; \}\n\}/);
    expect(CSS).not.toMatch(/\.mobile-modal-footer-actions \{ flex-wrap: nowrap; \}|\.mobile-modal-gen-left \{[^}]*flex-wrap: nowrap/);
    expect(CSS).toMatch(/\.mobile-modal-footer-actions \{\n {2}display: flex;\n {2}align-items: center;\n {2}justify-content: space-between;\n {2}gap: 6px 8px;\n {2}flex-wrap: wrap;\n\}/);
  });
});
