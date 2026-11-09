/**
 * POST /api/auth/mfa/recovery/mail { factor } -> { sent, to }
 *
 * The mail path, for someone with no recovery code left: one code to each email address of the account, `to` naming them
 * masked in the order the codes go back to ./confirm, which removes the factor at once. lib/mfa-recovery.ts sendMailCodes.
 */
import { NextResponse } from "next/server";
import { isFactor, recoveryRoute, sendMailCodes, tooFew, type MailSent } from "@/lib/mfa-recovery";

const REFUSED: Record<Exclude<MailSent["result"], "sent" | "too_few">, [string, number]> = {
  not_enrolled: ["That factor is not set up", 404],
  cooldown: ["Codes were just sent. Wait a minute before asking for new ones.", 429],
  daily_cap: ["No more codes today. Try again tomorrow.", 429],
  send_failed: ["Not every code could be sent. Try again in a minute.", 502],
};

export const POST = recoveryRoute("mail", async (req, supabase, userId) => {
  const body = (await req.json().catch(() => null)) as { factor?: unknown } | null;
  if (!isFactor(body?.factor)) return NextResponse.json({ error: "factor required" }, { status: 400 });
  const out = await sendMailCodes(supabase, userId, body.factor);
  if (out.result === "sent") return NextResponse.json({ sent: true, to: out.to });
  if (out.result === "too_few") return NextResponse.json({ error: await tooFew(supabase, userId) }, { status: 409 });
  const [error, status] = REFUSED[out.result];
  return NextResponse.json({ error }, { status });
});
