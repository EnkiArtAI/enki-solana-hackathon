/**
 * POST /api/auth/mfa/recovery/mail/confirm { codes } -> { removed }
 *
 * Every mailed code, in the order ../mail named the addresses: the factor goes at once, the unused recovery codes with it,
 * and every address hears. No wait. lib/mfa-recovery.ts confirmMailCodes.
 */
import { NextResponse } from "next/server";
import { confirmMailCodes, recoveryRoute, tooFew, type MailConfirmed } from "@/lib/mfa-recovery";

const REFUSED: Record<Exclude<MailConfirmed["result"], "removed" | "too_few">, [string, number]> = {
  none: ["No codes are waiting. Ask for new ones.", 404],
  changed: ["Your email addresses changed since the codes went out. Ask for new ones.", 409],
  locked: ["Too many wrong codes. Try again later.", 429],
  busy: ["Another check is running, try again", 409],
  wrong: ["Wrong code", 400],
};

export const POST = recoveryRoute("mail confirm", async (req, supabase, userId) => {
  const body = (await req.json().catch(() => null)) as { codes?: unknown } | null;
  const codes = body?.codes;
  if (!Array.isArray(codes) || !codes.length || codes.length > 10 || !codes.every((c) => typeof c === "string")) {
    return NextResponse.json({ error: "codes required" }, { status: 400 });
  }
  const out = await confirmMailCodes(supabase, userId, codes);
  if (out.result === "removed") return NextResponse.json({ removed: true });
  if (out.result === "too_few") return NextResponse.json({ error: await tooFew(supabase, userId) }, { status: 409 });
  const [error, status] = REFUSED[out.result];
  return NextResponse.json({ error }, { status });
});
