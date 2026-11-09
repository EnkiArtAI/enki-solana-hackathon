/**
 * Which rail the web pays on (Kev, 2026-10-18: "so, dass wir das einfach
 * umknipsen auf escrow können"). Escrow when its program is configured AND
 * deployed on the payment chain; the intent (durable-nonce) rail otherwise.
 * Switching is one env var: set SOLANA_ESCROW_PROGRAM_ID once the program is
 * on mainnet. A devnet program id left in a mainnet env finds no program and
 * falls back to intents instead of failing every checkout.
 *
 * The rail is chosen once, when /authorize opens an order; every later route
 * reads it from the row (railOf), so a flip never strands an order in flight.
 */
import { PublicKey } from "@solana/web3.js";
import { escrowServerChain } from "@/lib/payments/escrow/server-chain";
import { solanaConnection } from "@/lib/payments/solana";

export type PaymentRail = "escrow" | "intent";

/** The program check is one RPC call; a deployment does not change by the minute. */
const TTL_MS = 5 * 60_000;
let cached: { key: string; rail: PaymentRail; at: number } | null = null;

export async function paymentRail(): Promise<PaymentRail> {
  let chain: ReturnType<typeof escrowServerChain>;
  try {
    chain = escrowServerChain();
  } catch {
    return "intent";
  }
  // An RPC that cannot answer proves nothing: the last answer for this program, else intents.
  return (await deployedRail(chain)) ?? "intent";
}

/**
 * Whether the escrow program is deployed on the payment chain, for a decision that must not guess: an RPC that cannot
 * answer, with no answer cached for this program, throws (round 20, 2026-10-20: x402 read it as "not deployed" and
 * sold a referred prompt without the author's licence credit). paymentRail keeps its fallback to intents.
 */
export async function escrowDeployed(): Promise<boolean> {
  let chain: ReturnType<typeof escrowServerChain>;
  try {
    chain = escrowServerChain();
  } catch {
    return false;
  }
  const rail = await deployedRail(chain);
  if (rail === null) throw new Error("The escrow program's deployment could not be read");
  return rail === "escrow";
}

/** The program check, cached per program; null when the RPC could not answer and nothing is cached. */
async function deployedRail(chain: ReturnType<typeof escrowServerChain>): Promise<PaymentRail | null> {
  const key = `${chain.cluster}:${chain.programAddress}`;
  if (cached?.key === key && Date.now() - cached.at < TTL_MS) return cached.rail;
  try {
    const info = await solanaConnection().getAccountInfo(new PublicKey(chain.programAddress), "confirmed");
    cached = { key, rail: info?.executable ? "escrow" : "intent", at: Date.now() };
    return cached.rail;
  } catch {
    return cached?.key === key ? cached.rail : null;
  }
}

export function resetPaymentRailCache(): void {
  cached = null;
}

/** The rail an existing intent row belongs to, or null for a quote no rail has opened yet. */
export function railOf(row: { nonce_account?: string | null; batch_intent_id?: string | null; deposit_signature?: string | null }): PaymentRail | null {
  if (row.nonce_account || row.batch_intent_id) return "intent";
  if (row.deposit_signature) return "escrow";
  return null;
}
