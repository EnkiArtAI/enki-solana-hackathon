/**
 * POST /api/auth/wallet/jwt → { jwt, userId }
 *
 * Turns our app session into the short-lived external JWT that CDP validates
 * (against /api/auth/wallet/jwks or a pasted static key) to provision the
 * user's embedded wallets. sub is ALWAYS users.id so the vendor sees a stable
 * identity whether the session is still the fresh-login bridge
 * (wallet_address = users.id) or already carries the real wallet address.
 *
 * The client feeds this to CDP via CdpProvider's customAuth.getJwt callback.
 *
 * Ban tolerant on purpose: a ban locks the marketplace, never the wallet, so
 * a suspended account still signs its sends and exports its key.
 *
 * Locked once the account has a second factor (Kev, 2026-10-07): CDP calls
 * this before every wallet request, so it is the one place a stolen session
 * is stopped from signing or exporting straight through CDP. Such a session
 * needs a "wallet" or "export" step-up at most 2 h old, with wallet use in
 * the last 15 min (403 { locked }); each mint refreshes the 15 min. 2FA is
 * optional: without a factor the session alone opens the wallet, and the
 * red bar asks the user to protect it.
 *
 * Closed until the email is confirmed and the mailed one-time password is
 * replaced (Kev, 2026-10-07): an invitee's first login does both, a reset
 * through the inbox too (403 { confirmEmail }), and a signed-in account
 * confirms with a code in the "Confirm your email" window, which opens on
 * that answer (app/api/auth/password/confirm-email). Nobody can open the
 * wallet of an address they never received mail at.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { mintWalletJwt } from "@/lib/wallet-jwt";
import { enrolledFactors, type Factor } from "@/lib/mfa";
import { walletUnlocked } from "@/lib/webauthn";
import { isWalletOrigin } from "@/lib/auth/login-methods";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const token = req.headers.get("X-Session-Token");
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const supabase = getSupabaseServerClient();
  const { data: session, error: sessionErr } = await supabase
    .from("auth_sessions")
    .select("wallet_address, stepup_at, stepup_seen_at")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (sessionErr) return NextResponse.json({ error: "Could not read the session" }, { status: 503 });
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let userId: string | null = UUID.test(session.wallet_address) ? session.wallet_address : null;
  if (!userId) {
    const { data: walletRow } = await supabase
      .from("user_wallets")
      .select("user_id")
      .eq("address", session.wallet_address)
      .is("removed_at", null)
      .maybeSingle();
    userId = walletRow?.user_id ?? null;
  }
  if (!userId) return NextResponse.json({ error: "No user for session" }, { status: 404 });

  // Email lives in password_credentials (isolated from the encrypted-email
  // design); handle (optional public username) on users.
  const { data: cred, error: credErr } = await supabase
    .from("password_credentials")
    .select("email, email_verified_at, must_change_password")
    .eq("user_id", userId)
    .maybeSingle();
  if (credErr) return NextResponse.json({ error: "Could not read the account" }, { status: 503 });
  // A Google or X account has no password: the provider proved who signs in,
  // so its identity row stands in for the confirmed email (Kev, 2026-10-17).
  if (!cred) {
    const [{ data: identity, error: identityErr }, { data: account, error: accountErr }] = await Promise.all([
      supabase.from("auth_identities").select("provider").eq("user_id", userId).limit(1).maybeSingle(),
      supabase.from("users").select("origin").eq("id", userId).maybeSingle(),
    ]);
    if (identityErr || accountErr) return NextResponse.json({ error: "Could not read the account" }, { status: 503 });
    // An account made by a wallet sign-in pays with that wallet: an embedded one opened from its Google or X
    // session would become its payer, empty (review, 2026-10-17).
    if (isWalletOrigin(account?.origin)) {
      return NextResponse.json({ error: "This account pays with its own wallet: sign in with that wallet to pay.", walletAccount: true }, { status: 403 });
    }
    if (!identity) return NextResponse.json({ error: "Account has no email" }, { status: 400 });
  } else if (!cred.email) {
    return NextResponse.json({ error: "Account has no email" }, { status: 400 });
  } else if (!cred.email_verified_at || cred.must_change_password) {
    // Before the unlock: a wallet that cannot open asks for no second factor.
    return NextResponse.json(
      { error: "Confirm your email to open your wallet.", confirmEmail: true },
      { status: 403 },
    );
  }

  let factors: Factor[];
  try {
    factors = await enrolledFactors(supabase, userId);
  } catch {
    return NextResponse.json({ error: "Could not read your security settings" }, { status: 503 });
  }
  if (factors.length && !walletUnlocked(session)) {
    return NextResponse.json({ error: "Confirm it's you to use the wallet", locked: true, scope: "wallet", factors }, { status: 403 });
  }
  const { data: user } = await supabase.from("users").select("handle").eq("id", userId).maybeSingle();

  let jwt: string;
  try {
    jwt = await mintWalletJwt({ id: userId, email: cred?.email, username: user?.handle ?? null });
  } catch {
    // ENV-01: no (or no readable) signing key on this environment, a sentence instead of an empty 500.
    return NextResponse.json({ error: "Wallet sign-in is not configured on this environment" }, { status: 503 });
  }
  // Using the wallet keeps the unlock alive, never past its 2 h.
  if (factors.length) await supabase.from("auth_sessions").update({ stepup_seen_at: new Date().toISOString() }).eq("token", token);
  return NextResponse.json({ jwt, userId });
}
