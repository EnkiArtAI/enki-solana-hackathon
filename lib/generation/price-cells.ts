import type { SupabaseClient } from "@supabase/supabase-js";
import { effectiveQuality } from "@/lib/pricing";
import { reportPriceDrift } from "@/lib/generation/price-drift";

/**
 * The price a generator charges is the bill its priced route sent back last
 * time (Kev, 2026-10-13: "zieh den preis direkt vom api call"). Every
 * delivered paid render that came with a vendor bill writes an observation
 * (price_observations); the newest one per cell is the cell in force
 * (price_cells), read by every quote. The table in lib/pricing.ts seeds a
 * cell nobody has rendered yet and answers when the database cannot be read.
 *
 * A cell is keyed by family, size, the quality that ran and the route's
 * role, never by the host: the quote prices the model's FIRST eligible route,
 * so only a bill from that route may become the cell. A breaker or a probe
 * can run a request on a fallback host whose bill is another number; it is
 * kept for the record (priced = false) and never charged to anyone.
 */

export type RouteRole = "normal" | "boost";

export interface PriceObservation {
  modelFamily: string;
  provider: string;
  providerModel: string;
  resolution: string;
  quality: string | null;
  role: RouteRole;
  /** The route that ran is the one the quote prices. */
  priced: boolean;
  tokens: number | null;
  /** What the vendor billed for this image, in USD, as returned. */
  observedUsd: number;
  generationId: string | null;
}

export type PriceCells = ReadonlyMap<string, number>;

export const cellKey = (family: string, resolution: string, quality: string | null | undefined, role: RouteRole): string =>
  `${family}|${resolution}|${quality ?? "-"}|${role}`;

/** A bill rounded UP to the next tenth of a cent: the cell never sits below what the image cost. */
export const cellUsd = (observedUsd: number): number => Math.max(0, Math.ceil(observedUsd * 1000 - 1e-9)) / 1000;

const CACHE_MS = 60_000;
let cache: { at: number; cells: Map<string, number> } | null = null;

/**
 * The cells in force, read once a minute per instance. An unreadable table
 * answers the last read, else nothing — and nothing means the table in
 * lib/pricing.ts prices the quote.
 */
export async function loadPriceCells(supabase: SupabaseClient | null): Promise<PriceCells> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.cells;
  if (!supabase) return cache?.cells ?? new Map();
  try {
    const { data, error } = await supabase
      .from("price_cells")
      .select("model_family, resolution, quality, role, observed_usd");
    if (error) throw error;
    const cells = new Map<string, number>();
    for (const r of (data ?? []) as Array<{ model_family: string; resolution: string; quality: string | null; role: RouteRole; observed_usd: unknown }>) {
      const usd = Number(r.observed_usd);
      if (Number.isFinite(usd) && usd >= 0) cells.set(cellKey(r.model_family, r.resolution, r.quality, r.role), cellUsd(usd));
    }
    cache = { at: Date.now(), cells };
    return cells;
  } catch (e) {
    console.error("[price-cells] read failed:", e instanceof Error ? e.message : e);
    return cache?.cells ?? new Map();
  }
}

/**
 * The cell a quote charges: the quality that will run (the tier default when
 * the caller named none, as the service renders it) for a model with a
 * quality lever, else the family's single cell at that size.
 */
export function priceCellFor(
  cells: PriceCells,
  q: { modelFamily: string; resolution: string; quality?: string | null; boost?: boolean },
): number | null {
  const role: RouteRole = q.boost ? "boost" : "normal";
  return (
    cells.get(cellKey(q.modelFamily, q.resolution, effectiveQuality(q.resolution, q.quality), role)) ??
    cells.get(cellKey(q.modelFamily, q.resolution, null, role)) ??
    null
  );
}

/**
 * A delivered render's bill: the admins hear when it moved against the cell
 * in force, then it becomes the cell. Never throws — the image is already
 * delivered and paid for.
 */
export async function observePrice(supabase: SupabaseClient | null, obs: PriceObservation): Promise<void> {
  const inForce = obs.priced
    ? (await loadPriceCells(supabase)).get(cellKey(obs.modelFamily, obs.resolution, obs.quality, obs.role)) ?? null
    : null;
  await reportPriceDrift(
    supabase,
    { provider: obs.provider, modelFamily: obs.modelFamily, resolution: obs.resolution, quality: obs.quality, observedUsd: obs.observedUsd },
    inForce,
  );
  if (!supabase) return;
  try {
    const { error } = await supabase.from("price_observations").insert({
      model_family: obs.modelFamily,
      provider: obs.provider,
      provider_model: obs.providerModel,
      resolution: obs.resolution,
      quality: obs.quality,
      role: obs.role,
      priced: obs.priced,
      tokens: obs.tokens,
      observed_usd: obs.observedUsd,
      generation_id: obs.generationId,
    });
    if (error) throw error;
    // The next quote on this instance charges this bill, not last minute's.
    if (obs.priced) cache = null;
  } catch (e) {
    console.error("[price-cells] observation not saved:", e instanceof Error ? e.message : e);
  }
}

export const __testing__ = { reset: () => { cache = null; } };
