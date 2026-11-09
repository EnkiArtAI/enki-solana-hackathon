"use client";

/**
 * Server-priced checkout on the rail the server opened the order on
 * (lib/payments/rail.ts): escrow, where one submitted deposit moves the funds
 * into escrow and a retry reuses it; or intent, where the buyer signs one
 * payment per image and each is charged only after its image is made.
 */
import { sessionAuthHeaders } from "@/lib/session-headers";
import { cancelledStepUp, withRenderStepUp } from "@/lib/ui/kit/render-stepup";

/** The models table stores display names; pricing keys are their slugs. */
/* Re-exported, not redefined: the server enforces the same key and cannot
   import this file (see lib/generation/model-family.ts). */
export { toModelFamily } from "@/lib/generation/model-family";

/** Integer micro-USDC (string, as the API serialises u64s) → display dollars. */
export function microToUsd(micro: string | number): string {
  const n = typeof micro === "string" ? Number(micro) : micro;
  if (!Number.isFinite(n)) return "0.00";
  return (n / 1_000_000).toFixed(n % 10_000 === 0 ? 2 : 3);
}

export interface GenerationQuote {
  /** Integer micro-USDC, for totals over several images. */
  totalMicro: number;
  totalUsd: string;
  networkFeeUsd: string;
  artistUsd: string;
  expiresAt: string;
  appliedRule: { name: string } | null;
  /** The catalogue's number, shown until the server answers (lib/ui/kit/price estimatedQuote); the intent charges the server's. */
  estimated?: boolean;
}

/** The sum of settings the server prices and the intent stores (lib/payments/generation-settings.ts). */
export interface QuoteRequest {
  /** Absent for the buyer's own prompt (the editors). */
  promptId?: string;
  /** The exact catalogue row the user selected. */
  modelId: string;
  resolution: "1K" | "2K" | "4K";
  /** Boost reprices the model leg at the vendor-direct route's real cost. */
  boost?: boolean;
  quality?: "low" | "medium" | "high";
  referenceImageCount?: number;
}

/** One video's ask at /api/video/intent: its generator and its settings, one unit always. */
export interface VideoIntentRequest { promptId?: string; modelId: string; settings: object }

/** Null on any failure: a missing quote greys the paid button, never fakes a price. */
export async function fetchGenerationQuote(req: QuoteRequest): Promise<GenerationQuote | null> {
  try {
    const res = await fetch("/api/payments/generation/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify(req),
    });
    if (res.status === 404) throw new PromptUnavailable();
    if (!res.ok) return null;
    const json = (await res.json()) as { quote?: QuoteBody };
    return json.quote ? toQuote(json.quote) : null;
  } catch (e) {
    if (e instanceof PromptUnavailable) throw e;
    return null;
  }
}

/**
 * The quote's "not for sale": the prompt was taken down, deleted or never
 * listed. Unlike every other missing quote, waiting will not bring this one,
 * so the buyer is told instead of shown a price that never loads.
 */
export class PromptUnavailable extends Error {
  constructor() {
    super("This prompt is no longer available.");
    this.name = "PromptUnavailable";
  }
}

interface QuoteBody {
  expiresAt: string;
  breakdown: { totalAmount: string; networkFee: string; artistAmount: string };
  appliedRule: { name: string } | null;
}

function toQuote(q: QuoteBody): GenerationQuote {
  return {
    totalMicro: Number(q.breakdown.totalAmount),
    totalUsd: microToUsd(q.breakdown.totalAmount),
    networkFeeUsd: microToUsd(q.breakdown.networkFee),
    artistUsd: microToUsd(q.breakdown.artistAmount),
    expiresAt: q.expiresAt,
    appliedRule: q.appliedRule,
  };
}

/**
 * Many quotes in one request, in order; null where the server gave none.
 * What every picker shows next to its options (Kev, 2026-10-02: "ich
 * brauche safe überall den server-quote").
 */
export async function fetchGenerationQuotes(reqs: QuoteRequest[]): Promise<Array<GenerationQuote | null>> {
  if (!reqs.length) return [];
  try {
    const res = await fetch("/api/payments/generation/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ items: reqs.slice(0, 24) }),
    });
    // A refused request carries no quotes, so every option reads null.
    const json = ((await res.json().catch(() => null)) ?? {}) as { quotes?: Array<QuoteBody | { error: string }> };
    return reqs.map((_, i) => {
      const q = json.quotes?.[i];
      return q && "breakdown" in q ? toQuote(q) : null;
    });
  } catch {
    return reqs.map(() => null);
  }
}

export type EscrowDepositState = "prepared" | "submitting" | "submitted" | "funded" | "expired";
export interface EscrowUnitStatus {
  unit_index: number;
  state: "pending" | "running" | "delivered" | "failed";
  generation_id: string | null;
  imageUrl?: string;
}
export interface EscrowCheckout {
  intentId: string;
  units: number;
  paymentScheme: "escrow" | "intent";
  state: EscrowDepositState | "uncertain";
  unitStatuses?: EscrowUnitStatus[];
  /** Public signed wire, retained only to retry the SAME escrow deposit after a lost submit response. Never an
   *  intent's: each of those is a complete payment anyone could broadcast, and the server already holds them. */
  signedTransaction?: string;
}
export type FundedEscrowCheckout = EscrowCheckout & { state: "funded" };
export class CheckoutError extends Error {
  constructor(readonly step: "intent" | "authorize" | "sign" | "submit" | "status", message: string,
    readonly payment?: EscrowCheckout) {
    super(message);
    this.name = "CheckoutError";
  }
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...headers }, body: JSON.stringify(body),
  });
}
/**
 * Base64 transactions in, the same transactions with the buyer's signature
 * out, in order and in one wallet prompt. prepare, when the signer has one,
 * connects the wallet before an order is opened (verification 2026-10-18).
 */
export type PaymentSigner = ((transactions: string[]) => Promise<string[]>) & { prepare?: () => Promise<void> };
export type PaymentCheckpoint = (payment: EscrowCheckout) => void | Promise<void>;
async function checkpointPayment(checkpoint: PaymentCheckpoint | undefined, payment: EscrowCheckout) {
  try { await checkpoint?.(payment); }
  catch { throw new CheckoutError("submit", "The payment could not be saved safely. Check its status before continuing.", payment); }
}
const errorOf = async (res: Response, fallback: string) => {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : fallback;
};
const PENDING_PAYMENT = "Your payment is still being checked. Check its status before making another payment.";
const STATES: EscrowDepositState[] = ["prepared", "submitting", "submitted", "funded", "expired"];
async function statusBody(res: Response, payment: EscrowCheckout): Promise<EscrowCheckout> {
  if (!res.ok) throw new CheckoutError("status", PENDING_PAYMENT, payment);
  const body = await res.json().catch(() => null) as { intentId?: string; paymentScheme?: string; state?: EscrowDepositState; funded?: boolean; units?: EscrowUnitStatus[] } | null;
  if (!body || body.intentId !== payment.intentId || body.paymentScheme !== payment.paymentScheme || !body.state ||
      !STATES.includes(body.state) || body.funded !== (body.state === "funded")) {
    throw new CheckoutError("status", PENDING_PAYMENT, payment);
  }
  if (body.units !== undefined && (!Array.isArray(body.units) || body.units.some(unit => !unit ||
      !Number.isInteger(unit.unit_index) || unit.unit_index < 0 || unit.unit_index >= payment.units ||
      !["pending", "running", "delivered", "failed"].includes(unit.state) ||
      // A paid intent image whose gallery record was lost is delivered without a generation (DEC-88).
      (unit.state === "delivered" ? typeof unit.generation_id !== "string" && !(payment.paymentScheme === "intent" && unit.generation_id === null)
        : unit.generation_id !== null) ||
      (unit.imageUrl !== undefined && (unit.state !== "delivered" || typeof unit.imageUrl !== "string" || !unit.imageUrl.startsWith("https://")))) ||
      new Set(body.units.map(unit => unit.unit_index)).size !== body.units.length)) {
    throw new CheckoutError("status", PENDING_PAYMENT, payment);
  }
  return { ...payment, state: body.state, ...(body.units ? { unitStatuses: body.units } : {}) };
}
async function submitSameDeposit(payment: EscrowCheckout, onPayment?: PaymentCheckpoint): Promise<EscrowCheckout> {
  if (!payment.signedTransaction) throw new CheckoutError("submit", PENDING_PAYMENT, payment);
  await checkpointPayment(onPayment, payment);
  try {
    const res = await post("/api/payments/generation/submit", {
      intentId: payment.intentId, signedTransaction: payment.signedTransaction,
    });
    const current = await statusBody(res, payment);
    await checkpointPayment(onPayment, current);
    return current;
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError("submit", PENDING_PAYMENT, { ...payment, state: "uncertain" });
  }
}
/**
 * The intent order's submit: every unit's signed payment at once, kept
 * nowhere on the device. A refusal (4xx) held nothing: the server voided the
 * order before answering and says why, so the buyer reads that sentence and
 * no payment is left pending. An answer that never came, or a 5xx, may hide
 * an order the server stored: its status is asked at once, so a funded order
 * renders instead of waiting to be swept as abandoned, which counts against
 * the buyer (round 4, 2026-10-19).
 */
async function submitIntentOrder(payment: EscrowCheckout, signedTransactions: string[], onPayment?: PaymentCheckpoint,
  abandoned?: () => boolean): Promise<EscrowCheckout> {
  await checkpointPayment(onPayment, payment);
  // Taken back while the checkpoint saved (round 19) or while a shared limit's wait ran (round 18): the order is let
  // go and the signature goes nowhere, the rule authorizePaidGeneration keeps up to the submit (2026-10-20).
  const letGoIfTaken = () => {
    if (!abandoned?.()) return;
    void post("/api/payments/generation/cancel", { intentId: payment.intentId }).catch(() => undefined);
    throw new CheckoutError("submit", CANCELLED);
  };
  letGoIfTaken();
  // A lost answer is asked below; a shared limit's refusal is sent once more, the payments held only in memory.
  const send = () => post("/api/payments/generation/submit", { intentId: payment.intentId, signedTransactions }).catch(() => null);
  const res = await onceMoreAfterLimit(await send(), async () => { letGoIfTaken(); return send(); });
  if (res && res.status >= 400 && res.status < 500) throw new CheckoutError("submit", await errorOf(res, NOT_CONFIRMED));
  let current = res?.ok ? await statusBody(res, payment) : await checkPaidGenerationStatus(payment);
  // A submit whose answer was lost may still be storing the order: the intent rail reports it "prepared" until then,
  // so it is asked again over the same 30 s as an escrow deposit (round 5, 2026-10-20).
  for (const ms of res?.ok ? [] : CONFIRM_WAITS_MS) {
    if (current.state !== "prepared") break;
    await sleep(ms);
    current = await checkPaidGenerationStatus(current);
  }
  await checkpointPayment(onPayment, current);
  return current;
}
/**
 * A request a shared per-address limit refused (429 with Retry-After: met before the request is read, so nothing was
 * stored or claimed) is sent once more after its wait, at most 60 s; any other answer stands. Others on the buyer's
 * address could otherwise get a signed order refused, then swept or cancelled as the buyer's dropped units (round 17,
 * 2026-10-20). The other 429s (the per-account limit, the concurrency cap) carry no Retry-After.
 */
export async function onceMoreAfterLimit<R extends Response | null>(res: R, send: () => Promise<R>): Promise<R> {
  const header = res?.status === 429 ? res.headers.get("Retry-After") : null;
  const seconds = header === null ? NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) return res;
  await sleep(seconds * 1000);
  return send();
}
/**
 * How long a submitted deposit is asked about again before the order is left
 * as pending, 30 s in all. A Solana confirmation takes a few seconds: asking
 * once, right after the submit, found nearly every deposit unconfirmed, so
 * the buyer had paid into the escrow and got "still being checked" instead of
 * the image until they pressed Check payment (Kev's first browser payment,
 * 2026-10-13).
 */
export const CONFIRM_WAITS_MS = [1000, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 5000, 5000];
const sleep = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms); });
/** Never opens an intent or a wallet. Resume only the already signed deposit. */
export async function resumePaidGeneration(payment: EscrowCheckout, onPayment?: PaymentCheckpoint): Promise<FundedEscrowCheckout> {
  let current: EscrowCheckout;
  try {
    current = await checkPaidGenerationStatus(payment);
    if (current.state === "prepared" && current.signedTransaction) current = await submitSameDeposit(current, onPayment);
    // On its way to the chain: wait for the receipt. Every other state is an answer already.
    for (const ms of CONFIRM_WAITS_MS) {
      if (current.state !== "submitted" && current.state !== "submitting") break;
      await sleep(ms);
      current = await checkPaidGenerationStatus(current);
    }
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError("status", PENDING_PAYMENT, payment);
  }
  if (current.state === "expired") {
    throw new CheckoutError("status", "This payment has expired. Check your balance and payment history before starting another order.", current);
  }
  if (current.state !== "funded") throw new CheckoutError("status", PENDING_PAYMENT, current);
  await checkpointPayment(onPayment, current);
  return { ...current, state: "funded" };
}
const CANCELLED = "Cancelled before anything was charged.";
const NOT_CONFIRMED = "Not confirmed. Nothing was charged.";
/**
 * One signed escrow deposit for every paid image in this click. `abandoned`
 * is asked before each step up to the submit: once true the line stops cold,
 * and a signature already given is never submitted (Kev, 2026-10-13).
 */
export async function authorizePaidGeneration(req: QuoteRequest | VideoIntentRequest, sign: PaymentSigner, units = 1, onPayment?: PaymentCheckpoint,
  abandoned?: () => boolean, intentPath = "/api/payments/generation/intent"): Promise<FundedEscrowCheckout> {
  if (!Number.isInteger(units) || units < 1 || units > 24) throw new CheckoutError("intent", "Choose between one and twenty-four images.");
  const unless = (step: CheckoutError["step"]) => { if (abandoned?.()) throw new CheckoutError(step, CANCELLED); };
  // The wallet connects before anything is opened: the phone's wallet app spends this tap on the connect, and an order
  // opened before it would be dropped and counted against the buyer (verification 2026-10-18). First, so the tap's
  // activation is still fresh.
  try { await sign.prepare?.(); }
  catch (error) {
    if (error instanceof CheckoutError) throw error;
    // A refused connect is a cancel, told apart by the same words as a refused signature (render-queue settle).
    throw new CheckoutError("sign", error instanceof Error && /reject|denied|cancel/i.test(error.message)
      ? "Connecting was cancelled. Nothing was charged." : "The wallet could not connect. Nothing was charged.");
  }
  // Asked after the connect: a job taken back while the connect waited its turn requests no order.
  unless("intent");
  let intentRes: Response;
  // The render switch of the Settings table asks here, before anything is built or signed.
  try { intentRes = await withRenderStepUp((h) => post(intentPath, req, h)); }
  catch { throw new CheckoutError("intent", "Could not prepare the payment. Please try again."); }
  if (await cancelledStepUp(intentRes)) throw new CheckoutError("intent", NOT_CONFIRMED);
  if (!intentRes.ok) throw new CheckoutError("intent", await errorOf(intentRes, "Could not prepare the payment"));
  const intentBody = await intentRes.json().catch(() => null) as { intent?: { id?: string } } | null;
  const intentId = intentBody?.intent?.id;
  if (!intentId) throw new CheckoutError("intent", "Could not prepare the payment");
  unless("authorize");
  let authRes: Response;
  try { authRes = await post("/api/payments/generation/authorize", { intentId, units }); }
  catch { throw new CheckoutError("authorize", "Could not build the payment. Please try again."); }
  if (!authRes.ok) throw new CheckoutError("authorize", await errorOf(authRes, "Could not build the payment"));
  const prepared = await authRes.json().catch(() => null) as { intentId?: string; transaction?: string; transactions?: unknown; units?: number; paymentScheme?: string } | null;
  // Escrow: one deposit for the order. Intent: one payment per image, all signed in one wallet window (DEC-89).
  const scheme = prepared?.paymentScheme;
  const intentTxs = prepared?.transactions;
  const toSign = scheme === "escrow" && prepared?.transaction ? [prepared.transaction]
    : scheme === "intent" && Array.isArray(intentTxs) && intentTxs.length === units && intentTxs.every((tx) => typeof tx === "string" && tx) ? intentTxs as string[]
    : null;
  if (!toSign || prepared?.intentId !== intentId || prepared.units !== units) {
    throw new CheckoutError("authorize", "Could not build the payment");
  }
  let signed: string[] = [];
  try {
    unless("sign");
    try {
      signed = await sign(toSign);
      if (signed.length !== toSign.length || signed.some((tx) => !tx)) throw new Error("The wallet returned no signature.");
    }
    catch (error) {
      if (error instanceof CheckoutError) throw error;
      throw new CheckoutError("sign", error instanceof Error && /reject|denied|cancel/i.test(error.message)
        ? "Signing was cancelled. Nothing was charged." : "The wallet could not sign. Nothing was charged.");
    }
    // Taken back while the wallet was open: the signature goes nowhere.
    unless("sign");
  } catch (error) {
    // An unsigned intent order holds opened units against the buyer's open-image limit and USDC: let them go now,
    // not when the sweep finds them minutes later (review 2026-10-18). Escrow's unsigned deposit holds nothing.
    if (scheme === "intent") void post("/api/payments/generation/cancel", { intentId }).catch(() => undefined);
    throw error;
  }
  const payment = scheme === "intent"
    ? await submitIntentOrder({ intentId, units, paymentScheme: "intent", state: "uncertain" }, signed, onPayment, abandoned)
    : await submitSameDeposit({ intentId, units, paymentScheme: "escrow", state: "uncertain", signedTransaction: signed[0] }, onPayment);
  if (payment.state === "funded") return { ...payment, state: "funded" };
  return resumePaidGeneration(payment, onPayment);
}
/** Close unstarted units; already admitted generations may finish. */
export async function cancelPaidGeneration(payment: EscrowCheckout): Promise<void> {
  try {
    const res = await post("/api/payments/generation/cancel", { intentId: payment.intentId });
    if (!res.ok) throw new CheckoutError("status", "The remaining images could not be cancelled yet. Check the payment status.", payment);
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError("status", "The remaining images could not be cancelled yet. Check the payment status.", payment);
  }
}
export interface FreeGenerationQuota { used: number; limit: number; remaining: number; exhausted: boolean; resetsAt: null }
/** Unknown quota never becomes a fabricated free allowance. */
export async function fetchFreeGenerationQuota(): Promise<FreeGenerationQuota | null> {
  try {
    const res = await fetch("/api/generate-free/quota", { headers: sessionAuthHeaders(), cache: "no-store" });
    if (!res.ok) return null;
    const body = await res.json() as { freeQuota?: FreeGenerationQuota };
    const q = body.freeQuota;
    // Two per account, ever (lib/generation/free-quota FREE_GENERATIONS_PER_ACCOUNT, server-only); nothing resets.
    return q && Number.isInteger(q.used) && q.used >= 0 && q.limit === 2 &&
      Number.isInteger(q.remaining) && q.remaining >= 0 && q.remaining <= q.limit &&
      q.remaining === Math.max(0, q.limit - q.used) && q.exhausted === (q.remaining === 0) && q.resetsAt === null ? q : null;
  } catch { return null; }
}
export type PendingEscrowPayment = EscrowCheckout & { unitIndex: number; generationSubmitted: boolean };
const pendingKey = (owner: string) => "enki-pending-escrow:v1:" + owner;
/** Persist public payment identity only. Draft prompts and reference images are not stored here. */
export function storePendingEscrowPayments(storage: Pick<Storage, "setItem" | "removeItem">,
  owner: string, payments: PendingEscrowPayment[] | null): boolean {
  try {
    if (!payments?.length) storage.removeItem(pendingKey(owner));
    else storage.setItem(pendingKey(owner), JSON.stringify(payments.map(payment => ({
      intentId: payment.intentId, units: payment.units, paymentScheme: payment.paymentScheme,
      state: payment.state, ...(payment.paymentScheme === "escrow" ? { signedTransaction: payment.signedTransaction } : {}),
      unitIndex: payment.unitIndex, generationSubmitted: payment.generationSubmitted,
    }))));
    return true;
  } catch { return false; }
}
export function readPendingEscrowPayments(storage: Pick<Storage, "getItem">, owner: string): PendingEscrowPayment[] {
  try {
    const stored: unknown = JSON.parse(storage.getItem(pendingKey(owner)) ?? "[]");
    if (!Array.isArray(stored) || stored.length > 24 || stored.some(payment => !payment ||
        typeof payment.intentId !== "string" || !payment.intentId || !Number.isInteger(payment.units) || payment.units < 1 || payment.units > 24 ||
        !["escrow", "intent"].includes(payment.paymentScheme) || ![...STATES, "uncertain"].includes(payment.state) ||
        !Number.isInteger(payment.unitIndex) || payment.unitIndex < 0 || payment.unitIndex >= payment.units ||
        typeof payment.generationSubmitted !== "boolean" ||
        (payment.signedTransaction !== undefined && (typeof payment.signedTransaction !== "string" || payment.paymentScheme !== "escrow")) ||
        payment.intentId !== stored[0].intentId || payment.units !== stored[0].units) ||
        new Set(stored.map(payment => payment.unitIndex)).size !== stored.length) return [];
    return stored;
  } catch { return []; }
}

/** Read-only recovery after reload: never submits or rebuilds a deposit. */
export async function checkPaidGenerationStatus(payment: EscrowCheckout): Promise<EscrowCheckout> {
  try {
    const res = await fetch("/api/payments/generation/status?intentId=" + encodeURIComponent(payment.intentId), { headers: sessionAuthHeaders(), cache: "no-store" });
    return await statusBody(res, payment);
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError("status", PENDING_PAYMENT, payment);
  }
}
