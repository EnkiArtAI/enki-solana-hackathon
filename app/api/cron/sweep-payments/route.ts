import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { escrowServerChain } from "@/lib/payments/escrow/server-chain";
import { sweepGenerationEscrows } from "@/lib/payments/escrow/server-sweep";
import { sweepAndFlush } from "@/lib/payments/settle";
import { paymentRail } from "@/lib/payments/rail";
import { cronDenied } from "@/lib/cron";
export const runtime = "nodejs";
export const maxDuration = 300;
/** Intent rail rounds, at most two minutes. */
const INTENT_SWEEP_MS = 120_000;
/**
 * Settle the intent rail every run (stale and unsigned authorisations, unknown
 * captures, open nonces; it never throws), then retry immutable escrow
 * payments and reconcile delivered images, but only while escrow is the rail.
 */
export async function GET(req: NextRequest) {
  const denied = cronDenied(req);
  if (denied) return denied;
  const db = getSupabaseServerClient();
  let intents = 0;
  for (const until = Date.now() + INTENT_SWEEP_MS; Date.now() < until;) {
    const settled = await sweepAndFlush(db);
    intents += settled;
    if (settled === 0) break;
  }
  if (await paymentRail() !== "escrow") return NextResponse.json({ intents, escrow: "off" });
  try { return NextResponse.json({ intents, ...(await sweepGenerationEscrows(db, escrowServerChain())) }); }
  catch {
    console.error("[escrow/sweep] temporarily_unavailable");
    return NextResponse.json({ error: "The payment reconciliation service is temporarily unavailable." }, { status: 503 });
  }
}
