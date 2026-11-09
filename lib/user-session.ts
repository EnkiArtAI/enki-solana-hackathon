import { randomBytes } from "crypto";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

/** Email, Google and X logins stay signed in for 30 days, as long as the team cookie (Kev, 2026-10-21); a wallet signature session keeps its 24 h (app/api/auth/session). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Mint an auth_sessions row for an email/password user. Keyed by users.id as
 * wallet_address until the Dynamic embedded wallet is attached on first login
 * (then the real wallet address replaces it). requireAuth resolves by token.
 * ipHash: hashed login IP (lib/ip-hash) — never the raw address. ttlMs: a
 * trial login's session ends with its trial (lib/trial).
 */
export async function mintUserSession(userId: string, ipHash?: string | null, ttlMs = SESSION_TTL_MS) {
  const supabase = getSupabaseServerClient();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  let { error } = await supabase.from("auth_sessions").insert({
    token,
    wallet_address: userId,
    wallet_type: "password",
    expires_at: expiresAt,
    ip_hash: ipHash ?? null,
  });
  if (error && /ip_hash/.test(error.message)) {
    // moderation-council migration not run yet — insert without the column
    ({ error } = await supabase.from("auth_sessions").insert({
      token,
      wallet_address: userId,
      wallet_type: "password",
      expires_at: expiresAt,
    }));
  }
  if (error) throw error;
  return { token, expiresAt };
}
