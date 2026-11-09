import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * ENG-07. A free render called recordGeneration without imageUrl, and the
 * recorder writes the generated_images row only when one is given: every
 * free image was missing from its owner's gallery. The route now stores the
 * image (retries, fallback bucket) before it answers and records our copy,
 * never a data URL. The answer carries the same URL, so the client's copy and
 * the gallery row match (a data URL showed every free image twice).
 *
 * REC-1 (Kev's go, 2026-10-16): a stored render is recorded before the
 * answer, which then names its gallery row (imageId), waited for briefly.
 */

const ROUTE = readSource(join(__dirname, "..", "..", "app", "api", "generate-free", "route.ts"));
const answer = ROUTE.indexOf("return NextResponse.json({\n      imageUrl: delivered,");
const record = ROUTE.slice(ROUTE.indexOf("const record = (stored: StoredImage) =>"), ROUTE.indexOf('if (quick.imageUrl.startsWith("data:")) {'));
const missed = ROUTE.slice(ROUTE.indexOf('if (quick.imageUrl.startsWith("data:")) {'), ROUTE.indexOf("} else {", ROUTE.indexOf('if (quick.imageUrl.startsWith("data:")) {')));
const before = ROUTE.slice(ROUTE.indexOf("let delivered = imageUrl;"), ROUTE.indexOf("const record = (stored: StoredImage) =>"));

describe("a free render reaches its owner's gallery", () => {
  it("is stored before the answer, which carries our copy's URL", () => {
    expect(before).toMatch(/const quick = await storeGeneratedImage\(imageUrl, recUserId, Math\.min\(Date\.now\(\) \+ 30_000, storeDeadline\(startedAt\)\)\);\n\s+delivered = quick\.imageUrl;/);
    expect(answer).toBeGreaterThan(-1);
  });

  it("is stored again after the response when the first store missed, and recorded either way", () => {
    expect(missed).toMatch(/after\(async \(\) => \{\n\s+const stored = await storeGeneratedImage\(imageUrl, recUserId, Math\.min\(Date\.now\(\) \+ 120_000, storeDeadline\(startedAt\)\)\);/);
    expect(missed).toContain('if (stored.imageUrl.startsWith("data:")) console.warn("[generate-free] stored nowhere: recorded without its gallery row");');
    expect(missed).toContain("await record(stored);");
    // The clock starts with the request, not with the response.
    expect(ROUTE).toMatch(/export async function POST\(request: NextRequest\) \{\n(\s*\/\/.*\n)*\s+const startedAt = Date\.now\(\);/);
  });

  it("records our copy and never a data URL", () => {
    expect(record).toMatch(/recordGeneration\(supabase, \{\n(\s+\/\/.*\n)*\s+adult: adult \|\| seen\.verdict === "adult",\n\s+\.\.\.\(stored\.imageUrl\.startsWith\("data:"\) \? \{\} : stored\),/);
  });

  it("records a stored render before the answer and names its gallery row in it (REC-1)", () => {
    const stored = ROUTE.indexOf("const recording = record(quick);\n          after(recording);\n          imageId = await imageIdWithin(recording);");
    expect(stored).toBeGreaterThan(-1);
    expect(stored).toBeLessThan(answer);
    expect(ROUTE).toContain("imageUrl: delivered,\n      ...(imageId ? { imageId } : {}),");
  });

  it("stores no reference image: the free model takes none, so none is ever judged", () => {
    expect(record).toContain("references: [],");
    expect(ROUTE).not.toContain("storeReferenceImages(");
  });
});
