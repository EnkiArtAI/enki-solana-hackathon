import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "@/lib/__tests__/_read-source";
import type { GenerationCore } from "@/hooks/useGenerationCore";
import type { GenerationQuote } from "@/lib/generation-checkout";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";
import type { MenuOption } from "@/components/kit/PillMenu";
import { typedPick } from "@/lib/ui/kit/controls";

/**
 * Below 1024 px the Image View's settings show every option at once in their
 * sheet, a tap takes one and closes, the picked one too (Kev, 2026-10-26: "ich
 * will so wenig wie möglich scrollen müssen", "wenn ein model ausgewählt ist
 * und ich nochmal drauf clicke, so soll die UI das auswählen und sich
 * schließen"). The count is a grid of every count and takes a typed one.
 */
vi.mock("@/components/kit/PillMenu", () => ({ default: () => null }));
vi.mock("@/components/kit/AddFundsPopover", () => ({ default: () => null }));
vi.mock("@/components/kit/CostLine", () => ({ default: () => null }));
vi.mock("@/components/kit/GenerateButton", () => ({ default: () => null }));

import PillMenu from "@/components/kit/PillMenu";
import GeneratorPill from "@/components/kit/GeneratorPill";
import { QualityPill, RatioPill, ResolutionPill } from "@/components/kit/SettingsPills";
import ComposeFoot from "@/components/image-view/ComposeFoot";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
// Absolute, so the in-memory mutant runner reaches what these pins read.
const src = (...p: string[]) => readSource(join(__dirname, "..", "..", "..", "..", ...p));

describe("the Image View's pickers on a phone", () => {
  const core = { ratios: ["1:1"], tiers: [{ tier: "1K" }], free: false, entry: { name: "Nano Banana Pro" }, clampRatio: (v: string) => v, clampTier: (v: string) => v } as unknown as GenerationCore;
  const props = (el: unknown) => (el as El).props;

  it("each say what they set, the formats two to a row; the editor's keep their plain sheet", () => {
    const pills = [
      [RatioPill({ core, value: "1:1", onChange: vi.fn(), describe: true }), "The shape of your image", 2],
      [ResolutionPill({ core, value: "1K", onChange: vi.fn(), prices: [null], describe: true }), "How sharp it gets", 1],
      [QualityPill({ value: "low", onChange: vi.fn(), prices: [], describe: true }), "More detail costs a bit more", 1],
      [GeneratorPill({ models: [], value: null, onChange: vi.fn(), prices: [], look: "logo-name", describe: true, direction: "up" }), "Which AI makes your image", 1],
    ] as const;
    for (const [pill, hint, cols] of pills) {
      expect(props(pill).sheetHint).toBe(hint);
      expect(props(pill).sheetColumns ?? 1).toBe(cols);
      expect(props(pill)).not.toHaveProperty("wheel");
    }
    expect(props(RatioPill({ core, value: "1:1", onChange: vi.fn() })).sheetHint).toBeUndefined();
    expect(props(GeneratorPill({ models: [], value: null, onChange: vi.fn(), prices: [], look: "logo", direction: "up" })).sheetHint).toBeUndefined();
  });

  it("show every count four to a row with its price, lock what the balance cannot pay for, and take a typed one", () => {
    const quote = { totalMicro: 400_000, totalUsd: "0.40" } as GenerationQuote;
    const m = { guest: false, core: { entry: { name: "Nano Banana Pro" }, free: false, supportsQuality: false }, models: [], modelPrices: [],
      count: 1, countMax: 8, setCount: vi.fn(), quote, balanceUsd: 1.2, settingsChanged: false, button: { label: "Generate", dimmed: false }, funds: null } as unknown as ImageViewModel;
    const pill = [...walk(ComposeFoot({ model: m, phone: true }))].find((el) => el.type === PillMenu)!;
    // A greyed count says why on screen: a touch has no hover title (review 2026-10-26).
    expect([pill.props.sheetColumns, pill.props.typed, pill.props.sheetHint]).toEqual([4, "Or type a number", "×4 and up: more than your balance"]);
    const options = pill.props.options as MenuOption[];
    expect(options.map((o) => o.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(options.map((o) => !!o.disabled)).toEqual([false, false, false, true, true, true, true, true]);
    // No line under a count: it said the same for each (Kev, 2026-10-26).
    expect(options.every((o) => !o.desc)).toBe(true);
    expect(options[3].title).toBe("More than your balance covers. Add funds or pick fewer.");
    expect(options[0].title).toBeUndefined();
    (pill.props.onPick as (k: string) => void)("3");
    expect(m.setCount).toHaveBeenCalledWith(3);
    const roomy = [...walk(ComposeFoot({ model: { ...m, balanceUsd: 10 } as ImageViewModel, phone: true }))].find((el) => el.type === PillMenu)!;
    expect(roomy.props.sheetHint).toBe("Several takes in one go");
  });
});

describe("a typed count", () => {
  const options = [{ key: "1" }, { key: "2" }, { key: "3", disabled: true, title: "More than your balance covers." }];
  it("takes a number that is one of the options", () => {
    expect(typedPick(options, " 2 ")).toEqual({ key: "2" });
    expect(typedPick(options, "02")).toEqual({ key: "2" });
  });
  it("says why it takes nothing: the option's own reason, else the range", () => {
    expect(typedPick(options, "3")).toEqual({ why: "More than your balance covers." });
    expect(typedPick(options, "12")).toEqual({ why: "Type 1 to 3." });
    expect(typedPick(options, "")).toEqual({ why: "Type 1 to 3." });
    expect(typedPick(options, "two")).toEqual({ why: "Type 1 to 3." });
  });
});

describe("the sheet", () => {
  const MENU = src("components", "kit", "PillMenu.tsx");
  const CSS = src("components", "kit", "kit-controls.css");

  it("lists every option, a tap takes it and closes, the picked one too", () => {
    expect(MENU).not.toMatch(/Wheel|wheel/);
    expect(MENU).toContain("{list(sheetColumns ?? columns)}\n      </BottomSheet>");
    // Closing clears a typed error, however it closes (review 2026-10-26).
    expect(MENU).toContain("const shut = () => { setSheet(false); setTypedWhy(null); };");
    expect(MENU).toMatch(/const pick = \(key: string\) => \{\n\s+onPick\(key\);\n\s+if \(multi\) return;\n\s+close\(\);\n\s+shut\(\);/);
    expect(MENU).toContain("onClose={shut}>");
    // The selected row is a plain option button like the rest: pressing it calls pick.
    expect(MENU).toContain('className="kit-opt" onClick={() => pick(o.key)}>');
  });

  it("takes a typed number with Set or Enter (a form: an iPhone's number pad has no Enter) and says why when it cannot", () => {
    expect(MENU).toContain('<form className="kit-typed" noValidate onSubmit={takeTyped}>');
    expect(MENU).toContain('<input name="n" type="number" inputMode="numeric" enterKeyHint="done" defaultValue={value ?? ""}');
    expect(MENU).toContain('<button type="submit" className="kit-typed-set">Set</button>');
    expect(MENU).toMatch(/e\.preventDefault\(\);\n\s+const typed = typedPick\(options, String\(new FormData\(e\.currentTarget\)\.get\("n"\) \?\? ""\)\);\n\s+if \("key" in typed\) pick\(typed\.key\);\n\s+else setTypedWhy\(typed\.why\);/);
    expect(MENU).toContain('{typedWhy && <span className="kit-typed-why" role="alert">{typedWhy}</span>}');
  });

  it("is laid out to show all: up to 85 % of the screen, one-line descriptions, two or four to a row", () => {
    expect(CSS).toMatch(/\.kit-sheet \{[^}]*max-height: 85dvh;/);
    expect(CSS).toContain(".kit-sheet .kit-opts { grid-template-columns: minmax(0, 1fr); }");
    expect(CSS).toContain(".kit-sheet .kit-opt-desc { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }");
    expect(CSS).toContain(".kit-sheet .kit-opts--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); min-width: 0; gap: 6px; }");
    expect(CSS).toContain(".kit-opts.kit-opts--4 { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }");
  });
});

it("focuses the sheet's picked option only when it can be taken, else the first that can (review 2026-10-26)", () => {
  expect(src("components", "kit", "BottomSheet.tsx")).toContain(`panel?.querySelector<HTMLElement>('[aria-selected="true"]:not(:disabled)') ?? panel?.querySelector<HTMLElement>(FOCUSABLE)`);
});

it("lays the sheet out as the popover by default, so the editor's two-column pickers stay two to a row (review 2026-10-26)", () => {
  expect(src("components", "kit", "SettingsPills.tsx")).toContain("      sheetColumns={2}\n");
  expect(src("components", "kit", "PillMenu.tsx")).toContain("  sheetHint, sheetColumns, typed,\n");
});
