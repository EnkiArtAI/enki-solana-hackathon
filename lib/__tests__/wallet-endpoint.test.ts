import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The phone wallet signs for the chain the wallet adapter infers from the
 * provider's endpoint (wallet-adapter-react getInferredClusterFromEndpoint:
 * "devnet" in the URL is devnet, anything else mainnet). It was a hard-coded
 * devnet URL, so on mainnet the phone wallet would have been asked for devnet
 * (2026-10-18).
 */
import { paymentEndpoint } from "../../providers/SolanaWalletProvider";

describe("the wallet provider's endpoint", () => {
  it("is mainnet only when the payment chain is solana, devnet otherwise", () => {
    expect(paymentEndpoint("solana")).toBe("https://api.mainnet-beta.solana.com");
    for (const chain of ["solana-devnet", undefined, "", "base"]) expect(paymentEndpoint(chain)).toBe("https://api.devnet.solana.com");
  });

  it("is what the provider hands the wallet adapter", () => {
    const src = readFileSync(join(__dirname, "..", "..", "providers", "SolanaWalletProvider.tsx"), "utf8");
    expect(src).toContain("<ConnectionProvider endpoint={paymentEndpoint()}>");
    expect(src).toContain("chain = process.env.NEXT_PUBLIC_SOLANA_PAYMENT_CHAIN");
  });
});
