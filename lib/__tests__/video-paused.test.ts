import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Segmented from "@/components/kit/Segmented";

// Kev, 2026-11-08: "deaktivier die video funktion zunächst, also bei create prompt, grau sie aus, wir werden sie dann
// implementieren wenn alles ready ist" (DEC-2026-11-08-07).

describe("a segmented choice that is not offered yet", () => {
  it("renders as a disabled button the others stay clickable next to", () => {
    const out = renderToStaticMarkup(createElement(Segmented, {
      role: "radiogroup", ariaLabel: "What this prompt makes", value: "image", onChange: () => {},
      options: [{ key: "image", label: "Image" }, { key: "video", label: "Video · soon", disabled: true }],
    }));
    const buttons = out.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).not.toContain("disabled");
    expect(buttons[1]).toContain('disabled=""');
    expect(buttons[1]).toContain("Video · soon");
  });

  it("is greyed by the kit's own rule, in a tone the theme has", () => {
    const css = readFileSync("components/kit/kit-controls.css", "utf8");
    // The quiet label tone, not --enki-ink-3: cta-contrast.test.ts keeps ink-3 off every control (4.24:1 in purple).
    expect(css).toMatch(/\.kit-seg-btn:disabled \{ color: var\(--enki-label-quiet\); cursor: not-allowed; \}/);
  });
});

describe("Create prompt's Image | Video switch", () => {
  it("offers Video greyed, marked as coming, and Image as before", () => {
    const src = readFileSync("components/prompt-editor/PromptEditor.tsx", "utf8");
    expect(src).toContain('const MEDIA = [{ key: "image", label: "Image" }, { key: "video", label: "Video · soon", disabled: true, title: "Video comes later" }]');
  });
});
