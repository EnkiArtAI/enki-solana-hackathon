/**
 * Whether this environment can render what an intent paid for, by the same
 * checks /api/generate-image makes before it claims a unit: the paid model
 * still resolves to the paid family, and the route chosen for the paid
 * settings is a host this build implements, with a provider model and a key
 * here. /authorize asks before it opens anything: a model nobody can render
 * here would otherwise open nonce accounts the route then refuses, voided as
 * Enki's and so outside the buyer's limits, in a loop (verification
 * 2026-10-18). Keep the host list in step with the route's IMPLEMENTED.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { chooseRoute, resolveModel, type Route } from "@/lib/generation/models";
import { normalizeTier } from "@/lib/generation/resolution";
import { toModelFamily } from "@/lib/generation/model-family";
import { effectiveQuality } from "@/lib/pricing";
import { providerKeyMissing } from "@/lib/generation/provider-health";

export const RENDERING_HOSTS: readonly string[] = ["gemini", "wavespeed", "openai"];

type PaidSettings = { model_id: string | null; model_family: string | null; resolution: string | null; quality: string | null; boost: boolean | null; reference_image_count: number | null };

export async function renderableHere(supabase: SupabaseClient | null, paid: PaidSettings): Promise<boolean> {
  return Boolean(await renderableRoute(supabase, paid));
}

/** The route renderableHere approves, or null: /authorize also checks an artist's prompt against its host (round 11). */
export async function renderableRoute(supabase: SupabaseClient | null, paid: PaidSettings): Promise<Route | null> {
  const tier = normalizeTier(paid.resolution);
  const model = paid.model_id ? await resolveModel(supabase, [paid.model_id]) : null;
  if (!tier || !model || toModelFamily(model.name) !== paid.model_family) return null;
  // The references paid for, past what the model takes now: the route would refuse every unit (round 18, 2026-10-20).
  if ((paid.reference_image_count ?? 0) > model.maxRefs) return null;
  const route = await chooseRoute(supabase, model, {
    boost: paid.boost === true,
    quality: model.supportsQuality ? effectiveQuality(tier, paid.quality) : null,
    resolution: model.supportsResolution ? tier : null,
    referenceImages: paid.reference_image_count ?? 0,
  });
  return route && RENDERING_HOSTS.includes(route.provider) && route.providerModel && !providerKeyMissing(route.provider) ? route : null;
}
