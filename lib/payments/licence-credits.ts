import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The licence fees Enki owes for a render it sold over x402 (Kev, 2026-10-17:
 * "verkäufer-modell für künstlerprompts"): the buyer paid Enki the whole price,
 * and the artist's, the referrer's and the author's shares are written here
 * once the render was delivered, to be paid out later (licence_credits,
 * migrations/2026-10-17-licence-credits.sql).
 */
export interface LicenceCredit {
  role: "artist" | "referrer" | "author";
  /** The recipient as the 402 priced it: a wallet, or an author vault's owner; null for an artist without a payout wallet. */
  owner: string | null;
  /** The account owed, for the artist: a payout pays that account's wallet then (Kev, 2026-10-18). */
  userId?: string | null;
  micro: number;
}

/**
 * Writes one row per credit, keyed by the payment and the role, so a repeat
 * is a no-op. Asked again on a failure, three tries two seconds apart as with
 * the payer's account (lib/generation/record.ts); still failing, it says so on
 * the server log with the payment, never with a key. Answers whether it landed.
 */
export async function recordLicenceCredits(
  supabase: SupabaseClient,
  p: { source: string; mint: string; promptId: string | null; credits: LicenceCredit[] },
  { tries = 3, gapMs = 2_000 }: { tries?: number; gapMs?: number } = {},
): Promise<boolean> {
  const rows = p.credits.map((c) => ({
    source: p.source, role: c.role, owner: c.owner, user_id: c.userId ?? null, mint: p.mint, micro: c.micro, prompt_id: p.promptId,
  }));
  let failure = "";
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, gapMs));
    try {
      const { error } = await supabase.from("licence_credits").upsert(rows, { onConflict: "source,role", ignoreDuplicates: true });
      if (!error) return true;
      failure = error.code || "error";
    } catch {
      failure = "threw";
    }
  }
  console.error(`[licence-credits] ${rows.length} licence credit(s) for ${p.source} NOT recorded after ${tries} tries (${failure}): Enki owes them, add them by hand`);
  return false;
}
