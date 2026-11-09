/**
 * Shared password-reset core: sets the new Argon2id+pepper password, evicts
 * EVERY existing session (a reset must lock out anyone already in), and logs
 * the user in. Used by the email-code flow and the guardian-recovery flow.
 * A connected Google or X login stays: it signs in with that platform's own
 * password, so the reset mail names it and says how to disconnect it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { hashPassword } from "@/lib/password-auth";
import { mintUserSession } from "@/lib/user-session";
import { everyAddress, mailEach } from "@/lib/security-notice";
import { maskEmail } from "@/lib/confirm-email";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Random n-digit numeric code (crypto-strong). */
export function numericCode(digits = 7): string {
  const { randomInt } = require("crypto") as typeof import("crypto");
  return String(randomInt(10 ** (digits - 1), 10 ** digits));
}

const DISCONNECT = "If a login is not yours, disconnect it in Settings, Profile, Connected accounts. If the account has security factors, disconnecting asks you to confirm with every one of them.";

/** "Google (ow…@gmail.com) and X (@ka…)": each login that still works, masked, so the owner can tell whether it is theirs. */
function loginList(logins: { provider: string; email?: string | null; handle?: string | null }[]): string {
  const named = logins.map((l) =>
    l.provider === "x"
      ? `X${l.handle ? ` (@${l.handle.slice(0, 2)}…)` : ""}`
      : `Google${l.email ? ` (${maskEmail(l.email)})` : ""}`,
  );
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0];
}

/** inboxProven: the reset came through the account's inbox (the emailed
    code), so the email counts as confirmed and a one-time password is gone.
    A guardian recovery proves no inbox and leaves both as they are.
    ipHash: the network of a reset that ends in a login, for IP bans. */
export async function completePasswordReset(
  supabase: SupabaseClient,
  userId: string,
  password: string,
  // ttlMs: a trial tester's session ends with the trial (lib/trial).
  { inboxProven = false, ipHash = null as string | null, ttlMs = undefined as number | undefined } = {},
): Promise<{ email?: string; token: string; expiresAt: string } | { error: string }> {
  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("password_credentials")
    .update({ pw_hash: hash, pw_salt: salt, updated_at: now, ...(inboxProven ? { email_verified_at: now, must_change_password: false } : {}) })
    .eq("user_id", userId)
    .select("email")
    .single();
  if (error) {
    console.error("[password-reset] update failed:", error.message);
    return { error: "Could not reset password" };
  }
  // A reset is for the Enki password only: a Google or X login stays, it is that platform's business (Kev, 2026-11-07:
  // "soll bei x und google nur für die plattformen gelten"). So every address hears, and the mail names the logins that
  // still work. Neither a failed read nor a failed mail undoes the reset.
  const [told, logins] = await Promise.all([
    everyAddress(supabase, userId).catch((e) => {
      console.error("[password-reset] no reset notice:", e instanceof Error ? e.message : e);
      return [] as string[];
    }),
    supabase.from("auth_identities").select("provider, email, handle").eq("user_id", userId).then(({ data, error: e }) => (e ? null : data ?? [])),
  ]);

  // Sessions key on the users.id bridge before a wallet is attached and on the
  // wallet address after — evict both.
  const { data: wallets } = await supabase
    .from("user_wallets")
    .select("address")
    .eq("user_id", userId)
    .is("removed_at", null);
  const keys = [userId, ...(wallets ?? []).map((w) => w.address)];
  await supabase.from("auth_sessions").delete().in("wallet_address", keys);
  await mailEach(
    told,
    "The password of your Enki account was reset",
    `The password of your Enki account was reset (${new Date().toUTCString()}). This signed out every device.\n\n` +
      (logins === null
        ? `A Google or X login connected to it still signs in, as a reset changes only the Enki password. ${DISCONNECT}\n\n`
        : logins.length
          ? `${loginList(logins)} still ${logins.length > 1 ? "sign" : "signs"} in to it, as a reset changes only the Enki password. ${DISCONNECT}\n\n`
          : "") +
      `If that was you, there is nothing to do.\n\n` +
      `If it was not you, someone reset it with a code sent to your login email, or with your guardians' approval. Secure that email account first, then reset your password again: that signs them out.`,
  );

  const session = await mintUserSession(userId, ipHash, ttlMs);
  return { email: updated?.email ?? undefined, ...session };
}
