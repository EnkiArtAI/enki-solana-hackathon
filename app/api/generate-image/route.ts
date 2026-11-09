import { NextRequest, NextResponse, after } from "next/server";
import { isDbUnreachable, dbUnavailableResponse, refusalBody as baseRefusalBody } from "@/lib/db-error";
import { generateImagesWithWaveSpeed } from "@/backend/services/wavespeed-image-generation";
import { generateImagesWithOpenAI } from "@/backend/services/openai-image-generation";
import { resolveOwnerIds } from "@/lib/session-user";
import { generateImagesWithGemini, readImageDimensions } from "@/backend/services/gemini-image-generation";
import { PROMPT_MAX } from "@/lib/generation/prompt-limits";
import type { ImageGenerationRequest } from "@/backend/services/types";
import { referenceImageCount } from "@/lib/generation/provider-capabilities";
import { getSupabaseServerClient, getSupabaseServerClientSafe } from "@/lib/supabaseServer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authRefusal, requireAuth, checkRateLimit } from "@/lib/auth";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { moderate, screenFirst, CLIENT_BLOCK_MESSAGE } from "@/lib/moderation";
import { resolveModel, chooseRoute } from "@/lib/generation/models";
import { normalizeTier, clampTier } from "@/lib/generation/resolution";
import { effectiveQuality } from "@/lib/pricing";
import { observePrice } from "@/lib/generation/price-cells";
import { toModelFamily } from "@/lib/generation/model-family";
import { JUDGE_CALL_MICRO, releaseSpend, reserveSpend } from "@/lib/generation/spend-cap";
import {
  claimGenerationEscrowUnit, deliverGenerationEscrowUnit, escrowUnitSpent, ESCROW_UNIT_CONFLICT, failGenerationEscrowUnit,
  type GenerationEscrowUnitClaim,
} from "@/lib/payments/escrow/server-claims";
import { escrowServerChain, EscrowPaymentError } from "@/lib/payments/escrow/server-chain";
import { claimForGeneration, claimRefusal, type ClaimRow } from "@/lib/payments/generation-claim";
import { captureHeld, settleVoided, voidAndFlush } from "@/lib/payments/settle";
import { bookingState, voidAuthorization } from "@/lib/payments/authorization";
import { buyerCovers } from "@/lib/payments/authorize-flow";
import { paymentRail, railOf, type PaymentRail } from "@/lib/payments/rail";
import { solanaChainKey, solanaConnection } from "@/lib/payments/solana";
import { advanceGenerationEscrow } from "@/lib/payments/escrow/server-lifecycle";
import { settingMismatch, type StoredSettings } from "@/lib/payments/generation-settings";
import { buyersOwn, loadPromptText, fillVariables, inputsUnmatched, neutralFill, overLong, VALUE_MAX, shortestValue, shortestWebFill, type StoredVariable } from "@/lib/generation/prompt-text";
import { checkDown, checkPrompt, NOT_CHECKED, textValues, unnamedValues } from "@/lib/moderation/prompt-check";
import { recordWarning, warningMessage as baseWarningMessage } from "@/lib/moderation/warnings";
import { ADULT_REFUSAL, adultConfirmed, promptMarkedAdult } from "@/lib/adult-content";
import { showsHiddenText } from "@/lib/moderation/hidden-text";
import { letteringReleased, PROMPT_UNAVAILABLE, refusePrompt } from "@/lib/moderation/prompt-pause";
import { recordExtractionHit, SILENT_FAILURE as baseSilentFailureBody, silentFailure as baseSilentFailure } from "@/lib/moderation/extraction-hits";
import { classifyFailure, mayBeBilled, reportSuccess, reportFailure, providerKeyMissing, PROVIDER_NAME } from "@/lib/generation/provider-health";
import { childSafetyScore, recordModerationEvent } from "@/lib/moderation-enforcement";
import {
  recordGeneration, recordGenerationReferences, recordGenerationRenditions, resolveRecordingUserId,
  recordGenerationFailure, GenerationRecordError, providerFailure, type GenerationFailure,
} from "@/lib/generation/record";
import { storeReferenceImages } from "@/lib/generation/reference-images";
import { allowsReferences, REFERENCES_OFF } from "@/lib/prompt-references";
import { putDurably, removeStored, storeDeadline } from "@/lib/generation/derivative-store";
import { checkImageBytes, dataUrlBytes, heldBack, isLink, NOT_AN_IMAGE, providerReference, IMAGE_REFUSED as baseImageRefused, IMAGE_UNCHECKED as baseImageUnchecked, REFERENCE_LINK as baseReferenceLink, REFERENCE_REFUSED as baseReferenceRefused, REFERENCE_UNCHECKED as baseReferenceUnchecked } from "@/lib/moderation/image-check-bytes";
import { recordImageCase } from "@/lib/moderation/image-case";
import { acquireSlot, releaseSlot } from "@/lib/generation/concurrency";
import { stripWorkflowImages } from "@/lib/generation/workflow";

/**
 * The intent rail charges after the image check and before the answer: the
 * render, the store and the check give up this much of the store deadline
 * (285 s, so they end by 230 s) that the capture's send (at most 40 s) plus the
 * nonce close and the lookup after a timeout still fit before
 * CAPTURE_DEADLINE_MS (verification 2026-10-18; 45 s left the close 5 s).
 */
const CAPTURE_RESERVE_MS = 55_000;
/**
 * The capture decides by this point, so its booking, the record and the
 * answer still fit before the platform kills the function at 300 s.
 */
const CAPTURE_DEADLINE_MS = 285_000;

/** The image check's verdicts on bytes that hold no readable still image: what the provider answered, never the request. */
const UNREADABLE_OUTPUT: ReadonlySet<string> = new Set([NOT_AN_IMAGE, "unreadable", "not a still"]);

// A funded escrow can still be awaiting refund. Shared pre-payment copy must not claim it was never paid.
function escrowFailureMessage(message: string) {
  return message.replace(/Nothing was generated and nothing was charged\./gi, "No image was generated. Check your payment status before trying again.")
    .replace(/Nothing was charged\./gi, "Its payment is being reconciled.");
}
/** Escrow's answer to a failure nothing else explains: its deposit may still be awaiting its refund. */
const ESCROW_SILENT_FAILURE = { ...baseSilentFailureBody, error: escrowFailureMessage(baseSilentFailureBody.error) };
/**
 * A refusal's words on a rail: before its capture the intent rail has charged
 * nothing, so "Nothing was charged" stays; escrow's deposit may still be
 * awaiting its refund (round 4 follow-up, 2026-10-19).
 */
function refusalWords(rail: PaymentRail) {
  const say = (message: string) => (rail === "intent" ? message : escrowFailureMessage(message));
  return {
    say,
    IMAGE_REFUSED: say(baseImageRefused), IMAGE_UNCHECKED: say(baseImageUnchecked), REFERENCE_LINK: say(baseReferenceLink),
    REFERENCE_REFUSED: say(baseReferenceRefused), REFERENCE_UNCHECKED: say(baseReferenceUnchecked),
    SILENT_FAILURE: { ...baseSilentFailureBody, error: say(baseSilentFailureBody.error) },
    warningMessage: (...args: Parameters<typeof baseWarningMessage>) => say(baseWarningMessage(...args)),
    refusalBody: (...args: Parameters<typeof baseRefusalBody>) => { const body = baseRefusalBody(...args); return { ...body, error: say(body.error) }; },
    silentFailure: async () => {
      const response = await baseSilentFailure();
      const body = await response.json();
      return NextResponse.json({ ...body, error: say(body.error) }, { status: response.status, headers: response.headers });
    },
  };
}

// Provider timeout and storage must finish before the platform kills this
// function. A killed unit stays leased until its database lease expires.
export const maxDuration = 300;

// Five budgets that MUST stay in this order, or a generation that is still
// running gets treated as dead by something downstream:
//
//   285s  this timeout      give up in-process, with time left to upload,
//                           record and answer inside the platform budget
//   285s  storeDeadline     (lib/generation/derivative-store.ts) counted from
//                           the request, not the provider call: the stored
//                           image must have landed before delivery is recorded
//   300s  maxDuration       the platform kills the function here
//   330s  SLOT_TTL_MS       (lib/generation/concurrency.ts) a killed function
//                           must not free its slot before it is truly gone
//   360s  unit lease       a claim is only dead once every step above is
//
// Raising maxDuration alone inverts it: at 300s the slot expires at 150s and
// the claim expires at 180s while the generation is still legitimately
// running — the concurrency cap silently breaks and a live payment is undone.
// 15s of headroom, not a round guess. Measured 2026-08-07 on the largest real
// output we have (3840x2160, 13.92 MB PNG from bench-output/): the sharp
// derivatives cost 250ms. The rest of the headroom is for moving roughly 14 MB
// down from the provider and 14 MB up into blob storage, which cannot be
// measured from a dev machine — hence 15s rather than 1s.
//
// Raising it further buys nothing: the slowest generation ever measured here
// is 78.1s (WaveSpeed nano-banana-pro at 2K), so this bound is never what ends
// a real request. It only decides how long a HUNG one makes the user wait
// before it can answer with something they can act on.
const SOLANA_GENERATION_TIMEOUT_MS = 285_000;
// A timeout tells the breaker of the host only when the host had this long: past the slowest render measured (78.1 s, above)
// with room. Enki's own steps can spend the budget first, and a host handed the last second has shown nothing.
const HOST_WINDOW_MS = 120_000;

type GenerateImageBody = {
  prompt?: string;
  aspectRatio?: string;
  resolution?: string;
  modelIds?: string[];
  /** Spend more to run the same model directly instead of via WaveSpeed. */
  boost?: boolean;
  /** Data URLs or bare base64. Capped server-side by the model's own limit. */
  referenceImages?: string[];
  /** low | medium | high, for models that take it. Ignored by the rest. */
  quality?: "low" | "medium" | "high";
  /** The editor node graph. Image bytes inside it are extracted server-side. */
  workflow?: unknown;
  ratio?: string;
  /** Values for a marketplace prompt's [name] slots, filled on the server. */
  variableValues?: Record<string, string>;
  /** A funded escrow, prepared from the stored payment intent. */
  intentId?: string;
  /** One server-reserved image within this funded batch, never a delivered count. */
  unitIndex?: number;
  /** An artist's draft from an editor: no moderator may read it. */
  authoring?: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The adapters answer a dropped connection as { success: false }, so this is the one throw that says a host did not answer. */
class HostTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new HostTimeout(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export async function POST(request: NextRequest) {
  let owed = null as "owed" | "unknown" | null;
  const res = await generate(request, (state) => { owed = state; });
  // The void of a claimed unit settles before the answer, and books the buyer's own landed broadcast of its payment
  // with a refund owed: then no refusal may say "Nothing was charged", whatever refused (DEC-253's case at every exit
  // after the claim) (round 25, 2026-10-21). A settle that did not finish in time leaves it unknown (round 30).
  if (owed === "owed") return NextResponse.json({ error: "This image's payment was already sent from your wallet. Nothing more will be charged; it is refunded." }, { status: 409 });
  if (owed === "unknown") return NextResponse.json({ error: "This image could not be made, and its payment is still being checked. Nothing more will be charged; if it was already sent from your wallet, it is refunded." }, { status: 409 });
  return res;
}

async function generate(request: NextRequest, owedUnit: (state: "owed" | "unknown") => void) {
  // The clock maxDuration runs on; the image must be stored inside it.
  const startedAt = Date.now();
  // JSON only, before anything runs, like the free route: a page elsewhere
  // must not post here in a visitor's name as a form or plain text, which
  // browsers send unasked.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Send the request as JSON." }, { status: 415 });
  }
  let consumedUnit: { supabase: SupabaseClient; claim: GenerationEscrowUnitClaim } | null = null;
  // The intent rail's claimed unit row (2026-10-18), voided on any failure before its capture like an escrow unit.
  let intentUnit: string | null = null;
  // The intent unit this request pays with, once known: voided as Enki's, only while no render has claimed it, its
  // nonce settled after the answer.
  let openUnit: string | null = null;
  const voidOpenUnit = async () => {
    if (!openUnit) return;
    const unit = openUnit;
    const supabase = getSupabaseServerClient();
    const won = await voidAuthorization(supabase, unit, "provider_failed", { unclaimed: true }).catch(() => null);
    const account = won?.nonceAccount;
    if (account) after(() => settleVoided(supabase, unit, account));
  };
  // What a failure from the concurrency cap on is recorded with, for the admin person list.
  let failCtx: Omit<GenerationFailure, "error"> | null = null;
  const scheduleReconciliation = (held: { supabase: SupabaseClient; claim: GenerationEscrowUnitClaim }) => {
    after(async () => {
      try {
        await advanceGenerationEscrow(held.supabase, escrowServerChain(), held.claim.intentId, held.claim.owner);
      } catch {
        console.error("[escrow] reconciliation pending", held.claim.intentId);
      }
    });
  };
  const failIfClaimed = async (reason: "provider_failed" | "rejected" | "unfunded" = "provider_failed") => {
    if (intentUnit) {
      const unit = intentUnit;
      intentUnit = null;
      // Bounded by the store's deadline: the settle's nonce close retries for minutes (DEC-96), and the route must answer
      // before the platform kills it. A settle still running finishes after the answer, and the cron books what it
      // finds (round 30, 2026-10-21).
      const voided = voidAndFlush(getSupabaseServerClient(), unit, reason).then(() => true, () => { console.error("[intent] void pending", unit); return true; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<false>((done) => { timer = setTimeout(() => done(false), Math.max(0, storeDeadline(startedAt) - Date.now())); });
      const inTime = await Promise.race([voided, late]).finally(() => clearTimeout(timer));
      if (!inTime) { after(() => voided); owedUnit("unknown"); return; }
      if ((await bookingState(getSupabaseServerClient(), unit)) === "owed") owedUnit("owed");
      return;
    }
    if (!consumedUnit) return;
    const held = consumedUnit;
    consumedUnit = null;
    try { await failGenerationEscrowUnit(held.supabase, held.claim); }
    catch { console.error("[escrow] image request failure pending", held.claim.intentId); }
    scheduleReconciliation(held);
  };

  // Held for the length of the generation. Declared out here so EVERY exit —
  // success, provider failure, the catch-all — gives it back: a leaked slot
  // locks the user out until it expires, which is the failure a concurrency
  // cap must not introduce.
  let heldSlot: { supabase: SupabaseClient | null; id: string } | null = null;
  // For the catch-all's words: the rail once it is known, and whether the intent rail's capture began or was booked.
  let knownRail: PaymentRail | null = null;
  let capture: "started" | "booked" | null = null;
  // The render carries an artist's text (a marketplace prompt, a draft): a provider's own words are kept as their class.
  let artistText = false;
  const releaseHeldSlot = async () => {
    if (heldSlot) {
      await releaseSlot(heldSlot.supabase, heldSlot.id);
      heldSlot = null;
    }
  };

  try {
    const body = (await request.json()) as GenerateImageBody;
    const typedPrompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";

    /* The resolution is validated ONCE, here, and every read below uses the
       result. It used to travel as the raw client string and get cast to the
       tier union unchecked at the point of use — this route has no schema, only
       prompt and intentId are shape-checked. So a lowercase "4k", which the
       editor surfaces genuinely send, reached WaveSpeed's RESOLUTION_MAP, missed
       every key, and fell back to '1k' — the SMALLEST tier — while the price
       ladder below read the same string and charged for 4K. Refusing an
       unreadable value is the only answer that cannot end in a buyer paying for
       pixels nobody asked the provider for. */
    const askedResolution = body.resolution == null ? null : normalizeTier(body.resolution);
    if (body.resolution != null && askedResolution === null) {
      return NextResponse.json(
        { error: "Choose a supported image size: 1K, 2K or 4K." },
        { status: 400 },
      );
    }

    /* A PAID request is told which model it bought; it does not get to pick
     * one here.
     *
     * The buyer surface sends { intentId, prompt, aspectRatio } and no
     * modelIds — it already named the model when it took the quote, and
     * model_family was written onto the intent and PRICED from it. Resolving
     * from body.modelIds anyway meant falling back to DEFAULT_MODEL
     * ("Nano Banana Pro"), so the later family comparison refused every
     * GPT-Image-2 purchase.
     *
     * Read before the preflight on purpose: this same object decides the
     * routing, the reference-image eligibility and the quote below, so
     * learning the family after those were settled would only have let us
     * complain about them rather than get them right. Session ownership is
     * checked before the quote is read or a metered preflight can run. */
    const intentId = typeof body.intentId === "string" ? body.intentId.trim() : "";
    // Intents only (REC-4): the legacy X-PAYMENT rail paid first and generated
    // second, so a failed generation kept the money. Free models have their
    // own route, /api/generate-free.
    if (!intentId) {
      return NextResponse.json(
        { error: "A paid generation needs a payment intent. No image was generated." },
        { status: 402 },
      );
    }
    if (!UUID_RE.test(intentId)) {
      return NextResponse.json({ error: "Choose a valid image request before continuing." }, { status: 400 });
    }

    const unitIndex = body.unitIndex;
    if (!Number.isInteger(unitIndex) || unitIndex! < 0 || unitIndex! >= 24) {
      return NextResponse.json({ error: "Choose a valid image request." }, { status: 400 });
    }
    // Read below as a list and as text: any other shape is refused here, before the unit is known. A throw past this
    // point is voided as Enki's by the catch-all (DEC-185), so buyer input must not be able to cause one (round 9,
    // 2026-10-20: a string referenceImages or an object aspectRatio voided signed units outside the buyer's pause).
    if ((body.referenceImages != null && !Array.isArray(body.referenceImages))
      || [body.aspectRatio, body.ratio].some((v) => v != null && typeof v !== "string")) {
      return NextResponse.json({ error: "The reference images or the aspect ratio could not be read. No image was generated." }, { status: 400 });
    }

    // Login and the rate limits come before the checks below: each of them
    // is a paid call, so a caller without a session, or over the limit,
    // never reaches one.
    const ipLimit = checkRequestRateLimit(rateLimitKey(request, "generate:intent:ip"), 120, 60_000);
    if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

    // Session token only — requireAuth's fallback (X-Wallet-Address
    // signature headers, no server nonce) is replayable and deliberately
    // not accepted on payment paths (same gate as payments/generation/pay).
    if (!request.headers.get("X-Session-Token")) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    let authUser;
    try {
      authUser = await requireAuth(request);
    } catch (e) {
      return authRefusal(e);
    }
    if (!checkRateLimit(authUser.userId, "generate:intent", 60, 60_000)) {
      return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const supabase = getSupabaseServerClient();
    const recordingUserId = await resolveRecordingUserId(supabase, request);
    if (!recordingUserId) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    /* The intent is the sum of settings the buyer paid for (REC-4): the exact
       model row, the resolution, the quality that runs, boost and how many
       reference images. Everything below runs those and nothing the request
       body says instead. */
    const { data: intentRow, error: intentError } = await (getSupabaseServerClientSafe()
      ?.from("generation_payment_intents")
      .select("model_cost_micro, model_id, model_family, resolution, quality, boost, reference_image_count, prompt_id, artist_amount_micro, total_micro, tx_signature, nonce_account, batch_intent_id, deposit_signature, status, authorized_at, consumed_at, captured_at, voided_at")
      .eq("id", intentId)
      .ilike("buyer_wallet", authUser.walletAddress)
      .maybeSingle() ?? Promise.resolve({ data: null, error: null }));
    if (isDbUnreachable(intentError)) return dbUnavailableResponse();
    const paid = intentRow as
      | (StoredSettings & ClaimRow & {
          model_family: string;
          prompt_id: string | null;
          artist_amount_micro: number;
          // What the buyer paid in total (micro-USDC) and, for an intent
          // already settled before generation (the legacy "prepaid" claim
          // mode), the signature that settled it — read here because
          // claimForGeneration's two modes don't hand either back, and both
          // are needed below for the payment link (REC-1).
          total_micro: number | null;
          tx_signature: string | null;
          nonce_account: string | null;
          batch_intent_id: string | null;
          deposit_signature: string | null;
          // Enki's bill for this image (micro-USD): what the daily spend breaker reserves (SQL 72).
          model_cost_micro: number | null;
        })
      | null;
    if (!paid) {
      return NextResponse.json(
        { error: "Payment intent not found. No image was generated." },
        { status: 404 },
      );
    }
    // The rail that opened the order pays it; one no rail opened yet goes by the switch (lib/payments/rail.ts).
    const rail: PaymentRail = railOf(paid) ?? (await paymentRail());
    // The rail's own words from here on; the catch-all below picks its own by the rail and the capture.
    knownRail = rail;
    const { say, IMAGE_REFUSED, IMAGE_UNCHECKED, REFERENCE_LINK, REFERENCE_REFUSED, REFERENCE_UNCHECKED, SILENT_FAILURE, warningMessage, refusalBody, silentFailure } = refusalWords(rail);
    // On the intent rail every image is its own unit row: unit 0 is the order's row, the rest are its clones.
    let unitId: string | null = null;
    // A spent unit is answered here, before any judge, with the claim's own answer: only the claim refused it, after
    // every metered check had run, so replaying one spent id spent Enki's money on judges. The claim still decides a
    // race, and nothing is voided: a refused unit is not this request's to close.
    if (rail === "intent") {
      // Each unit's own row: unit 0 spent says nothing about the clone this request pays with.
      let own: ClaimRow | null = paid;
      if (unitIndex === 0) unitId = intentId;
      else {
        const { data: unitRow, error: unitError } = await supabase.from("generation_payment_intents").select("id, status, authorized_at, consumed_at, captured_at, voided_at")
          .eq("batch_intent_id", intentId).eq("unit_index", unitIndex!).ilike("buyer_wallet", authUser.walletAddress).maybeSingle();
        if (isDbUnreachable(unitError)) return dbUnavailableResponse();
        unitId = (unitRow?.id as string | undefined) ?? null;
        own = unitRow as ClaimRow | null;
      }
      if (!unitId) return NextResponse.json({ error: "This image request was not found." }, { status: 404 });
      const spent = claimRefusal(own!, unitId);
      if (spent) return NextResponse.json({ error: spent.error }, { status: spent.status });
      openUnit = unitId;
    } else if (!paid.deposit_signature || await escrowUnitSpent(supabase, intentId, unitIndex!)) {
      // tx_signature and status='confirmed' are never read as spent here: 'confirmed' is every funded escrow row. No
      // deposit_signature is no funded deposit (SQL confirm_generation_escrow_deposit writes both at once).
      throw new EscrowPaymentError(409, ESCROW_UNIT_CONFLICT);
    }
    // A funded intent unit this route refuses for a reason on Enki's side (or the artist's prompt gone) is voided
    // here as provider_failed, so the buyer's later cancel cannot count it as dropped (verification 2026-10-18).
    const refuseOurs = async (res: NextResponse) => {
      await voidOpenUnit();
      return res;
    };
    // A refusal for what the artist's text does (nothing to render, its own words too long): the creator's own doing when
    // they buy their own prompt, so the unit stays theirs; Enki's for anyone else. A lookup that fails reads as not
    // theirs (round 11, 2026-10-20: a creator could otherwise void their own units as Enki's at will).
    const buyerIsCreator = async () => {
      const [{ data: owner }, owners] = await Promise.all([
        supabase.from("prompts").select("creator_id").eq("id", String(paid.prompt_id)).maybeSingle(),
        resolveOwnerIds(supabase, request.headers.get("X-Session-Token")).catch(() => null),
      ]);
      return Boolean(owner?.creator_id && owners?.includes(String(owner.creator_id)));
    };
    const refuseArtists = async (res: NextResponse) => ((await buyerIsCreator()) ? res : refuseOurs(res));

    /* A marketplace prompt with an artist share is generated from the
       ARTIST's text, filled with the buyer's variables, never from what the
       client sends: the client only ever sees a paid prompt's excerpt, so it
       sent the title and the variables, and the buyer paid the artist for an
       image the artist's prompt never made. Free and own prompts take the
       buyer's own text. The artist's text is never returned to the buyer. */
    const fromArtist = Boolean(paid.prompt_id) && Number(paid.artist_amount_micro) > 0;
    let prompt = typedPrompt;
    let promptAdult = false;
    let shortestLength = 0;
    // The artist's stored variables, so the prompt check judges only what is the buyer's own (round 15).
    let artistVariables: StoredVariable[] = [];
    // The artist's text as stored, [slots] and all, for the check of what the render spells out.
    let hiddenTemplate = "";
    if (fromArtist) {
      const text = await loadPromptText(getSupabaseServerClient(), paid.prompt_id as string);
      if (!text.ok) {
        const res = NextResponse.json(refusalBody(text), { status: text.status });
        return text.status === 422 ? refuseArtists(res) : refuseOurs(res);
      }
      // Off sale since the order was quoted (paused for its own text, delisted, deleted): no buyer renders it now, and
      // the unit is Enki's (DEC-441); its creator still may.
      if (text.listed === false && !(await buyerIsCreator())) {
        return refuseOurs(NextResponse.json({ error: say(PROMPT_UNAVAILABLE) }, { status: 422 }));
      }
      const longInput = overLong(body.variableValues);
      if (longInput) {
        const res = NextResponse.json(
          { error: say(`Each input can be at most ${VALUE_MAX} characters. Nothing was generated and nothing was charged.`) },
          { status: 422 },
        );
        // Every choice the artist wrote for that field is longer than a value may be: not the buyer's to fix (round 13).
        const field = text.variables.find((v) => v.name === longInput);
        return field && shortestValue(field).length > VALUE_MAX ? refuseArtists(res) : res;
      }
      const filled = fillVariables(text.text, body.variableValues, text.variables);
      const shortest = shortestWebFill(text.text, text.variables);
      // A buyer must never pay for an image a value of theirs did not reach. A text no web buyer can fill is the
      // artist's doing: the creator's own when they buy it, Enki's for anyone else (round 12, 2026-10-20).
      if (inputsUnmatched(filled)) {
        const unmatched = NextResponse.json(
          { error: say("This prompt's inputs could not be matched to its text. Nothing was generated and nothing was charged.") },
          { status: 422 },
        );
        return inputsUnmatched(shortest) ? refuseArtists(unmatched) : unmatched;
      }
      prompt = filled.text;
      promptAdult = text.adult;
      shortestLength = shortest.text.length;
      artistVariables = text.variables;
      hiddenTemplate = text.text;
    } else if (paid.prompt_id) {
      const marked = await promptMarkedAdult(getSupabaseServerClient(), paid.prompt_id as string);
      if (marked === null) {
        return refuseOurs(NextResponse.json({ error: say("This prompt could not be checked right now. Nothing was generated and nothing was charged.") }, { status: 503 }));
      }
      promptAdult = marked;
    }
    // Blank once filled (an artist's text of slots only, filled with spaces): the adapters refuse an empty prompt after
    // the claim, voided as Enki's, so it is refused here, the buyer's (round 11, 2026-10-20).
    if (!prompt.trim()) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    // --- SECURITY GUARDS ---
    // 1. Prompt length cap (client text; an artist's prompt is not the buyer's to size)
    if (!fromArtist && prompt.length > 4000) {
      return NextResponse.json({ error: "Prompt too long" }, { status: 400 });
    }

    // 2. Variable injection guard
    const bracketCount = (prompt.match(/\[/g) || []).length;
    if (!fromArtist && bracketCount > 20) {
      return NextResponse.json({ error: "Too many variables" }, { status: 400 });
    }

    const paidTier = normalizeTier(paid.resolution);
    const paidModel = paid.model_id ? await resolveModel(getSupabaseServerClientSafe(), [paid.model_id]) : null;
    if (!paidTier || !paidModel || toModelFamily(paidModel.name) !== paid.model_family) {
      // The row it paid for is gone or changed family. Generating on anything
      // else would be the exact substitution this path exists to prevent.
      return refuseOurs(NextResponse.json(
        { error: say("This paid model is unavailable right now. Nothing was generated and nothing was charged.") },
        { status: 409 },
      ));
    }
    // A setting the request repeats must agree with the payment, refused here
    // before the slot and the claim, so there is nothing to void, and before
    // the checks below, so they judge no more images than were paid for.
    const attachedRefs = referenceImageCount(body.referenceImages);
    const mismatch = settingMismatch(
      paid,
      { modelIds: body.modelIds, resolution: askedResolution, quality: body.quality, boost: body.boost, referenceImageCount: attachedRefs },
      paidModel.supportsQuality,
    );
    if (mismatch) {
      return NextResponse.json(
        { error: say("The selected settings differ from this payment. Nothing was generated and nothing was charged.") },
        { status: 400 },
      );
    }
    // Never sliced away below: a reference the model cannot take is refused. Past settingMismatch the count is the one
    // paid for, so only a model changed since the order can refuse it: Enki's (round 18, 2026-10-20).
    if (attachedRefs > paidModel.maxRefs) {
      return refuseOurs(NextResponse.json(
        { error: say(`${paidModel.name} takes at most ${paidModel.maxRefs} reference images. Nothing was generated and nothing was charged.`) },
        { status: 422 },
      ));
    }
    // Its creator switched buyers' references off (SQL 62). The quote refuses an order with them and past settingMismatch
    // the count is the one paid for, so only a switch since the order can refuse it: Enki's, before the checks and the
    // claim. Its creator's own render is as ever.
    if (attachedRefs > 0 && paid.prompt_id && !(await allowsReferences(supabase, String(paid.prompt_id))) && !(await buyerIsCreator())) {
      return refuseOurs(NextResponse.json({ error: say(`${REFERENCES_OFF} Nothing was generated and nothing was charged.`) }, { status: 422 }));
    }
    // The ratio reaches the provider as sent, and one the model does not offer fails only after the claim, where it
    // read as Enki's failure: it is refused here, before anything is claimed (round 4, 2026-10-19).
    const aspectRatio = body.aspectRatio || body.ratio || "1:1";
    if (!paidModel.allowedRatios.includes(aspectRatio)) {
      return NextResponse.json(
        { error: say(`${paidModel.name} cannot make a ${aspectRatio} image. Nothing was generated and nothing was charged.`) },
        { status: 400 },
      );
    }

    // What the prompt asks for, judged before anything is generated or
    // charged: for an artist's prompt the buyer's values only (the artist's
    // text never goes out for this), otherwise the whole prompt. An explicit
    // or child-safety request is refused with a warning the user sees; an
    // extraction attempt and an outage of the check both answer like any
    // failed generation.
    // Without the artist's variable names, which are the artist's text too (round 17).
    const checked = fromArtist ? unnamedValues(textValues(buyersOwn(body.variableValues, artistVariables))) : { prompt };
    // What the buyer sent in full, the artist's picks included: what every record of this request carries (round 16,
    // 2026-10-20: round 15 recorded only what was judged).
    const sent = fromArtist ? textValues(body.variableValues) : { prompt };
    // A record of an artist's prompt names it and shows the buyer's values,
    // never its text; an artist's draft from an editor shows nothing, marked
    // as withheld on the requester's word, for any session token (as on the
    // free route; lib/moderation/evidence).
    const authoring = !fromArtist && body.authoring === true && Boolean(request.headers.get("X-Session-Token"));
    artistText = fromArtist || authoring;
    const about = fromArtist ? { promptId: String(paid.prompt_id) } : authoring ? { withheld: prompt, draft: true } : {};
    // The regex first: what Tier 1 refuses never reaches the chat model, and
    // its refusal is this request's moderation verdict (Kev, 2026-10-06).
    const first = screenFirst(checked);
    // Every reference image is judged too, beside the prompt, before it can
    // reach a model or anything is charged (Kev, 2026-10-08: every image).
    // They arrive as data: URLs or bare base64, as the providers read them.
    const refs = (body.referenceImages ?? []).filter((r): r is string => typeof r === "string" && r.trim() !== "");
    // A link is never fetched here: refused as one, not judged as junk and
    // answered "try again".
    if (refs.some(isLink)) {
      return NextResponse.json({ error: REFERENCE_LINK }, { status: 422 });
    }
    // The judges below run on Enki's money and a refused request can repeat them, so they reserve first (SQL 72), and only
    // what will run: the prompt check unless the regex refused already, and two views of each reference. A refusal that
    // called nobody adds nothing, and the check of the render is in its bill (modelLegMicro). Never given back.
    const judgeCalls = (first ? 0 : 1) + 2 * refs.length;
    if (judgeCalls) {
      const judges = await reserveSpend(supabase, JUDGE_CALL_MICRO * judgeCalls);
      if (!judges.ok) {
        const refused = NextResponse.json({ error: say(judges.error) }, { status: judges.status });
        // A cap that could not be read may answer in a moment: the signed unit stays open for the retry.
        return judges.retry ? refused : refuseOurs(refused);
      }
    }
    const refBytes = refs.map((r) => dataUrlBytes(r) ?? Buffer.from(r.trim(), "base64"));
    const [check, refsSeen] = await Promise.all([
      first ? NOT_CHECKED : checkPrompt(checked, { hidden: fromArtist, signal: request.signal }),
      Promise.all(refBytes.map((b) => checkImageBytes(b, { signal: request.signal }))),
    ]);
    // A child-safety reference becomes a case whatever else refuses the
    // request, the prompt's own warning below included.
    refsSeen.forEach((v, i) => {
      if (v.verdict === "child_safety") {
        after(recordImageCase(getSupabaseServerClient(), {
          surface: "generate-image", request, bytes: refBytes[i], scores: v.scores,
          about: authoring ? "" : JSON.stringify(sent), promptId: about.promptId,
        }));
      }
    });
    if (check.verdict === "minor_sexual" || check.verdict === "explicit_sexual") {
      const outcome = await recordWarning(getSupabaseServerClient(), {
        surface: "generate-image", request, category: check.verdict, text: authoring ? "" : JSON.stringify(sent), confidence: check.confidence, ...about,
      });
      return NextResponse.json({ error: warningMessage(check.verdict, outcome) }, { status: 422 });
    }
    // A reference the check refuses or cannot judge stops the request before
    // the slot and the claim, so there is nothing to void.
    if (refsSeen.some(heldBack)) {
      if (refsSeen.some((v) => v.verdict === "blocked" || v.verdict === "child_safety")) {
        return NextResponse.json({ error: REFERENCE_REFUSED }, { status: 422 });
      }
      const unchecked = NextResponse.json({ error: REFERENCE_UNCHECKED }, { status: 503 });
      // A judge Enki could not reach is Enki's, voided so the buyer's cancel cannot count it; one the image can provoke
      // stays the buyer's (DEC-152's third site; round 6, 2026-10-20).
      return refsSeen.every((v) => v.verdict !== "unavailable" || checkDown(v.reason)) ? refuseOurs(unchecked) : unchecked;
    }
    // The provider gets exactly the references the check passed, each as the type its bytes are: an entry that is
    // not one, or a data URL declaring another type, failed only at the provider, after the claim, where it read as
    // Enki's failure (round 5, 2026-10-20).
    const checkedRefs = await Promise.all(refBytes.map(providerReference));
    if (check.verdict === "unavailable") console.warn("[prompt-check] unavailable:", check.reason);
    // Refused silently, but only where a real generation fails: after the
    // slot and the claim (below). Answering here, before those, told a
    // caller which inputs were caught.
    const silent = check.verdict !== "clear";

    // 18+ (a suggestive prompt, or a prompt marked 18+) is for confirmed adults
    // only, refused before anything is charged.
    // Whatever else the check found, so the refusal never depends on it.
    // A reference judged 18+ makes the render 18+ too.
    const adult = ("adult" in check && check.adult === true) || promptAdult || refsSeen.some((v) => v.verdict === "adult");
    const asker = adult ? recordingUserId : null;
    // An unreadable confirmation is Enki's database, not a refusal of the buyer: voided as Enki's (round 5, 2026-10-20).
    const confirmed = adult ? await adultConfirmed(getSupabaseServerClient(), asker).catch(() => null) : true;
    if (confirmed === null) {
      return refuseOurs(NextResponse.json({ error: say("Your age confirmation could not be checked right now. Nothing was generated and nothing was charged.") }, { status: 503 }));
    }
    if (!confirmed) {
      // Counted only for a signed-in account: this answer comes before login,
      // where nothing would stop a loop filling the queue and the admins' inbox.
      if (check.verdict === "extraction" && asker) {
        after(recordExtractionHit(getSupabaseServerClient(), { surface: "generate-image", request, values: sent, confidence: check.confidence, ...about }));
      }
      return NextResponse.json(ADULT_REFUSAL, { status: 403 });
    }

    // 3. Content moderation — deliberately the FIRST thing after cheap input
    // validation and long before any payment step below. A refused prompt must
    // never be a charged prompt.
    //
    // The client only ever learns that it was refused: category, tier, rule ids
    // and scores stay server-side, otherwise this endpoint becomes an oracle an
    // attacker can probe to map the filter.
    // The prompt check saw only the buyer's values of an artist's prompt, so
    // tier 2 keeps its sexual flag for the artist's text unless the prompt is
    // marked 18+ (legacy prompts were never judged at save).
    // No request signal: a client that hangs up would make tier 2 fail open and let the render through (review
    // wf_866ba07b-01a); tier 2 keeps its own timeout.
    const verdict = first ?? await moderate({ prompt, surface: "generate-image", adultJudged: !fromArtist || promptAdult });
    // A child-safety hit on a marketplace prompt is a warning on the buyer's
    // ladder, and that warning is its one record: it weighs ten, so it
    // suspends at once, and every repeat climbs the ladder to a ban for good
    // (Kev, 2026-10-03: whoever keeps at it is banned).
    const minors = fromArtist && !verdict.allowed ? childSafetyScore(verdict) : null;
    if (minors !== null) {
      /* Judged again with the buyer's typed words neutral (neutralFill): still refused, it is the artist's text. The
         buyer is not warned for words they never saw; the prompt goes off sale for an admin and the hit is recorded
         (Kev, 2026-10-28, "3 yes"; DEC-474). A creator buying their own prompt wrote it and keeps the warning. A
         re-judge that could not run warns no one: Enki's unit. */
      const again = await moderate({ prompt: neutralFill(hiddenTemplate, body.variableValues, artistVariables), surface: "generate-image", adultJudged: promptAdult });
      if (!again.allowed && !(await buyerIsCreator())) {
        after(recordModerationEvent(verdict, { surface: "generate-image", request, prompt: JSON.stringify(sent), ...about }));
        after(refusePrompt(getSupabaseServerClient(), { promptId: String(paid.prompt_id), cause: "moderation", detail: "minor_sexual", buyerUserId: recordingUserId }));
        return refuseOurs(NextResponse.json({ error: say(PROMPT_UNAVAILABLE) }, { status: 422 }));
      }
      if (again.allowed && again.tier2Degraded) {
        // Still on file, warning no one (review wf_794afa1b-83d): before DEC-474 the warning was the hit's one record.
        after(recordModerationEvent(verdict, { surface: "generate-image", request, prompt: JSON.stringify(sent), ...about }));
        return refuseOurs(NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 }));
      }
      const outcome = await recordWarning(getSupabaseServerClient(), {
        surface: "generate-image", request, category: "minor_sexual", text: JSON.stringify(sent), confidence: minors, scores: verdict.scores, ...about,
      });
      return NextResponse.json({ error: warningMessage("minor_sexual", outcome) }, { status: 422 });
    }
    // after() and not a bare void: on a block this route returns immediately,
    // and a floating promise can be frozen with the lambda before the insert
    // lands — losing exactly the events we most want recorded.
    after(recordModerationEvent(verdict, { surface: "generate-image", request, prompt: fromArtist ? JSON.stringify(sent) : authoring ? "" : prompt, ...about }));
    if (!verdict.allowed) {
      /* An artist's prompt the regex let through and the model refused: judged again with the buyer's typed words
         neutral (lib/generation/prompt-text neutralFill). Refused again, it is the artist's text: Enki's unit, never
         the buyer's count, and the prompt off sale for an admin (DEC-441). A re-judge that could not run is no one's
         finding: Enki's unit, nothing paused. Refused only with the buyer's words, it stays theirs. */
      if (fromArtist && !first) {
        const again = await moderate({ prompt: neutralFill(hiddenTemplate, body.variableValues, artistVariables), surface: "generate-image", adultJudged: promptAdult });
        if (!again.allowed) {
          after(refusePrompt(getSupabaseServerClient(), { promptId: String(paid.prompt_id), cause: "moderation", detail: String(again.category ?? "blocked"), buyerUserId: recordingUserId }));
          return refuseArtists(NextResponse.json({ error: say(PROMPT_UNAVAILABLE) }, { status: 422 }));
        }
        if (again.tier2Degraded) return refuseOurs(NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 }));
      }
      return NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 });
    }

    const preflightModel = paidModel;
    // Chosen HERE and nowhere else, because the quote below carries the price
    // of a specific host: quoting AceData and then generating on WaveSpeed
    // would charge the wrong amount. This also skips hosts whose breaker is
    // open, so an outage costs a fallback rather than a failed payment.
    /* Reference images decide WHICH host is even eligible, which is why the
     * count is computed here, before the route is chosen and long before the
     * quote. Only hosts that can pass images to the model are considered, so a
     * prompt with references takes the Gemini row rather than the cheaper
     * WaveSpeed one that would discard them. */
    /* The quality that will RUN, not the one that was sent: the OpenAI
       service defaults an unstated quality by tier, and gpt's routes carry
       applies_when quality conditions that fail CLOSED on a missing value —
       routing on the raw body value would drop every conditioned row for
       callers without a quality lever (quick create). One value feeds the
       route, the price and the provider call. */
    const effQuality = preflightModel.supportsQuality
      ? effectiveQuality(paidTier, paid.quality)
      : null;
    const preflightRoute = await chooseRoute(
      getSupabaseServerClientSafe(),
      preflightModel,
      {
        boost: paid.boost,
        quality: effQuality,
        resolution: preflightModel.supportsResolution ? paidTier : null,
        referenceImages: attachedRefs,
      },
    );

    /* No host can carry these images. Refuse, and say so, rather than
     * generating without them.
     *
     * This is the case the whole capability layer exists for. Until
     * 2026-08-12 the request went through on the cheapest host, the images
     * were dropped somewhere below this line, and the buyer was charged in
     * full for a picture that had never seen them. Nothing surfaced it: the
     * output is a perfectly plausible answer to the prompt. 422 rather than
     * 501 — the request is well formed, the combination is simply not
     * available. */
    // chooseRoute finds no host only for references, and the model takes this many (checked above): every host that
    // carries them is down. An intent unit's host was found at /authorize (renderableHere), so this is Enki's outage
    // (round 5, 2026-10-20; DEC-133's branch for a request without references could never run).
    if (!preflightRoute && rail === "intent") {
      return refuseOurs(NextResponse.json(
        { error: `${preflightModel.name} is temporarily unavailable. Nothing was generated and nothing was charged.` },
        { status: 503 },
      ));
    }
    if (!preflightRoute) {
      return NextResponse.json(
        {
          error:
            `${preflightModel.name} cannot use reference images. ` +
            `No image was generated. Check your payment status before trying again. ` +
            `Choose a model that accepts them, or remove the ${attachedRefs} attached image${attachedRefs === 1 ? "" : "s"}.`,
        },
        { status: 422 },
      );
    }

    // No free host: a paid model never renders on Pollinations' Flux.
    const IMPLEMENTED: readonly string[] = ["gemini", "wavespeed", "openai"];
    if (!IMPLEMENTED.includes(preflightRoute.provider)) {
      return refuseOurs(NextResponse.json(
        { error: `${preflightModel.name} is not available yet.` },
        { status: 501 },
      ));
    }
    // A paid request never falls back to a guessed model (Kev, 2026-09-22).
    if (!preflightRoute.providerModel) {
      return refuseOurs(NextResponse.json(
        { error: say(`${preflightModel.name} is temporarily unavailable. Nothing was generated and nothing was charged.`) },
        { status: 503 },
      ));
    }
    // ENV-01: no host with a key on this environment, said as such before a
    // slot or a unit is taken (the unit's payment comes back with the batch).
    // Names the host, never the key; every buyer gets this same answer.
    if (providerKeyMissing(preflightRoute.provider)) {
      return refuseOurs(NextResponse.json(
        { error: say(`${PROVIDER_NAME[preflightRoute.provider] ?? preflightModel.name} is not configured on this environment. Nothing was generated and nothing was charged.`) },
        { status: 503 },
      ));
    }

    // An artist's prompt filled past what the host takes would be refused after the claim, voided as Enki's: refused
    // here (round 10; every host with a known limit, round 12). A fallback host is Enki's choice, and a text whose
    // shortest web fill is past the limit is not the buyer's to fix: both Enki's. Otherwise the buyer's values made it
    // too long (rounds 11, 12).
    const promptMax = PROMPT_MAX[preflightRoute.provider];
    if (fromArtist && promptMax !== undefined && prompt.length > promptMax) {
      const tooLong = () => NextResponse.json(
        { error: say(`This prompt is too long for ${preflightModel.name} right now. Nothing was generated and nothing was charged.`) },
        { status: 422 },
      );
      if (preflightRoute.primary !== true) return refuseOurs(tooLong());
      if (shortestLength > promptMax) return refuseArtists(tooLong());
      return NextResponse.json(
        { error: say(`Your inputs make this prompt longer than ${preflightModel.name} takes. Shorten them. Nothing was generated and nothing was charged.`) },
        { status: 422 },
      );
    }

    // 3c. Concurrency cap — before any payment step, so a refused request is
    // never a charged one. Unlimited unless an admin sets a number.
    const slotSupabase = supabase;
    const slotUserId = recordingUserId;
    failCtx = {
      request, surface: "generate-image", modelId: paid.model_id ?? null, resolution: paidTier ?? null, quality: effQuality,
      boost: paid.boost === true, aspectRatio: body.aspectRatio || body.ratio || null, referenceImageCount: attachedRefs,
      // For an artist's prompt only the buyer's values, for an artist's draft
      // nothing: an artist's text is never stored with a failure.
      prompt: fromArtist ? JSON.stringify(sent) : authoring ? null : prompt, intentId,
    };
    const slot = await acquireSlot(slotSupabase, slotUserId);
    if (slot.slotId) heldSlot = { supabase: slotSupabase, id: slot.slotId };
    // On the intent rail the unit is voided as Enki's (DEC-123): the web client sends an order's images at once and
    // never sends a paid one again, so the cap is Enki's own batch meeting an admin's limit; left open, the unit was
    // cancelled at the end of the batch and counted against the buyer (round 5, 2026-10-20; DEC-133 had removed it).
    if (!slot.allowed) {
      const busy = `You already have ${slot.limit} generation${slot.limit === 1 ? "" : "s"} running.`;
      return rail === "intent"
        ? refuseOurs(NextResponse.json({ error: `${busy} This image was not generated. Nothing was charged.` }, { status: 429 }))
        : NextResponse.json({ error: `${busy} Wait for one to finish.`, retryable: true }, { status: 429 });
    }

    const enhancedPrompt = prompt;

    // A conditional per-image lease prevents a replay or parallel request
    // from reaching a provider twice. The session binds both buyer and user.
    let chainKey: string;
    if (rail === "intent") {
      const claimed = await claimForGeneration(supabase, { intentId: unitId!, buyerWallet: authUser.walletAddress });
      if (!claimed.ok) {
        await releaseHeldSlot();
        const res = NextResponse.json({ error: claimed.error }, { status: claimed.status });
        // 500 is Enki's database: voided as Enki's, or the buyer's cancel would count it (round 4, 2026-10-19).
        return claimed.status === 500 ? refuseOurs(res) : res;
      }
      intentUnit = unitId;
      openUnit = null;
      // Every unit the buyer holds open must still be covered before a provider is paid (Kev, 2026-10-18).
      const cover = await buyerCovers(supabase, solanaConnection(), authUser.walletAddress, 0);
      if (!cover.ok) {
        // The buyer's own broadcast of this unit's payment may be what moved the balance: failIfClaimed tells it (round 24).
        await failIfClaimed("unfunded");
        await releaseHeldSlot();
        return NextResponse.json({ error: "Your wallet no longer holds enough USDC for this image. Nothing was charged." }, { status: 402 });
      }
      chainKey = solanaChainKey();
    } else {
      const paymentChain = escrowServerChain();
      const claim = await claimGenerationEscrowUnit(supabase, paymentChain, {
        intentId, owner: authUser.walletAddress, userId: recordingUserId, unitIndex: unitIndex!,
      });
      consumedUnit = { supabase, claim };
      chainKey = paymentChain.cluster;
    }
    // The intent rail's capture needs its own reserve inside the function budget.
    const deadline = storeDeadline(startedAt) - (rail === "intent" ? CAPTURE_RESERVE_MS : 0);
    const paymentMetadata = {
      paymentIntentId: intentId, unitIndex, modelFamily: paid.model_family, resolution: paid.resolution,
    };

    // Every request here holds a payment — bound the provider call so a hung
    // generation can't strand it.
    // The model the user actually picked, resolved to a provider model id.
    // Without this the service fell back to a hard coded model for every
    // generation, so the choice in the UI changed nothing while the price
    // was charged per selection.
    // Resolved once, in the pre-payment guard above — a second lookup could
    // disagree with the one the refusal was based on.
    const chosen = preflightModel;
    const route = preflightRoute;
    const shared = {
      prompt: enhancedPrompt,
      modelVersion: route.providerModel,
      aspectRatio: aspectRatio as ImageGenerationRequest["aspectRatio"],
      // Only sent to models that honour it. Asking a model without imageSize
      // for 2K silently returns 1024² — and we would still have charged for 2K.
      /* Clamped to what the CHOSEN route renders, not to what was asked.
         The router can fail over to a different host mid-request, and asking
         a host for a tier it does not have is how a 4K charge came back as a
         1K picture with nothing reporting it. */
      imageSize: chosen.supportsResolution
        ? (clampTier(
            paidTier,
            route.provider,
            route.providerModel,
          ) as ImageGenerationRequest["imageSize"])
        : undefined,
      // Reference images reached the model for the first time here: they were
      // uploaded, counted against the per-model cap and stored, and then
      // dropped before the request was built.
      // Sent only where it means something — and as the EFFECTIVE value,
      // the same one that chose the route and priced the request.
      quality: chosen.supportsQuality ? (effQuality ?? undefined) : undefined,
      // Exactly the count paid for, already checked against the model above.
      referenceImages: checkedRefs,
      numImages: 1,
    };

    // The silent refusal fails exactly like a provider failure: the claim goes
    // back the same way, the answer is the same, and it takes as long. Only a
    // request that got this far counts as a caught attempt.
    if (silent) {
      if (check.verdict === "extraction") {
        after(recordExtractionHit(getSupabaseServerClient(), { surface: "generate-image", request, values: sent, confidence: check.confidence, ...about }));
      }
      // The wait comes first: a provider failure holds the claim and the slot
      // until it answers, so a second request meanwhile must see them taken.
      const answer = await silentFailure();
      // Refused for what the request holds, or for a check its text could keep from clearing: the buyer's, like the
      // image check (round 4, 2026-10-19). A check Enki could not run (no key, an outage, our timeout) is Enki's
      // (round 5, 2026-10-20).
      await failIfClaimed(check.verdict === "unavailable" && checkDown(check.reason) ? "provider_failed" : "rejected");
      await releaseHeldSlot();
      return answer;
    }

    // Enki's bill, reserved before the provider is asked (SQL 72). Refused as a provider failure is: the unit is voided as
    // Enki's (the escrow's refunds by reconciliation), nobody is charged.
    const reserved = await reserveSpend(supabase, Number(paid.model_cost_micro));
    if (!reserved.ok) {
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: reserved.why }));
      await failIfClaimed("provider_failed");
      return NextResponse.json({ error: say(reserved.error) }, { status: reserved.status });
    }

    // Boost picks WHERE the model runs, never which model. WaveSpeed hosts
    // the same Nano Banana Pro at ~73-78s; going direct costs more and takes
    // ~19-39s. Same picture either way — the user is buying time.
    //
    // One switch over the resolved provider, so adding a host is a case here
    // and a row in model_providers — not a new branch scattered through the
    // request flow, which is how the free path ended up special-cased in its
    // own route with no price, no ratio list and no reference limit.
    const geminiRequest =
      route.provider === "wavespeed"
        ? generateImagesWithWaveSpeed(shared)
        : route.provider === "openai"
          ? generateImagesWithOpenAI(shared)
          : generateImagesWithGemini(shared);

    const hostWindow = Math.min(SOLANA_GENERATION_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
    const geminiResult = await withTimeout(
      geminiRequest,
      hostWindow,
      "Image generation timed out after payment. Please try again with a shorter prompt or lower resolution."
    ).catch((thrown: unknown) => {
      // The catch-all below knows nothing of the breaker, and a host that stops answering must count.
      if (thrown instanceof HostTimeout && hostWindow >= HOST_WINDOW_MS && route.modelProviderId && route.providerId) after(reportFailure(getSupabaseServerClient(), route.modelProviderId, route.providerId, thrown.message));
      throw thrown;
    });

    if (!geminiResult.success || !geminiResult.imageBuffers?.length) {
      // Tell the breaker. It classifies: a refused prompt says nothing about
      // the host and never counts, while a dead key or an empty balance
      // takes every route of that provider out at once.
      if (route.modelProviderId && route.providerId) {
        after(
          reportFailure(
            getSupabaseServerClient(),
            route.modelProviderId,
            route.providerId,
            geminiResult.error || "generation failed",
          ),
        );
      }
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: providerFailure(geminiResult.error || "generation failed", artistText) }));
      // The breaker's own reading: a prompt the provider refused for its content is what the buyer sent. Everything
      // else is Enki's, "request" included: the breaker files a provider's account and model errors there too, and
      // the buyer's inputs (ratio, references) are checked before the claim (round 5, 2026-10-20).
      const refusedContent = classifyFailure(geminiResult.error || "generation failed").kind === "content";
      if (!mayBeBilled(geminiResult.error || "generation failed")) await releaseSpend(supabase, reserved);
      // An artist's prompt the provider refused: no reason given, so the unit is Enki's, the refusal recorded, and the
      // prompt off sale once a second buyer is refused too (DEC-441). The creator's own purchase stays theirs, and so
      // does a render carrying the buyer's own reference images, which may be what was refused (review wf_866ba07b-01a).
      const artistsText = refusedContent && fromArtist && checkedRefs.length === 0 && !(await buyerIsCreator());
      if (artistsText) {
        after(refusePrompt(getSupabaseServerClient(), { promptId: String(paid.prompt_id), cause: "provider", detail: PROVIDER_NAME[route.provider] ?? String(route.provider), buyerUserId: recordingUserId }));
      }
      await failIfClaimed(refusedContent && !artistsText ? "rejected" : "provider_failed");
      await releaseHeldSlot();
      if (artistsText) return NextResponse.json({ error: say(PROMPT_UNAVAILABLE) }, { status: 422 });
      // The provider's own text stays in the logs and the failure record; the
      // buyer gets the answer a caught request gets, so the two cannot be told apart.
      return NextResponse.json(SILENT_FAILURE, { status: 500 });
    }

    // A delivered image resets the count, so three unrelated blips spread
    // over a week never add up to an outage.
    if (route.modelProviderId && route.providerId) {
      after(reportSuccess(getSupabaseServerClient(), route.modelProviderId, route.providerId));
    }
    const generatedImageBuffer = geminiResult.imageBuffers?.[0];
    if (!generatedImageBuffer) {
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: "No generated image buffer returned" }));
      await failIfClaimed();
      await releaseHeldSlot();
      return NextResponse.json(SILENT_FAILURE, { status: 500 });
    }

    // Escrow delivery needs an image stored independently of this response.
    // Its type measured from the bytes, as on the free and agent rails
    // (REC-1): this said image/png for every image, a JPEG one included. A
    // format the reader does not know stays PNG, as before.
    const format = readImageDimensions(generatedImageBuffer)?.format ?? "png";
    const storedName = `generations/${recordingUserId}/${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${format === "jpeg" ? "jpg" : format}`;
    const imageUrl = await putDurably(
      storedName, generatedImageBuffer, `image/${format}`, deadline,
    );
    // Leave time to persist delivery and answer before the platform's kill.
    if (!imageUrl || Date.now() > deadline) {
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: "image could not be stored" }));
      await failIfClaimed();
      await releaseHeldSlot();
      return NextResponse.json(
        { error: rail === "intent"
          ? "Your image was made but could not be delivered. Nothing was charged."
          : "Your image was made but could not be delivered. Its unused payment is being refunded. Check its status before trying again." },
        { status: 503 },
      );
    }

    // The image check, after storage and before the money moves (Kev,
    // 2026-10-08): what it refuses or cannot judge is not delivered and not
    // charged, and the stored copy comes down again (both stores: an aborted
    // Blob turn may still have landed one). Bounded by the store deadline, so
    // delivery recording keeps its reserve.
    const seen = await checkImageBytes(generatedImageBuffer, {
      // Not the request's signal: a buyer who closes the tab still gets the
      // render they paid for in the gallery.
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (heldBack(seen)) {
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: `image check: ${seen.verdict}` }));
      if (seen.verdict === "child_safety") {
        after(recordImageCase(getSupabaseServerClient(), {
          surface: "generate-image", request, bytes: generatedImageBuffer, scores: seen.scores,
          about: authoring ? "" : JSON.stringify(sent), promptId: about.promptId,
        }));
      }
      after(removeStored([imageUrl, storedName]));
      // What the image holds is the buyer's request; a judge Enki could not reach is Enki's (round 5, 2026-10-20), and so
      // are bytes that hold no readable still image, answered as the failed generation they are (round 10, 2026-10-20).
      const unreadable = seen.verdict === "blocked" && UNREADABLE_OUTPUT.has(seen.reason);
      await failIfClaimed(unreadable || (seen.verdict === "unavailable" && checkDown(seen.reason)) ? "provider_failed" : "rejected");
      await releaseHeldSlot();
      if (unreadable) return NextResponse.json(SILENT_FAILURE, { status: 500 });
      return seen.verdict === "unavailable"
        ? NextResponse.json({ error: IMAGE_UNCHECKED }, { status: 503 })
        : NextResponse.json({ error: IMAGE_REFUSED }, { status: 422 });
    }
    /* The artist's words read off the render: a buyer's value can tell the model to typeset the hidden text, and the
       judge on the inputs can miss a paraphrase (ENC review, 2026-10-27). Withheld, but whose doing it is cannot be
       told: lettering the artist meant to show reads the same (review wf_866ba07b-01a). So the unit is Enki's, no one
       is struck, and the prompt waits for an admin once two buyers met it; released, its lettering is meant. A creator
       buying their own prompt reads their own words. */
    if (fromArtist && seen.text && showsHiddenText(seen.text, hiddenTemplate) && !(await buyerIsCreator())
      && !(await letteringReleased(getSupabaseServerClient(), String(paid.prompt_id)))) {
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: "image check: hidden text" }));
      after(refusePrompt(getSupabaseServerClient(), { promptId: String(paid.prompt_id), cause: "render", detail: "hidden text", buyerUserId: recordingUserId }));
      after(removeStored([imageUrl, storedName]));
      await failIfClaimed("provider_failed");
      await releaseHeldSlot();
      return NextResponse.json(SILENT_FAILURE, { status: 500 });
    }

    // For escrow, every payment already settled when the deposit was
    // confirmed — there is no separate capture step here, unlike the legacy
    // authorize/capture rail. The RAW signature for the payment link (REC-1)
    // is whatever tx_signature the intent already carries: never the
    // redacted/truncated form the legacy branch used to store — this is
    // exactly what generation_payment_intents itself gets written with.
    let transactionHash: string | null = paid.tx_signature ?? null;
    // The intent rail charges here, after the check and BEFORE anything is
    // handed over (Kev, 2026-10-18: "wir printen nichts OHNE bestätigter
    // buchung"): only a capture the chain confirmed delivers; otherwise the
    // stored copy comes down and the buyer hears what happened.
    let capturedUnit: string | null = null;
    if (intentUnit) {
      const unit = intentUnit;
      intentUnit = null;
      capture = "started";
      const cap = await captureHeld(supabase, unit, {
        timeoutMs: Math.max(5_000, Math.min(40_000, startedAt + CAPTURE_DEADLINE_MS - Date.now())), deadlineAt: startedAt + CAPTURE_DEADLINE_MS,
      });
      if (cap.kind !== "captured") {
        after(removeStored([imageUrl, storedName]));
        if (failCtx) {
          after(recordGenerationFailure(getSupabaseServerClientSafe(), {
            ...failCtx, error: `capture ${cap.kind}, image withheld`, intentId: unit, ...(cap.kind === "unknown" ? { txSignature: cap.signature } : {}),
          }));
        }
        await releaseHeldSlot();
        if (cap.kind === "rejected") {
          return NextResponse.json({ error: "Your payment did not go through, so the image was not delivered. Nothing was charged." }, { status: 402 });
        }
        if (cap.kind === "unknown") {
          return NextResponse.json({ error: "Your payment could not be confirmed in time, so the image was not delivered. If it went through, it is refunded." }, { status: 503 });
        }
        // "Lost" is a capture another request or the sweep holds, or a lookup the database failed (nothing charged, swept
        // as Enki's): one sentence true for all of them (round 9, 2026-10-20).
        return NextResponse.json({ error: "The image was not delivered: its payment could not be claimed. If you were charged without an image, it is refunded." }, { status: 409 });
      }
      transactionHash = cap.signature;
      capturedUnit = unit;
      capture = "booked";
    }

    // Settlement's k comes from accepted image rows linked to the leased
    // units. Save both rows before acknowledging this unit as delivered.
    const m = geminiResult.metadata as {
      resolution?: string | null; bytes?: number | null; format?: string | null;
    } | undefined;
    const dims = m?.resolution?.split("x") ?? [];
    const stripped = stripWorkflowImages(body.workflow ?? {});
    const recorded = await recordGeneration(supabase, {
      adult: adult || seen.verdict === "adult", userId: recordingUserId,
      promptId: paid.prompt_id ?? null, finalPrompt: prompt, effectivePrompt: enhancedPrompt,
      variableValues: body.variableValues ?? {}, model: preflightModel, route: preflightRoute,
      boost: paid.boost, aspectRatio: body.aspectRatio || body.ratio || null,
      resolution: paidTier, seed: null,
      output: dims.length === 2 && m?.bytes
        ? { width: Number(dims[0]) || 0, height: Number(dims[1]) || 0, bytes: m.bytes, format: m.format ?? "" }
        : null,
      imageUrl, previewUrl: null, thumbnailUrl: null, mimeType: `image/${format}`,
      generationMs: geminiResult.generationTime ?? null,
      workflow: stripped.workflow, workflowTexts: stripped.texts, chainKey,
      // The payment link (REC-1): the raw on-chain signature, what the buyer
      // actually paid (derived from the intent's total, micro-USDC to cents),
      // and the intent id itself — never guessed, read back from `paid`.
      transactionHash,
      amountPaidCents: typeof paid.total_micro === "number" ? Math.round(paid.total_micro / 10_000) : null,
      // The same total, exact (Kev, 2026-10-18: "store defo exact usdc amount").
      amountPaidMicro: typeof paid.total_micro === "number" ? paid.total_micro : null,
      // On the intent rail the unit row, which carries this image's capture.
      paymentIntentId: capturedUnit ?? intentId,
      rail: "web",
      // Escrow settles by counting accepted image rows, so its record must land; an intent capture is already
      // booked, and a paid image is handed over even if the gallery record fails (that one alerts the admins).
    }, { requireAcceptedImage: rail === "escrow" });
    if (!recorded && rail === "escrow") throw new GenerationRecordError("record returned no generation id");
    const generationId = recorded?.generationId ?? null;
    const imageId = recorded?.imageId ?? null;
    /* The vendor's bill for THIS image is the price the next buyer is quoted
       (Kev, 2026-10-13), and a bill that moved against the cell in force
       mails the admins (Kev, 2026-09-05). Only the priced route's bill
       becomes the cell; a fallback host's is kept for the record. */
    if (typeof geminiResult.usage?.costUsd === "number") {
      const usage = geminiResult.usage as { costUsd: number; imageOutputTokens?: number };
      after(observePrice(getSupabaseServerClientSafe(), {
        modelFamily: toModelFamily(chosen.name),
        provider: route.provider,
        providerModel: route.providerModel,
        resolution: paidTier,
        quality: effQuality,
        role: paid.boost ? "boost" : "normal",
        priced: route.primary === true,
        tokens: usage.imageOutputTokens ?? null,
        observedUsd: usage.costUsd,
        generationId,
      }));
    }
    let reconciliationPending = false;
    if (rail === "escrow") {
      const held = consumedUnit;
      if (!held || !generationId) throw new GenerationRecordError("no consumed escrow unit at delivery");
      try {
        await deliverGenerationEscrowUnit(supabase, held.claim, generationId);
      } catch {
        // A lost acknowledgement may hide a committed delivery. This RPC is
        // idempotent, and a failure can never undo an already delivered unit.
        try { await deliverGenerationEscrowUnit(supabase, held.claim, generationId); }
        catch { reconciliationPending = true; await failIfClaimed(); }
      }
      if (consumedUnit) {
        consumedUnit = null;
        scheduleReconciliation(held);
      }
    }
    // Input history is optional. Slow reference uploads cannot hold delivery
    // or alter the database count used for settlement.
    if (generationId) after(async () => {
      try {
        const references = await storeReferenceImages(
          stripped.images.length ? stripped.images.map((img) => (refs.includes(img) ? img : "")) : refs,
          recordingUserId,
        );
        await recordGenerationReferences(supabase, generationId, references);
      } catch { console.error("[generation] input history pending", generationId); }
    });
    if (generationId) after(async () => {
      try {
        await recordGenerationRenditions(supabase, generationId, recordingUserId, imageUrl, storeDeadline(startedAt));
      } catch { console.error("[generation] image previews pending", generationId); }
    });

    await releaseHeldSlot();

    // Return image with payment metadata and headers
    return NextResponse.json(
      {
        imageUrl,
        imageId,
        prompt: fromArtist ? undefined : enhancedPrompt,
        provider: preflightRoute.provider,
        model: geminiResult.metadata?.model || preflightRoute.providerModel,
        generationTime: geminiResult.generationTime,
        paymentScheme: rail,
        generationId,
        reconciliationPending,
        metadata: {
          ...paymentMetadata,
          geminiMetadata: geminiResult.metadata,
        },
      },
      { status: 200 },
    );
  } catch (e: unknown) {
    if (e instanceof EscrowPaymentError) {
      await failIfClaimed();
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    if (e instanceof GenerationRecordError) {
      // The user gets the fixed sentence; the step that refused goes to the
      // log and to generation_failures (found on devnet 2026-10-13: a provider
      // CHECK refused every WaveSpeed/OpenAI row and nothing said so).
      const reason = `record: ${e.reason ?? "unknown"}`;
      console.error("[generate]", reason);
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: reason }));
      await failIfClaimed();
      return NextResponse.json({
        error: "Your image could not be saved. Its payment is being reconciled. Please check your history before starting a new request.",
        refundPending: true,
      }, { status: 503 });
    }
    const message = providerFailure(e instanceof Error ? e.message : String(e), artistText);
    console.error("Generate image error:", message);
    if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: message }));
    await failIfClaimed();
    // A throw before the claim (an unreachable database in resolveModel) left the unit open, and the batch's cancel
    // would count it as the buyer's dropped unit: Enki's, as refuseOurs voids it (round 8, 2026-10-20).
    await voidOpenUnit();
    // Before the rail is known nothing was touched; on the intent rail nothing is charged before the capture, a capture
    // that threw is settled by the sweep (a refund if it landed), and one that was booked stays charged; escrow keeps
    // its words.
    const SILENT_FAILURE = !knownRail ? { ...baseSilentFailureBody, error: "Image generation failed." }
      : knownRail !== "intent" ? ESCROW_SILENT_FAILURE
      : capture === "started" ? { ...baseSilentFailureBody, error: "Image generation failed. If this image was charged, it is refunded." }
      : capture === "booked" ? { ...baseSilentFailureBody, error: "Image generation failed." }
      : baseSilentFailureBody;
    // An outage before anything was charged is said as one, not as "sign in"
    // or a failed generation.
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    return NextResponse.json(SILENT_FAILURE, { status: 500 });
  } finally {
    // Unavoidable, because the early returns between taking the slot and
    // answering are the ones that matter: a refused claim leaking its slot
    // would refuse the buyer's retry too. releaseHeldSlot() nulls its own
    // reference, so the explicit calls on the success and failure paths stay
    // correct.
    await releaseHeldSlot();
  }
}
