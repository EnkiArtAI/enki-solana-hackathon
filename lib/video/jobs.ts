import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyAdmins } from "@/lib/admin-notify";
import { decryptString } from "@/lib/crypto";
import { recordGeneration } from "@/lib/generation/record";
import type { Provider, ResolvedModel } from "@/lib/generation/models";
import { loadPromptText } from "@/lib/generation/prompt-text";
import { recordImageCase } from "@/lib/moderation/image-case";
import { checkImageBytes, heldBack, NOT_AN_IMAGE } from "@/lib/moderation/image-check-bytes";
import { checkDown } from "@/lib/moderation/prompt-check";
import { showsHiddenText } from "@/lib/moderation/hidden-text";
import { letteringReleased, refusePrompt } from "@/lib/moderation/prompt-pause";
import { bookingState, type VoidReason } from "@/lib/payments/authorization";
import { captureHeld, voidAndFlush } from "@/lib/payments/settle";
import { solanaChainKey } from "@/lib/payments/solana";
import { VIDEO_ADAPTERS } from "./adapters";
import type { VideoJobWhy } from "./job-view";
import { JOBS_SQL, RUNNING } from "./ready";
import { videoRenditions } from "./renditions";
import { removeStored, storeVideo, type StoredVideo } from "./store";
import { removeTranscoded, transcode, type SourceInfo } from "./transcode";
import { modelOf } from "./models";

/**
 * The cron's minute (/api/cron/video-jobs): every job under way is asked about, and one the operator has finished goes through
 * transcode, the frames' check, storage, the capture and the record, in that order: nothing is captured until the output is
 * stored and its frames passed (Kev, 2026-08-06: "once the image goes through, we will receive the money"). Failure voids the
 * held payment, nothing was charged; a buyer's own landed broadcast is booked owed by the void. Enki carries the provider's bill
 * for what it then refuses, as with images. Submit is the POST route's and happens once: a job dead in "submitting" is failed
 * and voided, never resubmitted (Wan's docs: "Do not create duplicate tasks").
 */

/** A lease outlives the function that holds it (maxDuration 800). */
const LEASE_MS = 900_000;
/** A transcode starts only with this much of the function left: 73 s for 30 s of 1080p on one desktop thread, the vCPU unmeasured. */
export const TRANSCODE_MIN_LEFT_MS = 500_000;
/** The POST route answers well inside this. */
const SUBMIT_DEAD_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 3;
/** Past this no new work starts for a job: failed and voided. */
export const GIVE_UP_MS = 40 * 60_000;
/** hold_until, from the claim. Past giving up by one lease, so a transcode started in the job's last minute can still capture. */
export const HOLD_MS = GIVE_UP_MS + LEASE_MS;

export const VIDEO_SURFACE = "generate-video";

const COLUMNS = "id, user_id, intent_id, prompt_id, model_id, operator, provider_model, provider_task_id, settings, words_ct, words_iv, words_tag, words_kid, status, attempt_count, locked_until, video, generated_image_id, provider_usage, created_at";

export interface JobRow {
  id: string; user_id: string; intent_id: string; prompt_id: string | null; model_id: string; operator: string; provider_model: string; provider_task_id: string | null;
  settings: { modelId: string; seconds: number; aspect: string; resolution: string; audio: boolean; bitrate: "high" | "standard"; adult?: boolean; fromArtist?: boolean };
  words_ct: string | null; words_iv: string | null; words_tag: string | null; words_kid: string | null;
  status: string; attempt_count: number; locked_until: string | null; video: StoredVideo | null; generated_image_id: string | null; provider_usage: unknown; created_at: string;
}

type Ctx = { db: SupabaseClient; request: { headers: { get(name: string): string | null } }; deadlineAt: number };

const aadOf = (jobId: string) => `video-job:${jobId}`;

const release = (db: SupabaseClient, job: JobRow, patch: Record<string, unknown> = {}) =>
  db.from("video_jobs").update({ locked_until: null, updated_at: new Date().toISOString(), ...patch }).eq("id", job.id);

const finish = (db: SupabaseClient, job: JobRow, status: "delivered" | "failed" | "refused", patch: Record<string, unknown> = {}) => {
  const now = new Date().toISOString();
  return release(db, job, { status, finished_at: now, updated_at: now, ...patch });
};

/** The job ends without a video. Its stored files come down, its payment is voided; a broadcast of the buyer's that landed reads as owed. */
async function close(ctx: Ctx, job: JobRow, how: { status: "failed" | "refused"; why: VideoJobWhy; reason?: VoidReason; code?: string | null }) {
  const { db } = ctx;
  if (job.video) await removeStored(db, job.video.paths ?? []);
  if (how.reason) await voidAndFlush(db, job.intent_id, how.reason).catch((e: unknown) => console.error("[video] void pending", job.intent_id, e instanceof Error ? e.name : e));
  const booked = how.reason ? await bookingState(db, job.intent_id).catch(() => null) : null;
  await finish(db, job, how.status, { error_class: booked === "owed" ? "owed" : how.why, ...(how.code ? { provider_code: how.code } : {}) });
}

/** The frames' verdict: null to go on; the job is closed otherwise. A child-safety frame becomes a case in this same minute. */
async function framesRefused(ctx: Ctx, job: JobRow, frames: Buffer[]): Promise<{ adult: boolean } | null> {
  const { db, request, deadlineAt } = ctx;
  const signal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
  const seen = await Promise.all(frames.map((f) => checkImageBytes(f, { signal })));
  for (const [i, v] of seen.entries()) {
    if (v.verdict === "child_safety") {
      await recordImageCase(db, { surface: VIDEO_SURFACE, request, bytes: frames[i], scores: v.scores, about: "", promptId: job.prompt_id ?? undefined, account: job.user_id });
    }
  }
  const held = seen.find(heldBack);
  if (held) {
    const unreadable = held.verdict === "blocked" && (held.reason === NOT_AN_IMAGE || held.reason === "unreadable");
    const down = held.verdict === "unavailable" && checkDown(held.reason);
    await close(ctx, job, seen.some((v) => v.verdict === "blocked" || v.verdict === "child_safety") && !unreadable
      ? { status: "refused", why: "image_check", reason: "rejected" }
      : unreadable ? { status: "failed", why: "failed", reason: "provider_failed" }
      : { status: "failed", why: "unchecked", reason: down ? "provider_failed" : "rejected" });
    return null;
  }
  // The artist's words read off a frame, as on an image: whose doing it is cannot be told, so the unit is Enki's and no one is struck.
  if (job.settings.fromArtist && job.prompt_id) {
    const text = await loadPromptText(db, job.prompt_id);
    if (text.ok && seen.some((v) => v.text && showsHiddenText(v.text, text.text))) {
      const { data: owner } = await db.from("prompts").select("creator_id").eq("id", job.prompt_id).maybeSingle();
      if (owner?.creator_id !== job.user_id && !(await letteringReleased(db, job.prompt_id))) {
        await refusePrompt(db, { promptId: job.prompt_id, cause: "render", detail: "hidden text", buyerUserId: job.user_id });
        await close(ctx, job, { status: "failed", why: "failed", reason: "provider_failed" });
        return null;
      }
    }
  }
  return { adult: seen.some((v) => v.verdict === "adult") };
}

/** Booked and paid: its row in generations and generated_images, then delivered. A record that fails alerts the admins (recordGeneration, or the catch here), and the job still hands over its files. */
async function deliver(ctx: Ctx, job: JobRow, files: StoredVideo, signature: string | null, totalMicro: number) {
  const { db } = ctx;
  let imageId = job.generated_image_id;
  // Captured: nothing past this point may keep the buyer from the video. A throw here came back every minute, for ever, charged and undelivered.
  if (!imageId) try {
    const sealed = job.words_ct ? decryptString({ encrypted: job.words_ct, iv: String(job.words_iv), authTag: String(job.words_tag), kid: job.words_kid ?? undefined }, aadOf(job.id)) : "{}";
    const { words = "", values = {} } = JSON.parse(sealed) as { words?: string; values?: unknown };
    const route = { provider: "video" as Provider, providerModel: job.provider_model };
    const model = { id: job.model_id, name: modelOf(job.settings.modelId).label, normal: route, boost: route, allowedRatios: [], maxRefs: 0 } as unknown as ResolvedModel;
    const recorded = await recordGeneration(db, {
      adult: job.settings.adult === true, userId: job.user_id, promptId: job.prompt_id, finalPrompt: words, effectivePrompt: words, variableValues: values,
      model, route, boost: false, aspectRatio: job.settings.aspect, resolution: job.settings.resolution, seed: null,
      output: { width: files.width ?? 0, height: files.height ?? 0, bytes: files.v720Bytes ?? 0, format: "mp4" },
      imageUrl: files.v720, previewUrl: files.poster, thumbnailUrl: files.poster, mimeType: "video/mp4",
      generationMs: null, workflow: null, chainKey: solanaChainKey(), transactionHash: signature,
      amountPaidCents: Math.round(totalMicro / 10_000), amountPaidMicro: totalMicro, paymentIntentId: job.intent_id, rail: "web",
      video: videoRenditions(files)!, durationMs: files.durationMs,
    });
    imageId = recorded?.imageId ?? null;
  } catch (e) {
    console.error("[video] a delivered job was not recorded:", job.id, e instanceof Error ? e.name : "unknown");
    await notifyAdmins(db, {
      subject: "Paid video not recorded",
      text: `A paid video for user ${job.user_id} (payment intent ${job.intent_id}, job ${job.id}) was captured and delivered, but its record could not be written: its generations and generated_images rows are missing and need a manual look.`,
    }).catch(() => console.error("[video] admin alert failed", job.id));
  }
  await finish(ctx.db, job, "delivered", { generated_image_id: imageId });
}

/**
 * The files are stored: the money decides. Read whole first, because a job can come here again after a crash, and a lease or a
 * void of the sweep's may stand: only a row nobody has touched is captured. An outcome not known yet leaves the job for the next
 * minute, once the sweep has settled the row.
 */
async function settle(ctx: Ctx, job: JobRow, files: StoredVideo) {
  const { db, deadlineAt } = ctx;
  const { data: row, error } = await db.from("generation_payment_intents")
    .select("capture_started_at, captured_at, fulfilled_at, voided_at, total_micro, tx_signature").eq("id", job.intent_id).maybeSingle();
  if (error || !row) return void (await release(db, job));
  const total = Number(row.total_micro);
  if (row.fulfilled_at) return deliver(ctx, job, files, row.tx_signature, total);
  if (row.captured_at) return close(ctx, job, { status: "failed", why: "owed" });
  if (row.voided_at) return close(ctx, job, { status: "failed", why: "failed" });
  if (row.capture_started_at) return void (await release(db, job));

  const cap = await captureHeld(db, job.intent_id, { timeoutMs: 40_000, deadlineAt: Math.min(deadlineAt, Date.now() + 120_000) });
  if (cap.kind === "captured") return deliver(ctx, job, files, cap.signature, total);
  if (cap.kind === "rejected") return close(ctx, job, { status: "failed", why: "payment" });
  await release(db, job);
}

/**
 * Whether the provider sent less than the buyer paid for. Room for its rounding: a tenth of the length or 1 s, whichever is more, and 70% of the
 * resolution's pixels, since a shape moves width and height but hardly their product (21:9 at 480p is 992x432). Longer is no harm, and a file too long to
 * encode ends by MAX_ATTEMPTS. Omni is priced at its ceiling and its words set the length.
 */
function shortOfBought(bought: JobRow["settings"], got: SourceInfo): boolean {
  const seconds = bought.seconds * 1000;
  const lines = parseInt(bought.resolution, 10);
  return (!modelOf(bought.modelId).promptLength && got.durationMs < seconds - Math.max(1000, seconds / 10)) || got.width * got.height < 0.7 * lines * lines * (16 / 9);
}

/** One job's step, under its lease. A throw leaves it for the next minute; its deadline ends it. */
async function step(ctx: Ctx, job: JobRow) {
  const { db, deadlineAt } = ctx;
  if (job.video) return settle(ctx, job, job.video);
  const age = Date.now() - Date.parse(job.created_at);
  if (job.status === "submitting") {
    return age < SUBMIT_DEAD_MS ? void (await release(db, job)) : close(ctx, job, { status: "failed", why: "failed", reason: "provider_failed" });
  }
  const adapter = VIDEO_ADAPTERS[job.operator];
  if (age > GIVE_UP_MS || !adapter || !job.provider_task_id) return close(ctx, job, { status: "failed", why: "failed", reason: "provider_failed" });
  // A key taken out with jobs under way: no call with "Bearer undefined" to a metered host. It waits, for the key or for its deadline.
  if (!adapter.configured()) return void (await release(db, job));

  const answer = await adapter.poll(job.provider_task_id);
  if (answer.state === "running") return void (await release(db, job));
  if (answer.state === "failed") {
    return answer.kind === "other"
      ? close(ctx, job, { status: "failed", why: "failed", reason: "provider_failed", code: answer.code })
      : close(ctx, job, { status: "refused", why: answer.kind, reason: "rejected", code: answer.code });
  }

  // Enough of the function left, or the next minute's run takes it. Attempts count transcodes begun, so a poison file ends.
  if (deadlineAt - Date.now() < TRANSCODE_MIN_LEFT_MS) return void (await release(db, job));
  if (job.attempt_count >= MAX_ATTEMPTS) return close(ctx, job, { status: "failed", why: "failed", reason: "provider_failed" });
  await db.from("video_jobs").update({ status: "transcoding", attempt_count: job.attempt_count + 1, provider_usage: answer.usage ?? null, updated_at: new Date().toISOString() }).eq("id", job.id);

  const made = await transcode(answer.url, { bitrate: job.settings.bitrate, signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())) });
  try {
    // Before the money and before a paid check: the chip priced these seconds and this size.
    if (shortOfBought(job.settings, made.info)) return await close(ctx, job, { status: "failed", why: "failed", reason: "provider_failed", code: "short_output" });
    const passed = await framesRefused(ctx, job, made.frames);
    if (!passed) return;
    if (passed.adult) job.settings.adult = true;
    const files = await storeVideo(db, job.user_id, made);
    // Kept before the money moves: a crash after the capture still has what it paid for.
    const { error } = await db.from("video_jobs").update({ video: files, settings: job.settings, updated_at: new Date().toISOString() }).eq("id", job.id);
    if (error) {
      await removeStored(db, files.paths);
      throw new Error(`[video] the files could not be noted: ${error.code ?? ""}`);
    }
    await settle(ctx, { ...job, video: files }, files);
  } finally {
    await removeTranscoded(made.dir);
  }
}

/**
 * Every job due, each under a lease a conditional update hands to one run, so overlapping runs share work and never repeat it.
 * Nothing due: one read, and out. Before SQL 69 it says which file; nothing can be under way then.
 */
export async function runVideoJobs(db: SupabaseClient, { request, deadlineAt }: Omit<Ctx, "db">): Promise<{ due: number; delivered: number; run?: string }> {
  const now = new Date().toISOString();
  const { data, error } = await db.from("video_jobs").select(COLUMNS).in("status", RUNNING).or(`locked_until.is.null,locked_until.lt.${now}`).order("created_at").limit(50);
  if (error?.code === "PGRST205" || error?.code === "42P01") return { due: 0, delivered: 0, run: JOBS_SQL };
  if (error) throw error;
  const ctx: Ctx = { db, request, deadlineAt };
  let delivered = 0;
  for (const { id } of (data ?? []) as unknown as JobRow[]) {
    if (deadlineAt - Date.now() < 30_000) break;
    // The row as it is now, handed back by the lease: this list can be minutes old, and a job read as submitting may hold a live task by now.
    const { data: leased } = await db.from("video_jobs").update({ locked_until: new Date(Date.now() + LEASE_MS).toISOString() })
      .eq("id", id).in("status", RUNNING).or(`locked_until.is.null,locked_until.lt.${now}`).select(COLUMNS).maybeSingle();
    if (!leased) continue;
    const job = leased as unknown as JobRow;
    try {
      await step(ctx, job);
      const { data: after } = await db.from("video_jobs").select("status").eq("id", job.id).maybeSingle();
      if (after?.status === "delivered") delivered++;
    } catch (e) {
      // No words of a provider's or a path's: its class.
      console.error("[video] job step failed, next minute asks again:", job.id, e instanceof Error ? e.message.slice(0, 120) : "unknown");
      await release(db, job).then(undefined, () => undefined);
    }
  }
  return { due: data?.length ?? 0, delivered };
}

export const VIDEO_JOB_AAD = aadOf;
