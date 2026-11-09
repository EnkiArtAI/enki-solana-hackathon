import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Quick Create showed Nano Banana Pro (preselected), its price and its 4K
 * tier, and posted every generation to /api/generate-free: Flux rendered,
 * whatever was picked. It now generates the selected model through
 * runGeneration, and nothing when no model is selected.
 */
const ROOT = join(__dirname, "..", "..");
const LAUNCHER = readSource(join(ROOT, "components", "GenerateLauncher.tsx"));
const CORE = readSource(join(ROOT, "hooks", "useGenerationCore.ts"));

describe("Quick Create", () => {
  it("generates the explicitly selected entry through one batch, never the free route directly", () => {
    expect(LAUNCHER).toContain("const outcomes = await runGenerationBatch(requests, signPayment,");
    expect(LAUNCHER).toContain("model: core.entry, resolution: tier");
    expect(LAUNCHER).toContain("await executeOrder(Array.from({ length: count }, () => base));");
    expect(LAUNCHER).not.toMatch(/\/api\/generate-free/);
  });

  it("starts on the default generator (Kev, 2026-10-13), invents no slug, and still refuses without a selection", () => {
    expect(LAUNCHER).toMatch(/const \[model, setModel\] = useState<string>\(DEFAULT_GENERATOR\);/);
    expect(LAUNCHER).not.toMatch(/"nano-banana-pro"|"Nano Banana Pro"/);
    expect(LAUNCHER).toContain('if (!core.entry || !tier) return toast({ title: "Pick a model"');
  });

  // Nothing ever passed it a feed prompt to start from (its one mount is <GenerateLauncher />); that path is gone.
  it("starts from nothing but what is typed or brought back from the gallery", () => {
    expect(LAUNCHER).toContain("export default function GenerateLauncher() {");
    expect(LAUNCHER).not.toMatch(/seedPrompt|promptId: (?!mixed\.base\.promptId)/);
  });
});

describe("the generation core invents no model", () => {
  it("free is the server's flag, and no selection is not free", () => {
    expect(CORE).toMatch(/const free = entry\?\.free === true;/);
    expect(CORE).not.toMatch(/freeRoute|freeEntry|price === 0/);
  });
});
