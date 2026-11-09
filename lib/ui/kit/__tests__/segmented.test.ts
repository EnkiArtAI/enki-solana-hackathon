import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Segmented from "@/components/kit/Segmented";

type Seg = ReactElement<{ className: string; style?: Record<string, number>; "data-tone"?: string }>;

const mount = (value: "free" | "premium", slide?: boolean, tone?: "soft") =>
  Segmented({ options: [{ key: "free", label: "Open" }, { key: "premium", label: "Premium" }], value, onChange: vi.fn(), ariaLabel: "Listing", role: "radiogroup", slide, tone }) as Seg;

describe("Segmented slide (Kev, 2026-10-13: Open | Premium switches like a pill)", () => {
  it("tells the stylesheet how many choices there are and which one the thumb sits under", () => {
    expect(mount("free", true).props.style).toEqual({ "--kit-seg-n": 2, "--kit-seg-i": 0 });
    expect(mount("premium", true).props.style).toEqual({ "--kit-seg-n": 2, "--kit-seg-i": 1 });
    expect(mount("premium", true).props.className).toBe("kit-seg kit-focus kit-seg--slide");
  });

  it("the plain control (kinds, tabs) carries no thumb", () => {
    const plain = mount("premium");
    expect(plain.props.className).toBe("kit-seg kit-focus");
    expect(plain.props.style).toBeUndefined();
  });
});

// Kev, 2026-11-08: the Settings mock v64 replaces today's Settings, its bars and pills as drawn (DEC-2026-11-08-39).
describe("Segmented soft", () => {
  const css = readFileSync("components/kit/kit-controls.css", "utf8");
  const soft = css.slice(css.indexOf("\n/* Soft"), css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .kit-seg--slide::before"));

  it("is a tone the kit marks as it marks ValueList's, with or without the thumb; the control without it is as before", () => {
    expect(mount("free", true, "soft").props["data-tone"]).toBe("soft");
    expect(mount("free", false, "soft").props).toMatchObject({ className: "kit-seg kit-focus", "data-tone": "soft" });
    expect(mount("free", true).props["data-tone"]).toBeUndefined();
  });

  it("keeps a choice not offered yet a disabled button", () => {
    const out = renderToStaticMarkup(createElement(Segmented, {
      role: "tablist", ariaLabel: "Money", value: "balance", onChange: () => {}, slide: true, tone: "soft",
      options: [{ key: "balance", label: "Balance" }, { key: "api", label: "API", disabled: true }],
    }));
    expect(out).toContain('data-tone="soft"');
    expect(out.match(/<button[^>]*>API<\/button>/)?.[0]).toContain('disabled=""');
    expect(out.match(/<button[^>]*>Balance<\/button>/)?.[0]).not.toContain("disabled");
  });

  it("lays a quiet track, 3 px around the choices unless a bar sets its own", () => {
    expect(soft).toContain('.kit-seg[data-tone="soft"] { padding: var(--kit-seg-pad, 3px); border: 0; background: var(--enki-fill-hover); }');
  });

  it("writes the others in the quiet label tone and the chosen one in ink, all at 600", () => {
    expect(soft).toContain('.kit-seg[data-tone="soft"] .kit-seg-btn { color: var(--enki-label-quiet); font-weight: 600; }');
    expect(soft).toContain('.kit-seg[data-tone="soft"] .kit-seg-btn[aria-checked="true"],\n.kit-seg[data-tone="soft"] .kit-seg-btn[aria-selected="true"] { color: var(--enki-ink); }');
  });

  it("puts the chosen one on paper: the button itself without a thumb, the thumb inside the track's padding with one", () => {
    expect(soft).toContain('.kit-seg[data-tone="soft"]:not(.kit-seg--slide) .kit-seg-btn[aria-checked="true"],\n.kit-seg[data-tone="soft"]:not(.kit-seg--slide) .kit-seg-btn[aria-selected="true"] { background: var(--enki-paper); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14); }');
    const thumb = soft.slice(soft.indexOf('.kit-seg--slide[data-tone="soft"]::before {'));
    expect(thumb.slice(0, thumb.indexOf("}"))).toBe([
      '.kit-seg--slide[data-tone="soft"]::before {',
      "  top: var(--kit-seg-pad, 3px);",
      "  bottom: var(--kit-seg-pad, 3px);",
      "  left: var(--kit-seg-pad, 3px);",
      "  width: calc((100% - 2 * var(--kit-seg-pad, 3px)) / var(--kit-seg-n, 2));",
      "  background: var(--enki-paper);",
      "  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14);",
      "",
    ].join("\n"));
  });

  it("dims a choice not offered yet, whose colour is already the idle one's", () => {
    expect(soft).toContain('.kit-seg[data-tone="soft"] .kit-seg-btn:disabled { opacity: 0.45; }');
    expect(css).toContain(".kit-seg-btn:disabled { color: var(--enki-label-quiet); cursor: not-allowed; }");
  });

  it("names no colour of its own: every tone is the theme's", () => {
    expect(soft.length).toBeGreaterThan(200);
    expect(soft).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
