/**
 * x402 entrance for AGENTS — image generation as a payable HTTP resource
 * (Kev, 2026-08-23: "wir bauen das alles erst auf solana aus, damit agents
 * auch zugriff auf unsere prompts haben können").
 *
 * The protocol (x402): a request without payment answers HTTP 402 carrying
 * EXACT payment requirements; the agent builds a Solana transaction paying
 * them (one USDC TransferChecked to the platform wallet, OUR fee payer as
 * payer — only USDC needed, never SOL), partially signs it and resends with
 * the X-PAYMENT header. We verify offline, co-sign, submit with preflight,
 * generate, and answer with the image plus X-PAYMENT-RESPONSE.
 *
 *   GET  /api/x402/generate?modelFamily=…      → 402 requirements (probe)
 *   POST /api/x402/generate                    → 402 without X-PAYMENT
 *        { prompt } or { promptId, variableValues? }, plus the model
 *        { modelFamily } and optional { resolution, aspectRatio, quality }
 *   POST + X-PAYMENT                           → settle, generate, 200
 *
 * Prices are THE SAME ladders humans pay. Since 2026-08-24 (Kev: "i want
 * agents to purchase artists prompts") priced prompts settle too. Since
 * 2026-10-17 Enki sells the render (Kev: "verkäufer-modell für
 * künstlerprompts"): the agent pays Enki the whole price in one
 * TransferChecked, and the artist's, the referrer's and the author's shares
 * become licence fees Enki owes, recorded after delivery (licence_credits).
 * This reverses, for x402 only, the source split of 2026-07-05 (one
 * transfer per share in the buyer's own transaction, Enki never holding the
 * artist's money); the other rails keep it. A paid prompt's body is
 * decrypted server-side for the generation only — the agent buys the
 * generation, never the text.
 *
 * Order of operations is deliberate: model, route, prompt text and
 * moderation are all resolved BEFORE the payment settles — the only thing
 * standing between a settled payment and a delivered image is the provider
 * call itself. Payment first would take money for requests we then refuse.
 *
 * The image check judges the render, so it can only run after the payment
 * settled: an agent's payment expires with its blockhash, about a minute, and
 * a slow render outlasts it, so it cannot wait for the check. What the check
 * refuses or cannot judge is withheld, its copies taken down, and recorded
 * with the signature so support can make it right.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient, getSupabaseServerClientSafe } from "@/lib/supabaseServer";
import { computeQuote } from "@/lib/payments/generation-quote";
import { allowsReferences, REFERENCES_OFF } from "@/lib/prompt-references";
import { referenceImageCount } from "@/lib/generation/provider-capabilities";
import { dbUnavailableResponse, isDbUnreachable, refusalBody, type DbOutage } from "@/lib/db-error";
import { checkAgentPromptInputs } from "@/lib/generation/agent-prompt-inputs";
import {
  modelLegMicro, computeGenerationSplit, UnknownModelError, X402_ENKI_FEE_BPS,
} from "@/lib/payments/generation-pricing";
import { usdcMint, feePayerKeypair, solanaConnection, x402ChainKey, broadcastAndConfirm } from "@/lib/payments/solana";
import bs58 from "bs58";
import { effectiveQuality } from "@/lib/pricing";
import { loadPriceCells, observePrice, priceCellFor } from "@/lib/generation/price-cells";
import {
  parseXPayment, verifyAgentPayment, cosignAsFeePayer, simulatePayment, paymentLanded, submitAndConfirm, paymentResponseHeader,
  x402Network,
} from "@/lib/payments/x402-settle";
import { checkAndRecordSolanaSignature } from "@/backend/solana-x402-verifier";
import { shareLegs, sharesOf } from "@/lib/referral/shares";
import { recordLicenceCredits, type LicenceCredit } from "@/lib/payments/licence-credits";
import { escrowServerChain } from "@/lib/payments/escrow/server-chain";
import { escrowDeployed } from "@/lib/payments/rail";
import { isSolanaChain, type ChainKey } from "@/shared/payment-config";
import { loadPromptText, fillVariables, inputsUnmatched, VALUE_MAX, buyersOwn, neutralFill, type StoredVariable } from "@/lib/generation/prompt-text";
import { checkPrompt, NOT_CHECKED, textValues, unnamedValues } from "@/lib/moderation/prompt-check";
import { showsHiddenText } from "@/lib/moderation/hidden-text";
import { letteringReleased, PROMPT_UNAVAILABLE, refusePrompt } from "@/lib/moderation/prompt-pause";
import { imageIdWithin, payerAccount, providerFailure, recordGenerationFailure, recordGeneration } from "@/lib/generation/record";
import { addressWarnedOut, addressWarningMessage, byAddress, recordWarning } from "@/lib/moderation/warnings";
import { childSafetyScore, recordModerationEvent } from "@/lib/moderation-enforcement";
import { agentBlocked, recordExtractionHit, silentFailure } from "@/lib/moderation/extraction-hits";
import { findMissingAtas } from "@/lib/payments/solana-transfer";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { moderate, screenFirst, CLIENT_BLOCK_MESSAGE } from "@/lib/moderation";
import { resolveModelByFamily, chooseRoute } from "@/lib/generation/models";
import { clampTier } from "@/lib/generation/resolution";
import { JUDGE_CALL_MICRO, releaseSpend, reserveSpend } from "@/lib/generation/spend-cap";
import { classifyFailure, mayBeBilled, reportSuccess, reportFailure, providerKeyMissing, PROVIDER_NAME } from "@/lib/generation/provider-health";
import { INLINE_MAX_BYTES, removeStored, storeDeadline, storeGeneratedImage } from "@/lib/generation/derivative-store";
import { checkImageBytes, heldBack } from "@/lib/moderation/image-check-bytes";
import { recordImageCase } from "@/lib/moderation/image-case";
import { generateImagesWithWaveSpeed } from "@/backend/services/wavespeed-image-generation";
import { generateImagesWithOpenAI } from "@/backend/services/openai-image-generation";
import { generateImagesWithGemini, readImageDimensions } from "@/backend/services/gemini-image-generation";
import type { ImageGenerationRequest } from "@/backend/services/types";
import { PublicKey } from "@solana/web3.js";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

export const maxDuration = 300;

const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

const bodySchema = z.object({
  prompt: z.string().trim().min(1).max(4000).optional(),
  promptId: z.string().uuid().optional(),
  variableValues: z.record(z.string(), z.string().max(VALUE_MAX)).optional(),
  // Required: an agent that names no model gets a refusal, never a default
  // one (Kev, 2026-10-02: "NIEMALS IRGENDEIN standardmodell").
  modelFamily: z.string({ error: "modelFamily is required" }).trim().min(1, "modelFamily is required").max(64),
  resolution: z.enum(["1K", "2K", "4K"]).default("2K"),
  aspectRatio: z.enum(RATIOS).default("1:1"),
  quality: z.enum(["low", "medium", "high"]).optional(),
  // This rail carries none, whatever is sent (below). Read only to refuse them where a prompt's creator switched them off.
  referenceImages: z.unknown().optional(),
}).refine((v) => Boolean(v.prompt) !== Boolean(v.promptId), { message: "Send prompt or promptId, not both" })
  // Values for a plain prompt would be paid for and never read.
  .refine((v) => Boolean(v.promptId) || Object.keys(v.variableValues ?? {}).length === 0, { message: "variableValues needs a promptId" });

type Input = z.infer<typeof bodySchema>;

function platformWallet(): string | null {
  return process.env.SOLANA_PLATFORM_WALLET || process.env.NEXT_PUBLIC_SOLANA_PLATFORM_WALLET || null;
}

/** Fee payer address for the 402's extra — null when settlement is unconfigured. */
function feePayerAddress(): string | null {
  try { return feePayerKeypair().publicKey.toBase58(); } catch { return null; }
}

/** The x402 chain (X402_PAYMENT_CHAIN, else the deployment's) — null when it names no Solana chain. */
function x402Chain(): ChainKey | null {
  try { return x402ChainKey(); } catch { return null; }
}

interface Priced {
  status: 402;
  body: Record<string, unknown>;
  amountMicro: number;
  /** Enki's bill for the render (micro-USD): what the daily spend breaker reserves (SQL 72). */
  modelCostMicro: number;
  /**
   * The transfer the payment must carry: one, the whole price to the
   * platform wallet. Enki sells the render (Kev, 2026-10-17), so a prompt's
   * artist, referrer and author are owed licence fees, never paid in a leg.
   */
  legs: Array<{ recipient: string; amountMicro: number }>;
  /** The licence fees a delivered render owes; none for a plain prompt. */
  credits: LicenceCredit[];
  /**
   * A marketplace prompt's filled text, for settlement, and the values that are the agent's own (what the prompt
   * check judges, round 15); neither goes into the 402 body.
   */
  prompt?: { text: string; template: string; paid: boolean; own: Record<string, unknown>; variables: StoredVariable[] };
  /** The same requirements in x402 v2, base64 for the PAYMENT-REQUIRED header. */
  paymentRequired: string;
}
type Requirements = Priced | { status: 400 | 404 | 422 | 500 | 503; body: { error: string } };

/**
 * A marketplace prompt's text filled with the agent's values, or why not.
 * Only a live prompt is for sale, and every value must belong to a declared
 * variable, fit it and land in a slot, so an agent never pays for an input
 * that is ignored (agent-prompt-inputs). The 402 and settlement refuse the
 * same requests. The text never leaves the server.
 */
async function agentPrompt(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  promptId: string,
  values: Input["variableValues"],
): Promise<{ ok: true; text: string; template: string; adult: boolean; paid: boolean; own: Record<string, unknown>; variables: StoredVariable[] } | { ok: false; status: 400 | 404 | 422 | 500; error: string } | DbOutage> {
  const inputs = await checkAgentPromptInputs(supabase, promptId, values);
  if (!inputs.ok) return inputs;
  const text = await loadPromptText(supabase, promptId);
  if (!text.ok) return text;
  const filled = fillVariables(text.text, Object.fromEntries(inputs.values), inputs.variables);
  if (inputsUnmatched(filled)) {
    return { ok: false, status: 422, error: "This prompt's inputs could not be matched to its text — nothing was charged" };
  }
  // Every value is a declared variable's, so one that no slot takes would be paid for and dropped.
  if (filled.unused.length > 0) {
    return { ok: false, status: 422, error: `This prompt's text has no place for ${filled.unused.join(", ")} — nothing was charged` };
  }
  return { ok: true, text: filled.text, template: text.text, adult: text.adult, paid: inputs.paid, own: buyersOwn(Object.fromEntries(inputs.values), text.variables), variables: text.variables };
}

/**
 * The 402, in both x402 wire formats: the v1 body and the v2 PAYMENT-REQUIRED
 * header. Any standard client builds its payment from these fields alone
 * (PayBox included), so they follow the spec exactly: the deployment's own
 * network, an absolute resource URL, our fee payer (Kev, 2026-10-17).
 */
async function requirementsFor(input: Input, resource: string): Promise<Requirements> {
  const payTo = platformWallet();
  // Without a fee payer no client can build a Solana payment (it MUST be in extra), so no 402 at all.
  const feePayer = feePayerAddress();
  // x402 settles on its own chain (Kev, 2026-10-17: mainnet while the escrow stays on devnet).
  const chain = x402Chain();
  if (!payTo || !feePayer || !chain) return { status: 503, body: { error: "Payments are not configured on this deployment" } };

  let amountMicro: number;
  let modelCostMicro: number;
  let credits: LicenceCredit[] = [];
  let description: string;
  let prompt: Priced["prompt"];
  if (input.promptId) {
    const supabase = getSupabaseServerClient();
    // Refused here, so the 402 probe already says no, and no payment is ever
    // asked for a draft or for inputs a paid prompt does not take.
    const filled = await agentPrompt(supabase, input.promptId, input.variableValues);
    if (!filled.ok) return { status: filled.status, body: refusalBody(filled) };
    // PayBox buyers are not age-verified (Kev, 2026-10-17: "kein 18+"), so an
    // 18+ prompt is refused before any 402 asks for money.
    if (filled.adult) return { status: 422, body: { error: "This prompt is 18+ and is not sold over x402 — nothing was charged" } };
    // Its creator switched buyers' references off (SQL 62): said before any 402 asks for money, the payment included.
    if (referenceImageCount(input.referenceImages as unknown[] | undefined) > 0 && !(await allowsReferences(supabase, input.promptId))) {
      return { status: 422, body: { error: `${REFERENCES_OFF} Nothing was charged.` } };
    }
    prompt = { text: filled.text, template: filled.template, paid: filled.paid, own: filled.own, variables: filled.variables };
    const quote = await computeQuote(supabase, {
      promptId: input.promptId,
      modelFamily: input.modelFamily,
      resolution: input.resolution,
      quality: input.quality,
      // Agents pay Enki 20%, the web rails 10% (Kev, 2026-10-17).
      enkiFeeBps: X402_ENKI_FEE_BPS,
      // Enki owes the artist, so every listed prompt sells, wallet or not (Kev, 2026-10-18: "all prompts must be accessible").
      artistWalletOptional: true,
    });
    if (!quote.ok) return { status: quote.status, body: refusalBody(quote) };
    amountMicro = quote.split.totalMicro;
    modelCostMicro = quote.split.modelCostMicro;
    /* Enki sells the render (Kev, 2026-10-17: "verkäufer-modell für
       künstlerprompts"): the buyer pays Enki the whole price, and every share
       that was a leg of its own (the artist's price, a referred prompt's
       referrer and author, lib/referral/shares) becomes a licence fee Enki
       owes once the render is delivered. The author's vault is a PDA of the
       escrow program; without that program configured there is no vault and
       no author share, nor when x402 settles on another cluster than the
       escrow: the program that releases the vault is not there. Configured
       is not deployed: a devnet program id left in a mainnet env owed credits
       to a vault of a program that does not exist there (round 4,
       2026-10-19), so the rail switch's own deployment check decides. */
    let escrow: ReturnType<typeof escrowServerChain> | null = null;
    try { escrow = escrowServerChain(); } catch { escrow = null; }
    // A deployment the RPC cannot read (null) is read as deployed, and refused before any payment only where it
    // decides a share, an author paid through the program's vault: read as "not deployed", it sold the prompt
    // without that credit (round 20). No other prompt's price or credit depends on it (round 21, 2026-10-20).
    const deployed = escrow && escrow.cluster === chain ? await escrowDeployed().catch(() => null) : false;
    const programId = escrow && deployed !== false ? new PublicKey(escrow.programAddress) : null;
    const shares = await sharesOf(supabase, input.promptId, programId);
    if (deployed === null && shares?.author?.kind === "vault") {
      return { status: 503, body: { error: "This prompt cannot be priced right now — try again shortly. Nothing was charged." } };
    }
    credits = [
      // Owed to the artist's account, with the wallet it was priced to where there is one: an artist without a wallet is paid once they add one.
      ...(quote.split.artistAmountMicro > 0 ? [{ role: "artist" as const, owner: quote.artistWallet, userId: quote.artistId, micro: quote.split.artistAmountMicro }] : []),
      ...shareLegs({ split: quote.split, artistWallet: null, payTo, shares })
        .flatMap((l) => l.role === "referrer" || l.role === "author" ? [{ role: l.role, owner: l.recipient, micro: l.amountMicro }] : []),
    ];
    description = `Generate 1 image from prompt ${input.promptId} (${input.modelFamily}, ${input.resolution}) — licence included`;
  } else {
    try {
      // The checks the agent's render runs, as on every paid rail.
      // The 402 probe needs no database: without one the table prices it, as before.
      const cellUsd = priceCellFor(await loadPriceCells(getSupabaseServerClientSafe()), { modelFamily: input.modelFamily, resolution: input.resolution, quality: input.quality });
      modelCostMicro = modelLegMicro(input.modelFamily, input.resolution, { quality: input.quality, cellUsd });
      amountMicro = computeGenerationSplit(0, modelCostMicro, { enkiFeeBps: X402_ENKI_FEE_BPS }).totalMicro;
      description = `Generate 1 image (${input.modelFamily}, ${input.resolution})`;
    } catch (e) {
      if (e instanceof UnknownModelError) return { status: 422, body: { error: e.message } };
      throw e;
    }
  }

  // One transfer, the whole price to Enki, for every request: a prompt's licence is in it.
  const legs = [{ recipient: payTo, amountMicro }];
  const net = x402Network(chain);
  const asset = usdcMint(chain).toBase58();
  const extra = {
    // The agent builds its transaction WITH this fee payer, which is
    // how "only USDC, never SOL" is kept: we pay the gas.
    feePayer,
    // Always one entry, payTo and the amount, kept for clients that read
    // extra.legs; Enki pays the artist out of it (Kev, 2026-10-17).
    legs,
    modelFamily: input.modelFamily,
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
    ...(input.quality ? { quality: input.quality } : {}),
  };
  return {
    status: 402,
    amountMicro,
    modelCostMicro,
    legs,
    credits,
    prompt,
    body: {
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [
        {
          scheme: "exact",
          network: net.v1,
          asset,
          payTo,
          maxAmountRequired: String(amountMicro),
          resource,
          description,
          mimeType: "application/json",
          maxTimeoutSeconds: 120,
          extra: {
            ...extra,
            note: "Only USDC is needed — the platform fee payer carries Solana gas. Send one TransferChecked of the amount to payTo; a prompt's licence is included and Enki pays the artist.",
          },
        },
      ],
    },
    paymentRequired: Buffer.from(JSON.stringify({
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { url: resource, description, mimeType: "application/json", serviceName: "Enki" },
      // We settle before the render (v2 spec: a flow other than authorization MUST be named).
      accepts: [{ scheme: "exact", network: net.caip2, amount: String(amountMicro), asset, payTo, maxTimeoutSeconds: 120, extra: { ...extra, paymentFlow: "upfront" } }],
    })).toString("base64"),
  };
}

/** The answer to a request without a usable payment: the 402 in both formats, or the refusal. */
function answer(r: Requirements, error?: string): NextResponse {
  if (r.status !== 402) return NextResponse.json(r.body, { status: r.status });
  // A v2 client reads the reason from the header, a v1 client from the body: both carry it (review 2026-10-18).
  const header = error ? Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(r.paymentRequired, "base64").toString("utf8")), error })).toString("base64") : r.paymentRequired;
  return NextResponse.json(error ? { ...r.body, error } : r.body, { status: 402, headers: { "PAYMENT-REQUIRED": header } });
}

/**
 * A refusal of a request that carries a payment: it may be the retry of one that already landed, its answer lost, and
 * it was not looked up (this refusal has no price to verify it against, and nothing is co-signed before it is verified).
 * So it claims nothing about that payment.
 */
function sayingNothingOfThePayment(r: Exclude<Requirements, Priced>): Exclude<Requirements, Priced> {
  const said = r.body.error.replace(/(?:\s+(?:—|and))?\s+nothing was charged\.?$/i, "");
  if (said === r.body.error) return r;
  return { ...r, body: { ...r.body, error: `${said.replace(/\.$/, "")}. If you sent this payment before, look it up on Solana before you pay again.` } };
}

/** 402 again with a reason — the spec's answer to an unusable payment. */
function rejectPayment(reqs: Priced, error: string) {
  return answer(reqs, error);
}

async function settleAndGenerate(input: Input, paymentHeader: string, request: NextRequest, resource: string): Promise<NextResponse> {
  // The clock maxDuration runs on; the image must be stored inside it.
  const startedAt = Date.now();
  // Warnings and hits here count on the address alone: this rail never reads
  // an account's ban, so one filed on an account would stop nobody.
  const asker = byAddress(request);
  // ── Everything refusable is refused BEFORE money moves ──────────────────
  let feePayer;
  try {
    feePayer = feePayerKeypair();
  } catch {
    return NextResponse.json(
      { error: "x402 settlement is not configured on this deployment. No funds moved." },
      { status: 503 },
    );
  }

  const reqs = await requirementsFor(input, resource);
  if (reqs.status !== 402) return answer(sayingNothingOfThePayment(reqs));

  // ── Verify the agent's transaction offline, before anything is judged ──
  // Free, and the same answer for everyone: a header that is not a signed
  // transaction paying exactly these legs is refused here, so it can no
  // longer buy a metered prompt check or the address lookups below (Kev,
  // 2026-10-06). Moved up from after the routing, unchanged.
  // Every chain-dependent call from here on takes the x402 chain, which may
  // not be the escrow's; requirementsFor answered 503 if it is no Solana chain.
  const chainKey = x402ChainKey();
  const net = x402Network(chainKey);
  const parsed = parseXPayment(paymentHeader, [net.v1, net.caip2]);
  if (!parsed.ok) return rejectPayment(reqs, parsed.error);
  const verified = verifyAgentPayment(parsed.tx, {
    legs: reqs.legs.map((l) => ({ owner: new PublicKey(l.recipient), amountMicro: l.amountMicro })),
    mint: usdcMint(chainKey),
    feePayer: feePayer.publicKey,
  });
  if (!verified.ok) return rejectPayment(reqs, verified.error);
  // The settlement header in the version the payment came in, naming the buyer as payer.
  const buyer = verified.payer;
  const settledHeaders = (signature: string): Record<string, string> => parsed.version === 2
    ? { "PAYMENT-RESPONSE": paymentResponseHeader(signature, net.caip2, buyer) }
    : { "X-PAYMENT-RESPONSE": paymentResponseHeader(signature, net.v1, buyer) };

  const supabase = getSupabaseServerClient();

  // The routing refuses for free and before any money moves: the fronting just below is the first that does.
  let model: Awaited<ReturnType<typeof resolveModelByFamily>>;
  try {
    model = await resolveModelByFamily(supabase, input.modelFamily);
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
  if (!model) return NextResponse.json({ error: `Unknown model family: ${input.modelFamily}` }, { status: 422 });
  // The EFFECTIVE quality routes, prices and renders — one value, three uses
  // (gpt's route conditions fail closed on a missing quality).
  const effQuality = model.supportsQuality ? effectiveQuality(input.resolution, input.quality) : null;
  const route = await chooseRoute(supabase, model, {
    quality: effQuality,
    resolution: input.resolution,
    referenceImages: 0,
  });
  if (!route) {
    return NextResponse.json({ error: "No healthy route for this model right now — retry shortly" }, { status: 503 });
  }
  // A paid request never falls back to a guessed model (Kev, 2026-09-22) and
  // never lands on a host this route cannot call or on the free Flux host:
  // both are refused here, before any money moves.
  if (!["gemini", "wavespeed", "openai"].includes(route.provider)) {
    return NextResponse.json({ error: "This model is not available on a paid host right now — nothing was charged" }, { status: 503 });
  }
  if (!route.providerModel) {
    return NextResponse.json({ error: "This model has no provider model configured — nothing was charged" }, { status: 503 });
  }
  // ENV-01: no host with a key on this environment, before any money moves.
  if (providerKeyMissing(route.provider)) {
    return NextResponse.json({ error: `${PROVIDER_NAME[route.provider] ?? "This host"} is not configured on this environment — nothing was charged` }, { status: 503 });
  }

  // Before anything is judged, so a payment that cannot pay buys no metered check and adds nothing to the day's spend
  // (DEC-2026-11-04-68): anyone can sign one with an empty keypair.
  // The one leg, the platform wallet, can have no USDC account yet on the
  // x402 chain (mainnet, before its first payment). TransferChecked to a
  // missing ATA fails the whole payment, so the fee payer fronts it first,
  // rent (~0.002 SOL) on the fee payer. Since the merchant model (Kev,
  // 2026-10-17) no artist, referrer or author is a leg, so none of their
  // accounts is fronted here.
  try {
    const owners = reqs.legs.map((l) => l.recipient);
    const missing = await findMissingAtas(owners, chainKey);
    if (missing.length > 0) {
      const conn = solanaConnection(chainKey);
      const mint = usdcMint(chainKey);
      const ixs = missing.map((owner) =>
        createAssociatedTokenAccountIdempotentInstruction(
          feePayer.publicKey,
          // Off the curve allowed: the same address the verifier derives (x402-settle).
          getAssociatedTokenAddressSync(mint, new PublicKey(owner), true),
          new PublicKey(owner),
          mint,
        ),
      );
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({
        payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: ixs,
      }).compileToV0Message();
      const fronted = new VersionedTransaction(msg);
      fronted.sign([feePayer]);
      await broadcastAndConfirm(conn, fronted.serialize(), bs58.encode(fronted.signatures[0]), { lastValidBlockHeight, timeoutMs: 30_000, maxRetries: 3 });
      console.warn(`[x402] fronted ${missing.length} USDC account(s) for payment legs — rent on the fee payer`);
    }
  } catch (e) {
    return NextResponse.json(
      { error: "Could not prepare a recipient's USDC account — no funds moved. Retry shortly." },
      { status: 503 },
    );
  }

  // ── Settle: co-sign, replay-guard on the deterministic signature, submit ─
  const signature = cosignAsFeePayer(parsed.tx, feePayer);
  // x402ChainKey() already throws on non-Solana chains; the guard only
  // narrows the TYPE down to what the replay recorder accepts.
  if (!isSolanaChain(chainKey)) {
    return NextResponse.json({ error: "Deployment chain is not Solana" }, { status: 503 });
  }
  // Every payment is simulated with signature checks before anything else
  // is decided, and an unpayable one is refused here, the same way whether or
  // not the request was caught.
  const simulated = await simulatePayment(solanaConnection(chainKey), parsed.tx);
  // A payment that already landed is answered as the replay it is, so an
  // agent retrying after a timeout is not told to pay again. One lookup, the
  // signature history, which also covers the recent cache, and which counts
  // only a payment that landed without an error.
  const landed = simulated.ok ? false : await paymentLanded(solanaConnection(chainKey), signature);
  if (landed) {
    return NextResponse.json({ error: "This payment transaction was already settled", transaction: signature }, { status: 409 });
  }
  if (!simulated.ok) {
    // An expired payment whose history could not be read may still have landed: never "nothing was charged" then.
    if (simulated.reason === "expired" && landed === null) {
      return NextResponse.json({ error: "Enki could not check whether this payment already landed. Look the transaction up on Solana before you pay again.", transaction: signature }, { status: 503 });
    }
    // Enki's side: the buyer did nothing wrong and a retry later costs nothing.
    if (simulated.reason === "fee_payer") {
      console.error("[x402] the fee payer cannot pay the network fee: fund it with SOL, every agent payment fails until then");
      return NextResponse.json({ error: "Enki cannot settle payments right now (its fee payer is out of SOL). Nothing was charged — try again later." }, { status: 503 });
    }
    // The buyer's side, in words an agent can act on (Kev, 2026-10-18), with the 402 to pay again.
    const usdc = `${reqs.amountMicro / 1_000_000} USDC`;
    return rejectPayment(reqs,
      simulated.reason === "payer_usdc" ? `Your wallet holds less than the ${usdc} this costs. Add USDC and pay again — nothing was charged.`
      : simulated.reason === "payer_no_account" ? `Your wallet has no USDC on this network yet. Add at least ${usdc} and pay again — nothing was charged.`
      : simulated.reason === "expired" ? "Your payment expired before it reached Enki (a Solana payment is valid for about a minute). Sign a fresh one and send it again — nothing was charged."
      : simulated.error);
  }
  // Prompt text: sent directly, or loaded from the prompt row. A PAID
  // prompt's full body is encrypted at rest — it is decrypted HERE, used for
  // the generation, and never leaves this function: the agent buys the
  // generation, not the text (Kev, 2026-08-24: "i want agents to purchase
  // artists prompts"). Free/showcase prompts read their public text.
  let promptText = input.prompt ?? "";
  // Whether the text the values fill is one the agent must not see, whatever
  // the artist charges for it: a paid prompt at 0 cents is still secret.
  let hidden = false;
  // Filled and checked by requirementsFor above, in this same request.
  if (reqs.prompt) {
    promptText = reqs.prompt.text;
    hidden = reqs.prompt.paid;
  }

  // What the request asks for, judged before any payment: for a marketplace
  // prompt the agent's values only (an artist's text never goes out for
  // this), otherwise the whole prompt. An address with enough hits gets no
  // more; explicit and child-safety requests get a warning, everything else
  // that is refused reads like any failure.
  // A blocked address, like a caught request, fails silently; its payment
  // was simulated above, and a junk header never gets this far.
  const blocked = (await agentBlocked(supabase, request)) || (await addressWarnedOut(supabase, request));
  // An option the artist wrote is no input of the agent's to judge (round 15, 2026-10-20).
  // Without the artist's variable names, which are the artist's text too (round 17).
  const checked = input.promptId ? unnamedValues(textValues(reqs.prompt?.own ?? {})) : { prompt: promptText };
  // What the agent sent in full: what every record of this request carries (round 16, 2026-10-20).
  const sent = input.promptId ? textValues(input.variableValues) : { prompt: promptText };
  // A blocked address is still judged, so its answers and their timing match
  // everyone else's up to the silent point; only its hits are not recorded.
  // The regex first: what Tier 1 refuses never reaches the chat model, and
  // its refusal is this request's moderation verdict (Kev, 2026-10-06).
  const first = screenFirst(checked);
  // The prompt check runs on Enki's money, so it reserves first (SQL 72), and only when it runs: the regex's refusal costs
  // nothing, and the image check after the render is in the model leg (modelLegMicro). Never given back. This request may be
  // the retry of a payment that landed, not yet looked up, so it claims nothing of it.
  if (!first) {
    const judges = await reserveSpend(supabase, JUDGE_CALL_MICRO);
    if (!judges.ok) return NextResponse.json({ error: `${judges.why} No image was generated. If you sent this payment before, look it up on Solana before you pay again.` }, { status: judges.status });
  }
  const check = first ? NOT_CHECKED : await checkPrompt(checked, { hidden });
  if (check.verdict === "minor_sexual" || check.verdict === "explicit_sexual") {
    await recordWarning(supabase, {
      surface: "x402-generate", request: asker, category: check.verdict, text: JSON.stringify(sent), confidence: check.confidence,
      ...(input.promptId ? { promptId: input.promptId } : {}),
    });
    return NextResponse.json({ error: addressWarningMessage(check.verdict) }, { status: 422 });
  }
  // What the check finds 18+ is refused before any payment, whatever else it
  // found: PayBox buyers are not age-verified (Kev, 2026-10-17). Not
  // misconduct, so no warning.
  if ("adult" in check && check.adult === true) {
    return NextResponse.json({ error: "This request is 18+ and is not generated over x402 — nothing was charged" }, { status: 422 });
  }
  if (check.verdict === "unavailable") console.warn("[prompt-check] unavailable:", check.reason);
  const silent = blocked || check.verdict !== "clear";

  // Tier 2 keeps its sexual flag on every x402 request: nothing 18+ is
  // generated here (Kev, 2026-10-17), so no text counts as already judged 18+.
  const verdict = first ?? await moderate({ prompt: promptText, surface: "x402-generate", adultJudged: false });
  /* A marketplace prompt the model refused, judged again with the agent's typed words neutral (neutralFill), as on the
     web (DEC-441, DEC-474; Kev, 2026-10-28, "4 yes"): refused again, it is the artist's text: the prompt goes off sale
     for an admin, the agent is not warned, and nothing is charged (no payment is taken before this point). The regex's
     refusal is of the agent's own values and is never judged again. */
  const again = input.promptId && reqs.prompt && !first && !verdict.allowed
    ? await moderate({ prompt: neutralFill(reqs.prompt.template, input.variableValues, reqs.prompt.variables), surface: "x402-generate", adultJudged: false })
    : null;
  if (again && !again.allowed && input.promptId) {
    after(recordModerationEvent(verdict, { surface: "x402-generate", request: asker, prompt: JSON.stringify(sent), promptId: input.promptId }));
    after(refusePrompt(supabase, { promptId: input.promptId, cause: "moderation", detail: String(again.category ?? "blocked"), buyerUserId: null }));
    return NextResponse.json({ error: PROMPT_UNAVAILABLE }, { status: 422 });
  }
  // A re-judge that could not run is no one's finding: refused, nothing charged, no warning, the request still on file
  // (review wf_794afa1b-83d: it returned before the only record).
  if (again?.tier2Degraded && input.promptId) {
    after(recordModerationEvent(verdict, { surface: "x402-generate", request: asker, prompt: JSON.stringify(sent), promptId: input.promptId }));
    return NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 });
  }
  // A child-safety hit counts on the requester's ladder, where it stops an
  // address at once; an agent's own prompt too, since this rail has no
  // account to ban for good. The warning is the hit's one record.
  const minors = !verdict.allowed ? childSafetyScore(verdict) : null;
  if (minors !== null) {
    await recordWarning(supabase, {
      surface: "x402-generate", request: asker, category: "minor_sexual", text: JSON.stringify(sent), confidence: minors, scores: verdict.scores,
      ...(input.promptId ? { promptId: input.promptId } : {}),
    });
    return NextResponse.json({ error: addressWarningMessage("minor_sexual") }, { status: 422 });
  }
  // Every other decision is recorded as on the human rail, on the address: a
  // child-safety case below the auto-ban line goes to a human, and the
  // passes are the control group. A marketplace prompt is named, never quoted.
  after(recordModerationEvent(verdict, {
    surface: "x402-generate", request: asker,
    ...(input.promptId ? { prompt: JSON.stringify(sent), promptId: input.promptId } : { prompt: promptText }),
  }));
  if (!verdict.allowed) {
    return NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 });
  }

  // Refused silently: nothing is settled. A real failure only happens after
  // settlement, so a paying agent can still tell a failure from an image, as
  // with any check; every caught probe is recorded and the third blocks the
  // address (agentBlocked).
  if (silent) {
    if (!blocked && check.verdict === "extraction") {
      after(recordExtractionHit(supabase, { surface: "x402-generate", request: asker, values: sent, confidence: check.confidence, promptId: input.promptId }));
    }
    return silentFailure();
  }
  // The one rail paid before its provider: Enki's bill is reserved before any money moves, so a refusal charges nobody. A
  // simulation that passes says nothing of an earlier send of this same payment still on its way, so it claims nothing of it.
  const reserved = await reserveSpend(supabase, reqs.modelCostMicro);
  if (!reserved.ok) return NextResponse.json({ error: `${reserved.why} No image was generated. If you sent this payment before, look it up on Solana before you pay again.` }, { status: reserved.status });
  const replay = await checkAndRecordSolanaSignature(signature, chainKey, "x402-agent-generate");
  if (!replay.isNew) {
    await releaseSpend(supabase, reserved);
    return NextResponse.json(
      { error: "This payment transaction was already settled", transaction: signature },
      { status: 409 },
    );
  }
  const settled = await submitAndConfirm(solanaConnection(chainKey), parsed.tx);
  if (!settled.ok) {
    await releaseSpend(supabase, reserved);
    // A rejection (preflight, on chain, expired) means no funds moved; every
    // other failure is pending, the payment may still land, so the signature
    // travels with the error for the agent to check.
    if (settled.pending) {
      // The payment may still land with no image for it: recorded with its
      // signature so support can make it right.
      after(recordGenerationFailure(supabase, {
        request, surface: "x402-generate", modelId: model.id, resolution: input.resolution, quality: effQuality, boost: false,
        aspectRatio: input.aspectRatio ?? null, referenceImageCount: 0,
        prompt: input.promptId ? JSON.stringify(sent) : promptText,
        error: "Payment outcome unknown", txSignature: signature, amountPaidMicro: reqs.amountMicro,
      }));
    }
    if (settled.pending) return NextResponse.json({ error: settled.error, transaction: signature }, { status: 504 });
    // Refused at sending (most often the wallet's USDC moved after the check): the transfer did not happen.
    return rejectPayment(reqs, "Your payment was refused when Enki sent it (most often your wallet's USDC changed after it was checked). Nothing was charged — sign a fresh payment and send it again.");
  }

  // ── Paid work: one provider call on the routed host ─────────────────────
  const ratio = input.aspectRatio;
  const genRequest: ImageGenerationRequest = {
    prompt: promptText,
    // The routed model, exactly as the human route sends it. Without it every
    // adapter used to fall back to its own default model.
    modelVersion: route.providerModel,
    aspectRatio: ratio as ImageGenerationRequest["aspectRatio"],
    imageSize: model.supportsResolution
      ? clampTier(input.resolution, route.provider, route.providerModel)
      : undefined,
    quality: model.supportsQuality ? (effQuality ?? undefined) : undefined,
    numImages: 1,
  };
  const result = await (
    route.provider === "wavespeed" ? generateImagesWithWaveSpeed(genRequest)
    : route.provider === "openai" ? generateImagesWithOpenAI(genRequest)
    : generateImagesWithGemini(genRequest)
  );

  const buffer = result.success ? result.imageBuffers?.[0] : undefined;
  if (!buffer) {
    if (!mayBeBilled(result.error || "generation failed")) await releaseSpend(supabase, reserved);
    if (route.modelProviderId && route.providerId) {
      after(reportFailure(getSupabaseServerClient(), route.modelProviderId, route.providerId, result.error || "generation failed"));
    }
    // A provider that refused an artist's hidden text gives no reason: recorded for the admin (DEC-441, DEC-475). Without
    // a buyer: here one costs a fresh keypair, and two would take any prompt off sale (DEC-478); a public text is the
    // agent's to fill, as on the web. This rail carries no references.
    if (hidden && input.promptId && classifyFailure(result.error || "generation failed").kind === "content") {
      after(refusePrompt(supabase, { promptId: input.promptId, cause: "provider", detail: PROVIDER_NAME[route.provider] ?? String(route.provider), buyerUserId: null }));
    }
    // The agent paid and got nothing: recorded with the signature so support can make it right.
    after(recordGenerationFailure(supabase, {
      request, surface: "x402-generate", modelId: model.id, resolution: input.resolution, quality: effQuality, boost: false,
      aspectRatio: ratio, referenceImageCount: 0,
      // For a marketplace prompt only the agent's values: an artist's text is never stored with a failure.
      prompt: input.promptId ? JSON.stringify(sent) : promptText,
      error: providerFailure(result.error || "generation failed", Boolean(input.promptId)), txSignature: signature, amountPaidMicro: reqs.amountMicro,
    }));
    // The payment settled; hiding that would be worse than the failure.
    return NextResponse.json(
      {
        // A fixed sentence: the provider's own text would differ from case to case.
        error: "Image generation failed after your payment settled.",
        transaction: signature,
        note: "Keep this transaction signature — support will make it right.",
      },
      { status: 502 },
    );
  }
  if (route.modelProviderId && route.providerId) {
    after(reportSuccess(getSupabaseServerClient(), route.modelProviderId, route.providerId));
  }
  if (typeof result.usage?.costUsd === "number") {
    // The bill becomes the next quote's cell, as on the paid rail (lib/generation/price-cells.ts).
    const usage = result.usage as { costUsd: number; imageOutputTokens?: number };
    after(observePrice(supabase, {
      modelFamily: input.modelFamily,
      provider: route.provider,
      providerModel: route.providerModel,
      resolution: input.resolution,
      quality: effQuality,
      role: "normal",
      priced: route.primary === true,
      tokens: usage.imageOutputTokens ?? null,
      observedUsd: usage.costUsd,
      generationId: null,
    }));
  }

  // Measured from the bytes, never assumed: this said image/png
  // unconditionally while WaveSpeed/Gemini/OpenAI do not all return PNG, so
  // the stored (and recorded) content type silently mislabeled anything
  // else (REC-3).
  const measured = readImageDimensions(buffer);
  const mediaType = measured ? `image/${measured.format}` : "application/octet-stream";
  const dataUrl = `data:${mediaType};base64,${buffer.toString("base64")}`;
  // The payer's own wallet, never the pseudo-user "x402-agent" (REC-3):
  // verifyAgentPayment already resolved and trusted it above as the
  // TransferChecked authority — this is that same value, not a new lookup.
  const payerWallet = verified.payer.toBase58();
  const stored = await storeGeneratedImage(dataUrl, payerWallet, storeDeadline(startedAt));
  // Not stored by the deadline: inline only while it fits the response cap,
  // or the agent that paid would get HTTP 413 instead of its image.
  if (stored.imageUrl === dataUrl && buffer.length > INLINE_MAX_BYTES) {
    after(recordGenerationFailure(supabase, {
      request, surface: "x402-generate", modelId: model.id, resolution: input.resolution, quality: effQuality, boost: false,
      aspectRatio: ratio, referenceImageCount: 0,
      prompt: input.promptId ? JSON.stringify(sent) : promptText,
      error: "image could not be stored", txSignature: signature, amountPaidMicro: reqs.amountMicro,
    }));
    // A cut upload can still land: never left public unjudged.
    after(removeStored(stored.names));
    return NextResponse.json(
      {
        error: "Your image was made but could not be delivered after your payment settled.",
        transaction: signature,
        note: "Keep this transaction signature — support will make it right.",
      },
      { status: 502 },
    );
  }

  // The image check, after storage: refused or not judged, the image is
  // withheld, its copies come down, and the paid failure is recorded with
  // the signature. A child-safety verdict becomes a case an admin decides,
  // by address. An 18+ render is withheld the same way: PayBox buyers are
  // not age-verified (Kev, 2026-10-17).
  const seen = await checkImageBytes(buffer, { signal: AbortSignal.timeout(Math.max(1, storeDeadline(startedAt) - Date.now())) });
  if (heldBack(seen) || seen.verdict === "adult") {
    after(recordGenerationFailure(supabase, {
      request, surface: "x402-generate", modelId: model.id, resolution: input.resolution, quality: effQuality, boost: false,
      aspectRatio: ratio, referenceImageCount: 0,
      prompt: input.promptId ? JSON.stringify(sent) : promptText,
      error: `image check: ${seen.verdict}`, txSignature: signature, amountPaidMicro: reqs.amountMicro,
    }));
    if (seen.verdict === "child_safety") {
      after(recordImageCase(supabase, {
        surface: "x402-generate", request, bytes: buffer, scores: seen.scores, byAddress: true, promptId: input.promptId,
        about: input.promptId ? JSON.stringify(sent) : promptText,
      }));
    }
    // Every copy, by every name it may have landed under, in both stores.
    after(removeStored(stored.names));
    return NextResponse.json(
      {
        error: seen.verdict === "unavailable"
          ? "Your image could not be checked right now, so it was not delivered after your payment settled."
          : seen.verdict === "adult"
            ? "This image can't be delivered on Enki (18+). Your payment settled."
            : "This image can't be delivered on Enki. Your payment settled.",
        transaction: signature,
        note: "Keep this transaction signature — support will make it right.",
      },
      // Paid, so it says so as x402 does, and never 503: a client retrying
      // that would pay again for each render withheld the same way.
      {
        status: seen.verdict === "unavailable" ? 502 : 422,
        headers: settledHeaders(signature),
      },
    );
  }

  // The artist's words read off the render (ENC review, 2026-10-27): an agent's value can tell the model to typeset a
  // paid prompt's hidden text, or the artist meant the lettering to show (review wf_866ba07b-01a). Withheld, no one
  // struck, the prompt toward an admin's decision; the payment settled, as for any withheld render.
  if (hidden && reqs.prompt && input.promptId && seen.text && showsHiddenText(seen.text, reqs.prompt.template)
    && !(await letteringReleased(supabase, input.promptId))) {
    // Without a buyer, as a provider's refusal above (DEC-478).
    after(refusePrompt(supabase, { promptId: input.promptId, cause: "render", detail: "hidden text", buyerUserId: null }));
    after(recordGenerationFailure(supabase, {
      request, surface: "x402-generate", modelId: model.id, resolution: input.resolution, quality: effQuality, boost: false,
      aspectRatio: ratio, referenceImageCount: 0, prompt: JSON.stringify(sent),
      error: "image check: hidden text", txSignature: signature, amountPaidMicro: reqs.amountMicro,
    }));
    after(removeStored(stored.names));
    return NextResponse.json(
      { error: "This image can't be delivered on Enki. Your payment settled.", transaction: signature, note: "Keep this transaction signature — support will make it right." },
      { status: 422, headers: settledHeaders(signature) },
    );
  }

  // Recorded through the same pipeline as a human's render, under the account
  // the paying wallet has: the brand it is linked to, or its own, made at its
  // first paid render (Kev, 2026-10-14: agents are full accounts; the signed
  // payment is the proof a login gives). Started before the answer so the
  // answer can name the gallery row (REC-1), waited for a few seconds at most:
  // a recording problem must never withhold an already-settled image, and
  // the rest goes on in after().
  const recording = (async () => {
    // Asked again when a blip hid the account (ENG-07); still nothing, and
    // the paid render goes on record with its signature for support.
    const recUserId = await payerAccount(supabase, payerWallet);
    if (!recUserId) {
      await recordGenerationFailure(supabase, {
        request, surface: "x402-generate", modelId: model.id, resolution: input.resolution, quality: effQuality, boost: false,
        aspectRatio: ratio, referenceImageCount: 0,
        prompt: input.promptId ? JSON.stringify(sent) : promptText,
        error: "delivered and paid, but the paying wallet's account could not be found or made: not recorded", txSignature: signature, amountPaidMicro: reqs.amountMicro,
      });
      return null;
    }
    // Named apart from `stored.imageUrl` on purpose — this is the recorded
    // copy, not the delivery, and the two must stay textually distinct so a
    // source scan for "where does the response's own imageUrl come from"
    // finds exactly one answer.
    const { imageUrl: recordedUrl, previewUrl: recordedPreview, thumbnailUrl: recordedThumb } = stored;
    // Never a data URL in the gallery row (REC-1): a store that missed with
    // the whole clock records the render and its payment without one.
    const durable = !recordedUrl.startsWith("data:");
    return recordGeneration(supabase, {
      // Never 18+: x402 refuses 18+ prompts and withholds 18+ renders (Kev, 2026-10-17).
      adult: false,
      userId: recUserId,
      promptId: input.promptId ?? null,
      finalPrompt: promptText,
      // x402 sends promptText to the provider as-is — no separate rewrite
      // stage to keep apart, unlike the human rail's prompt-enhancement pass.
      effectivePrompt: promptText,
      variableValues: input.variableValues ?? {},
      model,
      route,
      boost: false,
      aspectRatio: ratio,
      resolution: input.resolution,
      seed: null,
      output: measured ? { width: measured.width, height: measured.height, bytes: buffer.length, format: measured.format } : null,
      mimeType: measured ? `image/${measured.format}` : null,
      ...(durable ? { imageUrl: recordedUrl, previewUrl: recordedPreview, thumbnailUrl: recordedThumb } : {}),
      generationMs: result.generationTime ?? null,
      workflow: null,
      references: [],
      chainKey,
      transactionHash: signature,
      amountPaidCents: Math.round(reqs.amountMicro / 10_000),
      // Exact: 7,560 micro is 1 cent above (Kev, 2026-10-18: "store defo exact usdc amount").
      amountPaidMicro: reqs.amountMicro,
      // No generation_payment_intents row on this rail — that table belongs
      // to the human authorize/capture flow.
      paymentIntentId: null,
      rail: "x402",
    });
  })();
  after(recording);
  const imageId = await imageIdWithin(recording);
  // Delivered: the licence fees this render owes go on Enki's books, keyed by
  // the payment so a repeat counts once (Kev, 2026-10-17). Only here: a
  // withheld or failed render owes nobody anything.
  if (reqs.credits.length > 0) {
    after(recordLicenceCredits(supabase, {
      source: `x402:${signature}`, mint: usdcMint(chainKey).toBase58(), promptId: input.promptId ?? null, credits: reqs.credits,
    }));
  }

  return NextResponse.json(
    {
      imageUrl: stored.imageUrl,
      ...(imageId ? { imageId } : {}),
      ...(stored.previewUrl ? { previewUrl: stored.previewUrl } : {}),
      modelFamily: input.modelFamily,
      resolution: input.resolution,
      aspectRatio: ratio,
      paidMicroUsdc: reqs.amountMicro,
      transaction: signature,
    },
    { headers: settledHeaders(signature) },
  );
}

/**
 * This route is public (proxy.ts) and every paying request costs a metered
 * prompt check: agents hold no session, so the address is the only handle
 * (Kev, 2026-10-06).
 */
function ipLimited(req: NextRequest): NextResponse | null {
  const limit = checkRequestRateLimit(rateLimitKey(req, "x402:ip"), 60, 60_000);
  return limit.allowed ? null : rateLimitResponse(limit.retryAfterSeconds);
}

/** The absolute URL of this resource, as the 402 names it (legacy clients refuse a relative one). */
const resourceUrl = (req: NextRequest) => new URL("/api/x402/generate", req.nextUrl.origin).href;

/**
 * The pricing fields a URL can carry, so a quote (GET) and a probe without a
 * body (PayBox use_service sends the body only on the paid re-fetch) price
 * what the paid POST will.
 */
function queryInput(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const pick = (key: string) => q.get(key) ?? undefined;
  return {
    prompt: pick("prompt"), promptId: pick("promptId"), modelFamily: pick("modelFamily"),
    resolution: pick("resolution"), aspectRatio: pick("aspectRatio"), quality: pick("quality"),
  };
}

/** A quote needs no prompt: without one or a promptId it prices a stand-in. */
const quoting = <T extends { prompt?: unknown; promptId?: unknown }>(input: T): T =>
  ({ ...input, prompt: input.prompt ?? (input.promptId ? undefined : "probe") });

export async function GET(req: NextRequest) {
  const limited = ipLimited(req);
  if (limited) return limited;
  const parsed = bodySchema.safeParse(quoting(queryInput(req)));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  return answer(await requirementsFor(parsed.data, resourceUrl(req)));
}

export async function POST(req: NextRequest) {
  const limited = ipLimited(req);
  if (limited) return limited;
  const body: unknown = await req.json().catch(() => null);
  // The body wins over the URL; a payment never renders the stand-in prompt.
  const input = { ...queryInput(req), ...(body && typeof body === "object" ? body : {}) };
  const payment = req.headers.get("X-PAYMENT") ?? req.headers.get("PAYMENT-SIGNATURE");
  const parsed = bodySchema.safeParse(payment ? input : quoting(input));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  if (payment) return settleAndGenerate(parsed.data, payment, req, resourceUrl(req));

  return answer(await requirementsFor(parsed.data, resourceUrl(req)));
}
