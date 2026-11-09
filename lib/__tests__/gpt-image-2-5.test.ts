import { describe, it, expect } from "vitest";
import { apiPricePerImage, apiBoostPricePerImage, MODEL_IMAGE_PRICING } from "@/lib/pricing";
import { getModelCostMicro } from "@/lib/payments/generation-pricing";
import { driftOf } from "@/lib/generation/price-drift";
import { maxTier } from "@/lib/generation/resolution";
import { toModelFamily } from "@/lib/generation/model-family";
import { __testing__, withCapabilities } from "@/lib/generation/models";
import { toEditModel } from "@/backend/services/wavespeed-image-generation";

const { fromRow } = __testing__;

/**
 * GPT-Image-2.5 Flare and Sunburst in the existing system: two rows in the
 * models table, OpenAI direct first (the cheapest host at every cell),
 * WaveSpeed's openai/… path as the outage fallback, priced per quality like
 * gpt-image-2 and from their own table — never gpt-image-2's.
 */
const FAMILIES = ["gpt-image-2-5-flare", "gpt-image-2-5-sunburst"] as const;
const MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;

const link = (key: string, provider_model: string, priority: number) => ({
  id: `${key}:${provider_model}`, role: "normal", provider_model, active: true, priority, applies_when: null,
  provider_id: key, providers: { id: key, key, audience: "public", active: true },
});
const row = (name: string, model: string) => ({
  id: "m", name, allowed_ratios: ["1:1"], max_reference_images: 16,
  model_providers: [link("openai", model, 10), link("wavespeed", `openai/${model}/text-to-image`, 20)],
});

describe("GPT-Image-2.5 Flare and Sunburst", () => {
  it("are their own families, from the display name", () => {
    expect(toModelFamily("GPT-Image-2.5 Flare")).toBe("gpt-image-2-5-flare");
    expect(toModelFamily("GPT-Image-2.5 Sunburst")).toBe("gpt-image-2-5-sunburst");
  });

  it.each(FAMILIES)("%s is charged OpenAI direct's cell per quality and size", (family) => {
    expect(apiPricePerImage(family, "1K", "low")).toBe(0.006);
    expect(apiPricePerImage(family, "2K", "low")).toBe(0.007);
    expect(apiPricePerImage(family, "4K", "low")).toBe(0.012);
    expect(apiPricePerImage(family, "1K", "medium")).toBe(0.014);
    expect(apiPricePerImage(family, "2K", "medium")).toBe(0.015);
    expect(apiPricePerImage(family, "4K", "medium")).toBe(0.026);
    expect(apiPricePerImage(family, "1K", "high")).toBe(0.053);
    expect(apiPricePerImage(family, "2K", "high")).toBe(0.056);
    expect(apiPricePerImage(family, "4K", "high")).toBe(0.101);
    // The tier defaults: 1K low, 2K medium, 4K high — the quality the service renders unasked.
    expect(apiPricePerImage(family, "1K")).toBe(0.006);
    expect(apiPricePerImage(family, "2k")).toBe(0.015);
    expect(apiPricePerImage(family, "4K")).toBe(0.101);
    // No faster host: boost answers the routed price.
    expect(apiBoostPricePerImage(family, "2K", "high")).toBe(0.056);
    expect(getModelCostMicro(family, "4K", { quality: "high" })).toBe(101_000);
    expect(getModelCostMicro(family, "2K", { boost: true })).toBe(15_000);
  });

  it.each(FAMILIES)("%s's 'from' row is its medium cell", (family) => {
    expect(MODEL_IMAGE_PRICING[family]).toEqual({ "1K": 0.014, "2K": 0.015, "4K": 0.026 });
    for (const tier of ["1K", "2K", "4K"] as const) {
      expect(apiPricePerImage(family, tier, "medium")).toBe(MODEL_IMAGE_PRICING[family][tier]);
    }
  });

  it("leaves gpt-image-2 priced from its own table", () => {
    expect(apiPricePerImage("gpt-image-2", "1K", "low")).toBe(0.006);
    expect(apiPricePerImage("gpt-image-2", "2K", "medium")).toBe(0.107);
    expect(apiPricePerImage("gpt-image-2", "4K", "high")).toBe(0.712);
    expect(apiPricePerImage("gpt-image-2", "2K")).toBe(0.107);
  });

  it("prices only the families in the table, never a prototype key or a look-alike", () => {
    expect(() => apiPricePerImage("constructor", "2K")).toThrow(/No price table/);
    expect(() => apiPricePerImage("gpt-image-2-5", "2K", "low")).toThrow(/No price table/);
    expect(() => apiPricePerImage("gpt-image-2.5-flare", "2K", "low")).toThrow(/No price table/);
  });

  it.each(FAMILIES)("%s billed at the table is no drift; WaveSpeed's price would be", (family) => {
    expect(driftOf({ provider: "openai", modelFamily: family, resolution: "4K", quality: "high", observedUsd: 0.101 }).drifted).toBe(false);
    expect(driftOf({ provider: "openai", modelFamily: family, resolution: "1K", quality: "low", observedUsd: 0.006 }).drifted).toBe(false);
    expect(driftOf({ provider: "wavespeed", modelFamily: family, resolution: "4K", quality: "high", observedUsd: 0.27 }).drifted).toBe(true);
  });

  it("renders up to 4K on both hosts and fails closed for look-alikes", () => {
    for (const m of MODELS) {
      expect(maxTier("openai", m)).toBe("4K");
      expect(maxTier("wavespeed", `openai/${m}/text-to-image`)).toBe("4K");
      expect(maxTier("wavespeed", `openai/${m}/edit`)).toBe("4K");
    }
    expect(maxTier("openai", "gpt-image-2")).toBe("4K");
    expect(maxTier("openai", "gpt-image-2.5")).toBe("1K");
    expect(maxTier("openai", "gpt-image-2-mini")).toBe("1K");
    expect(maxTier("openai", "gpt-image-2.5-flare-2026-09-08")).toBe("1K");
    expect(maxTier("wavespeed", "openai/gpt-image-2.5-flare/text-to-image-fast")).toBe("1K");
    expect(maxTier("wavespeed", "openai/gpt-image-2.5-turbo/text-to-image")).toBe("1K");
    expect(maxTier("wavespeed", "openai/gpt-image-2.5/text-to-image")).toBe("1K");
  });

  it("sends reference images to WaveSpeed's edit path", () => {
    expect(toEditModel("openai/gpt-image-2.5-flare/text-to-image")).toBe("openai/gpt-image-2.5-flare/edit");
    expect(toEditModel("openai/gpt-image-2.5-sunburst/edit")).toBe("openai/gpt-image-2.5-sunburst/edit");
  });

  it("offers the quality control from the route, without a display-name bridge", () => {
    const m = fromRow(row("GPT-Image-2.5 Flare", "gpt-image-2.5-flare"), "public");
    expect(m.supportsQuality).toBe(true);
    expect(m.maxResolution).toBe("4K");
    expect(m.normal).toMatchObject({ provider: "openai", providerModel: "gpt-image-2.5-flare" });
    expect(m.maxRefs).toBe(16);
    // Only the fallback left: WaveSpeed's openai/… path takes the same three values.
    const w = fromRow({ ...row("GPT-Image-2.5 Sunburst", "x"), model_providers: [link("wavespeed", "openai/gpt-image-2.5-sunburst/text-to-image", 20)] }, "public");
    expect(w.supportsQuality).toBe(true);
    expect(w.normal.provider).toBe("wavespeed");
    // The control is a fact about the route: a Google row has no quality tier, nor does an unrouted name.
    const g = fromRow({ id: "g", name: "Nano Banana 2", model_providers: [link("gemini", "gemini-3.1-flash-image", 10)] }, "public");
    expect(g.supportsQuality).toBe(false);
    // Nor does a gpt look-alike under another vendor's path: only OpenAI's own id and WaveSpeed's openai/… path.
    const o = fromRow({ id: "o", name: "GPT-Image-2", model_providers: [link("wavespeed", "google/gpt-image-2/text-to-image", 10)] }, "public");
    expect(o.supportsQuality).toBe(false);
    expect(fromRow({ id: "n", name: "GPT-Image-9" }, "public").supportsQuality).toBe(false);
    // gpt-image-2 keeps it, from its row and from the legacy bridge alike.
    expect(fromRow({ id: "o", name: "GPT-Image-2", model_providers: [link("openai", "gpt-image-2", 10)] }, "public").supportsQuality).toBe(true);
    expect(fromRow({ id: "o", name: "GPT-Image-2" }, "public").supportsQuality).toBe(true);
    // /api/models carries the answer to the pickers.
    expect(withCapabilities([row("GPT-Image-2.5 Sunburst", "gpt-image-2.5-sunburst")])[0].supportsQuality).toBe(true);
  });
});
