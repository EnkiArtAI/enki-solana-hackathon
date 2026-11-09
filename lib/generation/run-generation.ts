"use client";

/** Every surface uses the selected catalogue model and one funded escrow per paid batch. */
import { ensureCdpWallet } from "@/lib/cdp-bridge";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { tooLargeToSend, REFS_TOO_LARGE } from "@/lib/request-size";
import { cancelledStepUp, withRenderStepUp } from "@/lib/ui/kit/render-stepup";
import { freeRenderToken, HUMAN_CHECK_FAILED } from "@/lib/ui/kit/human-check";
import {
  authorizePaidGeneration, cancelPaidGeneration, onceMoreAfterLimit, resumePaidGeneration, CheckoutError,
  type EscrowCheckout, type PaymentSigner, type QuoteRequest,
} from "@/lib/generation-checkout";
import type { CatalogueEntry } from "@/hooks/useModelLimits";

export interface GenerationRequest {
  model: CatalogueEntry | undefined;
  resolution: "1K" | "2K" | "4K";
  quality?: "low" | "medium" | "high";
  boost?: boolean;
  prompt: string;
  promptId?: string;
  variableValues?: Record<string, string>;
  aspectRatio: string;
  referenceImages?: string[];
  workflow?: unknown;
  authoring?: boolean;
}
export type GenerationPhase = "prepare" | "authorization" | "generation";
/** Saved with a failed job so Retry cannot purchase or request the image twice. */
export type GenerationPayment = EscrowCheckout & { unitIndex: number; generationSubmitted: boolean };
export type GenerationOutcome =
  | { ok: true; imageUrl: string; data: Record<string, unknown>; payment?: GenerationPayment }
  | { ok: false; error: string; phase?: GenerationPhase; status?: number; data?: Record<string, unknown>; payment?: GenerationPayment };
/** What a queue watches a batch for (Kev, 2026-10-13: cancel "solange der API call noch nicht abgeschickt wurde"). */
export interface BatchWatch {
  /** Said right before unit `index`'s image request goes out; from then on it cannot be cancelled. */
  onSend?: (index: number) => void;
  /**
   * Asked before anything is opened, spent or sent for unit `index`: true
   * leaves it out. A batch whose units are all left out stops before the
   * wallet opens or a deposit is submitted; a deposit already made comes
   * back through the batch's close, like any unstarted unit's.
   */
  cancelled?: (index: number) => boolean;
}
const CANCELLED = "Cancelled before it was sent.";
function quoteFor(req: GenerationRequest): QuoteRequest {
  return {
    promptId: req.promptId, modelId: req.model!.id, resolution: req.resolution,
    quality: req.model!.supportsQuality ? req.quality : undefined,
    boost: req.boost === true && req.model!.boostAvailable === true,
    referenceImageCount: req.referenceImages?.length ?? 0,
  };
}
function contentFor(req: GenerationRequest) {
  return {
    prompt: req.prompt, variableValues: req.variableValues, aspectRatio: req.aspectRatio,
    referenceImages: req.referenceImages, workflow: req.workflow, authoring: req.authoring,
  };
}
async function generate(req: GenerationRequest, payment?: GenerationPayment, beforeRequest?: () => Promise<void>, cancelled?: () => boolean): Promise<GenerationOutcome> {
  const submitted = payment ? { ...payment, generationSubmitted: true } : undefined;
  try {
    // The human check of a free render, before it counts as sent: it can wait for a click, and be cancelled during that.
    let turnstileToken: string | null = null;
    if (req.model!.free) {
      try { turnstileToken = await freeRenderToken(); }
      catch { return { ok: false, phase: "prepare", error: HUMAN_CHECK_FAILED }; }
      if (cancelled?.()) return { ok: false, phase: "prepare", error: CANCELLED };
    }
    await beforeRequest?.();
    const send = (h: Record<string, string>) => fetch(req.model!.free ? "/api/generate-free" : "/api/generate-image", {
      method: "POST", headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },
      body: JSON.stringify(req.model!.free ? {
        ...contentFor(req), modelId: req.model!.id, promptId: req.promptId, resolution: req.resolution,
        ...(turnstileToken ? { turnstileToken } : {}),
      } : { ...contentFor(req), intentId: payment!.intentId, unitIndex: payment!.unitIndex }),
    });
    // A free render is its own first request: the render switch asks there. A paid one asked at its intent; refused by
    // the shared per-address limit, before its unit was read, it is sent once more (round 17, 2026-10-20).
    const res = req.model!.free ? await withRenderStepUp(send) : await onceMoreAfterLimit(await send({}), () => send({}));
    if (await cancelledStepUp(res)) return { ok: false, phase: "generation", error: "Not confirmed. Nothing was generated.", status: 401 };
    const data = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    if (!res.ok) return { ok: false, phase: "generation", error: typeof data.error === "string" ? data.error : "Generation could not finish.", status: res.status, data, ...(submitted ? { payment: submitted } : {}) };
    return typeof data.imageUrl === "string"
      ? { ok: true, imageUrl: data.imageUrl, data, ...(submitted ? { payment: submitted } : {}) }
      : { ok: false, phase: "generation", error: "No image returned", data, ...(submitted ? { payment: submitted } : {}) };
  } catch {
    return { ok: false, phase: "generation", error: "Connection lost. Check your gallery and payment status before trying again.", ...(submitted ? { payment: submitted } : {}) };
  }
}
/** Paid units share terms, one deposit, and their original indexes. A free unit requires an explicit free-model choice. */
export async function runGenerationBatch(reqs: GenerationRequest[], sign: PaymentSigner,
  onOutcome?: (outcome: GenerationOutcome, index: number) => void,
  resume?: GenerationPayment[], onPayment?: (payments: GenerationPayment[]) => void | Promise<void>,
  watch?: BatchWatch): Promise<GenerationOutcome[]> {
  const left = (index: number) => watch?.cancelled?.(index) === true;
  const abandoned = () => reqs.every((_, index) => left(index));
  const finishAll = (error: string, phase: GenerationPhase = "prepare", payment: EscrowCheckout | undefined = resume?.[0]) => reqs.map((req, index): GenerationOutcome => {
    const paidIndex = reqs.slice(0, index).filter(item => item.model && !item.model.free).length;
    const out: GenerationOutcome = { ok: false, phase, error,
      ...(payment && (resume?.[index] || (req.model && !req.model.free)) ? { payment: { ...payment, unitIndex: resume?.[index]?.unitIndex ?? paidIndex, generationSubmitted: resume?.[index]?.generationSubmitted ?? false } } : {}) };
    onOutcome?.(out, index);
    return out;
  });
  if (!reqs.length || reqs.length > 24) return finishAll("Choose between one and twenty-four images.");
  if (reqs.some(req => !req.model)) return finishAll("Pick a model first. Nothing was generated and nothing was charged.");
  if (reqs.some(tooLargeToSend)) return finishAll(REFS_TOO_LARGE);
  const paid = reqs.filter(req => !req.model!.free);
  if (reqs.length - paid.length > 1) return finishAll("Only one image from the free model is available each day. Choose a paid model for the remaining images.");
  const quote = paid[0] ? quoteFor(paid[0]) : null;
  if (paid.some(req => JSON.stringify(quoteFor(req)) !== JSON.stringify(quote))) {
    return finishAll("Choose the same paid model and settings for all paid images in this order.");
  }
  if (resume && (paid.length !== reqs.length || resume.length !== reqs.length ||
      resume.some(item => !Number.isInteger(item.unitIndex) || item.unitIndex < 0 ||
        item.unitIndex >= item.units || item.state === "expired" || item.intentId !== resume[0].intentId || item.units !== resume[0].units) ||
      new Set(resume.map(item => item.unitIndex)).size !== resume.length)) {
    return finishAll("This image was already requested. Check your gallery and payment status before placing another order.", "generation", resume[0]);
  }
  let paidIndex = 0;
  const indexes = reqs.map((req, index) => req.model!.free ? undefined : resume?.[index]?.unitIndex ?? paidIndex++);
  const sent = new Set(resume?.filter(item => item.generationSubmitted).map(item => item.unitIndex));
  let checkpointTurn: Promise<void> = Promise.resolve();
  const checkpoint = (checkout: EscrowCheckout) => {
    const operation = checkpointTurn.then(async () => {
      await onPayment?.(indexes.flatMap(unitIndex => unitIndex === undefined ? [] : [{ ...checkout, unitIndex, generationSubmitted: sent.has(unitIndex) }]));
    });
    checkpointTurn = operation.catch(() => undefined);
    return operation;
  };
  let payment: EscrowCheckout | undefined;
  let phase: GenerationPhase = "prepare";
  try {
    if (abandoned()) return finishAll(CANCELLED);
    if (paid.length) {
      if (!resume) await ensureCdpWallet({ attached: true });
      phase = "authorization";
      payment = resume ? await resumePaidGeneration(resume[0], checkpoint) : await authorizePaidGeneration(quote!, sign, paid.length, checkpoint, abandoned);
    }
  } catch (error) {
    return finishAll(error instanceof Error ? error.message : "The payment could not be prepared.", phase,
      error instanceof CheckoutError ? error.payment : resume?.[0]);
  }
  const outcomes = await Promise.all(reqs.map(async (req, index) => {
    const unitIndex = indexes[index];
    const unit = unitIndex === undefined ? undefined : payment?.unitStatuses?.find(item => item.unit_index === unitIndex);
    const previous = resume?.[index];
    let result: GenerationOutcome;
    if (unit?.state === "delivered" && unit.imageUrl) {
      result = { ok: true, imageUrl: unit.imageUrl, data: { generationId: unit.generation_id }, payment: { ...payment!, unitIndex: unitIndex!, generationSubmitted: true } };
    } else if (previous?.generationSubmitted || (unit && unit.state !== "pending")) {
      // An intent unit that failed was either never charged or is owed back in full (DEC-88): never "unused".
      const error = unit?.state === "delivered" ? "This image is already in your gallery." : unit?.state === "failed"
        ? (payment?.paymentScheme === "intent" ? "This image could not finish. If it was charged, the amount is refunded." : "This image could not finish. Its unused payment is being refunded.")
        : "This image was already requested and is still being checked. It will not be requested again.";
      result = { ok: false, phase: "generation", error, payment: { ...payment!, unitIndex: unitIndex!, generationSubmitted: true } };
    } else if (left(index)) {
      // Taken back while the batch was being paid for: never requested; its unit is closed with the batch.
      result = { ok: false, phase, error: CANCELLED, ...(unitIndex === undefined ? {} : { payment: { ...payment!, unitIndex, generationSubmitted: false } }) };
    } else result = await generate(req, unitIndex === undefined ? undefined : { ...payment!, unitIndex, generationSubmitted: false }, async () => {
      watch?.onSend?.(index);
      if (unitIndex === undefined) return;
      sent.add(unitIndex);
      await checkpoint(payment!);
    }, () => left(index));
    onOutcome?.(result, index);
    return result;
  }));
  // Stops unstarted units after all client requests ended; any in-flight server lease may still finish.
  if (payment) await cancelPaidGeneration(payment).catch(() => undefined);
  return outcomes;
}
/**
 * Whether a failed image still waits on its payment, so it is kept to be
 * checked again: an expired order holds nothing, and a unit the server
 * reports failed or delivered is finished (round 4, 2026-10-19: checking a
 * finished unit again marked it unresolved again, so the banner never left).
 */
export function awaitsPayment(outcome: GenerationOutcome): boolean {
  return !outcome.ok && Boolean(outcome.payment) && unitState(outcome.payment!) === "open";
}

/** Where a paid image's payment stands: its order expired, its unit failed or was delivered, or it is still open. */
export function unitState(payment: GenerationPayment): "expired" | "failed" | "delivered" | "open" {
  if (payment.state === "expired") return "expired";
  const state = payment.unitStatuses?.find((unit) => unit.unit_index === payment.unitIndex)?.state;
  return state === "failed" || state === "delivered" ? state : "open";
}
export async function runGeneration(req: GenerationRequest, sign: PaymentSigner, resume?: GenerationPayment): Promise<GenerationOutcome> {
  return (await runGenerationBatch([req], sign, undefined, resume ? [resume] : undefined))[0];
}
