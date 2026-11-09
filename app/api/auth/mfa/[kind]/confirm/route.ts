/**
 * POST /api/auth/mfa/[kind]/confirm { code } -> { confirmed }
 *
 * The first right code from the authenticator app, or from the inbox, proves
 * the user holds it; from then on the factor counts for step-up. The same
 * attempt counter and lock as a step-up apply (lib/mfa.ts). When the account
 * holds no unused recovery code the answer also carries recoveryCodes, shown once.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { checkCode, enrolledFactors } from "@/lib/mfa";
import { codesForNewFactor, removalWays } from "@/lib/mfa-recovery";
import { requireAddressFirst, requireStepUp } from "@/lib/webauthn";
import { mailFactorAdded } from "@/lib/security-notice";

export async function POST(req: NextRequest, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  if (kind !== "totp" && kind !== "email") return NextResponse.json({ error: "Unknown factor" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  if (typeof body.code !== "string") return NextResponse.json({ error: "code required" }, { status: 400 });
  try {
    const supabase = getSupabaseServerClient();
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    // With a factor in place, confirming another adds one: a step-up, so the
    // inbox alone never confirms a pending email beside the owner's passkey.
    const blocked = await requireStepUp(req, userId, "add-factor");
    if (blocked) return blocked;
    // Confirming a factor that already counts adds nothing: one factor must not get itself a set of recovery codes that way.
    const before = await enrolledFactors(supabase, userId);
    const added = !before.includes(kind);
    // Asked again here: the address the setup saw may be gone since.
    const first = kind === "totp" ? await requireAddressFirst(userId, before) : null;
    if (first) return first;
    const result = await checkCode(supabase, userId, kind, body.code, { confirm: true });
    if (result === "ok") {
      // The codes first: the mail names a recovery code only when none came with this factor (removalWays).
      const recoveryCodes = added ? await codesForNewFactor(supabase, userId, kind, before) : null;
      const ways = await removalWays(supabase, userId, kind, before, !!recoveryCodes);
      await mailFactorAdded(supabase, userId, kind === "totp" ? "An authenticator app" : "An email code", ways);
      return NextResponse.json({ confirmed: true, ...(recoveryCodes && { recoveryCodes }) });
    }
    if (result === "none") return NextResponse.json({ error: "This setup expired. Start it again." }, { status: 404 });
    if (result === "locked") return NextResponse.json({ error: "Too many wrong codes. Try again later." }, { status: 429 });
    if (result === "busy") return NextResponse.json({ error: "Another check is running, try again" }, { status: 409 });
    return NextResponse.json({ error: "Wrong code" }, { status: 400 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[mfa] confirm failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not confirm the factor" }, { status: 500 });
  }
}
