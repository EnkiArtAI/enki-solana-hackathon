import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The ways a user can get back into the account: a password, each provider
 * identity, and the wallet of an account made by a wallet sign-in. Any other
 * wallet row is not one of them (an embedded CDP wallet is provisioned FROM a
 * session, it cannot open one), so it is reported but not counted. Throws on a real query error; a missing auth_identities
 * table reads as no identities, so the settings page still lists the rest.
 */
/** Accounts that sign in with a wallet: made by a wallet sign-in, or for an x402 payer's wallet (users.origin agent,
    lib/generation/record.ts), which a wallet login of that address opens too (review, 2026-10-17). */
export const isWalletOrigin = (origin: unknown): boolean => origin === "wallet" || origin === "agent";

export type IdentityRow = {
  provider: string;
  handle: string | null;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string | null;
};

export async function loginMethods(supabase: SupabaseClient, userId: string) {
  const [ids, cred, wallets, user] = await Promise.all([
    supabase.from("auth_identities").select("provider, handle, email, display_name, avatar_url, created_at").eq("user_id", userId),
    supabase.from("password_credentials").select("user_id").eq("user_id", userId).maybeSingle(),
    supabase.from("user_wallets").select("id").eq("user_id", userId).is("removed_at", null).limit(1),
    supabase.from("users").select("origin").eq("id", userId).maybeSingle(),
  ]);
  if (cred.error) throw cred.error;
  if (wallets.error) throw wallets.error;
  if (user.error) throw user.error;
  const identities = (ids.error ? [] : (ids.data ?? [])) as IdentityRow[];
  const hasPassword = !!cred.data;
  const hasWallet = (wallets.data?.length ?? 0) > 0;
  const walletSignIn = hasWallet && isWalletOrigin(user.data?.origin);
  return {
    identities,
    hasPassword,
    hasWallet,
    loginMethodCount: identities.length + (hasPassword ? 1 : 0) + (walletSignIn ? 1 : 0),
  };
}
