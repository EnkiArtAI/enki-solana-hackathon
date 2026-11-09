import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Reference images in the Prompt Editor follow the caret (Kev, 2026-10-15):
 * an uploaded image's token goes where the cursor is, not to the end, and the
 * cursor moves behind it; a reference taken out leaves the cursor where it
 * stood, so the next image goes back there. The text side is removeRefAt
 * (prompt-tokens.test.ts); this pins the editor's wiring.
 */
const ED = readSource(join(__dirname, "..", "..", "..", "components", "prompt-editor", "PromptEditor.tsx"));
const between = (from: string, to: string) => ED.slice(ED.indexOf(from), ED.indexOf(to, ED.indexOf(from)));

describe("an uploaded reference", () => {
  const add = between("const addRef = ", "const removeRefImage = ");

  it("goes to the caret the field last had, else to the end, never past the text", () => {
    expect(ED).toContain("return caretKnown.current && ta ? ta.selectionEnd : null;");
    expect(add).toContain("const at = caretAt();");
    expect(add).toContain("const next = insertToken(d.prompt, at === null ? d.prompt.length : Math.min(at, d.prompt.length), refToken(d.refIds.length));");
    expect(add).not.toContain("insertToken(d.prompt, d.prompt.length,");
  });

  it("moves the caret behind its token, so the next one lines up after it", () => {
    expect(add).toContain("after.current = () => promptArea()?.setSelectionRange(next.caret, next.caret);");
    expect(add).toContain("return { refIds: [...d.refIds, refId], prompt: next.text };");
  });
});

describe("a reference taken out", () => {
  const remove = between("const removeRefImage = ", "const tileClick = ");

  it("leaves the caret where it stood, so the next upload goes back there", () => {
    expect(remove).toContain("const cut = removeRefAt(d.prompt, d.refIds.indexOf(refId) + 1);");
    expect(remove).toContain("caretKnown.current = true;");
    expect(remove).toContain("after.current = () => promptArea()?.setSelectionRange(at, at);");
    expect(remove).toContain("return { prompt: cut.text, refIds: d.refIds.filter((r) => r !== refId) };");
    expect(ED).toContain("onRemove={removeRefImage}");
  });

  it("leaves the caret alone when the reference was not in the text", () => {
    expect(remove).toContain("if (cut.caret !== null) {");
  });
});
