import type { SupabaseClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { solanaConnection, usdcMint } from "@/lib/payments/solana";
import { authorVaultOwner } from "@/lib/referral/shares";
import { artistPayoutWallet } from "@/lib/payments/generation-quote";

/**
 * An author claims what their posts earn (Kev, 2026-10-17;
 * docs/ESCROW-V2-SHARES.md §5): someone referred a prompt the author posted on
 * X, and every render of it pays the author a share. The proof is the X
 * account connected in Settings (an OAuth login of that account), matched by
 * X's numeric user id, never by the handle. The claim records the user on
 * every referral of that author; from then on the shares of all the author's
 * prompts go to the user's wallet, for as long as the user holds that X
 * account (lib/referral/shares.ts). Whoever holds it later claims anew and
 * takes over. What reached the author's vault before waits for the vault
 * release, which the escrow upgrade brings.
 */

export interface ClaimState {
  /** The connected X account, or null: nothing can be claimed without it. */
  x: { handle: string | null } | null;
  /** Approved referred prompts from this author's posts: the ones that earn. */
  prompts: number;
  /** The user claimed this author: the shares of all their prompts go to the user's wallet. */
  claimed: boolean;
  /** Approved prompts a claim would still move to the user: all before the first claim, then those someone else claimed. */
  open: number;
  /** USDC in the author's vault, or null when it cannot be read. */
  vaultUsd: number | null;
  /** The user has a Solana payout wallet: without one a claimed share goes into the vault (lib/referral/shares.ts). */
  payoutWallet: boolean;
}

/** The X account this user connected: X's numeric id and handle. */
export async function connectedX(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from("auth_identities")
    .select("subject, handle")
    .eq("user_id", userId)
    .eq("provider", "x")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: String(data.subject), handle: (data.handle as string | null) ?? null } : null;
}

/** The program the vaults belong to, as the x402 rail derives them; null when it is not configured. */
function escrowProgram(): PublicKey | null {
  try {
    return new PublicKey(process.env.SOLANA_ESCROW_PROGRAM_ID ?? "");
  } catch {
    return null;
  }
}

/** The vault's USDC, read on chain (its owner is off curve); null when there is none to read yet, or no answer. */
async function vaultUsd(xId: string): Promise<number | null> {
  const program = escrowProgram();
  if (!program) return null;
  try {
    const ata = getAssociatedTokenAddressSync(usdcMint(), authorVaultOwner(program, xId), true);
    const res = await solanaConnection().getTokenAccountBalance(ata);
    return res.value.uiAmount ?? 0;
  } catch {
    return null;
  }
}

export async function claimState(supabase: SupabaseClient, userId: string): Promise<ClaimState> {
  const x = await connectedX(supabase, userId);
  if (!x) return { x: null, prompts: 0, claimed: false, open: 0, vaultUsd: null, payoutWallet: false };
  const author = () => supabase.from("hunt_submissions").select("id", { count: "exact", head: true }).eq("source_author_id", x.id);
  // Counted are approved referrals, the prompts that earn; one stamped row of any status is the claim.
  const [prompts, mine, others, vault, payout] = await Promise.all([
    author().eq("status", "approved"),
    author().eq("claimed_by_user_id", userId),
    author().eq("status", "approved").not("claimed_by_user_id", "is", null).neq("claimed_by_user_id", userId),
    vaultUsd(x.id),
    artistPayoutWallet(supabase, userId),
  ]);
  for (const r of [prompts, mine, others]) if (r.error) throw r.error;
  const claimed = (mine.count ?? 0) > 0;
  return { x: { handle: x.handle }, prompts: prompts.count ?? 0, claimed, open: (claimed ? others.count : prompts.count) ?? 0, vaultUsd: vault, payoutWallet: payout.ok };
}

/** Records the claim on every referral of the connected X account's posts not yet this user's; answers how many. */
export async function claimAuthorShares(supabase: SupabaseClient, userId: string): Promise<{ claimed: number } | null> {
  const x = await connectedX(supabase, userId);
  if (!x) return null;
  const { data, error } = await supabase
    .from("hunt_submissions")
    .update({ claimed_by_user_id: userId, claimed_at: new Date().toISOString() })
    .eq("source_author_id", x.id)
    // Holding the X account proves the author now: a former holder's claim moves too.
    .or(`claimed_by_user_id.is.null,claimed_by_user_id.neq.${userId}`)
    .select("id");
  if (error) throw error;
  return { claimed: data?.length ?? 0 };
}
