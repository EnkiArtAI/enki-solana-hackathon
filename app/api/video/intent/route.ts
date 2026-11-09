/**
 * POST /api/video/intent: the held payment's first step for one video, as /api/payments/generation/intent is an image's. The client
 * sends identifiers and settings, never an amount; quoteVideo is the chip's one answer, so what shows is what is charged. Asked
 * first, before anything is written or any second factor: whether this generator can run at all. With no operator set, every
 * call ends here with "Not available yet." (Kev, 2026-11-03: "wir wechseln den betreiber später"). /authorize, /submit, /cancel and
 * /status are the image's own routes.
 */
import { NextRequest, NextResponse } from "next/server";
import { authRefusal, checkRateLimit, requireAuth } from "@/lib/auth";
import { dbUnavailableResponse, isDbUnreachable, refusalBody } from "@/lib/db-error";
import { spendFits } from "@/lib/generation/spend-cap";
import { PRICING_POLICY, splitToBreakdown } from "@/lib/payments/generation-pricing";
import { paymentRail } from "@/lib/payments/rail";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { VIDEO_MODELS, VIDEO_NOT_AVAILABLE } from "@/lib/video/models";
import { quoteVideo, videoAskSchema } from "@/lib/video/quote";
import { MAX_RUNNING, runningJobs, videoFileToRun } from "@/lib/video/ready";
import { loadVideoRoutes } from "@/lib/video/routes";
import { requireActionStepUp, resolveStableUserId } from "@/lib/webauthn";

/** Clips stay in the composer for now: their rate and minimum are unread, and a clip needs its own checks. */
const schema = videoAskSchema.omit({ clipTenths: true }).strict();

export async function POST(req: NextRequest) {
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "video:intent:ip"), 120, 60_000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  let user;
  try {
    user = await requireAuth(req);
  } catch (e) {
    return authRefusal(e);
  }
  if (!checkRateLimit(user.userId, "video:intent", 60, 60_000)) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  const { promptId, modelId } = parsed.data;

  const supabase = getSupabaseServerClient();
  try {
    const quote = await quoteVideo(supabase, { ...parsed.data, clipTenths: 0 }, { buyer: user.userId, sessionToken: req.headers.get("X-Session-Token") });
    if (!quote.ok) return NextResponse.json(refusalBody(quote), { status: quote.status });
    // The escrow rail deposits before the render; a video's money moves only once its output is stored and checked.
    if (!quote.available || (await paymentRail()) === "escrow") return NextResponse.json({ error: VIDEO_NOT_AVAILABLE }, { status: 503 });

    const run = await videoFileToRun(supabase);
    if (run) {
      console.error(`[video] a paid video needs sql-to-run/${run}`);
      return NextResponse.json({ error: `Videos need sql-to-run/${run}. Nothing was charged.`, run }, { status: 503 });
    }

    const renderer = await resolveStableUserId(supabase, user.userId);
    if (!renderer) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    if (((await runningJobs(supabase, renderer)) ?? 0) >= MAX_RUNNING) {
      return NextResponse.json({ error: `You have ${MAX_RUNNING} videos in the making. Wait for one to finish. Nothing was charged.` }, { status: 429 });
    }
    const blocked = await requireActionStepUp(req, renderer, "render", "render");
    if (blocked) return blocked;

    const model = VIDEO_MODELS.find((m) => m.id === modelId)!;
    const row = (await loadVideoRoutes(supabase))?.find((r) => r.id === modelId);
    if (!row) return NextResponse.json({ error: VIDEO_NOT_AVAILABLE }, { status: 503 });

    const { split, settings } = quote;
    // Before anything is signed: past this point a refusal costs the buyer a signature (SQL 72).
    const fits = await spendFits(supabase, split.modelCostMicro);
    if (!fits.ok) return NextResponse.json({ error: fits.error }, { status: fits.status });
    const expiresAt = new Date(Date.now() + PRICING_POLICY.quoteTtlSeconds * 1000).toISOString();
    const { data: intent, error } = await supabase
      .from("generation_payment_intents")
      .insert({
        buyer_wallet: user.walletAddress,
        prompt_id: promptId ?? null,
        model_id: row.modelId,
        model_family: model.label,
        resolution: settings.resolution,
        quality: null,
        boost: false,
        reference_image_count: 0,
        artist_wallet: quote.artistWallet,
        artist_amount_micro: split.artistAmountMicro,
        model_cost_micro: split.modelCostMicro,
        enki_fee_micro: split.enkiFeeMicro,
        total_micro: split.totalMicro,
        fee_bps: PRICING_POLICY.enkiFeeBps,
        fee_base: PRICING_POLICY.feeBase,
        fee_mode: PRICING_POLICY.feeMode,
        expires_at: expiresAt,
        video_settings: { modelId, ...settings },
      })
      .select("id")
      .single();
    if (isDbUnreachable(error)) return dbUnavailableResponse();
    if (error || !intent) {
      console.error("[video] intent insert failed");
      return NextResponse.json({ error: "Failed to create payment intent" }, { status: 500 });
    }
    return NextResponse.json({ intent: { id: intent.id, promptId: promptId ?? null, modelId, settings, expiresAt, breakdown: splitToBreakdown(split) } });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}
