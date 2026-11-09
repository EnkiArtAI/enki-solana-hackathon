import { describe, it, expect, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cellKey, cellUsd, loadPriceCells, priceCellFor, observePrice, __testing__ as cells } from "@/lib/generation/price-cells";
import { driftOf } from "@/lib/generation/price-drift";
import { computeQuote } from "@/lib/payments/generation-quote";
import {
  PRICING_POLICY, UnknownModelError, computeGenerationSplit, getModelCostMicro, modelLegMicro, usdToMicro,
} from "@/lib/payments/generation-pricing";
import { chooseRoute, __testing__ as models } from "@/lib/generation/models";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The price a generator charges is the bill its priced route sent back last
 * time (Kev, 2026-10-13: "zieh den preis direkt vom api call"): a delivered
 * render writes its bill, the newest priced bill per cell is what the next
 * quote charges, and the table in lib/pricing.ts only seeds and falls back.
 */

/** Any query chain answers the table's rows; reads and inserts are recorded. */
function fake(tables: Record<string, unknown[]>, opts: { failRead?: string; failInsert?: boolean } = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const read: string[] = [];
  const from = (table: string) => {
    read.push(table);
    const result = { data: tables[table] ?? [], error: opts.failRead === table ? { message: "boom" } : null };
    const chain: Record<string, unknown> = {
      then: (ok: (v: typeof result) => unknown) => Promise.resolve(result).then(ok),
      insert: (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return Promise.resolve({ error: opts.failInsert ? { message: "no table" } : null });
      },
      maybeSingle: () => Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null }),
    };
    for (const m of ["select", "eq", "in", "or", "is", "order", "limit", "ilike", "gte"]) chain[m] = () => chain;
    return chain;
  };
  return { client: { from } as unknown as SupabaseClient, inserts, read };
}

const cell = (model_family: string, resolution: string, quality: string | null, role: string, observed_usd: unknown) =>
  ({ model_family, resolution, quality, role, observed_usd });
const checks = PRICING_POLICY.extractionCheckMicro + PRICING_POLICY.imageCheckMicro;

afterEach(() => {
  cells.reset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("price cells", () => {
  it("rounds a bill up to the next tenth of a cent, never down", () => {
    expect(cellUsd(0.006)).toBe(0.006);
    expect(cellUsd(0.0527)).toBe(0.053);
    expect(cellUsd(0.05268)).toBe(0.053);
    expect(cellUsd(0.1002)).toBe(0.101);
    expect(cellUsd(0.0913)).toBe(0.092);
    expect(cellUsd(0.0001)).toBe(0.001);
    expect(cellUsd(0)).toBe(0);
    // A float that lands a hair above a step (66,900 tokens at $30/1M = 2.007, stored as 2007.0000000000002) is not a step higher.
    expect(cellUsd((66_900 * 30) / 1e6)).toBe(2.007);
  });

  it("reads the cells in force once a minute per instance", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const first = fake({ price_cells: [cell("gpt-image-2", "2K", "medium", "normal", "0.0999")] });
    const key = cellKey("gpt-image-2", "2K", "medium", "normal");
    expect((await loadPriceCells(first.client)).get(key)).toBe(0.1);
    // Within the minute the second client is never asked.
    const second = fake({ price_cells: [cell("gpt-image-2", "2K", "medium", "normal", "0.2")] });
    now.mockReturnValue(1_000_000 + 59_000);
    expect((await loadPriceCells(second.client)).get(key)).toBe(0.1);
    expect(second.read).toEqual([]);
    // After it, it is.
    now.mockReturnValue(1_000_000 + 60_000);
    expect((await loadPriceCells(second.client)).get(key)).toBe(0.2);
    expect(second.read).toEqual(["price_cells"]);
  });

  it("answers the last read when the table cannot be read, and nothing before the first", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const broken = fake({}, { failRead: "price_cells" });
    expect((await loadPriceCells(broken.client)).size).toBe(0);
    expect((await loadPriceCells(null)).size).toBe(0);
    const good = fake({ price_cells: [cell("nano-banana-2", "2K", null, "normal", 0.05)] });
    expect((await loadPriceCells(good.client)).get(cellKey("nano-banana-2", "2K", null, "normal"))).toBe(0.05);
    now.mockReturnValue(1_000_000 + 120_000);
    expect((await loadPriceCells(broken.client)).get(cellKey("nano-banana-2", "2K", null, "normal"))).toBe(0.05);
    expect((await loadPriceCells(null)).size).toBe(1);
    expect(quiet).toHaveBeenCalled();
  });

  it("keeps only rows that are a price", async () => {
    const f = fake({ price_cells: [
      cell("gpt-image-2", "2K", "medium", "normal", "abc"),
      cell("gpt-image-2", "2K", "high", "normal", -1),
      cell("gpt-image-2", "2K", "low", "normal", "0.012"),
    ] });
    const got = await loadPriceCells(f.client);
    expect([...got.keys()]).toEqual([cellKey("gpt-image-2", "2K", "low", "normal")]);
  });

  it("prices the quality that will run first, else the family's single cell at that size and role", () => {
    const map = new Map([
      [cellKey("gpt-image-2", "2K", "medium", "normal"), 0.1],
      [cellKey("nano-banana-2", "2K", null, "normal"), 0.05],
      [cellKey("nano-banana-2", "2K", null, "boost"), 0.13],
    ]);
    // No quality named: the 2K default (medium) runs, so its cell is the price.
    expect(priceCellFor(map, { modelFamily: "gpt-image-2", resolution: "2K" })).toBe(0.1);
    expect(priceCellFor(map, { modelFamily: "gpt-image-2", resolution: "2K", quality: "medium" })).toBe(0.1);
    expect(priceCellFor(map, { modelFamily: "gpt-image-2", resolution: "2K", quality: "high" })).toBeNull();
    // The quality that runs beats a quality-less key, should a family ever carry both.
    const both = new Map([...map, [cellKey("gpt-image-2", "2K", null, "normal"), 0.9]]);
    expect(priceCellFor(both, { modelFamily: "gpt-image-2", resolution: "2K" })).toBe(0.1);
    expect(priceCellFor(map, { modelFamily: "nano-banana-2", resolution: "2K" })).toBe(0.05);
    expect(priceCellFor(map, { modelFamily: "nano-banana-2", resolution: "2K", boost: true })).toBe(0.13);
    expect(priceCellFor(map, { modelFamily: "nano-banana-2", resolution: "4K" })).toBeNull();
    expect(priceCellFor(map, { modelFamily: "gpt-image-2-5-flare", resolution: "2K" })).toBeNull();
  });

  it("a quote charges the cell in force, and the table where there is none", async () => {
    const withCell = fake({ price_cells: [
      cell("gpt-image-2", "2K", "medium", "normal", "0.0888"),
      cell("nano-banana-2", "2K", null, "boost", "0.1"),
    ] });
    let q = await computeQuote(withCell.client, { modelFamily: "gpt-image-2", resolution: "2K" });
    expect(q.ok && q.split).toEqual(computeGenerationSplit(0, usdToMicro(0.089) + checks));
    // No size named is 2K, as everywhere in pricing.
    q = await computeQuote(withCell.client, { modelFamily: "gpt-image-2" });
    expect(q.ok && q.split).toEqual(computeGenerationSplit(0, usdToMicro(0.089) + checks));
    q = await computeQuote(withCell.client, { modelFamily: "nano-banana-2", resolution: "2K", boost: true });
    expect(q.ok && q.split).toEqual(computeGenerationSplit(0, usdToMicro(0.1) + checks));
    // No cell for high: the table.
    q = await computeQuote(withCell.client, { modelFamily: "gpt-image-2", resolution: "2K", quality: "high" });
    expect(q.ok && q.split).toEqual(computeGenerationSplit(0, getModelCostMicro("gpt-image-2", "2K", { quality: "high" }) + checks));
    cells.reset();
    const bare = fake({});
    q = await computeQuote(bare.client, { modelFamily: "gpt-image-2", resolution: "2K" });
    expect(q.ok && q.split).toEqual(computeGenerationSplit(0, getModelCostMicro("gpt-image-2", "2K") + checks));
    expect(bare.read).toContain("price_cells");
  });

  it("the cell outranks the table; an unknown family still has no price", () => {
    expect(getModelCostMicro("gpt-image-2", "2K", { cellUsd: 0.09 })).toBe(90_000);
    expect(getModelCostMicro("gpt-image-2", "2K", { cellUsd: 0.09, boost: true })).toBe(90_000);
    expect(modelLegMicro("gpt-image-2", "2K", { cellUsd: 0.09, references: 1 })).toBe(90_000 + checks + PRICING_POLICY.imageCheckMicro);
    expect(getModelCostMicro("gpt-image-2", "2K", { cellUsd: null })).toBe(usdToMicro(0.107));
    expect(() => getModelCostMicro("no-such-model", "2K", { cellUsd: 0.09 })).toThrow(UnknownModelError);
    expect(() => getModelCostMicro("constructor", "2K", { cellUsd: 0.09 })).toThrow(UnknownModelError);
  });

  it("drift is measured against the cell in force, else the table", () => {
    const obs = { provider: "openai", modelFamily: "gpt-image-2", resolution: "1K", quality: "medium", observedUsd: 0.05 };
    expect(driftOf(obs, 0.05)).toEqual({ expectedUsd: 0.05, ratio: 1, drifted: false });
    expect(driftOf(obs).drifted).toBe(true);
    expect(driftOf(obs, null).expectedUsd).toBe(0.0539);
  });

  it("a delivered bill is recorded, reported against the cell in force, and becomes the cell", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fake({ price_cells: [cell("gpt-image-2", "1K", "medium", "normal", "0.0539")] });
    await observePrice(f.client, {
      modelFamily: "gpt-image-2", provider: "openai", providerModel: "gpt-image-2", resolution: "1K", quality: "medium",
      role: "normal", priced: true, tokens: 1667, observedUsd: 0.05, generationId: "g1",
    });
    expect(f.inserts).toEqual([{ table: "price_observations", row: {
      model_family: "gpt-image-2", provider: "openai", provider_model: "gpt-image-2", resolution: "1K", quality: "medium",
      role: "normal", priced: true, tokens: 1667, observed_usd: 0.05, generation_id: "g1",
    } }]);
    // The cell in force is the rounded bill (0.0539 -> 0.054), and the new bill is held to it, not to the table.
    expect(said.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/\[price-drift\] openai gpt-image-2 1K medium: billed \$0\.0500 vs cell \$0\.0540 \(-7\.4% below\)/);
    // The next quote on this instance reads the new bill: the cache is gone.
    const next = fake({ price_cells: [cell("gpt-image-2", "1K", "medium", "normal", "0.05")] });
    expect((await loadPriceCells(next.client)).get(cellKey("gpt-image-2", "1K", "medium", "normal"))).toBe(0.05);
    expect(next.read).toEqual(["price_cells"]);
  });

  it("a fallback host's bill is kept for the record, held to the table, and never becomes the cell", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fake({ price_cells: [cell("gpt-image-2", "1K", "medium", "normal", "0.2")] });
    await loadPriceCells(f.client);
    await observePrice(f.client, {
      modelFamily: "gpt-image-2", provider: "wavespeed", providerModel: "openai/gpt-image-2/text-to-image", resolution: "1K",
      quality: "medium", role: "normal", priced: false, tokens: null, observedUsd: 0.0539, generationId: "g2",
    });
    expect(f.inserts[0].row).toMatchObject({ priced: false, provider: "wavespeed", observed_usd: 0.0539 });
    // 0.0539 is the table's cell: no drift — against the 0.2 cell it would have been one.
    expect(said).not.toHaveBeenCalled();
    const next = fake({ price_cells: [cell("gpt-image-2", "1K", "medium", "normal", "0.05")] });
    expect((await loadPriceCells(next.client)).get(cellKey("gpt-image-2", "1K", "medium", "normal"))).toBe(0.2);
    expect(next.read).toEqual([]);
  });

  it("never throws: a failed insert is logged, no database records nothing", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const obs = {
      modelFamily: "gpt-image-2", provider: "openai", providerModel: "gpt-image-2", resolution: "2K", quality: "medium" as const,
      role: "normal" as const, priced: true, tokens: 3568, observedUsd: 0.107, generationId: null,
    };
    const f = fake({}, { failInsert: true });
    await expect(observePrice(f.client, obs)).resolves.toBeUndefined();
    expect(said.mock.calls.map((c) => String(c[0])).join("\n")).toContain("[price-cells] observation not saved");
    await expect(observePrice(null, obs)).resolves.toBeUndefined();
  });
});

describe("the priced route", () => {
  const link = (id: string, key: string, provider_model: string, priority: number) => ({
    id, role: "normal", provider_model, active: true, priority, applies_when: null,
    provider_id: `p-${key}`, providers: { id: `p-${key}`, key, audience: "public", active: true },
  });
  const row = {
    id: "m", name: "GPT-Image-2", allowed_ratios: ["1:1"], max_reference_images: 16,
    model_providers: [link("a", "openai", "gpt-image-2", 10), link("b", "wavespeed", "openai/gpt-image-2/text-to-image", 20)],
  };

  it("passes over a host this environment has no key for, like an open breaker; primary still counts the full list (ENV-01)", async () => {
    const m = models.fromRow(row, "public");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEYS", " , ");
    vi.stubEnv("WAVESPEED_API_KEY", "test");
    expect(await chooseRoute(fake({ model_provider_health: [] }).client, m, { resolution: "2K" })).toMatchObject({ provider: "wavespeed", primary: false });
    // No host has a key: the first ELIGIBLE one, so the route can name the
    // missing host; not the settings-blind fallback (here a 4K-only host).
    vi.stubEnv("WAVESPEED_API_KEY", "");
    const fourK = models.fromRow({ ...row, model_providers: [
      { ...link("a", "openai", "gpt-image-2", 10), applies_when: { resolution: ["4K"] } },
      link("b", "wavespeed", "openai/gpt-image-2/text-to-image", 20),
    ] }, "public");
    expect(await chooseRoute(fake({ model_provider_health: [] }).client, fourK, { resolution: "2K" })).toMatchObject({ provider: "wavespeed", primary: true });
  });

  it("is the first eligible route; a breaker that skips it runs a later one that is not", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    vi.stubEnv("WAVESPEED_API_KEY", "test");
    const m = models.fromRow(row, "public");
    const healthy = fake({ model_provider_health: [] });
    expect(await chooseRoute(healthy.client, m, { resolution: "2K" })).toMatchObject({ provider: "openai", primary: true });
    const down = fake({ model_provider_health: [
      { model_provider_id: "a", provider_id: "p-openai", status: "down", consecutive_failures: 3, last_probe_at: new Date().toISOString(), last_quoted_micro: null },
    ] });
    expect(await chooseRoute(down.client, m, { resolution: "2K" })).toMatchObject({ provider: "wavespeed", primary: false });
  });

  it("is what both paid rails record, after the generation row, and what the x402 quote prices from", () => {
    const paid = readSource(join(__dirname, "..", "..", "app", "api", "generate-image", "route.ts"));
    expect(paid).toContain("priced: route.primary === true,");
    expect(paid).toContain("role: paid.boost ? \"boost\" : \"normal\",");
    expect(paid.indexOf("after(observePrice(")).toBeGreaterThan(paid.indexOf("const generationId = await recordGeneration("));
    expect(paid).not.toContain("reportPriceDrift");
    const agent = readSource(join(__dirname, "..", "..", "app", "api", "x402", "generate", "route.ts"));
    expect(agent).toContain("priced: route.primary === true,");
    expect(agent).toContain("modelLegMicro(input.modelFamily, input.resolution, { quality: input.quality, cellUsd })");
    expect(agent).not.toContain("reportPriceDrift");
  });

  it("is the model's own route when it has no provider rows", async () => {
    const m = models.fromRow({ id: "m", name: "GPT-Image-2" }, "public");
    expect(await chooseRoute(fake({}).client, m, {})).toMatchObject({ provider: "openai", providerModel: "gpt-image-2", primary: true });
  });
});
