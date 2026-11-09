import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";
import { holdingsOf } from "@/hooks/useHoldings";

/**
 * Opening the Image View flashed a red Generate with "Loading images… ·
 * Balance $0.00" (Kev, 2026-10-14): the balance hook had answered "ready"
 * for no address, and that $0.00 stood in for the address that arrived a
 * moment later. A balance is ready only with an answer for its own address;
 * the button is never red while its images load; and a button that cannot
 * go is a shade darker, not see-through.
 */
const ROOT = join(__dirname, "..", "..");
const HOOK = readSource(join(ROOT, "hooks", "useHoldings.ts"));
const MODEL = readSource(join(ROOT, "components", "image-view", "useImageViewModel.ts"));
const CSS = readFileSync(join(ROOT, "components", "kit", "kit-controls.css"), "utf8");

describe("holdingsOf", () => {
  it("is ready only with an answer for this very address", () => {
    expect(holdingsOf(null, "A")).toEqual({ balance: 0, ready: false });
    expect(holdingsOf({ address: "A", balance: 4.2 }, "A")).toEqual({ balance: 4.2, ready: true });
    expect(holdingsOf({ address: null, balance: 0 }, "A")).toEqual({ balance: 0, ready: false });
    expect(holdingsOf({ address: "A", balance: 4.2 }, "B")).toEqual({ balance: 0, ready: false });
    expect(holdingsOf({ address: null, balance: 0 }, null)).toEqual({ balance: 0, ready: true });
  });
});

describe("the holdings hook", () => {
  it("keys every answer by the address it was fetched for, and keeps a previous answer only for the same address", () => {
    expect(HOOK).toContain("const key = address ?? null;");
    expect(HOOK).toContain("if (!key) { setGot({ address: null, balance: 0 }); return; }");
    // A failed read is no answer: no $0.00 stands in, the previous answer for this address stays.
    expect(HOOK).toContain("      if (res.ok) {");
    expect(HOOK).toContain("        setGot({ address: key, balance });");
    expect(HOOK.split("setGot(")).toHaveLength(3);
    expect(HOOK).toContain("return { ...holdingsOf(got, key), refresh: fetchBalance };");
    expect(HOOK).not.toContain("setReady(true)");
  });
});

describe("Generate while the balance loads", () => {
  it("is greyed with a reason on the Image View, and a press reads the balance again", () => {
    expect(MODEL).toContain("    if (balance && !holdings.ready) return { label: GENERATE, why: BALANCE_LOADING };");
    expect(MODEL).toContain("      if (gate.why === BALANCE_LOADING) refreshHoldings();");
  });
  it("reads the balance again on a press in the Prompt Editor", () => {
    expect(readSource(join(ROOT, "components", "prompt-editor", "PromptEditor.tsx"))).toContain('    if (b.check === "balance") refreshHoldings();');
  });
});

describe("Generate while it cannot go", () => {
  it("is never red while the images load, and a shade darker rather than see-through", () => {
    expect(MODEL).toContain("const short = balance?.short && !reads.loading ? balance.text : null;");
    // Its ground only: the price keeps its colours (Kev, 2026-10-30: the price read grey).
    expect(CSS).toContain('.kit-gen[aria-disabled="true"] { background: linear-gradient(rgb(0 0 0 / 0.3), rgb(0 0 0 / 0.3)), var(--cta-bg); cursor: not-allowed; }');
    expect(CSS).not.toContain('.kit-gen[aria-disabled="true"] { opacity');
    expect(CSS).not.toMatch(/\.kit-gen[^{]*\{[^}]*filter:/);
  });
});
