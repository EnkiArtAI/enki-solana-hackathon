import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";

// The button's only hook is a ref: a plain box lets the component run as a
// function, and its click handler be pressed directly.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: <T>(current: T) => ({ current }),
}));

import GenerateButton from "@/components/kit/GenerateButton";

type Button = ReactElement<{
  onClick: (e: { timeStamp: number }) => void; "aria-disabled"?: boolean; disabled?: boolean; "data-short"?: boolean; title?: string;
  children: [string, ReactElement<{ className: string; children: [ReactElement<{ children: [string, string] }> | false, string] }>];
}>;

const mount = (dimmed: boolean, short: string | null = null) => {
  const onPress = vi.fn();
  const button = GenerateButton({ label: "✦ Generate", chip: "$0.147", dimmed, onPress, size: "block", short }) as Button;
  return { onPress, button, press: (t: number) => button.props.onClick({ timeStamp: t }) };
};

describe("GenerateButton", () => {
  it("drops a press within 350 ms of the last accepted one, so a double click pays once", () => {
    const { onPress, press } = mount(false);
    press(1000);
    press(1200);
    press(1350);
    press(1500);
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("only looks disabled when dimmed: the press still reaches the surface", () => {
    const { onPress, button, press } = mount(true);
    expect(button.props["aria-disabled"]).toBe(true);
    expect(button.props.disabled).toBeUndefined();
    press(0);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("a short balance marks the button, says what the press now does, and puts the balance beside the price in the chip (Kev, 2026-10-13)", () => {
    const { button } = mount(false, "$0.00");
    expect(button.props["data-short"]).toBe(true);
    expect(button.props.title).toBe("Your balance is below the price · opens Add funds");
    const chip = button.props.children[1];
    expect(chip.props.className).toBe("kit-gen-chip");
    expect(chip.props.children[0]).toMatchObject({ props: { className: "kit-gen-short", children: ["Balance ", "$0.00"] } });
    expect(chip.props.children[1]).toBe("$0.147");
  });

  it("with the balance in order the chip is the price alone and nothing marks the button", () => {
    const { button } = mount(false);
    expect(button.props["data-short"]).toBeUndefined();
    expect(button.props.title).toBeUndefined();
    expect(button.props.children[1].props.children).toEqual([false, "$0.147"]);
  });
});

describe("the Image View's hero", () => {
  const css = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "kit", "kit-controls.css"), "utf8");
  const phone = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view-mobile.css"), "utf8");
  const foot = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "ComposeFoot.tsx"), "utf8");

  it("is the button's hero size, with the same guard and chip", () => {
    const onPress = vi.fn();
    const hero = GenerateButton({ label: "✦ Generate 3", chip: "$0.60", dimmed: false, onPress, size: "hero" }) as Button;
    expect((hero.props as unknown as { className: string }).className).toBe("kit-gen kit-gen--hero kit-hit kit-focus");
    hero.props.onClick({ timeStamp: 1000 });
    hero.props.onClick({ timeStamp: 1100 });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(foot).toContain('short={m.photosNeeded ? null : m.short} onPress={m.generate} size="hero" />');
  });

  it("is 64 x 400 with radius 16 on desktop and 58 high, full width on the phone, its chip the kit's", () => {
    expect(css).toMatch(/\.kit-gen--hero \{\n  width: 400px;\n  max-width: 100%;\n  height: 64px;\n  padding: 0 90px;\n  border-radius: 16px;\n  font-size: 18px;/);
    expect(css).toContain(".kit-gen--hero .kit-gen-chip { top: 9px; right: 9px; bottom: 9px; padding: 0 14px; font-size: 15px; }");
    expect(phone).toContain(".iv-mobile .kit-gen--hero { width: 100%; height: 58px; padding: 0 84px; font-size: 17px; }");
  });
});

// Kev, 2026-10-30: "die preisanzeige und generate button aussehen sollte überall gleich sein. bei image gen im studio ist
// zb preis grau und video orange hinterlegt. keep these generate buttons pls rechteckig with abgerundeten ecken AND with
// ... bright rosa aka schon fast weiss and bordeaux".
describe("one Generate look on every surface", () => {
  const ROOT = join(__dirname, "..", "..", "..", "..");
  const css = readFileSync(join(ROOT, "components", "kit", "kit-controls.css"), "utf8");
  const block = (sel: string) => css.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[^}]*\\}`))![0];

  it("is a rounded rectangle, its price a near-white rose in ember, in every size", () => {
    expect(block(".kit-gen")).toContain("border-radius: 12px;");
    expect(css).toContain(".kit-gen--bar .kit-gen-chip { top: 5px; right: 5px; bottom: 5px; padding: 0 10px; border-radius: 6px; font-size: 12px; }");
    expect(block(".kit-gen-chip")).toContain("border-radius: 7px;\n  background: color-mix(in oklab, var(--enki-ember) 7%, var(--enki-paper));\n  color: var(--enki-ember);");
    // No size, no surface paints the price or the button another colour (the grey and the orange of 2026-10-30).
    expect(css).not.toContain("--enki-price-bg");
    for (const file of [["components", "enki", "feed.css"], ["components", "create", "video", "video.css"], ["components", "remix", "remix.css"],
      ["components", "image-view", "image-view.css"], ["components", "image-view", "image-view-mobile.css"], ["app", "editor", "mobile-modal.css"]]) {
      const rules = readFileSync(join(ROOT, ...file), "utf8").match(/[^{}]*\.kit-gen[^{]*\{[^}]*\}/g) ?? [];
      for (const rule of rules) expect(rule, file.join("/")).not.toMatch(/(^|[\s;{])(background|color|filter|border-radius):/);
    }
  });
});
