import type { SupabaseClient } from "@supabase/supabase-js";
import { VIDEO_ADAPTERS } from "./adapters";
import type { VideoAdapter } from "./adapters/types";
import { RESOLUTIONS, VIDEO_MODELS, type RateCells, type Resolution, type VideoRate } from "./models";

/** The file that adds video_routes and fills it. */
export const ROUTES_SQL = "68-video-routes.sql";

/** One model's row in video_routes, by the model's own id (lib/video/models). */
export interface VideoRoute {
  id: string;
  /** Its row in `models`, what an intent and a job name; never on a public answer. */
  modelId: string;
  operator: string | null;
  providerModel: string | null;
  rateOperator: string | null;
  rate: VideoRate;
}

/** What GET /api/video/models says of a route: its rate and where it can run, never who runs it. */
export interface PublicVideoRoute extends VideoRate {
  id: string;
  available: readonly Resolution[];
}

const missingTable = (e: { code?: string } | null) => e?.code === "PGRST205" || e?.code === "42P01";

/** The cells of a stored rate that are a price: a positive whole number of micro-USD, at a resolution there is. */
function rateCells(raw: unknown): RateCells {
  const cells = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return Object.fromEntries(RESOLUTIONS.flatMap((r) => (Number.isSafeInteger(cells[r]) && (cells[r] as number) > 0 ? [[r, cells[r] as number]] : [])));
}

/**
 * The routes in the composer's order, joined to the active video models by name. Null when SQL 68 has not run, or ran before
 * 67 and inserted nothing: what is on the page then says "…" and the answer names the file. Any other failed read throws.
 */
export async function loadVideoRoutes(supabase: SupabaseClient): Promise<VideoRoute[] | null> {
  const [models, rows] = await Promise.all([
    supabase.from("models").select("id, name").eq("media_type", "video").eq("active", true),
    supabase.from("video_routes").select("model_id, operator, provider_model, cost, audio_cost, clips_added, rate_operator"),
  ]);
  if (missingTable(rows.error)) return null;
  if (rows.error || models.error) throw rows.error ?? models.error;
  const routes = VIDEO_MODELS.flatMap((m): VideoRoute[] => {
    const modelId = (models.data ?? []).find((x) => x.name === m.label)?.id;
    const row = (rows.data ?? []).find((x) => x.model_id === modelId);
    return row ? [{
      id: m.id,
      modelId: String(modelId),
      operator: row.operator,
      providerModel: row.provider_model,
      rateOperator: row.rate_operator,
      rate: { cost: rateCells(row.cost), audioCost: row.audio_cost ? rateCells(row.audio_cost) : null, clipsAdded: row.clips_added === true },
    }] : [];
  });
  return routes.length ? routes : null;
}

/**
 * The resolutions this route can run now: an operator, its adapter registered, the adapter's key present, the rate that
 * operator's own, and a rate cell there. A rate left over from another operator is not available, never a charge under cost.
 */
export function availableAt(route: VideoRoute, adapters: Readonly<Record<string, VideoAdapter>> = VIDEO_ADAPTERS): Resolution[] {
  const adapter = route.operator ? adapters[route.operator] : undefined;
  if (!adapter?.configured() || route.rateOperator !== route.operator) return [];
  return RESOLUTIONS.filter((r) => route.rate.cost[r] !== undefined);
}

export const publicRoute = (route: VideoRoute): PublicVideoRoute => ({ id: route.id, ...route.rate, available: availableAt(route) });
