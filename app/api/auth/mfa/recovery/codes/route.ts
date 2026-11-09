/**
 * POST /api/auth/mfa/recovery/codes -> { recoveryCodes }
 *
 * A new set of ten codes, shown once; the older ones stop working, and every address hears if any was unused. Every factor
 * has to confirm it: one factor making codes could use them to strip the others.
 */
import { NextResponse } from "next/server";
import { codesLeft, newCodeSet, recoveryRoute } from "@/lib/mfa-recovery";
import { requireAllFactors } from "@/lib/webauthn";

export const POST = recoveryRoute("new set", async (req, supabase, userId) => {
  await codesLeft(supabase, userId); // before SQL 74 ran: 503, before anyone is asked for a factor
  const blocked = await requireAllFactors(req, userId, "recovery-codes", { mandatory: true });
  if (blocked) return blocked;
  return NextResponse.json({ recoveryCodes: await newCodeSet(supabase, userId) });
});
