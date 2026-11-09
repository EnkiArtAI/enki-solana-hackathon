import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { submitGenerationEscrow } from "@/lib/payments/escrow/server-deposit";
import { EscrowPaymentError, escrowServerChain } from "@/lib/payments/escrow/server-chain";
import { escrowRoute } from "@/lib/payments/escrow/server-route";
import { railFor, submitIntent, voidUnsignedAsOurs } from "@/lib/payments/intent-checkout";
import { solanaConnection } from "@/lib/payments/solana";
export const runtime = "nodejs";
const signed = z.string().min(64).max(1700);
const schema = z.object({ intentId: z.string().uuid(), signedTransaction: signed.optional(), signedTransactions: z.array(signed).min(1).max(24).optional() })
  .strict().refine((b) => Boolean(b.signedTransaction) !== Boolean(b.signedTransactions));
/** Escrow: deposit, generation starts once the funded accounts are verified. Intent: each signed payment is checked and held unbroadcast. */
export async function POST(req: NextRequest) {
  return escrowRoute(req, "submit", async owner => {
    const body = schema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new EscrowPaymentError(400, "The signed payment is invalid.");
    const { intentId, signedTransaction, signedTransactions } = body.data;
    const db = getSupabaseServerClient();
    // An order whose rail could not be read may be a signed intent order: its unsigned units are Enki's (round 8).
    const rail = await railFor(db, intentId, owner).catch(async (e) => { await voidUnsignedAsOurs(db, intentId, owner); throw e; });
    if (rail === "intent") {
      return submitIntent(db, solanaConnection(), { intentId, owner, signedTransactions: signedTransactions ?? [signedTransaction!] });
    }
    if (!signedTransaction) throw new EscrowPaymentError(400, "The signed payment is invalid.");
    return submitGenerationEscrow(db, escrowServerChain(), { intentId, signedTransaction, owner });
  });
}
