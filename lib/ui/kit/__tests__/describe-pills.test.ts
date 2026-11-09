import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { GenerationCore } from "@/hooks/useGenerationCore";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";
import type { MenuOption } from "@/components/kit/PillMenu";

/**
 * The Image View's settings menus say in one line what each option is for
 * (image UI v2, plan B4); the editor's menus, which share the pills, stay as
 * they were. Copy from option-copy.ts, options and prices from the core.
 */
vi.mock("@/components/kit/PillMenu", () => ({ default: () => null }));
vi.mock("@/components/kit/AddFundsPopover", () => ({ default: () => null }));
vi.mock("@/components/kit/CostLine", () => ({ default: () => null }));
vi.mock("@/components/kit/GenerateButton", () => ({ default: () => null }));

import GeneratorPill from "@/components/kit/GeneratorPill";
import { QualityPill, RatioPill, ResolutionPill } from "@/components/kit/SettingsPills";
import ComposeFoot from "@/components/image-view/ComposeFoot";

type Menu = ReactElement<{ options: MenuOption[]; columns?: number; trigger: ReactNode }>;
const core = {
  ratios: ["1:1", "4:5"], tiers: [{ tier: "1K" }, { tier: "2K" }], free: false, entry: { name: "Nano Banana Pro" },
  clampRatio: (v: string) => v, clampTier: (v: string) => v,
} as unknown as GenerationCore;
const descs = (menu: Menu) => menu.props.options.map((o) => o.desc ?? null);
const nano = { id: "nb", name: "Nano Banana Pro", free: false } as CatalogueEntry;
const gpt = { id: "gpt", name: "GPT Image 2", free: false } as CatalogueEntry;

describe("the settings pills", () => {
  it("give each format its line and one column when asked, two bare columns otherwise", () => {
    const asked = RatioPill({ core, value: "1:1", onChange: vi.fn(), describe: true }) as Menu;
    expect(descs(asked)).toEqual(["Square · Instagram feed, profile pictures", "Portrait · Instagram feed posts"]);
    expect(asked.props.columns).toBe(1);
    const bare = RatioPill({ core, value: "1:1", onChange: vi.fn() }) as Menu;
    expect(descs(bare)).toEqual([null, null]);
    expect(bare.props.columns).toBe(2);
  });

  it("give each resolution and quality its line only when asked", () => {
    expect(descs(ResolutionPill({ core, value: "1K", onChange: vi.fn(), prices: [null, null], describe: true }) as Menu))
      // tierOptions lists every tier and disables the ones this generator lacks.
      .toEqual(["Fast preview, smallest file", "Sharp on any screen", "Print quality, the most detail"]);
    expect(descs(ResolutionPill({ core, value: "1K", onChange: vi.fn(), prices: [null, null] }) as Menu)).toEqual([null, null, null]);
    expect(descs(QualityPill({ value: "low", onChange: vi.fn(), prices: [null, null, null], describe: true }) as Menu))
      .toEqual(["Quick drafts, lowest cost", "Good for everyday images", "Finest detail, best for portraits"]);
    expect(descs(QualityPill({ value: "low", onChange: vi.fn(), prices: [null, null, null] }) as Menu)).toEqual([null, null, null]);
  });

  it("give each generator what it is good at, and the pill its logo and name", () => {
    const pill = GeneratorPill({ models: [nano, gpt], value: "nb", onChange: vi.fn(), prices: [null, null], look: "logo-name", describe: true, direction: "up" }) as Menu;
    expect(descs(pill)).toEqual([
      "Best all-rounder: lifelike faces and skin, keeps your people recognisable.",
      "Follows long, detailed prompts closely and can write text into the image.",
    ]);
    const face = [pill.props.trigger].flat(3) as ReactElement<{ children?: ReactNode; className?: string }>[];
    const parts = isValidElement(face[0]) ? [(face[0] as ReactElement<{ children: ReactNode[] }>).props.children].flat() as ReactElement<{ className?: string; children?: ReactNode }>[] : [];
    expect(parts.find((p) => p.props?.className === "kit-pill-name")?.props.children).toBe("Nano Banana Pro");
    const bare = GeneratorPill({ models: [nano], value: "nb", onChange: vi.fn(), prices: [null], look: "logo", direction: "up" }) as Menu;
    expect(descs(bare)).toEqual([null]);
  });
});

describe("the Image View's foot", () => {
  it("asks every pill for its lines and the generator for its logo and name", () => {
    const m = { guest: false, core: { ...core, supportsQuality: true, entry: nano }, models: [nano], modelPrices: [null], ratio: "1:1", resolution: "1K",
      tierPrices: [], quality: "low", qualityPrices: [], button: { label: "Generate", dimmed: false }, funds: null } as unknown as ImageViewModel;
    const all: ReactElement<Record<string, unknown>>[] = [];
    const walk = (n: ReactNode): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (isValidElement<Record<string, unknown>>(n)) { all.push(n); walk(n.props.children as ReactNode); }
    };
    walk(ComposeFoot({ model: m }));
    for (const type of [GeneratorPill, RatioPill, ResolutionPill, QualityPill]) {
      expect(all.find((el) => el.type === type)?.props.describe, type.name).toBe(true);
    }
    expect(all.find((el) => el.type === GeneratorPill)?.props.look).toBe("logo-name");
  });

  it("leaves the editor's pills bare", () => {
    const bar = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "prompt-editor", "GenerateBar.tsx"), "utf8");
    expect(bar).not.toContain("describe");
  });
});

describe("the settings styles", () => {
  const root = join(__dirname, "..", "..", "..", "..", "components");
  const VIEW = readFileSync(join(root, "image-view", "image-view.css"), "utf8");
  const PHONE = readFileSync(join(root, "image-view", "image-view-mobile.css"), "utf8");
  const KIT = readFileSync(join(root, "kit", "kit-controls.css"), "utf8");
  const MENU = readFileSync(join(root, "kit", "PillMenu.tsx"), "utf8");

  it("keep the row of 38 px pills on desktop (a second line only where it cannot fit), one row of 36 px on the phone, the phone's generator a logo only", () => {
    expect(VIEW).toContain(".iv-foot .iv-bar { --kit-pill-h: 38px; flex-wrap: wrap; min-width: 0; }");
    // Never a second row on the phone (Kev, 2026-10-27; narrow-phone.test.ts).
    expect(PHONE).toContain(".iv-mobile .iv-foot .iv-bar {\n  --kit-pill-h: 36px; flex-wrap: nowrap;");
    expect(PHONE).toContain(".iv-mobile .kit-pill-name { display: none; }");
  });

  it("draw the line under the label and widen only a described menu", () => {
    expect(MENU).toContain('{o.desc ? <span className="kit-opt-text"><span>{o.label}</span><span className="kit-opt-desc">{o.desc}</span></span> : <span>{o.label}</span>}');
    expect(KIT).toContain(".kit-menu-panel:has(.kit-opt-desc) { min-width: 240px; max-width: min(320px, calc(100vw - 40px)); }");
    expect(KIT).toContain(".kit-opt-desc { font-size: 11.5px; line-height: 1.35; opacity: 0.72; white-space: normal; }");
  });
});
