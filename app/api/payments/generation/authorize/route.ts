import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { prepareGenerationEscrow } from "@/lib/payments/escrow/server-deposit";
import { EscrowPaymentError, escrowServerChain } from "@/lib/payments/escrow/server-chain";
import { escrowRoute } from "@/lib/payments/escrow/server-route";
import { authorizeIntent, railFor } from "@/lib/payments/intent-checkout";
import { solanaConnection } from "@/lib/payments/solana";
export const runtime = "nodejs";
const schema = z.object({ intentId: z.string().uuid(), units: z.number().int().min(1).max(24) }).strict();
/** Prepare the payment for the entire paid batch: one escrow deposit, or one held intent per image. Nothing is sent until the buyer signs. */
export async function POST(req: NextRequest) {
  return escrowRoute(req, "authorize", async owner => {
    const body = schema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new EscrowPaymentError(400, "Choose a valid number of images before paying.");
    const db = getSupabaseServerClient();
    if (await railFor(db, body.data.intentId, owner) === "intent") return authorizeIntent(db, solanaConnection(), { ...body.data, owner });
    return prepareGenerationEscrow(db, escrowServerChain(), { ...body.data, owner });
  });
}
