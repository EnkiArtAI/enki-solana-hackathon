import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { solanaConnection, usdcMint } from "@/lib/payments/solana";
import type { ChainKey } from "@/shared/payment-config";

/** SPL TransferChecked verifies these decimals against the USDC mint. */
export const USDC_DECIMALS = 6;

/**
 * Cap on the per-CU price so a fee-market spike can never make the fee payer
 * overpay: 1,000,000 micro-lamports/CU × 120k CU = 0.00012 SOL per payment.
 */
export const MAX_PRIORITY_FEE_MICROLAMPORTS = 1_000_000;

/**
 * p75 of the cluster's recent prioritization fees (never hardcoded), capped.
 * Returns 0 when the fee market is idle — the caller then skips the
 * ComputeBudget price instruction entirely.
 */
export function priorityFeeMicroLamports(
  recent: ReadonlyArray<{ prioritizationFee: number }>,
): number {
  const fees = recent
    .map((f) => f.prioritizationFee)
    .filter((f) => Number.isFinite(f) && f >= 0)
    .sort((a, b) => a - b);
  if (fees.length === 0) return 0;
  const p75 = fees[Math.floor((fees.length - 1) * 0.75)];
  return Math.min(p75, MAX_PRIORITY_FEE_MICROLAMPORTS);
}

/** Read-only recipient lookup used by the direct-transfer agent route, on its chain (x402ChainKey). */
export async function findMissingAtas(recipients: string[], chain?: ChainKey): Promise<string[]> {
  const connection = solanaConnection(chain);
  const mint = usdcMint(chain);
  const missing: string[] = [];
  for (const owner of recipients) {
    // An author's vault is owned by a PDA, off the curve (lib/referral/shares).
    const ata = getAssociatedTokenAddressSync(mint, new PublicKey(owner), true);
    const info = await connection.getAccountInfo(ata, "confirmed");
    if (!info) missing.push(owner);
  }
  return missing;
}
