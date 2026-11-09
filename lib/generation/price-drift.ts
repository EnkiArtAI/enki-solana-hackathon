import type { SupabaseClient } from "@supabase/supabase-js";
import { apiPricePerImage, geminiDirectPricePerImage } from "@/lib/pricing";
import { notifyAdmins } from "@/lib/admin-notify";

/**
 * Runtime price-drift detector (Kev, 2026-09-05: "ich brauche eine meldung
 * wenn ein generator die preise erhöht").
 *
 * The weekly cloud routine reads the providers' PRICING PAGES; this catches
 * what pages cannot — the bill itself. Every direct-vendor generation
 * answers with the tokens it consumed, so the real cost of THIS image is
 * known the moment it lands. Compared against the table we charge by; a gap
 * beyond the tolerance alerts the admins (email via lib/admin-notify) and
 * logs loudly. One alert per model/quality/tier per 6h per instance, so a
 * repriced provider produces a report, not a flood.
 */
export interface DriftObservation {
  provider: string;
  modelFamily: string;
  resolution: string;
  quality?: string | null;
  /** What the provider actually billed for this image, in USD. */
  observedUsd: number;
}

/** Vendor bills are token-quantised; a few percent is noise, more is a repricing. */
const TOLERANCE = 0.03;
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const lastAlert = new Map<string, number>();

/**
 * `cellUsd` is the cell in force (the priced route's last bill, see
 * lib/generation/price-cells.ts); without one the table answers.
 */
export function driftOf(obs: DriftObservation, cellUsd?: number | null): { expectedUsd: number; ratio: number; drifted: boolean } {
  // A Google bill is held against Google's own price: a model can run there as its boost or fallback host.
  const expectedUsd =
    cellUsd ??
    (obs.provider === "gemini" ? geminiDirectPricePerImage(obs.modelFamily, obs.resolution) : null) ??
    apiPricePerImage(obs.modelFamily, obs.resolution, obs.quality);
  const ratio = expectedUsd > 0 ? obs.observedUsd / expectedUsd : Infinity;
  return { expectedUsd, ratio, drifted: Math.abs(ratio - 1) > TOLERANCE };
}

export async function reportPriceDrift(supabase: SupabaseClient | null, obs: DriftObservation, cellUsd?: number | null): Promise<void> {
  const { expectedUsd, ratio, drifted } = driftOf(obs, cellUsd);
  if (!drifted) return;
  const key = `${obs.modelFamily}|${obs.quality ?? "-"}|${obs.resolution}`;
  const direction = ratio > 1 ? "ABOVE" : "below";
  const line =
    `[price-drift] ${obs.provider} ${obs.modelFamily} ${obs.resolution}${obs.quality ? " " + obs.quality : ""}: ` +
    `billed $${obs.observedUsd.toFixed(4)} vs ${cellUsd == null ? "table" : "cell"} $${expectedUsd.toFixed(4)} (${((ratio - 1) * 100).toFixed(1)}% ${direction})`;
  console.error(line);
  const now = Date.now();
  if ((lastAlert.get(key) ?? 0) + ALERT_COOLDOWN_MS > now) return;
  lastAlert.set(key, now);
  if (!supabase) return;
  try {
    await notifyAdmins(supabase, {
      subject: `⚠️ Generator price drift: ${obs.modelFamily} ${obs.resolution} ${obs.quality ?? ""}`.trim(),
      text:
        `${line}\n\n` +
        (ratio > 1
          ? "The provider now bills MORE than the last quote charged — this image lost the difference."
          : "The provider now bills LESS than the last quote charged — this buyer paid the difference.") +
        "\n\nThe new bill is the cell in force from now on (price_observations); the seed in lib/pricing.ts can follow when convenient.",
    });
  } catch (e) {
    console.error("[price-drift] admin notification failed:", e instanceof Error ? e.message : e);
  }
}
