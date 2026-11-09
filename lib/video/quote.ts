import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { dbOutage, isDbUnreachable } from "@/lib/db-error";
import { videoColumns } from "@/lib/marketplace/video-columns";
import { computeQuote, type QuoteResult } from "@/lib/payments/generation-quote";
import { videoLeg } from "./charge";
import { ASPECTS, AUTO, RESOLUTIONS, VIDEO_MODELS, fitSettings, type VideoSettings } from "./models";
import { ROUTES_SQL, availableAt, loadVideoRoutes } from "./routes";

/** What may be asked: one video, by the model's own id. Strict, so a count never slips through (Kev, 2026-11-03: "allow also only the creation of 1 video"). */
export const videoAskSchema = z.object({
  promptId: z.string().uuid().optional(),
  modelId: z.string().max(40),
  settings: z.object({
    seconds: z.number().int().min(1).max(60),
    aspect: z.enum([...ASPECTS, AUTO]),
    resolution: z.enum(RESOLUTIONS),
    audio: z.boolean(),
    bitrate: z.enum(["high", "standard"]),
  }).strict(),
  clipTenths: z.number().int().min(0).max(6000).default(0),
}).strict();
export type VideoAsk = z.infer<typeof videoAskSchema>;

export type VideoQuote =
  | (Extract<QuoteResult, { ok: true }> & { settings: VideoSettings; available: boolean })
  | { ok: false; status: number; error: string; code?: string };

/**
 * One video's price, from the operator's row, through computeQuote: the prompt's own rules (live, its creator not hidden, an
 * artist to pay) are an image's. What the chip shows and what the intent will charge are this function's one answer. The
 * settings as the model takes them come back with it. A price is not a yes: `available` says whether it can run.
 */
export async function quoteVideo(supabase: SupabaseClient, ask: VideoAsk, user: { buyer?: string; sessionToken?: string | null } = {}): Promise<VideoQuote> {
  try {
    const m = VIDEO_MODELS.find((x) => x.id === ask.modelId);
    if (!m) return { ok: false, status: 400, error: "Unknown video generator" };
    const routes = await loadVideoRoutes(supabase);
    if (!routes) return { ok: false, status: 503, error: `Video prices need sql-to-run/${ROUTES_SQL}.` };
    const route = routes.find((r) => r.id === m.id);
    const settings = fitSettings(m, ask.settings);
    const leg = route ? videoLeg(m, route.rate, settings, ask.clipTenths) : null;
    if (!route || !leg) return { ok: false, status: 422, error: `${m.label} has no price for these settings yet.` };
    if (ask.promptId) {
      // Before SQL 52 every prompt is an image's.
      const row = (await videoColumns(supabase)) ? await supabase.from("prompts").select("media_type").eq("id", ask.promptId).maybeSingle() : { data: { media_type: "image" }, error: null };
      if (row.error) throw row.error;
      if (row.data && row.data.media_type !== "video") return { ok: false, status: 422, error: "This prompt makes images." };
    }
    const quote = await computeQuote(supabase, { promptId: ask.promptId, modelFamily: m.label, buyer: user.buyer, sessionToken: user.sessionToken, video: leg });
    return quote.ok ? { ...quote, settings, available: availableAt(route).includes(settings.resolution) } : quote;
  } catch (e) {
    if (isDbUnreachable(e)) return dbOutage();
    throw e;
  }
}
