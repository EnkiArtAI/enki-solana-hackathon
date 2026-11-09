import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "@/lib/__tests__/_read-source";
import { balanceView, chipLabel } from "@/lib/ui/kit/price";
import type { GenerationQuote } from "@/lib/generation-checkout";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";

/**
 * Images per run (image UI v2, handoff §5.11, plan B4): one press makes N
 * images as one batch. The chip and the low-balance check price all N, in
 * micro-USDC; the Premium badge keeps the price per image; Regenerate makes
 * one; a free generator makes one at a time (its daily allowance is one).
 */
vi.mock("@/components/kit/PillMenu", () => ({ default: () => null }));
vi.mock("@/components/kit/AddFundsPopover", () => ({ default: () => null }));
vi.mock("@/components/kit/CostLine", () => ({ default: () => null }));
vi.mock("@/components/kit/GenerateButton", () => ({ default: () => null }));
vi.mock("@/components/kit/GeneratorPill", () => ({ default: () => null }));
vi.mock("@/components/kit/SettingsPills", () => ({ RatioPill: () => null, ResolutionPill: () => null, QualityPill: () => null }));

import CountStepper from "@/components/kit/CountStepper";
import PillMenu from "@/components/kit/PillMenu";
import ComposeFoot from "@/components/image-view/ComposeFoot";

const quote = (totalMicro: number, estimated = false): GenerationQuote => ({
  totalMicro, totalUsd: (totalMicro / 1e6).toString(), networkFeeUsd: "0", artistUsd: "0", expiresAt: "", appliedRule: null, estimated,
});
function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const MODEL = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"));

describe("the price of a run", () => {
  const base = { signedIn: true, free: false, pending: false };
  it("is N times the total on the chip, an estimate … (never a second number)", () => {
    expect(chipLabel({ ...base, quote: quote(200_000), count: 3 })).toBe("$0.60");
    expect(chipLabel({ ...base, quote: quote(200_000, true), count: 3 })).toBe("…");
    expect(chipLabel({ ...base, quote: quote(534_000), count: 1 })).toBe("$0.534");
    expect(chipLabel({ ...base, quote: quote(534_000) })).toBe("$0.534");
  });

  it("is short when the balance cannot pay for all N, to the micro-USDC", () => {
    const at = (balance: number, count: number) => balanceView({ payer: "Sol1", ready: true, balance, free: false, quote: quote(400_000), count })?.short;
    expect(at(1, 2)).toBe(false);
    expect(at(1.2, 3)).toBe(false);
    expect(at(1.199999, 3)).toBe(true);
    expect(at(1, 3)).toBe(true);
    expect(balanceView({ payer: "Sol1", ready: true, balance: 0.5, free: false, quote: quote(400_000) })?.short).toBe(false);
  });
});

describe("the model", () => {
  it("makes N images on Generate, as one batch, and one on Regenerate", () => {
    expect(MODEL).toContain("else runBatch(Array.from({ length: n }, () => job));");
    expect(MODEL).toContain("start(job, undefined, count);");
    expect(MODEL).toContain("start(job.setup, retried);");
  });

  it("prices the whole run for the chip and the balance, one image for the badge", () => {
    expect(MODEL).toContain("balanceView({ payer, ready: holdings.ready, balance: holdings.balance, free: core.free, quote: quoted, count });");
    expect(MODEL).toContain("chip: chipLabel({ signedIn: !guest, free: core.free, quote: quoted, pending: quote.pending, count }),");
    expect(MODEL).toContain("perImage: chipLabel({ signedIn: !guest, free: core.free, quote: quoted, pending: quote.pending }),");
  });

  it("counts 1 to 8, one on a free generator, and names the count on the button", () => {
    expect(MODEL).toContain("export const COUNT_MAX = 8;");
    expect(MODEL).toContain("const countMax = entry?.free ? 1 : COUNT_MAX;");
    expect(MODEL).toContain("const count = Math.min(Math.max(1, countPick), countMax);");
    expect(MODEL).toContain("label: gate.label === GENERATE && count > 1 ? `${GENERATE} ${count}` : gate.label,");
  });

  it("sets the generator, format, resolution and quality back to the prompt's own, and says when they differ", () => {
    expect(MODEL).toMatch(/const resetSettings = \(\) => \{\n\s+setPick\(""\);\n\s+setRatio\(""\);\n\s+setResolution\(""\);\n\s+setQuality\("medium"\);\n\s+\};/);
    // Never in a blank composer: no prompt to go back to (Kev, 2026-10-30, Create > Image).
    expect(MODEL).toContain('const settingsChanged = !blank && (modelName !== defaultModel({ catalogue, pick: "", aiModel: prompt?.ai_model, premium, offered })');
    expect(MODEL).toContain('|| ratio !== core.clampRatio(prompt?.aspect_ratio || "1:1") || resolution !== core.clampTier(prompt?.resolution || "2K")');
    expect(MODEL).toContain('|| (core.supportsQuality && quality !== "medium"));');
  });
});

describe("the count control", () => {
  const press = (el: ReactElement<Record<string, unknown>>) => (el.props.onClick as () => void)();
  const buttons = (value: number, max: number, onChange = vi.fn()) => [...walk(CountStepper({ value, max, onChange }))].filter((el) => el.type === "button");

  it("steps by one and greys its ends instead of wrapping", () => {
    const onChange = vi.fn();
    const [less, more] = buttons(3, 8, onChange);
    press(less); press(more);
    expect(onChange.mock.calls).toEqual([[2], [4]]);
    expect(buttons(1, 8)[0].props.disabled).toBe(true);
    expect(buttons(1, 8)[1].props.disabled).toBe(false);
    expect(buttons(8, 8)[1].props.disabled).toBe(true);
    expect(buttons(1, 1).map((b) => b.props.disabled)).toEqual([true, true]);
  });

  const model = (over: Partial<ImageViewModel> = {}) => ({
    guest: false, core: { entry: { name: "Nano Banana Pro" }, supportsQuality: false, free: false }, models: [], modelPrices: [],
    count: 2, countMax: 8, setCount: vi.fn(), quote: quote(200_000), settingsChanged: false, resetSettings: vi.fn(),
    button: { label: "Generate", dimmed: false }, funds: null, ...over,
  }) as unknown as ImageViewModel;

  it("is a stepper on desktop and a pill with each count's price on the phone", () => {
    expect([...walk(ComposeFoot({ model: model() }))].filter((el) => el.type === CountStepper)).toHaveLength(1);
    const m = model();
    const phone = [...walk(ComposeFoot({ model: m, phone: true }))];
    expect(phone.filter((el) => el.type === CountStepper)).toHaveLength(0);
    const pill = phone.find((el) => el.type === PillMenu)!;
    const options = pill.props.options as { key: string; sub: string | null }[];
    expect(options.map((o) => o.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(options[2].sub).toBe("$0.60");
    (pill.props.onPick as (k: string) => void)("5");
    expect(m.setCount).toHaveBeenCalledWith(5);
  });

  it("offers the reset only when a setting differs, and none of it to a guest", () => {
    const reset = (m: ImageViewModel, phone = false) => [...walk(ComposeFoot({ model: m, phone }))].find((el) => el.props.className === "iv-reset kit-hit");
    expect(reset(model())).toBeUndefined();
    const changed = model({ settingsChanged: true });
    press(reset(changed)!);
    expect(changed.resetSettings).toHaveBeenCalledOnce();
    const guest = model({ guest: true, settingsChanged: true });
    expect(reset(guest)).toBeUndefined();
    expect([...walk(ComposeFoot({ model: guest }))].filter((el) => el.type === CountStepper)).toHaveLength(0);
  });
});
