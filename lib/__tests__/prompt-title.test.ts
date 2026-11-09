import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRealTitle } from "../prompt-title";

describe("a prompt's title (Kev, 2026-10-17: every prompt has one)", () => {
  it("is a non-blank text that is not a placeholder", () => {
    expect(isRealTitle("Fox at dusk")).toBe(true);
    expect(isRealTitle("Untitled #2")).toBe(true);
    for (const t of ["", "   ", "Untitled", "untitled prompt", " Untitled  Prompt ", null, undefined, 3]) expect(isRealTitle(t), String(t)).toBe(false);
  });

  it("is checked by the save route before anything else, and stored trimmed", () => {
    const route = readFileSync(join(__dirname, "..", "..", "app", "api", "prompt", "route.ts"), "utf8");
    expect(route).toMatch(/const body = \(await req\.json\(\)\) as SaveBody;\s+if \(!isRealTitle\(body\?\.title\)\) \{\s+return NextResponse\.json\(\{ error: "title is required" \}, \{ status: 400 \}\);\s+\}\s+body\.title = body\.title\.trim\(\);/);
    const patch = readFileSync(join(__dirname, "..", "..", "app", "api", "prompts", "[id]", "route.ts"), "utf8");
    expect(patch).toContain(`if (body.title !== undefined) {
      if (!isRealTitle(body.title)) return NextResponse.json({ error: "title is required" }, { status: 400 });
      update.title = body.title.trim();`);
  });

  it("keeps Refer a prompt's Publish off for a placeholder, so the server's refusal never shows", () => {
    const modal = readFileSync(join(__dirname, "..", "..", "components", "enki-shell", "ReferModal.tsx"), "utf8");
    expect(modal).toContain(`if (step.at !== "verify" || !isRealTitle(title)) return;`);
    expect(modal).toContain(`disabled={step.at === "publishing" || !isRealTitle(title)}`);
  });
});
