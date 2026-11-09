/**
 * The ONE place a generation may claim an intent of the nonce rail.
 *
 * An authorised intent holds a signed but unbroadcast transaction: nothing has
 * moved. It is captured after the image is made, or voided.
 *
 * The prepaid branch is gone (Kev, 2026-10-18, intents back on the web): its
 * filter, status 'confirmed', matches every intent the escrow rail settled
 * (60 live rows, each already fulfilled once), so restoring it would have let
 * each buy one more render. A confirmed row is never claimable here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const TABLE = "generation_payment_intents";

export type ClaimResult =
  | { ok: true; mode: "authorized"; resolution: string; modelFamily: string }
  | { ok: false; status: 402 | 404 | 409 | 500; error: string };

export interface ClaimRow {
  status: string | null;
  authorized_at: string | null;
  consumed_at: string | null;
  captured_at: string | null;
  voided_at: string | null;
}

/** Why a row with these columns cannot be claimed, or null when it can. It only reads: the update below still decides a race. */
export function claimRefusal(r: ClaimRow, intentId: string): { status: 402 | 409; error: string } | null {
  if (r.authorized_at && r.status === "confirmed") {
    // Settled funds AND a held signature on one row: one of the two would be
    // charged a second time. Refuse and let a human look.
    console.error("[payments/claim] intent is both confirmed and authorised:", intentId);
    return { status: 409, error: "Payment intent is in an inconsistent state" };
  }
  if (!r.authorized_at) return { status: 402, error: "Payment intent is not ready" };

  // Terminal states first, so the refusal says something true rather than
  // falling through to the generic "already used".
  if (r.captured_at) return { status: 409, error: "Payment intent already used" };
  if (r.voided_at) return { status: 409, error: "Payment intent was cancelled" };
  if (r.consumed_at) return { status: 409, error: "Payment intent already used" };
  return null;
}

export async function claimForGeneration(
  supabase: SupabaseClient,
  { intentId, buyerWallet }: { intentId: string; buyerWallet: string },
): Promise<ClaimResult> {
  const { data: row, error } = await supabase
    .from(TABLE)
    .select("status, authorized_at, consumed_at, captured_at, voided_at")
    .eq("id", intentId)
    .eq("buyer_wallet", buyerWallet)
    .maybeSingle();

  if (error) {
    console.error("[payments/claim] lookup failed:", error.message);
    return { ok: false, status: 500, error: "Failed to claim payment intent" };
  }
  if (!row) return { ok: false, status: 404, error: "Payment intent not found" };
  const refused = claimRefusal(row as ClaimRow, intentId);
  if (refused) return { ok: false, ...refused };

  // One-shot claim: consumed_at is the in-flight marker and only an unclaimed
  // row can flip it, so two concurrent requests cannot both start generating
  // against one signature.
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from(TABLE)
    .update({ consumed_at: now, updated_at: now })
    .eq("id", intentId)
    .eq("buyer_wallet", buyerWallet)
    .not("authorized_at", "is", null)
    .neq("status", "confirmed")
    .is("captured_at", null)
    .is("voided_at", null)
    .is("consumed_at", null)
    .select("resolution, model_family")
    .maybeSingle();

  if (claimError) {
    console.error("[payments/claim] authorised claim failed:", claimError.message);
    return { ok: false, status: 500, error: "Failed to claim payment intent" };
  }
  if (!claimed) return { ok: false, status: 409, error: "Payment intent already used" };

  return {
    ok: true,
    mode: "authorized",
    resolution: claimed.resolution as string,
    modelFamily: claimed.model_family as string,
  };
}
