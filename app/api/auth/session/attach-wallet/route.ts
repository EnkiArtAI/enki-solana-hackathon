/**
 * POST /api/auth/session/attach-wallet
 *   { solanaAddress, evmAddress?, proof?: [{ address, nonce, signature }] } → { attached, evm }
 *   evm is the EVM address this request attached, null when it attached none.
 *
 * Maps a wallet to the session's users.id (user_wallets) and points the session
 * at it (auth_sessions.wallet_address, replacing the users.id bridge value of an
 * email login). Every resolver maps the session's address to users.id through
 * user_wallets, and artistPayoutWallet pays that wallet, so (Kev, 2026-11-05):
 *
 * - An address another account holds is refused (409): it would make the caller
 *   that account, and /api/auth/wallet/jwt would mint a CDP login for its wallet.
 * - A Solana address that is a live row of this account only re-points the session,
 *   to the row's own spelling: a case variant of an address is no wallet, and the
 *   resolvers, which match exactly, would lose the account and its ban. An EVM
 *   address in that request is dropped unread, with no row, proof or factor: only
 *   Solana pays, and any live row is a login that outlives the session and a reset.
 * - Any other Solana address is new, a removed row of this account included, and
 *   so is an EVM address going along with it. It answers
 *   428 { proof: [{ address, family, nonce, message }] } until each one signs its
 *   message, so nobody claims an address they do not hold.
 * - Then the factors: with any enrolled, ALL of them must pass (requireAllFactors,
 *   scope wallet-change:<solana address>), a first wallet too. Without one, an
 *   account with no live wallet passes on the proof alone (the silent first attach
 *   of a fresh embedded wallet); one with a live wallet of any family answers
 *   403 { enroll }.
 * - A new Solana address on an account with any live wallet also waits out the newest
 *   factor's first 24 hours (Kev, 2026-11-05): 403 { wait, until }. It starts paying,
 *   whether or not it retires a row. A first attach, with no live wallet, is never held.
 * - The signature is checked before the wait and the factors, the nonce spent after
 *   them, so a person asked for a factor signs only once and a refusal spends nothing.
 * - A real switch retires the family's old rows and drops the account's other
 *   sessions on them. The old rows go last: a failure at any step answers an error
 *   and leaves at worst both wallets live.
 * - The owner gets a mail once a row was written on an account that already had a
 *   live wallet, whichever step failed after it, and when a session moves onto one
 *   of two live Solana wallets, which only a half-finished switch leaves.
 *
 * Any lookup or write failure refuses; a suspended account maps nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { activeBanFor } from "@/lib/session-user";
import { verifySolanaWalletSignature, verifyWalletSignature } from "@/lib/auth";
import { requireAllFactors } from "@/lib/webauthn";
import { newFactorWaitUntil, RESET_ADVICE } from "@/lib/mfa";
import { mailSecurityNotice } from "@/lib/security-notice";
import { checkRequestRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";

const bodySchema = z.object({
  solanaAddress: z.string().min(32).max(64),
  evmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullish(),
  proof: z.array(z.object({
    address: z.string().max(64),
    nonce: z.string().regex(/^[0-9a-f]{64}$/), // as issued: 32 random bytes in hex
    signature: z.string().max(200),
  })).max(2).nullish(),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE_TTL_MS = 5 * 60_000; // as /api/auth/nonce

type Wanted = { addr: string; family: "solana" | "evm"; primary: boolean; removedRow?: string };
type Db = ReturnType<typeof getSupabaseServerClient>;

function isValidSolana(addr: string): boolean {
  try { new PublicKey(addr); return true; } catch { return false; }
}

/**
 * What a new address signs. The server rebuilds it from the session's account,
 * so a proof for one account serves no other. It names neither the app nor a
 * timestamp: /api/auth/session takes any text naming the wallet, the nonce and
 * the app, and would otherwise take this one as a login; its own login text and
 * linkWalletMessage differ from this one, so they prove nothing here.
 */
function proofMessage(userId: string, address: string, nonce: string): string {
  return [
    "Change the wallet of this account.",
    "",
    `Account: ${userId}`,
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    "",
    "Signing moves no funds and costs nothing.",
  ].join("\n");
}

async function issueProofs(supabase: Db, userId: string, fresh: Wanted[]): Promise<NextResponse> {
  const limit = checkRequestRateLimit(`attach-proof:${userId}`, 10, 600_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
  const proof = fresh.map((w) => {
    const nonce = randomBytes(32).toString("hex");
    return { address: w.addr, family: w.family, nonce, message: proofMessage(userId, w.addr, nonce) };
  });
  const expires_at = new Date(Date.now() + NONCE_TTL_MS).toISOString();
  // The nonce store keys on the lowercased address, as /api/auth/nonce writes it.
  const { error } = await supabase.from("auth_nonces").insert(
    proof.map((p) => ({ wallet_address: p.address.toLowerCase(), nonce: p.nonce, expires_at, consumed: false })),
  );
  if (error) return isDbUnreachable(error) ? dbUnavailableResponse() : NextResponse.json({ error: "Could not check the wallet" }, { status: 500 });
  return NextResponse.json({ proof }, { status: 428 });
}

/** CDP answers a Solana signature in base58 and an EVM one in hex. */
async function signedBy(w: Wanted, message: string, signature: string): Promise<boolean> {
  if (w.family === "evm") return verifyWalletSignature(w.addr, signature, message);
  try {
    return await verifySolanaWalletSignature(w.addr, Buffer.from(bs58.decode(signature)).toString("base64"), message);
  } catch {
    return false; // not base58
  }
}

function tellOwner(supabase: Db, userId: string, what: string): Promise<void> {
  return mailSecurityNotice(
    supabase,
    userId,
    "wallet-change",
    "Your Enki wallet was changed",
    `${what} (${new Date().toUTCString()}). If that was you, there is nothing to do.

` +
      `If it was not, that wallet can now sign in to your account and your payouts may go to it: ${RESET_ADVICE} A reset does not remove that wallet. If it came with a factor you did not add, open Settings, Recovery, Lost a factor, to remove it.`,
  );
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("X-Session-Token");
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !isValidSolana(parsed.data.solanaAddress)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }
  const sol = parsed.data.solanaAddress;
  const evm = parsed.data.evmAddress ?? null;

  const supabase = getSupabaseServerClient();
  const { data: session, error: sessionErr } = await supabase
    .from("auth_sessions")
    .select("wallet_address, wallet_type")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  // A dead database is not "signed out" (Kev, 2026-09-05).
  if (isDbUnreachable(sessionErr)) return dbUnavailableResponse();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (session.wallet_type !== "password") {
    return NextResponse.json({ error: "Only password sessions attach wallets" }, { status: 400 });
  }

  // Resolve users.id: fresh sessions carry it directly, re-attached ones map back.
  let userId: string | null = UUID.test(session.wallet_address) ? session.wallet_address : null;
  if (!userId) {
    const { data, error } = await supabase
      .from("user_wallets")
      .select("user_id")
      .eq("address", session.wallet_address)
      .is("removed_at", null)
      .maybeSingle();
    if (isDbUnreachable(error)) return dbUnavailableResponse();
    userId = data?.user_id ?? null;
  }
  if (!userId) return NextResponse.json({ error: "No user for session" }, { status: 404 });
  // A suspended account maps no new wallets. The ones it already holds stay
  // its own: signing and key export go through wallet/jwt, which stays ban
  // tolerant.
  let banned: boolean;
  try {
    banned = Boolean(await activeBanFor(supabase, userId));
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
  if (banned) {
    return NextResponse.json({ error: "This account is suspended.", banned: true }, { status: 403 });
  }

  if (session.wallet_address === sol) {
    return NextResponse.json({ attached: sol, evm: null });
  }

  // CDP embedded wallets are MPC/TEE EOAs → wallet_type 'external_eoa' (the value
  // the user_wallets CHECK allows for a plain owned account).
  const wanted: Wanted[] = [{ addr: sol, family: "solana", primary: true }];
  if (evm) wanted.push({ addr: evm, family: "evm", primary: false });

  // Every address is checked before any row is written. ilike: EVM rows exist in
  // both cases, and a Solana row lowercased by an old bug is still owned.
  const fresh: Wanted[] = [];
  let target = sol; // what the session ends up on
  for (const w of wanted) {
    const { data: owners, error } = await supabase.from("user_wallets").select("id, user_id, address, removed_at").ilike("address", w.addr);
    if (error) return NextResponse.json({ error: "Could not check the wallet" }, { status: 500 });
    if ((owners ?? []).some((o) => o.user_id !== userId)) {
      return NextResponse.json({ error: "This wallet belongs to another account" }, { status: 409 });
    }
    const held = owners?.find((o) => !o.removed_at);
    if (!held) fresh.push({ ...w, removedRow: owners?.[0]?.id });
    else if (w.primary) {
      target = held.address;
      break; // Solana comes first: this request only re-points, the EVM address is dropped unread.
    }
  }

  // The same family's live rows, which a new address replaces.
  type LiveRow = { id: string; address: string; chain_family: string };
  let beside: LiveRow[] = []; // the account's other live rows
  let retired: LiveRow[] = [];
  if (fresh.length) {
    const proofs = parsed.data.proof ?? [];
    const proofOf = (w: Wanted) => proofs.find((p) => p.address === w.addr);
    if (!fresh.every(proofOf)) return issueProofs(supabase, userId, fresh);
    for (const w of fresh) {
      const p = proofOf(w)!;
      if (!(await signedBy(w, proofMessage(userId, w.addr, p.nonce), p.signature))) {
        return NextResponse.json({ error: "Invalid wallet signature" }, { status: 401 });
      }
    }

    const { data: live, error: liveErr } = await supabase
      .from("user_wallets")
      .select("id, address, chain_family")
      .eq("user_id", userId)
      .is("removed_at", null);
    if (liveErr) return NextResponse.json({ error: "Could not check the wallet" }, { status: 500 });
    // A live row of an address being attached is no old wallet: another tab or the silent attach was just faster.
    const attaching = fresh.map((w) => w.addr.toLowerCase());
    beside = (live ?? []).filter((r) => !attaching.includes(r.address.toLowerCase()));
    retired = beside.filter((r) => fresh.some((w) => w.family === r.chain_family));
    if (beside.length) {
      let until: string | null;
      try {
        until = await newFactorWaitUntil(supabase, userId);
      } catch {
        return NextResponse.json({ error: "Could not verify security settings" }, { status: 503 });
      }
      if (until) {
        return NextResponse.json({
          error: `A security factor was added to this account less than 24 hours ago, so its wallet can change only after ${new Date(until).toUTCString()}.`,
          wait: true,
          until,
        }, { status: 403 });
      }
    }
    const blocked = await requireAllFactors(req, userId, `wallet-change:${sol}`, { mandatory: beside.length > 0 });
    if (blocked) return blocked;

    for (const w of fresh) {
      const { data: consumed, error } = await supabase.rpc("consume_auth_nonce", {
        p_wallet_address: w.addr.toLowerCase(),
        p_nonce: proofOf(w)!.nonce,
      });
      if (isDbUnreachable(error)) return dbUnavailableResponse();
      if (error || !consumed) {
        return NextResponse.json({ error: "This signature expired or was already used. Try again." }, { status: 401 });
      }
    }
  }

  if (!fresh.length) {
    const { data: split, error } = await supabase.from("user_wallets").select("id").eq("user_id", userId).eq("chain_family", "solana").neq("address", target).is("removed_at", null);
    if (error) return NextResponse.json({ error: "Could not check the wallet" }, { status: 500 });
    if (split?.length) await tellOwner(supabase, userId, `A wallet change on your Enki account did not finish: ${target} is live beside the old wallet`);
  }

  let written = false;
  try {
    // The new row is promoted below, once the old one stopped being primary: no
    // read of the table can tell whether a constraint allows one primary per user.
    for (const w of fresh) {
      const is_primary = w.primary && !retired.some((r) => r.chain_family === w.family);
      const { error } = await (w.removedRow
        ? supabase.from("user_wallets").update({ removed_at: null, address: w.addr, is_primary }).eq("id", w.removedRow)
        : supabase.from("user_wallets").insert({ user_id: userId, address: w.addr, chain_family: w.family, wallet_type: "external_eoa", is_primary }));
      if (error?.code === "23505") {
        // user_wallets_live_address_ci: a double attach of this wallet, or someone else was faster. The row that won decides.
        const { data: won, error: wonErr } = await supabase.from("user_wallets").select("user_id").ilike("address", w.addr).is("removed_at", null).maybeSingle();
        if (wonErr) return NextResponse.json({ error: "Could not check the wallet" }, { status: 500 });
        if (won?.user_id !== userId) return NextResponse.json({ error: "This wallet belongs to another account" }, { status: 409 });
      } else if (error) {
        console.error("[attach-wallet] user_wallets write failed:", error.message);
        return NextResponse.json({ error: "Could not save the wallet" }, { status: 500 });
      } else {
        written = true;
      }
    }

    // From here the session speaks the wallet address like every other login type.
    const { error: sessErr } = await supabase
      .from("auth_sessions")
      .update({ wallet_address: target })
      .eq("token", token);
    if (sessErr) return NextResponse.json({ error: "Could not update session" }, { status: 500 });

    if (retired.length) {
      const ids = retired.map((r) => r.id);
      const steps = [
        // Before the rows go: /api/prompt would mint a new empty user for a session on a retired address. This session moved off above.
        () => supabase.from("auth_sessions").delete().in("wallet_address", retired.map((r) => r.address)),
        () => supabase.from("user_wallets").update({ is_primary: false }).in("id", ids),
        () => supabase.from("user_wallets").update({ is_primary: true }).eq("user_id", userId).eq("address", target).is("removed_at", null),
        () => supabase.from("user_wallets").update({ removed_at: new Date().toISOString() }).in("id", ids),
      ];
      for (const step of steps) {
        const { error } = await step();
        if (error) {
          console.error("[attach-wallet] wallet switch stopped:", error.message);
          return NextResponse.json({ error: "Could not save the wallet" }, { status: 500 });
        }
      }
    }
  } finally {
    if (written && beside.length) {
      const added = fresh.map((w) => w.addr).join(", ");
      await tellOwner(supabase, userId, retired.length ? `The wallet on your Enki account was changed to ${added}` : `A wallet was added to your Enki account: ${added}`);
    }
  }

  return NextResponse.json({ attached: target, evm: fresh.some((w) => w.family === "evm") ? evm : null });
}
