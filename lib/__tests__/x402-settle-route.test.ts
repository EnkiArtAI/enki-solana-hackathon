import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

/**
 * The x402 route end to end, offline: the payment is a real signed
 * transaction and is verified for real; the chain, the providers, the checks
 * and the database are stand-ins that record what the route asked of them.
 */

const state = vi.hoisted(() => ({
  screen: vi.fn(), simulate: vi.fn(), landed: vi.fn(), submit: vi.fn(), atas: vi.fn(), replay: vi.fn(), broadcast: vi.fn(),
  check: vi.fn(), moderate: vi.fn(), provider: vi.fn(), imageCheck: vi.fn(), record: vi.fn(), fail: vi.fn(),
  removeStored: vi.fn(), warn: vi.fn(), inputs: vi.fn(), deployedThrows: false, modEvent: vi.fn(async (..._args: unknown[]) => {}), shares: vi.fn(), quote: vi.fn(), text: vi.fn(), credit: vi.fn(),
  routeIds: { modelProviderId: null, providerId: null } as { modelProviderId: string | null; providerId: string | null }, reportFailure: vi.fn(async (..._a: unknown[]) => {}),
  escrowCluster: "solana-devnet", rail: "escrow" as "escrow" | "intent", allows: vi.fn(), reserve: vi.fn(), release: vi.fn(),
}));
const db = { from: () => { throw new Error("the route reached the database stand-in"); } };

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/generation/spend-cap", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/spend-cap")>()),
  reserveSpend: (...a: unknown[]) => state.reserve(...a), releaseSpend: (...a: unknown[]) => state.release(...a),
}));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db, getSupabaseServerClientSafe: () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRequestRateLimit: () => ({ allowed: true }), rateLimitKey: () => "key", rateLimitResponse: () => new Response("", { status: 429 }),
}));
vi.mock("@/lib/payments/solana", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/solana")>()),
  broadcastAndConfirm: (...a: unknown[]) => state.broadcast(...a),
}));
vi.mock("@/lib/payments/x402-settle", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/x402-settle")>()),
  simulatePayment: (...a: unknown[]) => state.simulate(...a),
  paymentLanded: (...a: unknown[]) => state.landed(...a),
  submitAndConfirm: (...a: unknown[]) => state.submit(...a),
}));
vi.mock("@/lib/payments/solana-transfer", () => ({ findMissingAtas: (...a: unknown[]) => state.atas(...a) }));
vi.mock("@/backend/solana-x402-verifier", () => ({ checkAndRecordSolanaSignature: (...a: unknown[]) => state.replay(...a) }));
vi.mock("@/lib/payments/escrow/server-chain", () => ({
  // "none": no escrow program configured, as the handoff's mainnet setup leaves it.
  escrowServerChain: () => { if (state.escrowCluster === "none") throw new Error("The payment program is not configured."); return { cluster: state.escrowCluster, programAddress: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" }; },
}));
vi.mock("@/lib/payments/rail", () => ({
  paymentRail: async () => state.rail,
  escrowDeployed: async () => { if (state.deployedThrows) throw new Error("The escrow program's deployment could not be read"); return state.rail === "escrow"; },
}));
vi.mock("@/lib/referral/shares", async (orig) => ({
  ...(await orig<typeof import("@/lib/referral/shares")>()),
  sharesOf: (...a: unknown[]) => state.shares(...a),
}));
vi.mock("@/lib/payments/generation-quote", () => ({ computeQuote: (...a: unknown[]) => state.quote(...a) }));
vi.mock("@/lib/prompt-references", async (orig) => ({
  ...(await orig<typeof import("@/lib/prompt-references")>()),
  allowsReferences: (...a: unknown[]) => state.allows(...a),
}));
vi.mock("@/lib/payments/licence-credits", () => ({ recordLicenceCredits: (...a: unknown[]) => state.credit(...a) }));
vi.mock("@/lib/generation/agent-prompt-inputs", () => ({
  checkAgentPromptInputs: async (...a: unknown[]) => state.inputs(...a),
}));
vi.mock("@/lib/generation/prompt-text", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/prompt-text")>()),
  loadPromptText: (...a: unknown[]) => state.text(...a),
}));
// A render that spells out the hidden text goes toward the prompt's pause (review wf_866ba07b-01a).
const pause = vi.hoisted(() => ({ refused: vi.fn(async () => false), released: false }));
vi.mock("@/lib/moderation/prompt-pause", async (orig) => ({
  PROMPT_UNAVAILABLE: (await orig<typeof import("@/lib/moderation/prompt-pause")>()).PROMPT_UNAVAILABLE,
  refusePrompt: (...a: unknown[]) => pause.refused(...(a as [])), letteringReleased: async () => pause.released,
}));
vi.mock("@/lib/moderation/extraction-hits", () => ({
  agentBlocked: async () => false, recordExtractionHit: vi.fn(async () => {}),
  silentFailure: async () => new Response(JSON.stringify({ error: "silent" }), { status: 502 }),
}));
vi.mock("@/lib/moderation/warnings", () => ({
  addressWarnedOut: async () => false, addressWarningMessage: (c: string) => `warned: ${c}`,
  byAddress: (r: unknown) => r, recordWarning: (...a: unknown[]) => state.warn(...a),
}));
vi.mock("@/lib/moderation", () => ({
  moderate: (...a: unknown[]) => state.moderate(...a), screenFirst: (...a: unknown[]) => state.screen(...a), CLIENT_BLOCK_MESSAGE: "Refused by moderation",
}));
vi.mock("@/lib/moderation/prompt-check", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/prompt-check")>()),
  checkPrompt: (...a: unknown[]) => state.check(...a),
}));
// A child-safety reading for a verdict whose category says so (DEC-475); none for every other.
vi.mock("@/lib/moderation-enforcement", () => ({
  childSafetyScore: (v: { category?: string }) => (v?.category === "minor_sexual" ? 0.97 : null),
  recordModerationEvent: (...a: unknown[]) => state.modEvent(...a),
}));
vi.mock("@/lib/generation/models", () => ({
  resolveModelByFamily: async () => ({ id: "model-1", name: "Nano Banana Pro", supportsQuality: false, supportsResolution: true }),
  chooseRoute: async () => ({ provider: "gemini", providerModel: "gemini-image", ...state.routeIds, primary: true }),
}));
vi.mock("@/lib/generation/provider-health", async (orig) => ({
  classifyFailure: (await orig<typeof import("@/lib/generation/provider-health")>()).classifyFailure,
  mayBeBilled: (await orig<typeof import("@/lib/generation/provider-health")>()).mayBeBilled,
  providerKeyMissing: () => false, reportSuccess: async () => {}, reportFailure: (...a: unknown[]) => state.reportFailure(...a), PROVIDER_NAME: {},
}));
vi.mock("@/backend/services/gemini-image-generation", async (orig) => ({
  ...(await orig<typeof import("@/backend/services/gemini-image-generation")>()),
  generateImagesWithGemini: (...a: unknown[]) => state.provider(...a),
}));
vi.mock("@/backend/services/wavespeed-image-generation", () => ({ generateImagesWithWaveSpeed: (...a: unknown[]) => state.provider(...a) }));
vi.mock("@/backend/services/openai-image-generation", () => ({ generateImagesWithOpenAI: (...a: unknown[]) => state.provider(...a) }));
vi.mock("@/lib/generation/derivative-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/derivative-store")>()),
  storeGeneratedImage: async () => ({ imageUrl: "https://blob.test/x.png", previewUrl: null, thumbnailUrl: null, names: ["x.png"] }),
  removeStored: (...a: unknown[]) => state.removeStored(...a),
}));
vi.mock("@/lib/moderation/image-check-bytes", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/image-check-bytes")>()),
  checkImageBytes: (...a: unknown[]) => state.imageCheck(...a),
}));
vi.mock("@/lib/moderation/image-case", () => ({ recordImageCase: async () => {} }));
vi.mock("@/lib/generation/record", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/record")>()),
  payerAccount: async () => "user-1",
  recordGeneration: (...a: unknown[]) => state.record(...a),
  recordGenerationFailure: (...a: unknown[]) => state.fail(...a),
}));

const MAINNET_USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const MAINNET_RPC = "https://mainnet.rpc.test/";
const URL_BASE = "https://www.enki.gallery/api/x402/generate";
const LOOK_IT_UP = "If you sent this payment before, look it up on Solana before you pay again.";
const feePayer = Keypair.generate();
const buyer = Keypair.generate();
const payTo = Keypair.generate().publicKey;

let GET: typeof import("../../app/api/x402/generate/route").GET;
let POST: typeof import("../../app/api/x402/generate/route").POST;
let NextRequest: typeof import("next/server").NextRequest;
beforeAll(async () => {
  ({ GET, POST } = await import("../../app/api/x402/generate/route"));
  ({ NextRequest } = await import("next/server"));
}, 60_000);

beforeEach(async () => {
  vi.clearAllMocks();
  // The escrow and every other rail stay on devnet; x402 settles on mainnet (Kev, 2026-10-17).
  vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
  vi.stubEnv("X402_PAYMENT_CHAIN", "solana");
  vi.stubEnv("SOLANA_RPC_URL", MAINNET_RPC);
  vi.stubEnv("SOLANA_RPC_URL_FALLBACK", "");
  vi.stubEnv("SOLANA_PLATFORM_WALLET", payTo.toBase58());
  vi.stubEnv("SOLANA_FEE_PAYER_SECRET_KEY", JSON.stringify(Array.from(feePayer.secretKey)));
  (await import("@/lib/payments/solana")).resetFeePayerCache();
  state.escrowCluster = "solana-devnet"; state.rail = "escrow"; state.deployedThrows = false;
  state.atas.mockResolvedValue([]);
  state.allows.mockResolvedValue(true);
  state.reserve.mockImplementation(async (_db: unknown, micro: number) => ({ ok: true, day: "2026-11-04", micro }));
  state.release.mockResolvedValue(undefined);
  state.screen.mockReturnValue(null);
  state.simulate.mockResolvedValue({ ok: true });
  state.landed.mockResolvedValue(false);
  state.submit.mockResolvedValue({ ok: true, signature: "sig" });
  state.replay.mockResolvedValue({ isNew: true });
  state.check.mockResolvedValue({ verdict: "clear" });
  state.inputs.mockResolvedValue({ ok: true, paid: false, variables: [], values: new Map() });
  state.moderate.mockResolvedValue({ allowed: true });
  state.provider.mockResolvedValue({ success: true, imageBuffers: [Buffer.from("fixture")] });
  state.imageCheck.mockResolvedValue({ verdict: "clear" });
  state.record.mockResolvedValue({ generationId: "gen-1", imageId: "img-1" });
  state.fail.mockResolvedValue(undefined);
  state.removeStored.mockResolvedValue(undefined);
  state.warn.mockResolvedValue(undefined);
  state.shares.mockResolvedValue(null);
  state.credit.mockResolvedValue(true);
  state.text.mockResolvedValue({ ok: true, text: "a fox", variables: [], adult: false });
  const { computeGenerationSplit } = await import("@/lib/payments/generation-pricing");
  state.quote.mockResolvedValue({ ok: true, artistWallet: null, split: computeGenerationSplit(0, 100_000), appliedRule: null });
});
afterEach(() => { vi.unstubAllEnvs(); state.routeIds = { modelProviderId: null, providerId: null }; state.reportFailure.mockClear(); });

const BODY = { prompt: "a fox", modelFamily: "nano-banana-pro", resolution: "2K" };

/** The 402's one leg, paid as a standard client pays it: one TransferChecked, our fee payer as payer, signed by the buyer. */
async function payment(network: string, mint = MAINNET_USDC): Promise<string> {
  const quote = await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&resolution=2K`));
  const amount = Number(((await quote.json()) as { accepts: Array<{ maxAmountRequired: string }> }).accepts[0].maxAmountRequired);
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
    instructions: [createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(mint, buyer.publicKey), mint, getAssociatedTokenAddressSync(mint, payTo), buyer.publicKey, amount, 6,
    )],
  }).compileToV0Message());
  tx.sign([buyer]);
  return Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network, payload: { transaction: Buffer.from(tx.serialize()).toString("base64") } })).toString("base64");
}

async function paid(body: Record<string, unknown> = BODY, network = "solana") {
  return POST(new NextRequest(URL_BASE, {
    method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": await payment(network) }, body: JSON.stringify(body),
  }));
}

const endpoint = (fn: typeof state.simulate) => (fn.mock.calls[0]?.[0] as { rpcEndpoint?: string } | undefined)?.rpcEndpoint;

describe("x402 settles on its own chain", () => {
  it("verifies against mainnet USDC and simulates, records and submits on mainnet while the escrow stays on devnet", async () => {
    const res = await paid();
    expect(res.status).toBe(200);
    expect(endpoint(state.simulate)).toBe(MAINNET_RPC);
    expect(endpoint(state.submit)).toBe(MAINNET_RPC);
    expect(state.atas).toHaveBeenCalledWith([payTo.toBase58()], "solana");
    expect(state.replay).toHaveBeenCalledWith(expect.any(String), "solana", "x402-agent-generate");
    expect(state.record.mock.calls[0][1]).toMatchObject({ chainKey: "solana", rail: "x402" });
    const settled = JSON.parse(Buffer.from(res.headers.get("X-PAYMENT-RESPONSE") ?? "", "base64").toString("utf8"));
    expect(settled).toMatchObject({ network: "solana", payer: buyer.publicKey.toBase58() });
  });

  it("records the exact amount paid in micro-USDC, next to the rounded cents (Kev, 2026-10-18)", async () => {
    const quote = await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&resolution=2K`));
    const amount = Number(((await quote.json()) as { accepts: Array<{ maxAmountRequired: string }> }).accepts[0].maxAmountRequired);
    expect((await paid()).status).toBe(200);
    expect(state.record.mock.calls[0][1]).toMatchObject({ amountPaidMicro: amount, amountPaidCents: Math.round(amount / 10_000) });
    // A payment that simulates clean is not looked up in the history: one RPC call less, and never a 409 for it.
    expect(state.landed).not.toHaveBeenCalled();
  });

  it("keeps the exact amount on a paid render that failed, the amount a refund returns (Kev, 2026-10-18)", async () => {
    const quote = await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&resolution=2K`));
    const amount = Number(((await quote.json()) as { accepts: Array<{ maxAmountRequired: string }> }).accepts[0].maxAmountRequired);
    state.provider.mockResolvedValue({ success: false, error: "boom" });
    expect((await paid()).status).toBe(502);
    expect(state.fail).toHaveBeenCalledWith(db, expect.objectContaining({ txSignature: expect.any(String), amountPaidMicro: amount }));
  });

  it("counts no outage for a throw, whatever its words, and tells a host's answered failure once, as before", async () => {
    state.routeIds = { modelProviderId: "route-1", providerId: "host-1" };
    state.provider.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'timeout')"));
    await paid().catch(() => null);
    expect(state.reportFailure).not.toHaveBeenCalled();
    state.provider.mockResolvedValue({ success: false, error: "boom" });
    expect((await paid()).status).toBe(502);
    expect(state.reportFailure.mock.calls.map((c) => c.slice(1))).toEqual([["route-1", "host-1", "boom"]]);
  });

  it("refuses a payment named for the escrow's network or paid in its USDC", async () => {
    expect((await paid(BODY, "solana-devnet")).status).toBe(402);
    const devnetMint = await POST(new NextRequest(URL_BASE, {
      method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": await payment("solana", DEVNET_USDC) }, body: JSON.stringify(BODY),
    }));
    expect(devnetMint.status).toBe(402);
    expect(state.simulate).not.toHaveBeenCalled();
  });

  it("looks a landed payment up on mainnet", async () => {
    state.simulate.mockResolvedValue({ ok: false, error: "AlreadyProcessed" });
    state.landed.mockResolvedValue(true);
    expect((await paid()).status).toBe(409);
    expect(endpoint(state.landed)).toBe(MAINNET_RPC);
  });

  it("fronts a missing USDC account on mainnet, for mainnet USDC", async () => {
    state.atas.mockResolvedValue([payTo.toBase58()]);
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      urls.push(String(url));
      const { id } = JSON.parse(init.body) as { id: string };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 100 } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    state.broadcast.mockResolvedValue(undefined);
    try {
      expect((await paid()).status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(urls).toEqual([MAINNET_RPC]);
    expect(endpoint(state.broadcast)).toBe(MAINNET_RPC);
    const fronted = VersionedTransaction.deserialize(state.broadcast.mock.calls[0][1] as Uint8Array);
    const keys = fronted.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys).toContain(getAssociatedTokenAddressSync(MAINNET_USDC, payTo, true).toBase58());
    expect(keys).toContain(MAINNET_USDC.toBase58());
  });

  it("pays no author vault when the escrow runs on another cluster, where the program that releases it is", async () => {
    const promptId = "11111111-1111-4111-8111-111111111111";
    await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&promptId=${promptId}`));
    expect(state.shares).toHaveBeenLastCalledWith(db, promptId, null);
    vi.stubEnv("X402_PAYMENT_CHAIN", "solana-devnet");
    await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&promptId=${promptId}`));
    expect(String(state.shares.mock.lastCall?.[2])).toBe("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  });

  it("asks no payment for a prompt whose author is paid through the vault when the escrow program's deployment cannot be read (rounds 20, 21, 2026-10-20)", async () => {
    const promptId = "11111111-1111-4111-8111-111111111111";
    vi.stubEnv("X402_PAYMENT_CHAIN", "solana-devnet");
    state.deployedThrows = true;
    state.shares.mockResolvedValue({ referrerWallet: null, author: { kind: "vault", owner: Keypair.generate().publicKey.toBase58() }, claimed: false });
    const res = await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&promptId=${promptId}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "This prompt cannot be priced right now — try again shortly. Nothing was charged." });
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    // Read as deployed, so the vault share shows.
    expect(String(state.shares.mock.lastCall?.[2])).toBe("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    // With a payment: refused before it is checked, so nothing is said of it (it may be a retry of one that landed).
    const refused = await paid({ promptId, modelFamily: "nano-banana-pro" });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: `This prompt cannot be priced right now — try again shortly. ${LOOK_IT_UP}` });
    expect(state.simulate).not.toHaveBeenCalled();
  });

  it("sells every other prompt as before when the deployment cannot be read: no referral, an author paid to a wallet, another cluster, no program (round 21, 2026-10-20)", async () => {
    const promptId = "11111111-1111-4111-8111-111111111111";
    const probe = () => GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&promptId=${promptId}`));
    state.deployedThrows = true;
    vi.stubEnv("X402_PAYMENT_CHAIN", "solana-devnet");
    // Never referred, and referred with the author paid to their own wallet: the deployment decides nothing.
    expect((await probe()).status).toBe(402);
    state.shares.mockResolvedValue({ referrerWallet: null, author: { kind: "wallet", owner: Keypair.generate().publicKey.toBase58() }, claimed: true });
    expect((await probe()).status).toBe(402);
    // A hunter paid to their wallet, the author claimed or unknown: the referrer's credit needs no program (round 30).
    state.shares.mockResolvedValue({ referrerWallet: Keypair.generate().publicKey.toBase58(), author: { kind: "wallet", owner: Keypair.generate().publicKey.toBase58() }, claimed: true });
    expect((await probe()).status).toBe(402);
    state.shares.mockResolvedValue({ referrerWallet: Keypair.generate().publicKey.toBase58(), author: null, claimed: false });
    expect((await probe()).status).toBe(402);
    // The escrow on another cluster than x402's: its deployment is not asked, so it cannot fail.
    state.shares.mockResolvedValue({ referrerWallet: null, author: { kind: "vault", owner: Keypair.generate().publicKey.toBase58() }, claimed: false });
    vi.stubEnv("X402_PAYMENT_CHAIN", "solana");
    expect((await probe()).status).toBe(402);
    expect(state.shares).toHaveBeenLastCalledWith(db, promptId, null);
    // No escrow program configured at all.
    state.escrowCluster = "none";
    vi.stubEnv("X402_PAYMENT_CHAIN", "solana-devnet");
    expect((await probe()).status).toBe(402);
    expect(state.shares).toHaveBeenLastCalledWith(db, promptId, null);
  });

  it("pays no author vault when the escrow program is configured but not deployed on this chain (round 4, 2026-10-19)", async () => {
    const promptId = "11111111-1111-4111-8111-111111111111";
    vi.stubEnv("X402_PAYMENT_CHAIN", "solana-devnet");
    state.rail = "intent";
    await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&promptId=${promptId}`));
    expect(state.shares).toHaveBeenLastCalledWith(db, promptId, null);
  });
});

describe("a payment that would not settle says why (Kev, 2026-10-18: \"write the clear message\")", () => {
  const usdc = async () => Number(((await (await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&resolution=2K`))).json()) as { accepts: Array<{ maxAmountRequired: string }> }).accepts[0].maxAmountRequired) / 1_000_000;

  it("tells a buyer with too little USDC what it costs, with the 402 to pay again, and settles nothing", async () => {
    state.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "payer_usdc" });
    const res = await paid();
    expect(res.status).toBe(402);
    const sentence = `Your wallet holds less than the ${await usdc()} USDC this costs. Add USDC and pay again — nothing was charged.`;
    expect(((await res.json()) as { error: string }).error).toBe(sentence);
    // A v2 client reads the reason from the header: the same sentence, the requirements unchanged.
    const v2 = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8")) as { error: string; x402Version: number; accepts: unknown[] };
    expect(v2).toMatchObject({ error: sentence, x402Version: 2 });
    expect(v2.accepts).toHaveLength(1);
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("keeps the plain v2 error on a 402 that asks for the first payment", async () => {
    const res = await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&resolution=2K`));
    const v2 = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8")) as { error: string };
    expect(v2.error).toBe("PAYMENT-SIGNATURE header is required");
  });

  it("never says nothing was charged for an expired payment whose history could not be read (review 2026-10-18)", async () => {
    state.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "expired" });
    state.landed.mockResolvedValue(null);
    const res = await paid();
    expect(res.status).toBe(503);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    const body = (await res.json()) as { error: string; transaction: string };
    expect(body.error).toBe("Enki could not check whether this payment already landed. Look the transaction up on Solana before you pay again.");
    expect(body.transaction).toBeTruthy();
    // Not expired, the lookup failing changes nothing: the buyer's USDC was short, nothing landed.
    state.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "payer_usdc" });
    expect((await paid()).status).toBe(402);
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("tells a buyer whose payment was refused when sent that nothing was charged, with the 402 to pay again; a pending one stays 504", async () => {
    state.submit.mockResolvedValue({ ok: false, pending: false, error: "Simulation failed. custom program error: 0x1", signature: "sig" });
    const refused = await paid();
    expect(refused.status).toBe(402);
    expect(refused.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(((await refused.json()) as { error: string }).error).toBe("Your payment was refused when Enki sent it (most often your wallet's USDC changed after it was checked). Nothing was charged — sign a fresh payment and send it again.");
    state.submit.mockResolvedValue({ ok: false, pending: true, error: "timed out", signature: "sig" });
    const pending = await paid();
    expect(pending.status).toBe(504);
    expect(pending.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(((await pending.json()) as { error: string }).error).toBe("timed out");
  });

  it("tells a buyer without a USDC account and a buyer whose payment expired what to do", async () => {
    state.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "payer_no_account" });
    expect(((await (await paid()).json()) as { error: string }).error).toBe(`Your wallet has no USDC on this network yet. Add at least ${await usdc()} USDC and pay again — nothing was charged.`);
    state.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "expired" });
    const expired = await paid();
    expect(expired.status).toBe(402);
    expect(((await expired.json()) as { error: string }).error).toContain("Your payment expired before it reached Enki");
    state.simulate.mockResolvedValue({ ok: false, error: "Transaction simulation failed: \"SignatureFailure\"", reason: "other" });
    expect(((await (await paid()).json()) as { error: string }).error).toBe("Transaction simulation failed: \"SignatureFailure\"");
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("puts a fee payer out of SOL on Enki's side: 503, never a 402 that asks the buyer to pay again, and a log line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "fee_payer" });
    const res = await paid();
    expect(res.status).toBe(503);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe("Enki cannot settle payments right now (its fee payer is out of SOL). Nothing was charged — try again later.");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[x402] the fee payer cannot pay the network fee"));
    expect(state.submit).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("x402 charges its own fee", () => {
  it("quotes an artist prompt at 20% (Kev, 2026-10-17)", async () => {
    await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&promptId=11111111-1111-4111-8111-111111111111`));
    expect(state.quote).toHaveBeenCalledWith(db, expect.objectContaining({ enkiFeeBps: 2000 }));
  });
});

describe("x402 sells nothing 18+ (Kev, 2026-10-17: PayBox buyers are not age-verified)", () => {
  const PROMPT = "11111111-1111-4111-8111-111111111111";

  it("refuses an 18+ marketplace prompt before any 402 or quote, and before a payment is read", async () => {
    state.text.mockResolvedValue({ ok: true, text: "a fox", variables: [], adult: true });
    const res = await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&promptId=${PROMPT}`));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("This prompt is 18+ and is not sold over x402 — nothing was charged");
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(state.quote).not.toHaveBeenCalled();
    const refused = await paid({ promptId: PROMPT, modelFamily: "nano-banana-pro" });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: `This prompt is 18+ and is not sold over x402. ${LOOK_IT_UP}` });
    expect(state.simulate).not.toHaveBeenCalled();
  });

  it("refuses a request the prompt check finds 18+ before any payment, with no warning", async () => {
    for (const verdict of [{ verdict: "clear", adult: true }, { verdict: "extraction", confidence: 0.9, adult: true }]) {
      state.check.mockResolvedValue(verdict);
      const res = await paid();
      expect(res.status, verdict.verdict).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("This request is 18+ and is not generated over x402 — nothing was charged");
    }
    expect(state.submit).not.toHaveBeenCalled();
    expect(state.moderate).not.toHaveBeenCalled();
    expect(state.warn).not.toHaveBeenCalled();
  });

  it("keeps tier 2's sexual flag for an agent's own prompt too", async () => {
    expect((await paid()).status).toBe(200);
    expect(state.moderate).toHaveBeenCalledWith(expect.objectContaining({ prompt: "a fox", adultJudged: false }));
  });

  it("withholds an 18+ render after settlement: copies down, failure recorded with the signature, never recorded as a generation", async () => {
    state.imageCheck.mockResolvedValue({ verdict: "adult" });
    const res = await paid();
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; transaction: string; imageUrl?: string };
    expect(body.error).toBe("This image can't be delivered on Enki (18+). Your payment settled.");
    expect(body.imageUrl).toBeUndefined();
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    expect(state.removeStored).toHaveBeenCalledWith(["x.png"]);
    expect(state.fail).toHaveBeenCalledWith(db, expect.objectContaining({ error: "image check: adult", txSignature: body.transaction }));
    expect(state.record).not.toHaveBeenCalled();
  });

  it("records what it delivers as not 18+", async () => {
    expect((await paid()).status).toBe(200);
    expect(state.record.mock.calls[0][1]).toMatchObject({ adult: false });
  });
});

describe("Enki sells artist prompts over x402 and owes the licence (Kev, 2026-10-17: \"verkäufer-modell für künstlerprompts\")", () => {
  const PROMPT = "11111111-1111-4111-8111-111111111111";
  const ARTIST = Keypair.generate().publicKey.toBase58();
  const REFERRER = Keypair.generate().publicKey.toBase58();
  const VAULT = Keypair.generate().publicKey.toBase58();
  const QUERY = `modelFamily=nano-banana-pro&resolution=2K&promptId=${PROMPT}`;
  let split: import("@/lib/payments/generation-pricing").GenerationSplit;

  beforeEach(async () => {
    const { computeGenerationSplit, X402_ENKI_FEE_BPS } = await import("@/lib/payments/generation-pricing");
    // A $1 artist prompt on a 10-cent render, at the x402 fee: 220,000 fee, 1,320,000 total.
    split = computeGenerationSplit(1_000_000, 100_000, { enkiFeeBps: X402_ENKI_FEE_BPS });
    state.quote.mockResolvedValue({ ok: true, artistWallet: ARTIST, artistId: "u-artist", split, appliedRule: null });
    state.shares.mockResolvedValue({ referrerWallet: REFERRER, author: { kind: "vault", owner: VAULT }, claimed: false });
  });

  /** A payment of the given TransferChecked, built as a standard client builds it. */
  function pay(transfers: Array<[string, number]>): string {
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: feePayer.publicKey,
      recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
      instructions: transfers.map(([to, amount]) => createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(MAINNET_USDC, buyer.publicKey), MAINNET_USDC,
        getAssociatedTokenAddressSync(MAINNET_USDC, new PublicKey(to), true), buyer.publicKey, amount, 6,
      )),
    }).compileToV0Message());
    tx.sign([buyer]);
    return Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: Buffer.from(tx.serialize()).toString("base64") } })).toString("base64");
  }
  const buy = (transfers: Array<[string, number]>) => POST(new NextRequest(URL_BASE, {
    method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": pay(transfers) },
    body: JSON.stringify({ promptId: PROMPT, modelFamily: "nano-banana-pro", resolution: "2K" }),
  }));

  it("asks for one transfer of the whole price to Enki, in v1 and v2, and names no artist, referrer or vault", async () => {
    const res = await GET(new NextRequest(`${URL_BASE}?${QUERY}`));
    expect(res.status).toBe(402);
    expect(split.totalMicro).toBe(1_320_000);
    const one = [{ recipient: payTo.toBase58(), amountMicro: split.totalMicro }];
    const v1 = (await res.json()) as { accepts: Array<{ maxAmountRequired: string; payTo: string; description: string; extra: { legs: unknown; note: string } }> };
    expect(v1.accepts[0].maxAmountRequired).toBe(String(split.totalMicro));
    expect(v1.accepts[0].payTo).toBe(payTo.toBase58());
    expect(v1.accepts[0].extra.legs).toEqual(one);
    expect(v1.accepts[0].description).toContain("licence included");
    const v2 = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8")) as { accepts: Array<{ amount: string; extra: { legs: unknown } }> };
    expect(v2.accepts[0].amount).toBe(String(split.totalMicro));
    expect(v2.accepts[0].extra.legs).toEqual(one);
    const both = JSON.stringify(v1) + JSON.stringify(v2);
    for (const wallet of [ARTIST, REFERRER, VAULT]) expect(both).not.toContain(wallet);
    // The manifest says the same: one transfer, the licence included.
    const { GET: manifest } = await import("../../app/.well-known/x402/route");
    const m = JSON.stringify(await (await manifest(new NextRequest("https://www.enki.gallery/.well-known/x402"))).json());
    expect(m).toContain("Pay with one TransferChecked of the exact amount to payTo");
    expect(m).toContain("priced artist prompts (licence included)");
    expect(m).not.toMatch(/one per recipient|multi-leg|inside your own transaction/);
  });

  it("judges only the agent's own values, never an option the artist wrote (round 15, 2026-10-20)", async () => {
    state.inputs.mockResolvedValue({ ok: true, paid: true, variables: [{ name: "style" }, { name: "subject" }], values: new Map([["style", "noir"], ["subject", "a cat"]]) });
    state.text.mockResolvedValue({ ok: true, text: "a [subject] in [style]", variables: [{ name: "style", type: "single_select", choices: ["noir", "pastel"] }, { name: "subject" }], adult: false });
    const res = await POST(new NextRequest(URL_BASE, {
      method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": pay([[payTo.toBase58(), split.totalMicro]]) },
      body: JSON.stringify({ promptId: PROMPT, modelFamily: "nano-banana-pro", resolution: "2K", variableValues: { style: "noir", subject: "a cat", blank: "  " } }),
    }));
    expect(res.status).toBe(200);
    // Without the artist's variable names (round 17).
    expect(state.check).toHaveBeenCalledWith({ input_1: "a cat" }, expect.anything());
    // Every record carries what the agent sent in full, blank values left out (rounds 16, 18).
    expect(state.modEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prompt: JSON.stringify({ style: "noir", subject: "a cat" }) }));
  });

  it("settles one TransferChecked of the total to Enki for an artist prompt, and refuses the old per-share legs", async () => {
    const res = await buy([[payTo.toBase58(), split.totalMicro]]);
    expect(res.status).toBe(200);
    expect(state.submit).toHaveBeenCalledTimes(1);
    const fee = split.enkiFeeMicro;
    const legs = await buy([[ARTIST, split.artistAmountMicro], [payTo.toBase58(), split.enkiTotalMicro - 2 * Math.floor(fee / 4)], [REFERRER, Math.floor(fee / 4)], [VAULT, Math.floor(fee / 4)]]);
    expect(legs.status).toBe(402);
    expect(state.submit).toHaveBeenCalledTimes(1);
  });

  it("owes the artist, the referrer and the author their split amounts once the render is delivered, keyed by the payment", async () => {
    const res = await buy([[payTo.toBase58(), split.totalMicro]]);
    expect(res.status).toBe(200);
    const { transaction } = (await res.json()) as { transaction: string };
    expect(state.credit).toHaveBeenCalledTimes(1);
    expect(state.credit).toHaveBeenCalledWith(db, {
      source: `x402:${transaction}`,
      mint: MAINNET_USDC.toBase58(),
      promptId: PROMPT,
      credits: [
        { role: "artist", owner: ARTIST, userId: "u-artist", micro: 1_000_000 },
        // A quarter each of the 10% fee (110,000), not of the 20% x402 fee (Kev, 2026-10-18).
        { role: "referrer", owner: REFERRER, micro: 27_500 },
        { role: "author", owner: VAULT, micro: 27_500 },
      ],
    });
  });

  it("sells a priced prompt whose artist has no payout wallet, and owes the share to the account (Kev, 2026-10-18: \"all prompts must be accessible\")", async () => {
    state.quote.mockResolvedValue({ ok: true, artistWallet: null, artistId: "u-artist", split, appliedRule: null });
    const quote = await GET(new NextRequest(`${URL_BASE}?${QUERY}`));
    expect(quote.status).toBe(402);
    expect(state.quote).toHaveBeenCalledWith(db, expect.objectContaining({ artistWalletOptional: true }));
    const res = await buy([[payTo.toBase58(), split.totalMicro]]);
    expect(res.status).toBe(200);
    expect(state.credit.mock.calls[0][1].credits).toEqual([
      { role: "artist", owner: null, userId: "u-artist", micro: 1_000_000 },
      { role: "referrer", owner: REFERRER, micro: 27_500 },
      { role: "author", owner: VAULT, micro: 27_500 },
    ]);
  });

  it("owes no artist for a free prompt, only the shares", async () => {
    const { computeGenerationSplit, X402_ENKI_FEE_BPS } = await import("@/lib/payments/generation-pricing");
    const free = computeGenerationSplit(0, 100_000, { enkiFeeBps: X402_ENKI_FEE_BPS });
    state.quote.mockResolvedValue({ ok: true, artistWallet: null, artistId: null, split: free, appliedRule: null });
    expect((await buy([[payTo.toBase58(), free.totalMicro]])).status).toBe(200);
    expect(state.credit.mock.calls[0][1].credits.map((c: { role: string }) => c.role)).toEqual(["referrer", "author"]);
  });

  it("owes nothing for a render it withheld or could not make, nor for a plain prompt", async () => {
    state.imageCheck.mockResolvedValue({ verdict: "adult" });
    expect((await buy([[payTo.toBase58(), split.totalMicro]])).status).toBe(422);
    state.imageCheck.mockResolvedValue({ verdict: "unavailable" });
    expect((await buy([[payTo.toBase58(), split.totalMicro]])).status).toBe(502);
    state.imageCheck.mockResolvedValue({ verdict: "clear" });
    state.provider.mockResolvedValue({ success: false, error: "boom" });
    expect((await buy([[payTo.toBase58(), split.totalMicro]])).status).toBe(502);
    expect(state.credit).not.toHaveBeenCalled();
    state.provider.mockResolvedValue({ success: true, imageBuffers: [Buffer.from("fixture")] });
    expect((await paid()).status).toBe(200);
    expect(state.credit).not.toHaveBeenCalled();
  });

  // DEC-475 (Kev, 2026-10-28, "4 yes"): an artist's text is refused by the web's rules here too (DEC-441, DEC-474).
  describe("an artist's prompt refused for its own text", () => {
    const UNAVAILABLE = "This prompt can't be generated right now. Nothing was generated and nothing was charged.";
    const buyWith = () => POST(new NextRequest(URL_BASE, {
      method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": pay([[payTo.toBase58(), split.totalMicro]]) },
      body: JSON.stringify({ promptId: PROMPT, modelFamily: "nano-banana-pro", resolution: "2K", variableValues: { subject: "my neighbour" } }),
    }));
    beforeEach(() => {
      state.inputs.mockResolvedValue({ ok: true, paid: true, variables: [{ name: "subject" }], values: new Map([["subject", "my neighbour"]]) });
      state.text.mockResolvedValue({ ok: true, text: "a portrait of [subject] in oil on linen", variables: [{ name: "subject" }], adult: false });
      pause.refused.mockClear();
    });

    it("is judged again with the agent's typed words neutral; refused again, the prompt pauses, nothing is charged and no one is warned", async () => {
      state.moderate.mockResolvedValueOnce({ allowed: false, category: "violence" }).mockResolvedValueOnce({ allowed: false, category: "violence" });
      const res = await buyWith();
      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe(UNAVAILABLE);
      expect(state.moderate.mock.calls[1][0]).toMatchObject({ prompt: "a portrait of something in oil on linen", surface: "x402-generate" });
      expect(pause.refused).toHaveBeenCalledWith(expect.anything(), { promptId: PROMPT, cause: "moderation", detail: "violence", buyerUserId: null });
      expect(state.warn).not.toHaveBeenCalled(); expect(state.submit).not.toHaveBeenCalled(); expect(state.provider).not.toHaveBeenCalled();
    });

    it("pauses on a child-safety hit the artist's text makes alone, and warns the agent for its own words only", async () => {
      state.moderate.mockResolvedValueOnce({ allowed: false, category: "minor_sexual" }).mockResolvedValueOnce({ allowed: false, category: "minor_sexual" });
      expect((await (await buyWith()).json()).error).toBe(UNAVAILABLE);
      expect(pause.refused).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cause: "moderation", detail: "minor_sexual" }));
      expect(state.warn).not.toHaveBeenCalled();
      pause.refused.mockClear();
      state.moderate.mockResolvedValueOnce({ allowed: false, category: "minor_sexual" }).mockResolvedValueOnce({ allowed: true });
      const own = await buyWith();
      expect(own.status).toBe(422);
      expect((await own.json()).error).toBe("warned: minor_sexual");
      expect(state.warn).toHaveBeenCalledOnce(); expect(pause.refused).not.toHaveBeenCalled();
    });

    it("refuses as moderation without a pause or a warning when the re-judge could not run, or only the agent's words were refused", async () => {
      state.moderate.mockResolvedValueOnce({ allowed: false, category: "minor_sexual" }).mockResolvedValueOnce({ allowed: true, tier2Degraded: true });
      expect((await (await buyWith()).json()).error).toBe("Refused by moderation");
      // Still on file (review wf_794afa1b-83d).
      expect(state.modEvent).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, category: "minor_sexual" }), expect.objectContaining({ surface: "x402-generate", promptId: PROMPT }));
      state.moderate.mockResolvedValueOnce({ allowed: false, category: "violence" }).mockResolvedValueOnce({ allowed: true });
      expect((await (await buyWith()).json()).error).toBe("Refused by moderation");
      expect(pause.refused).not.toHaveBeenCalled(); expect(state.warn).not.toHaveBeenCalled(); expect(state.submit).not.toHaveBeenCalled();
    });

    // DEC-478 (review wf_794afa1b-83d): a buyer here is a fresh keypair, so no refusal on this rail counts one.
    it("records a provider's content refusal of its hidden text for the admin, counting no buyer; another failure is no refusal", async () => {
      state.provider.mockResolvedValueOnce({ success: false, error: "Your request was rejected by the safety system" });
      expect((await buyWith()).status).toBe(502);
      expect(pause.refused).toHaveBeenCalledWith(expect.anything(), { promptId: PROMPT, cause: "provider", detail: expect.any(String), buyerUserId: null });
      pause.refused.mockClear();
      state.provider.mockResolvedValueOnce({ success: false, error: "boom" });
      expect((await buyWith()).status).toBe(502);
      expect(pause.refused).not.toHaveBeenCalled();
    });

    it("records no refusal of a public text: the agent filled it", async () => {
      state.inputs.mockResolvedValue({ ok: true, paid: false, variables: [{ name: "subject" }], values: new Map([["subject", "my neighbour"]]) });
      state.provider.mockResolvedValueOnce({ success: false, error: "Your request was rejected by the safety system" });
      expect((await buyWith()).status).toBe(502);
      expect(pause.refused).not.toHaveBeenCalled();
    });
  });

  // ENC review (2026-10-27): an agent's value can tell the model to typeset a paid prompt's hidden words.
  it("withholds a render that spells out a paid prompt's hidden text, and owes nothing for it", async () => {
    state.inputs.mockResolvedValue({ ok: true, paid: true, variables: [], values: new Map() });
    state.text.mockResolvedValue({ ok: true, text: "a lone red fox crossing a frozen river at dawn in thick fog", variables: [], adult: false });
    state.imageCheck.mockResolvedValue({ verdict: "clear", text: "A LONE RED FOX CROSSING A FROZEN RIVER" });
    const res = await buy([[payTo.toBase58(), split.totalMicro]]);
    expect(res.status).toBe(422);
    expect(state.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ error: "image check: hidden text" }));
    expect(state.removeStored).toHaveBeenCalled();
    expect(state.credit).not.toHaveBeenCalled();
    // No one struck: the artist's lettering reads the same as an extraction; the prompt goes toward a pause.
    const { recordExtractionHit } = await import("@/lib/moderation/extraction-hits");
    expect(recordExtractionHit).not.toHaveBeenCalled();
    expect(pause.refused).toHaveBeenCalledWith(expect.anything(), { promptId: PROMPT, cause: "render", detail: "hidden text", buyerUserId: null });
    // Released by an admin as meant lettering, it is delivered.
    pause.released = true;
    expect((await buy([[payTo.toBase58(), split.totalMicro]])).status).toBe(200);
    pause.released = false;
    // A free prompt's text is public: the same render is delivered.
    state.inputs.mockResolvedValue({ ok: true, paid: false, variables: [], values: new Map() });
    expect((await buy([[payTo.toBase58(), split.totalMicro]])).status).toBe(200);
  });

  it("writes the credits on the delivered path only, after the answer is decided", async () => {
    const { readSource } = await import("./_read-source");
    const { join } = await import("node:path");
    const src = readSource(join(__dirname, "..", "..", "app", "api", "x402", "generate", "route.ts"));
    expect((src.match(/recordLicenceCredits\(/g) ?? []).length).toBe(1);
    const call = src.indexOf("after(recordLicenceCredits(supabase, {");
    expect(call).toBeGreaterThan(src.indexOf("const imageId = await imageIdWithin(recording);"));
    expect(call).toBeLessThan(src.indexOf("imageUrl: stored.imageUrl,"));
    expect(src.slice(call, src.indexOf("}));", call))).toContain("source: `x402:${signature}`, mint: usdcMint(chainKey).toBase58(),");
  });
});

describe("a prompt whose creator switched buyers' references off (SQL 62)", () => {
  const promptId = "11111111-1111-4111-8111-111111111111";
  const ASKED = { promptId, modelFamily: "nano-banana-pro", referenceImages: ["data:image/png;base64,AAAA"] };
  const REFUSED = { error: "This prompt does not take reference images. Nothing was charged." };
  const probe = (body: Record<string, unknown>) => POST(new NextRequest(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

  it("says no at the 402, before any payment is asked for", async () => {
    state.allows.mockResolvedValue(false);
    const res = await probe(ASKED);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(REFUSED);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(state.allows).toHaveBeenCalledWith(db, promptId);
    expect(state.quote).not.toHaveBeenCalled();
  });

  it("says no to a payment sent anyway: nothing simulated, settled or rendered, and no word that nothing was charged, as it may be the retry of one that landed", async () => {
    state.allows.mockResolvedValue(false);
    for (const header of ["X-PAYMENT", "PAYMENT-SIGNATURE"]) {
      const res = await POST(new NextRequest(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json", [header]: "anything" }, body: JSON.stringify(ASKED) }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: `This prompt does not take reference images. ${LOOK_IT_UP}` });
    }
    expect(state.simulate).not.toHaveBeenCalled();
    expect(state.submit).not.toHaveBeenCalled();
    expect(state.provider).not.toHaveBeenCalled();
  });

  it("a refusal with a payment drops only that clause, and one that claims nothing stays as it is", async () => {
    const send = () => POST(new NextRequest(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": "anything" }, body: JSON.stringify({ promptId, modelFamily: "nano-banana-pro" }) }));
    state.text.mockResolvedValue({ ok: false, status: 500, error: "This prompt's text cannot be read right now. Nothing was generated and nothing was charged." });
    expect(await (await send()).json()).toEqual({ error: `This prompt's text cannot be read right now. Nothing was generated. ${LOOK_IT_UP}` });
    state.text.mockResolvedValue({ ok: false, status: 404, error: "This prompt is not for sale." });
    expect(await (await send()).json()).toEqual({ error: "This prompt is not for sale." });
  });

  it("does not ask without references: this rail sends none, the prompt sells as ever", async () => {
    state.allows.mockResolvedValue(false);
    for (const referenceImages of [undefined, [], [""], "a string is no list"]) {
      expect((await probe({ promptId, modelFamily: "nano-banana-pro", referenceImages })).status).toBe(402);
    }
    expect(state.allows).not.toHaveBeenCalled();
  });

  it("changes nothing on a prompt left on, or on an agent's own prompt", async () => {
    expect((await probe(ASKED)).status).toBe(402);
    state.allows.mockClear();
    expect((await probe({ ...BODY, referenceImages: ["data:image/png;base64,AAAA"] })).status).toBe(402);
    expect(state.allows).not.toHaveBeenCalled();
  });
});

// The daily spend breaker (key-theft measures, M3): the only rail paid before its provider, so a refusal comes before money
// moves. The refusals are the real module's. Blind spot: the database is a stand-in; the arithmetic is in spend-cap.test.ts.
describe("the daily spend breaker", () => {
  async function refusals() {
    const real = await vi.importActual<typeof import("@/lib/generation/spend-cap")>("@/lib/generation/spend-cap");
    const reached = await real.reserveSpend({ rpc: async () => ({ data: [{ allowed: false, first_refusal: false, spend_day: "2026-11-04" }], error: null }) } as never, 1);
    const unread = await real.reserveSpend(null, 1);
    if (reached.ok || unread.ok) throw new Error("the fixture was allowed");
    return { reached, unread };
  }
  const HELD = { ok: true, day: "2026-11-04", micro: 900 };
  /** The two amounts the route reserved: the judge's, then the render's. */
  const amounts = () => state.reserve.mock.calls.map((c) => c[1] as number);

  it.each(["reached", "unread"] as const)("the judge's reservation refused (%s): no judge, no payment, no provider, and it says nothing of a payment it did not look up", async (which) => {
    const refusal = (await refusals())[which];
    state.reserve.mockResolvedValueOnce(refusal);
    const res = await paid();
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(`${refusal.why} No image was generated. ${LOOK_IT_UP}`);
    expect(body.error).not.toMatch(/nothing was charged/i);
    for (const spy of [state.check, state.moderate, state.replay, state.submit, state.provider, state.record, state.credit]) expect(spy).not.toHaveBeenCalled();
    expect(amounts()).toEqual([300]);
  });

  it.each(["reached", "unread"] as const)("the render's reservation refused (%s): judged and simulated, but no signature recorded, nothing settled, no provider", async (which) => {
    const refusal = (await refusals())[which];
    state.reserve.mockResolvedValueOnce(HELD).mockResolvedValueOnce(refusal);
    const res = await paid();
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(`${refusal.why} No image was generated. ${LOOK_IT_UP}`);
    expect(body.error).not.toMatch(/nothing was charged/i);
    expect(state.check).toHaveBeenCalledOnce();
    expect(state.simulate).toHaveBeenCalledOnce();
    for (const spy of [state.replay, state.submit, state.provider, state.record, state.credit, state.release]) expect(spy).not.toHaveBeenCalled();
  });

  it("a payment that cannot pay is refused before any reservation or judge: a stranger's empty keypair adds nothing to the day", async () => {
    state.simulate.mockResolvedValue({ ok: false, error: "raw", reason: "payer_usdc" });
    expect((await paid()).status).toBe(402);
    for (const spy of [state.reserve, state.screen, state.check, state.moderate, state.submit, state.provider]) expect(spy).not.toHaveBeenCalled();
  });

  it("what the regex refuses costs nothing and reserves nothing, for a payable payment too", async () => {
    state.screen.mockReturnValue({ allowed: false, tier: 1, category: "fixture", rules: [], scores: {} });
    expect((await paid()).status).toBe(422);
    for (const spy of [state.reserve, state.check, state.moderate, state.submit, state.provider]) expect(spy).not.toHaveBeenCalled();
  });

  it("simulates first, reserves the judge before it runs and the bill before the payment settles", async () => {
    const seen: string[] = [];
    state.simulate.mockImplementation(async () => { seen.push("simulate"); return { ok: true }; });
    state.reserve.mockImplementation(async (_d: unknown, micro: number) => { seen.push(micro === 300 ? "reserve judge" : "reserve bill"); return { ...HELD, micro }; });
    state.check.mockImplementation(async () => { seen.push("judge"); return { verdict: "clear" }; });
    state.replay.mockImplementation(async () => { seen.push("replay"); return { isNew: true }; });
    state.submit.mockImplementation(async () => { seen.push("settle"); return { ok: true, signature: "sig" }; });
    state.provider.mockImplementation(async () => { seen.push("provider"); return { success: true, imageBuffers: [Buffer.from("fixture")] }; });
    expect((await paid()).status).toBe(200);
    expect(seen).toEqual(["simulate", "reserve judge", "judge", "reserve bill", "replay", "settle", "provider"]);
    expect(state.release).not.toHaveBeenCalled();
  });

  it("a plain prompt reserves the model's leg of the price, not the price with Enki's fee", async () => {
    const { computeGenerationSplit, X402_ENKI_FEE_BPS } = await import("@/lib/payments/generation-pricing");
    await paid();
    const bill = amounts()[1];
    expect(bill).toBeGreaterThan(0);
    const quoted = await GET(new NextRequest(`${URL_BASE}?modelFamily=nano-banana-pro&resolution=2K`));
    const total = Number(((await quoted.json()) as { accepts: Array<{ maxAmountRequired: string }> }).accepts[0].maxAmountRequired);
    expect(computeGenerationSplit(0, bill, { enkiFeeBps: X402_ENKI_FEE_BPS }).totalMicro).toBe(total);
    expect(bill).toBeLessThan(total);
  });

  it("a marketplace prompt reserves the quote's model leg, not its total", async () => {
    const { computeGenerationSplit } = await import("@/lib/payments/generation-pricing");
    state.quote.mockResolvedValue({ ok: true, artistWallet: null, split: computeGenerationSplit(50_000, 100_000), appliedRule: null });
    const body = { promptId: "99999999-9999-4999-8999-999999999999", modelFamily: "nano-banana-pro", resolution: "2K" };
    const reqs = await POST(new NextRequest(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    const amount = Number(((await reqs.json()) as { accepts: Array<{ maxAmountRequired: string }> }).accepts[0].maxAmountRequired);
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: feePayer.publicKey, recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
      instructions: [createTransferCheckedInstruction(getAssociatedTokenAddressSync(MAINNET_USDC, buyer.publicKey), MAINNET_USDC, getAssociatedTokenAddressSync(MAINNET_USDC, payTo), buyer.publicKey, amount, 6)],
    }).compileToV0Message());
    tx.sign([buyer]);
    const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: Buffer.from(tx.serialize()).toString("base64") } })).toString("base64");
    await POST(new NextRequest(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": header }, body: JSON.stringify(body) }));
    expect(amounts()).toEqual([300, 100_000]);
  });

  it("a signature already recorded gives the reservation back: no provider will be called", async () => {
    state.replay.mockResolvedValue({ isNew: false });
    expect((await paid()).status).toBe(409);
    expect(state.provider).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
    expect(state.release.mock.calls[0][1]).toMatchObject({ micro: amounts()[1] });
  });

  it.each([
    ["refused at sending", { ok: false, pending: false, error: "rejected" }],
    ["outcome unknown", { ok: false, pending: true, error: "pending" }],
  ])("a payment that did not settle gives the reservation back (%s): no provider will be called", async (_name, settled) => {
    state.submit.mockResolvedValue(settled);
    await paid();
    expect(state.provider).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
    expect(state.release.mock.calls[0][1]).toMatchObject({ micro: amounts()[1] });
  });

  it("a provider that refused the content gives the reservation back", async () => {
    state.provider.mockResolvedValue({ success: false, error: "blocked by content_policy" });
    expect((await paid()).status).toBe(502);
    expect(state.release).toHaveBeenCalledOnce();
  });

  it.each(["fixture outage", "rate limit exceeded", "upstream timeout"])("an outage may be billed: %s keeps the reservation", async (error) => {
    state.provider.mockResolvedValue({ success: false, error });
    expect((await paid()).status).toBe(502);
    expect(state.release).not.toHaveBeenCalled();
  });

  it.each(["GEMINI_API_KEY is not set", "invalid api key", "invalid request"])("answered before any work: %s gives the reservation back", async (error) => {
    state.provider.mockResolvedValue({ success: false, error });
    expect((await paid()).status).toBe(502);
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("a request refused silently reserves no render and settles nothing", async () => {
    state.check.mockResolvedValue({ verdict: "extraction", confidence: 0.9 });
    await paid();
    expect(amounts()).toEqual([300]);
    expect(state.submit).not.toHaveBeenCalled();
    expect(state.provider).not.toHaveBeenCalled();
  });
});
