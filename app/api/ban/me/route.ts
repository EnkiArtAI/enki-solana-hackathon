/**
 * GET /api/ban/me — the banned self-service surface (works WITH an active
 * ban; everything else in the API refuses banned sessions). Returns the ban,
 * the latest appeal for it, and the user's wallets so the /banned page can
 * show that funds remain theirs.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { admitAllowlisted, grantGateCookie, revokeGateCookie } from "@/lib/allowlist";
import { accountAllowed } from "@/lib/auth/oauth";
import { activeTrial, grantTrialCookie } from "@/lib/trial";

const STAFF = new Set(["mod", "admin"]);

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const token = req.headers.get("X-Session-Token");
  const { userId, ban } = await resolveSessionUserWithBan(supabase, token);
  // No live session, no access cookie: the app closes on the server too (DEC-434).
  if (!userId) return revokeGateCookie(NextResponse.json({ error: "Not signed in" }, { status: 401 }));
  // A ban that ended gives app access back: the login that minted this
  // session passed the allowlist but got no cookie while banned. Only to an
  // account the list admits, asked as every login asks it: a role says too
  // little (a member taken off the list stays 'beta'; a session that outlived
  // its listing took the team cookie here; review and DEC-366, 2026-10-26).
  // The landing asks here too, for a signed-in browser whose cookie is gone
  // (DEC-434): `admitted` says the app is open to it again.
  if (!ban) {
    try {
      const { data: me, error } = await supabase.from("users").select("role").eq("id", userId).maybeSingle();
      if (error) throw error;
      if (STAFF.has(String(me?.role ?? "")) || (await accountAllowed(supabase, userId))) {
        await admitAllowlisted(supabase, userId);
        // The cookie ends with this session, as at the login that made it.
        const { data: session, error: sessionErr } = await supabase.from("auth_sessions").select("expires_at").eq("token", token).maybeSingle();
        if (sessionErr) throw sessionErr;
        return grantGateCookie(NextResponse.json({ banned: false, admitted: true }), userId, String(session?.expires_at ?? ""));
      }
      // A tester's running trial gets its own cookie back, never the team's.
      const trial = await activeTrial(supabase, userId);
      return trial ? grantTrialCookie(NextResponse.json({ banned: false, admitted: true }), userId, trial) : NextResponse.json({ banned: false });
    } catch {
      return NextResponse.json({ error: "Your account could not be read right now. Try again." }, { status: 503 });
    }
  }

  const [{ data: appeals }, { data: wallets }, { data: session }] = await Promise.all([
    supabase.from("appeals")
      .select("status, created_at, decision_notes")
      .eq("user_id", userId).eq("target_uuid", ban.id)
      .order("created_at", { ascending: false }).limit(1),
    supabase.from("user_wallets")
      .select("address, chain_family")
      .eq("user_id", userId).is("removed_at", null),
    supabase.from("auth_sessions").select("wallet_type").eq("token", token).maybeSingle(),
  ]);
  const a = appeals?.[0] ?? null;
  // user_wallets cannot tell an embedded wallet from a self-custodial one:
  // attach-wallet writes the CDP wallet as external_eoa too, and the
  // wallet_type CHECK has no value for it (probed 2026-10-07: only
  // external_eoa and smart_account pass). How the account signs in can: a
  // password session (social login reuses the type) gets wallets only
  // through attach-wallet, a wallet login brings its own.
  const embedded = session?.wallet_type === "password";
  return revokeGateCookie(NextResponse.json({
    banned: true,
    reason: ban.reason,
    permanent: !ban.expiresAt,
    expiresAt: ban.expiresAt,
    appeal: a ? { status: String(a.status), at: a.created_at, notes: (a.decision_notes as string) ?? null } : null,
    wallets: (wallets ?? []).map((w) => ({
      address: String(w.address),
      external: !embedded,
      chain: String(w.chain_family),
    })),
  }));
}
