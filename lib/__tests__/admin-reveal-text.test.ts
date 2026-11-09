import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The moderation owner's reveal of a prompt's text (round 11, 2026-10-20): a
 * text that could not be read right now is said as such, before the answer
 * that the record holds no artist text.
 */
const ADMIN = readSource(join(__dirname, "..", "..", "app", "api", "admin", "route.ts"));

describe("the admin reveal of a prompt's text", () => {
  it("answers a load that failed for any reason but no text with 503, before the 404", () => {
    const failed = ADMIN.indexOf("if (loaded && !loaded.ok && loaded.status !== 422) {");
    const answer = ADMIN.indexOf('return NextResponse.json({ error: "The prompt\'s text could not be read right now. Try again." }, { status: 503 });', failed);
    const none = ADMIN.indexOf("This record holds no ");
    expect(failed).toBeGreaterThan(ADMIN.indexOf("const loaded = fromPrompt ? await loadPromptText("));
    expect(answer).toBeGreaterThan(failed);
    expect(none).toBeGreaterThan(answer);
  });
});
