/**
 * A signed-in password account confirms its login email with a code (Kev, 2026-11-07: "enter code oder request code").
 * The wallet stays closed until it is confirmed (app/api/auth/wallet/jwt/route.ts), and the register route writes no
 * email_verified_at, so this is how such an account opens it without resetting its password. A right code sets
 * email_verified_at and nothing else. Routes: app/api/auth/password/confirm-email.
 *
 * The code lives where the forgot route keeps its own (password_reset_tokens: the SHA-256 of 7 digits, one live code per
 * account, 15 min), so it is a reset code too, and a reset code confirms: both prove the same inbox (DEC-2026-11-07-01).
 *
 * Ban tolerant, as the wallet is: a ban locks the marketplace, never the wallet. A deleted account has no session left.
 */
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";

export const CODE_TTL_MS = 15 * 60 * 1000; // as the forgot route's
export const TOO_MANY_TRIES = "Too many tries. Wait 15 minutes, then try again.";

/** needed: the login email waits for its code. invited: the one-time password of an invitation is still on; its first login confirms. */
export type LoginEmail = { email: string; state: "needed" | "confirmed" | "invited" };

/** As the guardian page masks an address (app/api/recovery/guardians/confirm/route.ts). */
export const maskEmail = (email: string) => {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}…@${domain}`;
};

/** The signed-in account and its login email (null without a password), or the answer that ends the request. */
export async function signedInLogin(req: NextRequest): Promise<{ supabase: SupabaseClient; userId: string; login: LoginEmail | null } | NextResponse> {
  const supabase = getSupabaseServerClient();
  try {
    const { userId } = await resolveSessionUserWithBan(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const { data, error } = await supabase
      .from("password_credentials")
      .select("email, email_verified_at, must_change_password")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return dbUnavailableResponse();
    const login: LoginEmail | null = data?.email
      ? { email: data.email, state: data.email_verified_at ? "confirmed" : data.must_change_password ? "invited" : "needed" }
      : null;
    return { supabase, userId, login };
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}

/** What a request or a code gets when there is nothing to confirm; null while the login email waits. Already confirmed says so. */
export function nothingToConfirm(login: LoginEmail | null): NextResponse | null {
  if (!login) return NextResponse.json({ error: "This account signs in without a password, so it has no login email to confirm." }, { status: 404 });
  if (login.state === "confirmed") return NextResponse.json({ confirmed: true });
  if (login.state === "invited") {
    return NextResponse.json({ error: "Log in once with the password from your invitation and choose your own: that confirms your email." }, { status: 409 });
  }
  return null;
}

/** A 429 in words a person can act on. */
export const tooMany = (error: string, retryAfterSeconds: number) =>
  NextResponse.json({ error }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } });
