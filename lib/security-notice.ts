import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail } from "@/lib/mailer";
import { decryptString } from "@/lib/crypto";
import { confirmedEmailFactor, RESET_ADVICE } from "@/lib/mfa";
import { checkRequestRateLimit } from "@/lib/rate-limit";

/**
 * Every address this account has, deduplicated ignoring case: the login email even if unconfirmed, every connected
 * Google or X email, the email on users, a confirmed email factor. Every security notice goes to all of them, and the
 * recovery mails past the limiter below too: nobody may be able to take a factor away while the owner hears nothing.
 * Throws on a failed read.
 */
export async function everyAddress(supabase: SupabaseClient, userId: string): Promise<string[]> {
  const { doors, factor } = await addressSources(supabase, userId);
  return distinct([...doors, factor]);
}

/** The addresses that sign in by themselves (the login email, a connected Google or X account's, the email on users), and a confirmed email factor's. */
async function addressSources(supabase: SupabaseClient, userId: string): Promise<{ doors: unknown[]; factor: string | null }> {
  const [cred, identities, user, factor] = await Promise.all([
    supabase.from("password_credentials").select("email").eq("user_id", userId).maybeSingle(),
    supabase.from("auth_identities").select("email").eq("user_id", userId).not("email", "is", null),
    usersEmail(supabase, userId),
    confirmedEmailFactor(supabase, userId),
  ]);
  if (cred.error) throw cred.error;
  if (identities.error) throw identities.error;
  return { doors: [cred.data?.email, ...(identities.data ?? []).map((i) => i.email), user], factor };
}

/**
 * An X login gives no email (lib/auth/oauth.ts asks X for none), so an X account has no address until its owner adds one.
 * Said wherever such an account meets the email (Kev, 2026-11-07: "das muss in der meldung stehen bzw unsere settings
 * müssen das widerspiegeln, dass das wichtig ist (und warum das wichtig ist)"). One address alone never unlocks anything:
 * the mail path needs two (lib/mfa-recovery.ts tooFew).
 */
export const X_NEEDS_EMAIL =
  "You sign in with X, and X does not share your email with us. Without one we cannot warn you when someone adds a way to sign in, adds a security factor or moves your money. " +
  "An email warns you, it cannot unlock your account: it is usually the inbox that resets your X password, so it cannot prove it is you. " +
  "Lose a factor and your recovery codes without two guardians, and your wallet stays locked.";

/** Whether the account signs in with X. Throws on a failed read. */
export async function hasXLogin(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from("auth_identities").select("provider").eq("user_id", userId).eq("provider", "x");
  if (error) throw error;
  return !!data?.length;
}

/** Deduplicated ignoring case, in order, empty ones left out. */
function distinct(list: unknown[]): string[] {
  const seen = new Map<string, string>();
  for (const a of list) {
    if (a && !seen.has(String(a).toLowerCase())) seen.set(String(a).toLowerCase(), String(a));
  }
  return [...seen.values()];
}

/** The email on users, written only by lib/auth/oauth.ts emailColumns. A row that does not open is no address. */
async function usersEmail(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await supabase.from("users").select("email_ct, email_iv, email_tag, email_kid").eq("id", userId).maybeSingle();
  if (error) throw error;
  if (!data?.email_ct) return null;
  try {
    return decryptString({ encrypted: data.email_ct, iv: data.email_iv, authTag: data.email_tag, kid: data.email_kid ?? undefined });
  } catch {
    return null;
  }
}

/** Sends one mail to each address; how many went out. Never throws. */
export async function mailEach(to: string[], subject: string, text: string): Promise<number> {
  const sent = await Promise.all(to.map((address) => sendMail({ to: address, subject, text }).then((m) => m.ok, () => false)));
  return sent.filter(Boolean).length;
}

/**
 * A new factor passes every step-up from now on, so the owner hears at once: a
 * session under ten minutes old can plant the first one on a factor-free account.
 * ways: the ways this account has to remove it (lib/mfa-recovery.ts removalWays), never one it cannot use; null names none.
 */
export function mailFactorAdded(supabase: SupabaseClient, userId: string, what: string, ways: string | null = null): Promise<void> {
  return mailSecurityNotice(
    supabase,
    userId,
    "factor-added",
    "A security factor was added to your Enki account",
    `${what} was added to your Enki account (${new Date().toUTCString()}). If that was you, there is nothing to do.\n\n` +
      `If it was not, someone is using your session and can now confirm actions as you: ${RESET_ADVICE}${ways ? ` ${ways}` : ""}`,
  );
}

/** A connected Google or X account is a new way in: whoever holds a phished password and a fresh login can add one. */
export function mailProviderConnected(supabase: SupabaseClient, userId: string, provider: "google" | "x"): Promise<void> {
  const name = provider === "google" ? "Google" : "X";
  return mailSecurityNotice(
    supabase,
    userId,
    "provider-connected",
    `${name} was connected to your Enki account`,
    `${name} was connected as a way to sign in to your Enki account (${new Date().toUTCString()}). If that was you, there is nothing to do.

` +
      `If it was not, someone can now sign in as you with it: disconnect it in Settings and ${RESET_ADVICE}`,
  );
}

/**
 * Tells every address of the account (everyAddress), one just connected included, three notices an hour per kind at most.
 * Never one ranked address: a stolen session that connects its own Google must not become the only one who hears
 * (DEC-2026-11-05-40 point 2). Best effort: it never throws, the action already stands.
 */
export async function mailSecurityNotice(supabase: SupabaseClient, userId: string, kind: string, subject: string, text: string): Promise<void> {
  try {
    const to = await everyAddress(supabase, userId);
    if (to.length && checkRequestRateLimit(`${kind}-notice:${userId}`, 3, 3600_000).allowed) await mailEach(to, subject, text);
  } catch (e) {
    console.error("[security-notice] not sent:", e instanceof Error ? e.message : e);
  }
}
