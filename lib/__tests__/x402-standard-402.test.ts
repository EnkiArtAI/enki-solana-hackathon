import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

/**
 * The 402 is the whole interface to a standard x402 client (PayBox included):
 * it builds the payment from these fields alone (Kev, 2026-10-17: "dann ist
 * standardkonformität ein muss"). Each test pins one field a client reads.
 */

let GET: typeof import("../../app/api/x402/generate/route").GET;
let POST: typeof import("../../app/api/x402/generate/route").POST;
let NextRequest: typeof import("next/server").NextRequest;
beforeAll(async () => {
  ({ GET, POST } = await import("../../app/api/x402/generate/route"));
  ({ NextRequest } = await import("next/server"));
}, 60_000);

async function configure(chain: "solana" | "solana-devnet", feePayer = true, x402Chain = "") {
  vi.stubEnv("SOLANA_PAYMENT_CHAIN", chain);
  vi.stubEnv("X402_PAYMENT_CHAIN", x402Chain);
  vi.stubEnv("SOLANA_PLATFORM_WALLET", "P1atformWa11et111111111111111111111111111111");
  vi.stubEnv("SOLANA_FEE_PAYER_SECRET_KEY", feePayer ? JSON.stringify(Array.from(Keypair.generate().secretKey)) : "");
  const { resetFeePayerCache } = await import("@/lib/payments/solana");
  resetFeePayerCache();
}
afterEach(() => vi.unstubAllEnvs());

type V1 = { x402Version: number; accepts: Array<{ network: string; resource: string; maxAmountRequired: string; asset: string; payTo: string; extra: { feePayer?: string } }> };
type V2 = { x402Version: number; resource: { url: string }; accepts: Array<{ network: string; amount: string; asset: string; payTo: string; extra: { feePayer?: string; paymentFlow?: string } }> };
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const v2Of = (res: Response): V2 => JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8"));

describe("the x402 402", () => {
  it("names the deployment's own network in v1 and CAIP-2, with its own USDC", async () => {
    for (const [chain, v1, caip2, mint] of [
      ["solana", "solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
      ["solana-devnet", "solana-devnet", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"],
    ] as const) {
      await configure(chain);
      const res = await GET(new NextRequest("https://www.enki.gallery/api/x402/generate?modelFamily=nano-banana-pro&resolution=2K"));
      expect(res.status).toBe(402);
      const body = (await res.json()) as V1;
      expect(body.accepts[0].network).toBe(v1);
      expect(body.accepts[0].asset).toBe(mint);
      const v2 = v2Of(res);
      expect(v2.accepts[0].network).toBe(caip2);
      expect(v2.accepts[0].asset).toBe(mint);
    }
  });

  it("gives an absolute resource URL and the same requirements in the v2 header, flow upfront", async () => {
    await configure("solana");
    const res = await GET(new NextRequest("https://www.enki.gallery/api/x402/generate?modelFamily=nano-banana-pro&resolution=2K"));
    const body = (await res.json()) as V1;
    const v2 = v2Of(res);
    expect(body.accepts[0].resource).toBe("https://www.enki.gallery/api/x402/generate");
    expect(v2.x402Version).toBe(2);
    expect(v2.resource.url).toBe("https://www.enki.gallery/api/x402/generate");
    expect(v2.accepts[0].amount).toBe(body.accepts[0].maxAmountRequired);
    expect(v2.accepts[0].payTo).toBe(body.accepts[0].payTo);
    expect(v2.accepts[0].extra.feePayer).toBe(body.accepts[0].extra.feePayer);
    expect(v2.accepts[0].extra.paymentFlow).toBe("upfront");
  });

  it("answers 503, not an unpayable 402, without a fee payer", async () => {
    await configure("solana", false);
    const res = await GET(new NextRequest("https://www.enki.gallery/api/x402/generate?modelFamily=nano-banana-pro"));
    expect(res.status).toBe(503);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  it("prices a POST without a body from its URL, as a probe that sends the body only when paying", async () => {
    await configure("solana");
    const res = await POST(new NextRequest("https://www.enki.gallery/api/x402/generate?modelFamily=nano-banana-pro&resolution=2K", { method: "POST" }));
    expect(res.status).toBe(402);
    const quote = await GET(new NextRequest("https://www.enki.gallery/api/x402/generate?modelFamily=nano-banana-pro&resolution=2K"));
    expect(((await res.json()) as V1).accepts[0].maxAmountRequired).toBe(((await quote.json()) as V1).accepts[0].maxAmountRequired);
  });

  it("answers a settled payment in the version it came in, naming the buyer as payer", async () => {
    // Settlement needs a chain, so the wiring is read from the source.
    const { readSource } = await import("@/lib/__tests__/_read-source");
    const { join } = await import("node:path");
    const src = readSource(join(__dirname, "..", "..", "app", "api", "x402", "generate", "route.ts"));
    expect(src).toContain('const payment = req.headers.get("X-PAYMENT") ?? req.headers.get("PAYMENT-SIGNATURE");');
    expect(src).toContain("const parsed = parseXPayment(paymentHeader, [net.v1, net.caip2]);");
    expect(src).toContain("const buyer = verified.payer;");
    expect(src).toContain('? { "PAYMENT-RESPONSE": paymentResponseHeader(signature, net.caip2, buyer) }');
    expect(src).toContain(': { "X-PAYMENT-RESPONSE": paymentResponseHeader(signature, net.v1, buyer) };');
    expect(src).not.toContain("feePayer.publicKey) }");
    // The delivered render, the withheld one and the one that spelled out the hidden text (ENC review, 2026-10-27).
    expect(src.match(/headers: settledHeaders\(signature\)/g)?.length).toBe(3);
  });

  it("is described the same way in the discovery manifest", async () => {
    await configure("solana-devnet");
    const { GET: manifest } = await import("../../app/.well-known/x402/route");
    const m = (await (await manifest(new NextRequest("https://www.enki.gallery/.well-known/x402"))).json()) as { network: string; resources: Array<{ resource: string }> };
    expect(m.network).toBe("solana-devnet");
    expect(m.resources[0].resource).toBe("https://www.enki.gallery/api/x402/generate");
  });

  it("settles on X402_PAYMENT_CHAIN, not the escrow's chain, in v1 and v2", async () => {
    // Kev, 2026-10-17: x402 on mainnet while the escrow stays on devnet.
    await configure("solana-devnet", true, "solana");
    const res = await GET(new NextRequest("https://www.enki.gallery/api/x402/generate?modelFamily=nano-banana-pro&resolution=2K"));
    expect(res.status).toBe(402);
    const body = (await res.json()) as V1;
    expect(body.accepts[0].network).toBe("solana");
    expect(body.accepts[0].asset).toBe(MAINNET_USDC);
    const v2 = v2Of(res);
    expect(v2.accepts[0].network).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(v2.accepts[0].asset).toBe(MAINNET_USDC);
  });

  it("follows SOLANA_PAYMENT_CHAIN while X402_PAYMENT_CHAIN is unset or empty", async () => {
    for (const x402Chain of [undefined, ""]) {
      await configure("solana-devnet");
      if (x402Chain === undefined) delete process.env.X402_PAYMENT_CHAIN;
      const res = await GET(new NextRequest("https://www.enki.gallery/api/x402/generate?modelFamily=nano-banana-pro&resolution=2K"));
      const body = (await res.json()) as V1;
      expect(body.accepts[0].network, String(x402Chain)).toBe("solana-devnet");
      expect(body.accepts[0].asset).toBe(DEVNET_USDC);
    }
  });

  it("answers 503, never a 402, when X402_PAYMENT_CHAIN names no Solana chain", async () => {
    for (const bad of ["base", "solana-mainnet"]) {
      await configure("solana-devnet", true, bad);
      const res = await GET(new NextRequest("https://www.enki.gallery/api/x402/generate?modelFamily=nano-banana-pro"));
      expect(res.status, bad).toBe(503);
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
      const { x402ChainKey } = await import("@/lib/payments/solana");
      expect(() => x402ChainKey()).toThrow(/Not a Solana chain key/);
    }
  });

  it("names the x402 chain in the discovery manifest", async () => {
    await configure("solana-devnet", true, "solana");
    const { GET: manifest } = await import("../../app/.well-known/x402/route");
    const m = (await (await manifest(new NextRequest("https://www.enki.gallery/.well-known/x402"))).json()) as { network: string };
    expect(m.network).toBe("solana");
  });

  it("charges agents Enki's 20% where the web rails charge 10% (Kev, 2026-10-17)", async () => {
    await configure("solana");
    const res = await GET(new NextRequest("https://www.enki.gallery/api/x402/generate?modelFamily=nano-banana-pro&resolution=2K"));
    const { computeGenerationSplit, modelLegMicro } = await import("@/lib/payments/generation-pricing");
    const leg = modelLegMicro("nano-banana-pro", "2K");
    const amount = ((await res.json()) as V1).accepts[0].maxAmountRequired;
    expect(amount).toBe(String(computeGenerationSplit(0, leg, { enkiFeeBps: 2000 }).totalMicro));
    expect(amount).not.toBe(String(computeGenerationSplit(0, leg).totalMicro));
    expect(v2Of(res).accepts[0].amount).toBe(amount);
  });

  it("quotes the quality a paid POST will be priced at", async () => {
    await configure("solana");
    const quote = await GET(new NextRequest("https://www.enki.gallery/api/x402/generate?modelFamily=gpt-image-2&resolution=1K&quality=high"));
    const unpaid = await POST(new NextRequest("https://www.enki.gallery/api/x402/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a fox", modelFamily: "gpt-image-2", resolution: "1K", quality: "high" }),
    }));
    const low = await GET(new NextRequest("https://www.enki.gallery/api/x402/generate?modelFamily=gpt-image-2&resolution=1K&quality=low"));
    const amount = async (r: Response) => ((await r.json()) as V1).accepts[0].maxAmountRequired;
    const high = await amount(quote);
    expect(high).toBe(await amount(unpaid));
    expect(high).not.toBe(await amount(low));
  });
});
