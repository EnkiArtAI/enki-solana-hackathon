/**
 * POST /api/auth/mfa/recovery/redeem { code, factor } -> { removed, recoveryCodes, codesLeft }
 *
 * A signed-in session and one recovery code remove one named factor; recoveryCodes holds the one new code that replaces
 * the used one, shown once. Attempts count in the database. lib/mfa-recovery.ts.
 */
import { NextResponse } from "next/server";
import { isFactor, recoveryRoute, redeemCode } from "@/lib/mfa-recovery";

export const POST = recoveryRoute("redeem", async (req, supabase, userId) => {
  const body = (await req.json().catch(() => null)) as { code?: unknown; factor?: unknown } | null;
  if (typeof body?.code !== "string" || !isFactor(body.factor)) return NextResponse.json({ error: "code and factor required" }, { status: 400 });
  const out = await redeemCode(supabase, userId, body.code, body.factor);
  if (out.result === "ok") return NextResponse.json({ removed: true, recoveryCodes: out.recoveryCodes, codesLeft: out.codesLeft });
  if (out.result === "not_enrolled") return NextResponse.json({ error: "That factor is not set up" }, { status: 404 });
  if (out.result === "locked") return NextResponse.json({ error: "Too many wrong codes. Try again later." }, { status: 429 });
  if (out.result === "busy") return NextResponse.json({ error: "Another check is running, try again" }, { status: 409 });
  return NextResponse.json({ error: "Wrong code" }, { status: 400 });
});
