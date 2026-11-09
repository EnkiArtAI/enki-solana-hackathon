/**
 * POST /api/video/jobs: a paid, signed video goes to its operator. What ran is what the intent stored, never what this body says;
 * the words (for a premium prompt: the artist's, filled on the server) and the pictures are judged first, as an image's are, and
 * the operator is asked once. Nothing is charged here: the cron (lib/video/jobs) captures once the output is stored and passed.
 * A refusal here voids the held payment and answers one sentence.
 * GET: the signed-in account's own jobs, newest first; ?promptId= for one prompt's.
 */
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ADULT_REFUSAL, adultConfirmed, promptMarkedAdult } from "@/lib/adult-content";
import { authRefusal, checkRateLimit, requireAuth } from "@/lib/auth";
import { encryptString } from "@/lib/crypto";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { fillVariables, inputsUnmatched, buyersOwn, loadPromptText, neutralFill, overLong, VALUE_MAX } from "@/lib/generation/prompt-text";
import { resolveRecordingUserId } from "@/lib/generation/record";
import { mayBeBilled } from "@/lib/generation/provider-health";
import { JUDGE_CALL_MICRO, releaseSpend, reserveSpend } from "@/lib/generation/spend-cap";
import { CLIENT_BLOCK_MESSAGE, moderate, screenFirst } from "@/lib/moderation";
import { childSafetyScore, recordModerationEvent } from "@/lib/moderation-enforcement";
import { recordExtractionHit, silentFailure } from "@/lib/moderation/extraction-hits";
import { recordImageCase } from "@/lib/moderation/image-case";
import { checkImageBytes, heldBack } from "@/lib/moderation/image-check-bytes";
import { checkDown, checkPrompt, NOT_CHECKED, textValues, unnamedValues } from "@/lib/moderation/prompt-check";
import { PROMPT_UNAVAILABLE, refusePrompt } from "@/lib/moderation/prompt-pause";
import { recordWarning, warningMessage } from "@/lib/moderation/warnings";
import { buyerCovers, capturePause, droppedPause } from "@/lib/payments/authorize-flow";
import { claimForGeneration } from "@/lib/payments/generation-claim";
import { voidAndFlush } from "@/lib/payments/settle";
import { solanaConnection } from "@/lib/payments/solana";
import { allowsReferences, REFERENCES_OFF } from "@/lib/prompt-references";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { REFERENCE_BUCKET, REFERENCE_SIGN_TTL } from "@/lib/reference-library";
import { resolveOwnerIds, resolveSessionUserId } from "@/lib/session-user";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { UUID_RE } from "@/lib/dm";
import { VIDEO_ADAPTERS } from "@/lib/video/adapters";
import { VideoRefused } from "@/lib/video/adapters/types";
import { JOB_WHY, VIDEO_CONSENT_REFUSED, VIEW_COLUMNS, jobView, type VideoJobWhy } from "@/lib/video/job-view";
import { HOLD_MS, VIDEO_JOB_AAD, VIDEO_SURFACE } from "@/lib/video/jobs";
import { VIDEO_MODELS, VIDEO_NOT_AVAILABLE, type Resolution } from "@/lib/video/models";
import { HOLD_SQL, JOBS_SQL, MAX_RUNNING, runningJobs } from "@/lib/video/ready";
import { endUserHash } from "@/lib/video/safety-id";
import { availableAt, loadVideoRoutes } from "@/lib/video/routes";

export const runtime = "nodejs";
export const maxDuration = 120;

const NOT_READ = "This video request could not be read. Nothing was charged.";
const TOO_MANY = `You have ${MAX_RUNNING} videos in the making. Wait for one to finish. Nothing was charged.`;

/** Strict, so a count never slips through: one press is one video. */
const schema = z.object({
  intentId: z.string().uuid(),
  words: z.string().max(4000).optional(),
  variableValues: z.record(z.string(), z.unknown()).optional(),
  frames: z.object({ start: z.string().uuid().optional(), end: z.string().uuid().optional() }).strict().optional(),
  refs: z.array(z.string().uuid()).max(30).optional(),
  consent: z.boolean().optional(),
}).strict();

const say = (error: string, status: number) => NextResponse.json({ error }, { status });

/** The saved references a job names, the owner's own, with their bytes for the check and an address the operator can read for an hour. */
async function picturesOf(db: SupabaseClient, ids: string[], userId: string) {
  if (!ids.length) return [];
  const { data, error } = await db.from("reference_uploads").select("id, path").in("id", ids).eq("user_id", userId).is("deleted_at", null);
  if (error) throw error;
  if (new Set(ids).size !== ids.length || (data ?? []).length !== ids.length) return null;
  return Promise.all(ids.map(async (id) => {
    const { path } = (data ?? []).find((r) => r.id === id)!;
    const bucket = db.storage.from(REFERENCE_BUCKET);
    const [file, link] = await Promise.all([bucket.download(path), bucket.createSignedUrl(path, REFERENCE_SIGN_TTL)]);
    if (file.error || link.error || !file.data || !link.data) throw new Error("[video] a reference could not be read");
    return { id, url: link.data.signedUrl, bytes: Buffer.from(await file.data.arrayBuffer()) };
  }));
}

export async function POST(req: NextRequest) {
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "video:jobs:ip"), 120, 60_000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);
  if (!req.headers.get("X-Session-Token")) return say("Authentication required", 401);
  let user;
  try {
    user = await requireAuth(req);
  } catch (e) {
    return authRefusal(e);
  }
  if (!checkRateLimit(user.userId, "video:jobs", 60, 60_000)) return say("Rate limit exceeded", 429);

  const raw = await req.json().catch(() => null) as Record<string, unknown> | null;
  const parsed = schema.safeParse(raw);
  // Refused here, before any row is read: nothing is held by a body that says nothing true.
  if (!parsed.success) return say(raw && "count" in raw ? "One press makes one video. Nothing was charged." : NOT_READ, 422);
  const { intentId, words: typed = "", variableValues = {}, frames = {}, refs = [], consent = false } = parsed.data;

  const db = getSupabaseServerClient();
  try {
    const userId = await resolveRecordingUserId(db, req);
    if (!userId) return say("Authentication required", 401);

    const { data: unit, error: unitError } = await db.from("generation_payment_intents")
      .select("id, model_id, model_family, prompt_id, artist_amount_micro, model_cost_micro, resolution, video_settings, authorized_at, batch_intent_id, consumed_at, captured_at, voided_at")
      .eq("id", intentId).ilike("buyer_wallet", user.walletAddress).maybeSingle();
    if (unitError?.code === "42703") return say(`Videos need sql-to-run/${HOLD_SQL}. Nothing was charged.`, 503);
    if (unitError) throw unitError;
    const settings = unit?.video_settings as ({ modelId: string; seconds: number; aspect: string; resolution: Resolution; audio: boolean; bitrate: string } | null | undefined);
    if (!unit || !settings) return say("This video request was not found.", 404);
    if (!unit.authorized_at || unit.batch_intent_id !== unit.id) return say("This video has not been paid for yet.", 402);
    // A spent unit asks no judge: only the claim below refused it, after every paid check had run, so one signature was a metered loop. The claim still decides a race.
    if (unit.voided_at) return say("Payment intent was cancelled", 409);
    if (unit.consumed_at || unit.captured_at) return say("Payment intent already used", 409);

    // Before the claim: a void here needs no render to have started, and a claimed row is no longer the buyer's cancel.
    const refused = async (error: string, status: number, reason: "rejected" | "provider_failed" | "cancelled") => {
      await voidAndFlush(db, intentId, reason, { unclaimed: true }).catch(() => console.error("[video] void pending", intentId));
      return say(error, status);
    };
    const ours = (error: string, status = 503) => refused(error, status, "provider_failed");
    const theirs = (error: string, status = 422) => refused(error, status, "rejected");

    // Kev, 2026-10-18: "sperre nur für 30min bei 5 geplatzten abbuchungen". /authorize asks it, but a video's bill is the operator's whole price, so units signed before the pause stop here too.
    if ((await capturePause(db, user.walletAddress)).paused || (await droppedPause(db, user.walletAddress)).paused) {
      return ours("Paying is paused for now: earlier payments did not go through. Nothing was charged.", 429);
    }

    const model = VIDEO_MODELS.find((m) => m.id === settings.modelId);
    const route = model && (await loadVideoRoutes(db))?.find((r) => r.id === model.id);
    const adapter = route?.operator ? VIDEO_ADAPTERS[route.operator] : undefined;
    if (!model || !route || !adapter || !route.providerModel || !availableAt(route).includes(settings.resolution)) return ours(VIDEO_NOT_AVAILABLE);

    const running = await runningJobs(db, userId);
    if (running === null) return ours(`Videos need sql-to-run/${JOBS_SQL}. Nothing was charged.`);
    if (running >= MAX_RUNNING) return refused(TOO_MANY, 429, "cancelled");

    // What this generator takes, whatever a body claims.
    const framed = [frames.start, frames.end].filter((x): x is string => Boolean(x));
    const held = framed.length + refs.length;
    if ((framed.length && !model.slots.includes("frames")) || (refs.length && (!model.slots.includes("refs") || refs.length > (model.refs?.images ?? 0))) || (model.oneSlot && framed.length && refs.length)) {
      return theirs(`${model.label} does not take these pictures. Nothing was charged.`);
    }
    if (held && consent !== true) return theirs(VIDEO_CONSENT_REFUSED);

    // ── The words: a premium prompt's are the artist's, filled here, and never leave.
    const promptId = unit.prompt_id ? String(unit.prompt_id) : null;
    const fromArtist = Boolean(promptId) && Number(unit.artist_amount_micro) > 0;
    let words = typed.trim();
    let promptAdult = false;
    let template = "";
    let variables: Parameters<typeof neutralFill>[2] = [];
    const isCreator = async () => {
      if (!promptId) return false;
      const [{ data: owner }, owners] = await Promise.all([
        db.from("prompts").select("creator_id").eq("id", promptId).maybeSingle(),
        resolveOwnerIds(db, req.headers.get("X-Session-Token")).catch(() => null),
      ]);
      return Boolean(owner?.creator_id && owners?.includes(String(owner.creator_id)));
    };
    // Its creator switched buyers' references off (SQL 62), as generate-image and x402 ask: a video's intent holds no count for the quote to refuse, so it is asked here. Its creator's own render is as ever.
    if (held && promptId && !(await allowsReferences(db, promptId)) && !(await isCreator())) return ours(`${REFERENCES_OFF} Nothing was charged.`, 422);
    if (fromArtist) {
      const text = await loadPromptText(db, promptId!);
      if (!text.ok) return ours(`${PROMPT_UNAVAILABLE} Nothing was charged.`, text.status);
      if (text.listed === false && !(await isCreator())) return ours(`${PROMPT_UNAVAILABLE} Nothing was charged.`, 422);
      if (overLong(variableValues)) return theirs(`Each input can be at most ${VALUE_MAX} characters. Nothing was charged.`);
      const filled = fillVariables(text.text, variableValues, text.variables);
      if (inputsUnmatched(filled)) return theirs("This prompt's inputs could not be matched to its text. Nothing was charged.");
      words = filled.text;
      promptAdult = text.adult;
      template = text.text;
      variables = text.variables;
    } else if (promptId) {
      const marked = await promptMarkedAdult(db, promptId);
      if (marked === null) return ours("This prompt could not be checked right now. Nothing was charged.");
      promptAdult = marked;
    }
    if (!words) return theirs("Write what the video shows first. Nothing was charged.", 400);

    // ── The checks, as an image's: the regex first, then the prompt check, then the moderation tiers.
    const checked = fromArtist ? unnamedValues(textValues(buyersOwn(variableValues, variables))) : { prompt: words };
    const sent = fromArtist ? textValues(variableValues) : { prompt: words };
    const about = fromArtist ? { promptId: promptId! } : {};
    const first = screenFirst(checked);
    const pictures = await picturesOf(db, [...framed, ...refs], userId);
    if (!pictures) return theirs("One of these pictures is not in your saved references. Nothing was charged.");
    // The judges run on Enki's money, so they reserve first (SQL 72), and only what will run: the prompt check unless the regex
    // refused already, and two views of each picture. A refusal that called nobody adds nothing. Never given back.
    const judgeCalls = (first ? 0 : 1) + 2 * pictures.length;
    if (judgeCalls) {
      const judges = await reserveSpend(db, JUDGE_CALL_MICRO * judgeCalls);
      // A cap that could not be read may answer in a moment: the signed unit stays open for the retry.
      if (!judges.ok) return judges.retry ? say(judges.error, judges.status) : ours(judges.error, judges.status);
    }
    const [check, seen] = await Promise.all([
      first ? NOT_CHECKED : checkPrompt(checked, { hidden: fromArtist, signal: req.signal }),
      Promise.all(pictures.map((p) => checkImageBytes(p.bytes, { signal: req.signal }))),
    ]);
    seen.forEach((v, i) => {
      if (v.verdict === "child_safety") after(recordImageCase(db, { surface: VIDEO_SURFACE, request: req, bytes: pictures[i].bytes, scores: v.scores, about: JSON.stringify(sent), promptId: about.promptId, account: userId }));
    });
    if (check.verdict === "minor_sexual" || check.verdict === "explicit_sexual") {
      const outcome = await recordWarning(db, { surface: VIDEO_SURFACE, request: req, category: check.verdict, text: JSON.stringify(sent), confidence: check.confidence, ...about });
      return theirs(warningMessage(check.verdict, outcome));
    }
    const heldPicture = seen.find(heldBack);
    if (heldPicture) {
      if (seen.some((v) => v.verdict === "blocked" || v.verdict === "child_safety")) return theirs("One of your pictures can't be used on Enki. Nothing was charged.");
      return refused("Your pictures could not be checked right now. Nothing was charged. Please try again.", 503, seen.every((v) => v.verdict !== "unavailable" || checkDown(v.reason)) ? "provider_failed" : "rejected");
    }
    const adult = ("adult" in check && check.adult === true) || promptAdult || seen.some((v) => v.verdict === "adult");
    const confirmed = adult ? await adultConfirmed(db, userId).catch(() => null) : true;
    if (confirmed === null) return ours("Your age confirmation could not be checked right now. Nothing was charged.");
    if (!confirmed) return theirs(ADULT_REFUSAL.error, 403);
    // Told as any failed video: no hint that a check exists, nor when it ran.
    if (check.verdict !== "clear") {
      if (check.verdict === "extraction") after(recordExtractionHit(db, { surface: VIDEO_SURFACE, request: req, values: sent, confidence: check.confidence, ...about }));
      await silentFailure();
      return refused(JOB_WHY.failed, 500, check.verdict === "unavailable" && checkDown(check.reason) ? "provider_failed" : "rejected");
    }
    const verdict = first ?? await moderate({ prompt: words, surface: VIDEO_SURFACE, adultJudged: !fromArtist || promptAdult });
    after(recordModerationEvent(verdict, { surface: VIDEO_SURFACE, request: req, prompt: fromArtist ? JSON.stringify(sent) : words, ...about }));
    if (!verdict.allowed) {
      // Judged again with the buyer's values neutral: still refused, it is the artist's text, off sale for an admin, the unit Enki's.
      if (fromArtist && !first) {
        const again = await moderate({ prompt: neutralFill(template, variableValues, variables), surface: VIDEO_SURFACE, adultJudged: promptAdult });
        if (!again.allowed && !(await isCreator())) {
          after(refusePrompt(db, { promptId: promptId!, cause: "moderation", detail: String(again.category ?? "blocked"), buyerUserId: userId }));
          return ours(`${PROMPT_UNAVAILABLE} Nothing was charged.`, 422);
        }
        if (again.tier2Degraded) return ours(CLIENT_BLOCK_MESSAGE, 422);
      }
      const minors = fromArtist ? childSafetyScore(verdict) : null;
      if (minors !== null) {
        const outcome = await recordWarning(db, { surface: VIDEO_SURFACE, request: req, category: "minor_sexual", text: JSON.stringify(sent), confidence: minors, scores: verdict.scores, ...about });
        return theirs(warningMessage("minor_sexual", outcome));
      }
      return theirs(CLIENT_BLOCK_MESSAGE);
    }

    const hash = endUserHash(userId);
    if (!hash) return ours(VIDEO_NOT_AVAILABLE);

    // ── Claimed: from here a failure is voided whether or not a render started.
    const claimed = await claimForGeneration(db, { intentId, buyerWallet: user.walletAddress });
    if (!claimed.ok) return claimed.status === 500 ? ours(claimed.error, 500) : say(claimed.error, claimed.status);
    const failed = async (error: string, status: number, reason: "rejected" | "provider_failed" | "unfunded" | "cancelled") => {
      await voidAndFlush(db, intentId, reason).catch(() => console.error("[video] void pending", intentId));
      return say(error, status);
    };
    const cover = await buyerCovers(db, solanaConnection(), user.walletAddress, 0).catch(() => null);
    if (!cover) return failed("Your wallet could not be checked right now. Nothing was charged.", 503, "provider_failed");
    if (!cover.ok) return failed("Your wallet no longer holds enough USDC for this video. Nothing was charged.", 402, "unfunded");
    const { error: holdError } = await db.from("generation_payment_intents").update({ hold_until: new Date(Date.now() + HOLD_MS).toISOString() }).eq("id", intentId);
    if (holdError) return failed(JOB_WHY.failed, 503, "provider_failed");

    const jobId = randomUUID();
    const sealed = encryptString(JSON.stringify({ words, values: variableValues }), VIDEO_JOB_AAD(jobId));
    const { error: jobError } = await db.from("video_jobs").insert({
      id: jobId, user_id: userId, intent_id: intentId, prompt_id: promptId, model_id: unit.model_id, operator: route.operator, provider_model: route.providerModel,
      settings: { ...settings, adult, fromArtist }, words_ct: sealed.encrypted, words_iv: sealed.iv, words_tag: sealed.authTag, words_kid: sealed.kid ?? "field-v1",
      refs: pictures.map((p) => p.id), end_user_hash: hash, consent: held > 0 && consent, status: "submitting",
    });
    if (jobError) return failed(JOB_WHY.failed, 503, "provider_failed");
    const close = async (status: "failed" | "refused", why: VideoJobWhy, code: string | null) => {
      const now = new Date().toISOString();
      await db.from("video_jobs").update({ status, error_class: why, provider_code: code, finished_at: now, updated_at: now }).eq("id", jobId);
    };

    // The read above is before all the judging: presses at once all pass it. Counted again with this row in, so the k-th to land sees at least k, and only the cap's first ever reach the operator (one that reads late may stand back too; it is voided and can press again).
    if (((await runningJobs(db, userId)) ?? 0) > MAX_RUNNING) {
      await close("failed", "failed", null);
      return failed(TOO_MANY, 429, "cancelled");
    }

    // The operator's bill, reserved before it is asked (SQL 72), with two views of each of the output's 5 frames (lib/video/jobs),
    // which only a render runs. A row without a price stays 0, so the SQL refuses it. A refusal voids the unit: nobody is charged.
    const bill = Number(unit.model_cost_micro);
    const reserved = await reserveSpend(db, bill && bill + JUDGE_CALL_MICRO * 10);
    if (!reserved.ok) {
      await close("failed", "failed", null);
      return failed(reserved.error, reserved.status, "provider_failed");
    }

    const urlOf = (id: string | undefined) => pictures.find((p) => p.id === id)?.url;
    try {
      // Once, whatever happens next: the operator's bill for a stray task is Enki's, never a second task.
      const { taskId } = await adapter.submit({
        providerModel: route.providerModel, words, frames: { start: urlOf(frames.start), end: urlOf(frames.end) }, refs: refs.map((id) => urlOf(id)!),
        settings: { seconds: settings.seconds, aspect: settings.aspect, resolution: settings.resolution, audio: settings.audio }, endUserHash: hash,
      });
      const { error } = await db.from("video_jobs").update({ status: "running", provider_task_id: taskId, updated_at: new Date().toISOString() }).eq("id", jobId);
      // Left "submitting", the cron fails and voids it in minutes.
      if (error) console.error("[video] a task id was not kept:", jobId);
    } catch (e) {
      if (e instanceof VideoRefused) {
        await releaseSpend(db, reserved);
        await close("refused", e.kind, e.code);
        return failed(JOB_WHY[e.kind], 422, "rejected");
      }
      if (!mayBeBilled(e instanceof Error ? e.message : "")) await releaseSpend(db, reserved);
      await close("failed", "failed", null);
      console.error("[video] submit failed:", e instanceof Error ? e.message.slice(0, 120) : "unknown");
      return failed(JOB_WHY.failed, 502, "provider_failed");
    }
    return NextResponse.json({ job: { id: jobId, status: "running" } });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}

export async function GET(req: NextRequest) {
  try {
    const db = getSupabaseServerClient();
    const me = await resolveSessionUserId(db, req.headers.get("X-Session-Token"));
    if (!me) return say("Not signed in", 401);
    const promptId = req.nextUrl.searchParams.get("promptId");
    if (promptId && !UUID_RE.test(promptId)) return NextResponse.json({ jobs: [] });
    let list = db.from("video_jobs").select(VIEW_COLUMNS).eq("user_id", me).order("created_at", { ascending: false }).limit(30);
    if (promptId) list = list.eq("prompt_id", promptId);
    const { data, error } = await list;
    if (error?.code === "PGRST205" || error?.code === "42P01") return NextResponse.json({ jobs: [], run: JOBS_SQL });
    if (error) throw error;
    return NextResponse.json({ jobs: (data ?? []).map(jobView) });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[video] jobs read failed");
    return say("Could not read your videos", 500);
  }
}
