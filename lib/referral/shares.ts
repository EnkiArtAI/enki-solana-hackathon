import type { SupabaseClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";
import { artistPayoutWallet } from "@/lib/payments/generation-quote";
import { computeGenerationSplit, type GenerationSplit } from "@/lib/payments/generation-pricing";

/**
 * The shares a referred prompt earns on every render, paid by the buyer's own
 * transaction so Enki never holds them (Kev, 2026-10-14; docs/ESCROW-V2-SHARES.md).
 *
 * Of Enki's fee at the policy rate (10%): before the author claimed, a quarter to the referrer and a
 * quarter into the author's vault; after the claim, nothing to the referrer
 * and half to the author: to the claimant's wallet while the claimant holds
 * the X account, else into the vault (a reset or a disconnect does not hand
 * the referrer its quarter back, review 2026-10-17). Floored to micro-USDC; what rounding
 * leaves stays in Enki's leg, so the legs always add up to the total. A
 * referrer without a Solana wallet, or an author without a known X id, has
 * no leg: nothing is held for later.
 *
 * On x402 Enki sells the render (Kev, 2026-10-17: "verkäufer-modell für
 * künstlerprompts"): the buyer pays Enki the whole price, and every leg but
 * Enki's becomes a licence fee Enki owes after delivery (licence_credits).
 * Its 20% fee does not double the shares (Kev, 2026-10-18: "fix double
 * referral"): they stay fractions of the 10% fee, Enki keeps the rest.
 */

export interface PromptShares {
  /** The referrer's Solana wallet, or null when the account has none. */
  referrerWallet: string | null;
  /** The claimant's wallet while it holds the X account, else the vault's owner (a PDA), else null when the X id is unknown. */
  author: { kind: "wallet"; owner: string } | { kind: "vault"; owner: string } | null;
  /** Someone claimed this author: the referrer's quarter has ended, the author's half stands. */
  claimed: boolean;
}

export interface Leg {
  recipient: string;
  amountMicro: number;
  /** Whose share it is: on x402 every leg but Enki's becomes a licence fee Enki owes (Kev, 2026-10-17). */
  role: "artist" | "enki" | "referrer" | "author";
}

/** The owner of an author's vault: a PDA of the escrow program, seeds ["author", u64 LE X user id]. */
export function authorVaultOwner(programId: PublicKey, xUserId: string): PublicKey {
  if (!/^\d{1,20}$/.test(xUserId)) throw new Error("not an X user id");
  const id = BigInt(xUserId);
  if (id > BigInt("18446744073709551615")) throw new Error("not an X user id");
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(id);
  return PublicKey.findProgramAddressSync([Buffer.from("author"), bytes], programId)[0];
}

/**
 * Every transfer a render's payment carries, in order: the artist's price (a
 * priced prompt), Enki's leg, the referrer's share, the author's share. Legs
 * of nothing are left out.
 */
export function shareLegs(p: { split: GenerationSplit; artistWallet: string | null; payTo: string; shares: PromptShares | null }): Leg[] {
  // The policy fee on the same base, never more than the fee charged (a discounted split keeps its legs whole).
  const fee = Math.min(p.split.enkiFeeMicro, computeGenerationSplit(p.split.artistAmountMicro, p.split.modelCostMicro).enkiFeeMicro);
  const claimed = !!p.shares?.claimed;
  // The referrer's leg ends with the claim; a referrer without a wallet never had one.
  const referrerWallet = claimed ? null : p.shares?.referrerWallet ?? null;
  const referrer = referrerWallet ? Math.floor(fee / 4) : 0;
  const author = p.shares?.author ? Math.floor(claimed ? fee / 2 : fee / 4) : 0;
  const legs: Leg[] = [];
  if (p.split.artistAmountMicro > 0 && p.artistWallet) legs.push({ recipient: p.artistWallet, amountMicro: p.split.artistAmountMicro, role: "artist" });
  legs.push({ recipient: p.payTo, amountMicro: p.split.enkiTotalMicro - referrer - author, role: "enki" });
  if (referrerWallet && referrer > 0) legs.push({ recipient: referrerWallet, amountMicro: referrer, role: "referrer" });
  if (p.shares?.author && author > 0) legs.push({ recipient: p.shares.author.owner, amountMicro: author, role: "author" });
  return legs;
}

/**
 * The shares of a prompt, from its referral record: null when the prompt was
 * not referred. Wallets are read the way an artist's payout wallet is read.
 */
export async function sharesOf(
  supabase: SupabaseClient,
  promptId: string,
  programId: PublicKey | null,
): Promise<PromptShares | null> {
  const { data, error } = await supabase
    .from("hunt_submissions")
    .select("hunter_user_id, claimed_by_user_id, source_author_id")
    .eq("minted_prompt_id", promptId)
    .eq("status", "approved")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const wallet = async (userId: unknown) => {
    if (typeof userId !== "string" || !userId) return null;
    const payout = await artistPayoutWallet(supabase, userId);
    return payout.ok ? payout.wallet : null;
  };
  const authorId = typeof data.source_author_id === "string" && data.source_author_id ? data.source_author_id : null;
  // The claimant is whoever holds the author's X account now and claimed it (Kev, 2026-10-17): the claim covers
  // the author's later prompts too, and ends when the X account leaves the claimant's Enki account.
  let claimedBy: string | null = null;
  let claimed = !!data.claimed_by_user_id;
  if (authorId) {
    const { data: holder, error: holderErr } = await supabase
      .from("auth_identities")
      .select("user_id")
      .eq("provider", "x")
      .eq("subject", authorId)
      .maybeSingle();
    if (holderErr) throw holderErr;
    const holderId = typeof holder?.user_id === "string" ? holder.user_id : null;
    if (holderId && data.claimed_by_user_id === holderId) claimedBy = holderId;
    else if (holderId) {
      const { data: claim, error: claimErr } = await supabase
        .from("hunt_submissions")
        .select("id")
        .eq("source_author_id", authorId)
        .eq("claimed_by_user_id", holderId)
        .limit(1)
        .maybeSingle();
      if (claimErr) throw claimErr;
      if (claim) claimedBy = holderId;
    }
    // A recorded claim ends the referrer's quarter even while nobody holds the X account.
    if (!claimedBy && !claimed) {
      const { data: any, error: anyErr } = await supabase
        .from("hunt_submissions")
        .select("id")
        .eq("source_author_id", authorId)
        .not("claimed_by_user_id", "is", null)
        .limit(1)
        .maybeSingle();
      if (anyErr) throw anyErr;
      claimed = !!any;
    }
  }
  const claimant = await wallet(claimedBy);
  const author: PromptShares["author"] = claimant
    ? { kind: "wallet", owner: claimant }
    : authorId && programId ? { kind: "vault", owner: authorVaultOwner(programId, authorId).toBase58() } : null;
  return { referrerWallet: await wallet(data.hunter_user_id), author, claimed: claimed || !!claimedBy };
}
