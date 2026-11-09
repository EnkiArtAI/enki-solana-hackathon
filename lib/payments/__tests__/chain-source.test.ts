import { describe, it, expect, afterEach, vi } from "vitest";
import { PAYMENT_CHAINS, isSolanaChain } from "@/shared/payment-config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the money settles is a server decision.
 *
 * The generate route asserted a raw query parameter into ChainKey and, in the
 * Solana branch, used that string as the chain while the fee payer, the RPC
 * connection and the USDC mint all came from SOLANA_PAYMENT_CHAIN. Two sources
 * of truth for one decision, and the one a stranger controls was winning for
 * half the code.
 */

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(p, "utf8").split("\r\n").join("\n");
const ROUTE = read(join(ROOT, "app", "api", "generate-image", "route.ts"));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("the caller cannot choose the settlement chain", () => {
  it("an unknown chain key fails loudly in the config", () => {
    // isSolanaChain does PAYMENT_CHAINS[key].isSolana — on an unknown key that
    // is a TypeError, which is why no route may pass it a raw query value.
    expect(() => isSolanaChain("not-a-chain" as never)).toThrow();
    expect("solana-devnet" in PAYMENT_CHAINS).toBe(true);
  });

  it("the generate route reads no chain from the request at all", () => {
    // Since REC-4 it takes intents only, and the intent rail settles on the
    // server's chain. The x402 branches that read ?chain= are gone.
    expect(ROUTE).not.toMatch(/searchParams\.get\(['"]chain['"]\)/);
  });

  it("it records the server's chain, not a default a caller could steer", () => {
    // Intent-paid generations used to be recorded with the query string's
    // fallback, 'base-sepolia', on a rail that only ever settles on Solana.
    // Each rail records the chain its server settles on (2026-10-18): escrow its program's cluster, intents SOLANA_PAYMENT_CHAIN.
    expect(ROUTE).toMatch(/workflowTexts: stripped\.texts, chainKey,\n/);
    expect(ROUTE).toMatch(/chainKey = paymentChain\.cluster;/);
    expect(ROUTE).toMatch(/paymentChain = escrowServerChain\(\)/);
    expect(ROUTE).toMatch(/chainKey = solanaChainKey\(\);/);
  });
});

describe("solanaChainKey", () => {
  it("returns the configured chain", async () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
    const { solanaChainKey } = await import("@/lib/payments/solana");
    expect(solanaChainKey()).toBe("solana-devnet");
  });

  it("refuses a non-Solana chain rather than settling on it", async () => {
    // "base" is a real chain and still the wrong answer here — a silent
    // acceptance would build a Solana transfer against an EVM config.
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "base");
    const { solanaChainKey } = await import("@/lib/payments/solana");
    expect(() => solanaChainKey()).toThrow(/Not a Solana chain key/);
  });

  it("refuses a chain that does not exist", async () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-mainnet-beta-typo");
    const { solanaChainKey } = await import("@/lib/payments/solana");
    expect(() => solanaChainKey()).toThrow(/Not a Solana chain key/);
  });

  it("treats an empty env value as unset rather than as a chain", async () => {
    // The || is deliberate: `SOLANA_PAYMENT_CHAIN=` puts an empty string in
    // the environment and ?? would take it, which threw on the devnet dry run.
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "");
    vi.stubEnv("SOLANA_FUND_CHAIN", "");
    const { solanaChainKey } = await import("@/lib/payments/solana");
    expect(solanaChainKey()).toBe("solana-devnet");
  });
});

describe("x402ChainKey", () => {
  // Kev, 2026-10-17: x402 settles on mainnet while the escrow stays on devnet.
  it("takes X402_PAYMENT_CHAIN over the deployment's chain, which keeps its own", async () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
    vi.stubEnv("X402_PAYMENT_CHAIN", "solana");
    const { x402ChainKey, solanaChainKey, usdcMint } = await import("@/lib/payments/solana");
    expect(x402ChainKey()).toBe("solana");
    expect(solanaChainKey()).toBe("solana-devnet");
    expect(usdcMint(x402ChainKey()).toBase58()).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(usdcMint().toBase58()).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });

  it("is the deployment's chain while unset or empty", async () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana");
    vi.stubEnv("X402_PAYMENT_CHAIN", "");
    const { x402ChainKey } = await import("@/lib/payments/solana");
    expect(x402ChainKey()).toBe("solana");
  });

  it("refuses a key that is no Solana chain", async () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
    for (const key of ["base", "solana-mainnet-beta", "constructor"]) {
      vi.stubEnv("X402_PAYMENT_CHAIN", key);
      const { x402ChainKey } = await import("@/lib/payments/solana");
      expect(() => x402ChainKey(), key).toThrow(/Not a Solana chain key/);
    }
  });

  it("reaches mainnet through SOLANA_RPC_URL for x402 while the devnet deployment never does", async () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
    vi.stubEnv("SOLANA_RPC_URL", "https://mainnet.rpc.test/");
    vi.stubEnv("SOLANA_RPC_URL_FALLBACK", "");
    const { solanaRpcUrls, solanaConnection } = await import("@/lib/payments/solana");
    expect(solanaRpcUrls("solana")).toEqual(["https://mainnet.rpc.test/", PAYMENT_CHAINS.solana.rpcUrl]);
    expect(solanaConnection("solana").rpcEndpoint).toBe("https://mainnet.rpc.test/");
    expect(solanaRpcUrls()).toEqual([PAYMENT_CHAINS["solana-devnet"].rpcUrl]);
  });
});
