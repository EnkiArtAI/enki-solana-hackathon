import type { SupabaseClient } from "@supabase/supabase-js";
import { storeGeneratedImage } from "@/lib/generation/derivative-store";
import { encryptString } from "@/lib/crypto";
import { isDbUnreachable } from "@/lib/db-error";
import { classifyFailure } from "@/lib/generation/provider-health";
import { autoTitle } from "@/lib/generation/auto-title";
import type { ResolvedModel, Route } from "@/lib/generation/models";
import type { StoredReference } from "@/lib/generation/reference-images";
import type { VideoRenditions } from "@/lib/video/renditions";

/**
 * Write down what produced an image, in enough detail to run it again.
 *
 * Nothing recorded a generation before this. `POST /api/generations` inserted
 * columns that do not exist (final_prompt, status, image_urls, payment_verified)
 * and its six callers wrapped the failure in `catch { /* ignore *\/ }`, so the
 * table stayed empty and every generation vanished the moment the tab closed.
 *
 * ── The two honest limits ───────────────────────────────────────────────
 * A faithful record is not byte-identical replay, and the gap is stated rather
 * than papered over:
 *
 *   1. No provider we use exposes a seed except Pollinations, which generates
 *      one and discards it. `seed` is NULL for Gemini and WaveSpeed, and NULL
 *      here means "not reproducible", not "not recorded".
 *   2. effectivePrompt (the text that actually reached the model) is stored
 *      separately from what the user typed, and it is what a replay must send.
 *
 * So the button this feeds should say "Re-run", not "Reproduce".
 */

export interface GenerationRecord {
  userId: string;
  /** The marketplace prompt used, or null for a free-form editor generation. */
  promptId: string | null;
  /** After variable substitution, before the rewrite. */
  finalPrompt: string;
  /** What actually reached the image model. */
  effectivePrompt: string;
  variableValues: unknown;
  model: ResolvedModel;
  /** 18+: from the prompt check or the prompt's own mark. Shown to other people only when they opted in. */
  adult?: boolean;
  route: Route;
  boost: boolean;
  aspectRatio: string | null;
  resolution: string | null;
  seed: number | null;
  /** Measured from the returned bytes — never echoed from the request. */
  output: { width: number; height: number; bytes: number; format: string } | null;
  /**
   * Where the image ended up. Written into generated_images, which is what the
   * gallery reads — without it a paid image exists in blob storage and in
   * generations, and the user can never find it again.
   */
  imageUrl?: string | null;
  previewUrl?: string | null;
  thumbnailUrl?: string | null;
  mimeType?: string | null;
  generationMs: number | null;
  /** The editor node graph — structure only, no image bytes and no text. */
  workflow: Record<string, unknown> | null;
  /**
   * The strings pulled out of that graph. Encrypted here, never stored in the
   * jsonb: the prompt would otherwise sit in clear two columns from
   * final_prompt_ct and make that encryption decoration.
   */
  workflowTexts?: string[];
  /**
   * The images fed in, in prompt order. A null keeps the position — "@Image 2"
   * has to keep meaning the second one even if the second failed to store.
   */
  references?: (StoredReference | null)[];
  transactionHash?: string | null;
  chainKey?: string | null;
  amountPaidCents?: number | null;
  /** What the buyer paid, exact, in micro-USDC (Kev, 2026-10-18); amountPaidCents rounds 7,560 micro to 1 cent. */
  amountPaidMicro?: number | null;
  /** The generation_payment_intents row this was bought with; null for free generations. */
  paymentIntentId?: string | null;
  /** Which way the render came (Kev, 2026-10-14: the share of agents, e-mail and wallet customers). */
  rail: GenerationRail;
  /** A video's files (lib/video/jobs): imageUrl is its v720, previewUrl and thumbnailUrl its poster, and every picture surface reads those. */
  video?: VideoRenditions;
  durationMs?: number | null;
}

export type GenerationRail = "web" | "free" | "x402" | "mcp";

/**
 * What recordGeneration hands back: the generations row always (when
 * anything was written at all), the generated_images row's id only when that
 * second insert also landed. A route that needs to answer with "imageId"
 * reads this, not the bare string the old contract returned — checked
 * against every caller (generate-image, generate-free) before this changed:
 * both call recordGeneration from inside a floating/after() promise and read
 * nothing back, so widening the return shape breaks neither.
 */
export interface RecordedGeneration {
  generationId: string;
  imageId: string | null;
}

/** Paid escrow can be delivered only after its accepted image row exists. */
export class GenerationRecordError extends Error {
  /** Which step refused, for the server log and generation_failures; never shown to the user. */
  constructor(readonly reason: string) { super("The generated image could not be saved. Please check your image history before trying again."); }
}

export interface GenerationRecordOptions {
  requireAcceptedImage?: boolean;
}

/** Optional input history never decides whether a generated image was delivered. */
export async function recordGenerationReferences(
  supabase: SupabaseClient,
  generationId: string,
  references: (StoredReference | null)[],
): Promise<void> {
  const rows = references
    .map((ref, i) => (ref ? { ...ref, sequence_index: i } : null))
    .filter((r): r is StoredReference & { sequence_index: number } => r !== null);
  if (!rows.length) return;
  const { error } = await supabase.from("generation_reference_images").insert(
    rows.map((r) => ({
      generation_id: generationId, sequence_index: r.sequence_index,
      storage_url: r.url, mime_type: r.mimeType, bytes: r.bytes, content_hash: r.contentHash,
    })),
  );
  if (error) console.warn("[generation] could not record references:", error.message);
}

/** Optional WebP previews can arrive after the original image is delivered. */
export async function recordGenerationRenditions(
  supabase: SupabaseClient, generationId: string, userId: string, imageUrl: string, deadline: number,
): Promise<void> {
  const stored = await storeGeneratedImage(imageUrl, userId, deadline);
  const updates = {
    ...(stored.previewUrl ? { preview_url: stored.previewUrl } : {}),
    ...(stored.thumbnailUrl ? { thumbnail_url: stored.thumbnailUrl } : {}),
  };
  if (!Object.keys(updates).length) return;
  const { error } = await supabase.from("generated_images").update(updates)
    .eq("generation_id", generationId).eq("user_id", userId);
  if (error) throw new GenerationRecordError(`generated_images update: ${error.code ?? ""} ${error.message}`);
}

/** Encrypt into the four columns this schema uses everywhere. */
function envelope(prefix: string, plaintext: string): Record<string, string> {
  const p = encryptString(plaintext);
  return {
    [`${prefix}_ct`]: p.encrypted,
    [`${prefix}_iv`]: p.iv,
    [`${prefix}_tag`]: p.authTag,
    [`${prefix}_kid`]: p.kid ?? "field-v1",
  };
}

/**
 * A free-form generation still needs a prompt row, because generations.prompt_id
 * is NOT NULL — and that constraint is right: it is what keeps every image
 * traceable to an author, which is what artist payouts rest on.
 *
 * The user wrote the prompt, so they get a prompt row of their own, private.
 * Publishing later is then a visibility change on something that already
 * exists, rather than a second code path that has to reconstruct it.
 */
async function ensurePromptRow(
  supabase: SupabaseClient,
  userId: string,
  prompt: string,
  model: ResolvedModel,
  adult = false,
  video = false,
): Promise<string | null> {
  // The prompts table predates the `_ct` convention: its ciphertext column is
  // plain `encrypted_content`, while iv/tag/kid carry the prefix. Probed live
  // 2026-08-08 — encrypted_content_ct is 400, encrypted_content is 200. The
  // envelope spread wrote the former, so every free-form generation's prompt
  // row failed with PGRST204 and recordGeneration bailed before writing
  // anything at all.
  const sealed = envelope("encrypted_content", prompt);
  sealed.encrypted_content = sealed.encrypted_content_ct;
  delete sealed.encrypted_content_ct;

  const { data, error } = await supabase
    .from("prompts")
    .insert({
      creator_id: userId,
      title: autoTitle(),
      tags: [],
      ...sealed,
      ai_model: model.name,
      ai_settings: {},
      // Private until the author releases it. Generating is not publishing.
      is_listed: false,
      listing_status: "draft",
      price_usd_cents: 0,
      is_adult: adult,
      ...(video ? { media_type: "video" } : {}),
    })
    .select("id")
    .single();
  if (error) {
    console.warn("[generation] could not create the prompt row:", error.message);
    return null;
  }
  return data?.id ?? null;
}

/** Whether this record carries real money — gates the admin alert below. */
function isPaid(rec: GenerationRecord): boolean {
  return rec.paymentIntentId != null || rec.amountPaidCents != null;
}

/**
 * Losing a free generation's record is a shrug — console.warn and move on,
 * as this always has. Losing a PAID one is a different severity: the buyer
 * was charged, the image was handed over, and now nothing says so. The image
 * is never withheld for it (that is decided before this is ever called), but
 * someone has to go reconcile the row by hand, and a warning only this
 * process ever sees is not how they find out.
 */
async function alertLostRecording(supabase: SupabaseClient, rec: GenerationRecord, reason: string): Promise<void> {
  console.error("[generation] PAID generation recording problem:", {
    userId: rec.userId,
    paymentIntentId: rec.paymentIntentId ?? null,
    reason,
  });
  const { notifyAdmins } = await import("@/lib/admin-notify");
  await notifyAdmins(supabase, {
    subject: "Paid generation not recorded",
    text:
      `A paid generation for user ${rec.userId} (payment intent ${rec.paymentIntentId ?? "unknown"}) ` +
      `was delivered to the buyer, but ${reason}. The image was NOT lost — it was already returned ` +
      `to the payer — but its generations/generated_images row is missing or incomplete and needs a ` +
      `manual look.`,
  }).catch((e) => console.error("[generation] admin alert failed:", e instanceof Error ? e.message : e));
}

/**
 * Best-effort by design: losing the record must never lose the user their
 * image. Returns the generations row id and, when that second insert also
 * landed, the generated_images row id a caller can answer with as imageId —
 * null when nothing could be written at all.
 */
export async function recordGeneration(
  supabase: SupabaseClient,
  rec: GenerationRecord,
  options: GenerationRecordOptions = {},
): Promise<RecordedGeneration | null> {
  try {
    if (options.requireAcceptedImage) {
      // The paid route supplies the URL returned by putDurably. Inline bytes
      // or a missing image cannot become the durable billing record.
      if (!rec.imageUrl || new URL(rec.imageUrl).protocol !== "https:") throw new GenerationRecordError("image url is not https");
    }
    const promptId =
      rec.promptId ?? (await ensurePromptRow(supabase, rec.userId, rec.finalPrompt, rec.model, rec.adult === true, Boolean(rec.video)));
    if (!promptId) {
      if (options.requireAcceptedImage) throw new GenerationRecordError("no prompt row");
      if (isPaid(rec)) await alertLostRecording(supabase, rec, "no prompt row could be created for it");
      return null;
    }

    const { data, error } = await supabase
      .from("generations")
      .insert({
        user_id: rec.userId,
        prompt_id: promptId,
        ...envelope("final_prompt", rec.finalPrompt),
        ...envelope("effective_prompt", rec.effectivePrompt),
        ...envelope("variable_values", JSON.stringify(rec.variableValues ?? {})),
        model_id: rec.model.id,
        provider: rec.route.provider,
        provider_model: rec.route.providerModel,
        boost: rec.boost,
        aspect_ratio: rec.aspectRatio,
        resolution: rec.resolution,
        seed: rec.seed,
        output_width: rec.output?.width ?? null,
        output_height: rec.output?.height ?? null,
        output_bytes: rec.output?.bytes ?? null,
        output_format: rec.output?.format ?? null,
        generation_ms: rec.generationMs,
        workflow: rec.workflow,
        ...(rec.workflowTexts?.length
          ? envelope("workflow_text", JSON.stringify(rec.workflowTexts))
          : {}),
        transaction_hash: rec.transactionHash ?? null,
        chain_key: rec.chainKey ?? null,
        amount_paid_cents: rec.amountPaidCents ?? null,
        // Only a paid render names the column, so a free one records as before.
        ...(rec.amountPaidMicro != null ? { amount_paid_micro: rec.amountPaidMicro } : {}),
        payment_intent_id: rec.paymentIntentId ?? null,
        rail: rec.rail,
      })
      .select("id")
      .single();

    if (error) {
      if (options.requireAcceptedImage) throw new GenerationRecordError(`generations insert: ${error.code ?? ""} ${error.message}`);
      console.warn("[generation] could not record:", error.message);
      if (isPaid(rec)) await alertLostRecording(supabase, rec, "the generations insert failed");
      return null;
    }
    const generationId = data?.id as string | undefined;
    if (!generationId) {
      if (options.requireAcceptedImage) throw new GenerationRecordError("generations insert returned no id");
      return null;
    }

    // The inputs, in prompt order — "@Image 2" refers to sequence_index 1, so
    // the index comes from the ORIGINAL position and never from a filtered
    // array. A reference that failed to store simply has no row.
    await recordGenerationReferences(supabase, generationId, rec.references ?? []);

    // The image itself. generations records what PRODUCED it; generated_images
    // is what the gallery reads, and nothing was ever writing a row there for a
    // generation — so a delivered image was invisible to its owner. "Ordered
    // means delivered" (Kev, 2026-08-06) is a durability requirement, and this
    // is where it is met. Its id is also what a caller answers "imageId" with
    // (REC-1) — selected back below, never derived from anything else.
    let imageId: string | null = null;
    if (rec.imageUrl) {
      /* Our copy + WebP renditions. Token-graceful (no BLOB token = the
         provider URL passes through) and never throwing — the paid image
         always lands in the row, optimised or not. A caller that passes
         previewUrl, even null, stored the image itself: storing it again
         here would be unbounded work in after(). */
      const stored = rec.previewUrl !== undefined
        ? { imageUrl: rec.imageUrl, previewUrl: rec.previewUrl, thumbnailUrl: rec.thumbnailUrl ?? null }
        : await storeGeneratedImage(rec.imageUrl, rec.userId);
      const { data: imgRow, error: imgErr } = await supabase
        .from("generated_images")
        .insert({
          user_id: rec.userId,
          generation_id: generationId,
          prompt_id: promptId,
          sequence_index: 0,
          storage_provider: rec.video ? "supabase" : "vercel_blob",
          storage_url: stored.imageUrl,
          preview_url: stored.previewUrl,
          thumbnail_url: stored.thumbnailUrl,
          width: rec.output?.width ?? null,
          height: rec.output?.height ?? null,
          file_size_bytes: rec.output?.bytes ?? null,
          mime_type: rec.mimeType ?? (rec.output?.format ? `image/${rec.output.format}` : "image/png"),
          // Generated, not uploaded — the flag the gallery filters on, and the
          // one chk_upload_consistency checks against generation_id.
          is_uploaded: false,
          is_adult: rec.adult === true,
          is_watermarked: false,
          visibility: "private",
          accepted: true,
          // Only a video names these, so an image records as before (SQL 52, 60).
          ...(rec.video ? { video: rec.video, duration_ms: rec.durationMs ?? null, view_url: rec.previewUrl, tiny_url: rec.thumbnailUrl } : {}),
        })
        .select("id")
        .single();
      if (imgErr) {
        if (options.requireAcceptedImage) throw new GenerationRecordError(`generated_images insert: ${imgErr.code ?? ""} ${imgErr.message}`);
        // The generations row above is real and stays: the caller still gets
        // a generationId. What it loses is imageId — the gallery/share-preview
        // row simply does not exist for this one.
        console.warn("[generation] could not record the image:", imgErr.message);
        if (isPaid(rec)) await alertLostRecording(supabase, rec, "the generated_images insert failed (the generation row was written; the gallery row was not)");
      } else {
        imageId = (imgRow?.id as string | undefined) ?? null;
      }
    }

    return { generationId, imageId };
  } catch (e) {
    if (options.requireAcceptedImage) throw e instanceof GenerationRecordError ? e : new GenerationRecordError(`record failed: ${e instanceof Error ? e.message : String(e)}`);
    console.warn("[generation] record failed:", e instanceof Error ? e.message : e);
    if (isPaid(rec)) await alertLostRecording(supabase, rec, "recording threw an exception").catch(() => {});
    return null;
  }
}

/**
 * Whose generation this is, resolved server-side.
 *
 * From the session token, never from a body field: PR #54 keyed enforcement on
 * a client-supplied wallet, which let anyone write rows under someone else's
 * name. A generation with no session is simply not recorded — an unattributed
 * row would be worse than none, because it cannot be shown back to anyone.
 */
export async function resolveRecordingUserId(
  supabase: SupabaseClient | null,
  request: { headers: { get(name: string): string | null } },
): Promise<string | null> {
  if (!supabase) return null;
  const token = request.headers.get("X-Session-Token");
  if (!token) return null;
  const { resolveSessionUserId } = await import("@/lib/session-user");
  // An unreachable database reaches the caller (503), it is not "nobody".
  return resolveSessionUserId(supabase, token).catch((e) => {
    if (isDbUnreachable(e)) throw e;
    return null;
  });
}

/**
 * The account a paying wallet's renders are recorded under (Kev, 2026-10-14:
 * agents are full accounts, not shadows): the account the wallet is linked
 * to when a brand registered it as its agent (linked_wallets, signed by the
 * wallet itself), else the wallet's own account, made here at its first paid
 * render. The transaction it signed to pay is the same proof a wallet login
 * gives, and the rows are the ones a login makes, so a later sign-in with
 * that wallet finds its own history. A failed lookup is not "no account":
 * nothing is minted on a read that did not answer (a founder's wallet,
 * 2026-10-07). Null means the render is delivered unrecorded.
 */
export async function userIdForPayer(supabase: SupabaseClient | null, address: string): Promise<string | null> {
  if (!supabase || !address) return null;
  const linked = await supabase.from("linked_wallets").select("user_id").eq("address", address).maybeSingle();
  if (linked.data?.user_id) return String(linked.data.user_id);
  // Case-insensitive like the login: a legacy row lowercased its Solana address.
  const own = await supabase.from("user_wallets").select("user_id").ilike("address", address).is("removed_at", null).maybeSingle();
  if (own.data?.user_id) return String(own.data.user_id);
  if (linked.error || own.error) {
    console.warn("[generation] payer lookup failed:", (linked.error ?? own.error)?.message);
    return null;
  }
  const made = await supabase.from("users").insert({ origin: "agent" }).select("id").single();
  if (made.error || !made.data?.id) {
    console.warn("[generation] could not make the payer's account:", made.error?.message);
    return null;
  }
  const userId = String(made.data.id);
  const { error: walletError } = await supabase.from("user_wallets")
    .insert({ user_id: userId, address, chain_family: "solana", wallet_type: "external_eoa", is_primary: true });
  if (!walletError) return userId;
  // Two first renders of one wallet at once, or the address was taken meanwhile: the orphan goes, the row that won is the account.
  await supabase.from("users").delete().eq("id", userId);
  if (walletError.code === "23505") {
    const again = await supabase.from("user_wallets").select("user_id").ilike("address", address).is("removed_at", null).maybeSingle();
    return again.data?.user_id ? String(again.data.user_id) : null;
  }
  console.warn("[generation] could not keep the payer's wallet:", walletError.message);
  return null;
}

/**
 * userIdForPayer, asked again when it answered nothing (ENG-07): a lookup that
 * did not answer returns null, and a blip used to leave a paid render with no
 * record at all. Three tries, two seconds apart.
 */
export async function payerAccount(
  supabase: SupabaseClient | null,
  address: string,
  { tries = 3, gapMs = 2_000 }: { tries?: number; gapMs?: number } = {},
): Promise<string | null> {
  if (!supabase || !address) return null;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, gapMs));
    const userId = await userIdForPayer(supabase, address);
    if (userId) return userId;
  }
  return null;
}

/**
 * The gallery row's id when the record lands within `ms`, else null (REC-1):
 * a route answers with it when it can and never waits longer for it. The
 * caller hands the same recording to after(), so a slow one still lands.
 */
export async function imageIdWithin(recording: Promise<RecordedGeneration | null>, ms = 5_000): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((done) => { timer = setTimeout(() => done(null), ms); });
  try {
    return (await Promise.race([recording.catch(() => null), late]))?.imageId ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** What a failed generation asked for, so an admin can see what broke for whom (Kev, 2026-10-03). */
export interface GenerationFailure {
  request: { headers: { get(name: string): string | null } };
  surface: "generate-image" | "generate-free" | "x402-generate";
  modelId: string | null;
  resolution: string | null;
  quality: string | null;
  boost: boolean;
  aspectRatio: string | null;
  referenceImageCount: number;
  /** The prompt as the user wrote it; for an artist's prompt only the buyer's values; null for an artist's draft. Stored encrypted. */
  prompt: string | null;
  error: string;
  imageUrl?: string | null;
  intentId?: string | null;
  txSignature?: string | null;
  /** What a settled x402 payment carried, exact, in micro-USDC: the amount a refund returns (Kev, 2026-10-18). */
  amountPaidMicro?: number | null;
}

/**
 * A provider's own error words, as a failure records and logs them. They can repeat the request, so for a render that
 * carries an artist's text (a marketplace prompt, a draft) only their class is kept: staff read failures, and the
 * artist's words are no one else's (ENC review, 2026-10-27).
 */
export const providerFailure = (error: string, artistText: boolean): string =>
  artistText ? `provider: ${classifyFailure(error).kind}` : error;

/**
 * The other half of recordGeneration: a generation that was accepted and then
 * broke. Called from after(), and a failure to record never changes what the
 * user saw.
 */
export async function recordGenerationFailure(supabase: SupabaseClient | null, f: GenerationFailure): Promise<void> {
  if (!supabase) return;
  try {
    const userId = await resolveRecordingUserId(supabase, f.request);
    const { getClientIp, hashIp } = await import("@/lib/ip-hash");
    const { error } = await supabase.from("generation_failures").insert({
      user_id: userId,
      ip_hash: hashIp(getClientIp(f.request)),
      surface: f.surface,
      model_id: f.modelId,
      resolution: f.resolution,
      quality: f.quality,
      boost: f.boost,
      aspect_ratio: f.aspectRatio,
      reference_image_count: f.referenceImageCount,
      error: f.error.slice(0, 1000),
      ...(f.prompt === null ? {} : envelope("prompt", f.prompt.slice(0, 4000))),
      image_url: f.imageUrl ?? null,
      intent_id: f.intentId ?? null,
      tx_signature: f.txSignature ?? null,
      // Only a paid failure names the column, so every other rail records as before.
      ...(f.amountPaidMicro != null ? { amount_paid_micro: f.amountPaidMicro } : {}),
    });
    // Best effort, but never silent: a missing table or a bad value would
    // otherwise lose every row without a trace.
    if (error) console.warn("[generation-failures] not recorded:", error.message);
  } catch {
    /* recording is best-effort by design */
  }
}
