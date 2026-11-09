/**
 * The guardians' way for a lost factor (lib/mfa-recovery.ts askGuardians):
 *
 *   POST   { factor } -> { asked, needed, emailed, notReached, wallets }: every email guardian gets a link, the wallet guardians'
 *                        links come back for the owner to send; the moment enough say yes the factor is removed, with no wait;
 *                        502 when fewer could be reached than must say yes (nothing is asked then)
 *   DELETE            -> { withdrawn }: the owner takes it back
 *
 * Needs two confirmed guardians or more; the number that must say yes is the owner's threshold, never below two.
 */
import { NextResponse } from "next/server";
import { askGuardians, isFactor, recoveryRoute, withdrawGuardianAsk, type Asked } from "@/lib/mfa-recovery";
import { checkRequestRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const REFUSED: Record<Exclude<Asked["result"], "asked">, [string, number]> = {
  not_enrolled: ["That factor is not set up", 404],
  too_few: ["Asking your guardians needs two confirmed guardians or more, by email or wallet. Add them under Guardians.", 409],
  open: ["Your guardians were already asked. Withdraw that first to ask again.", 409],
  send_failed: ["Your guardians' emails did not go out, so not enough of them could be asked. Nothing was asked. Try again in a minute.", 502],
};

export const POST = recoveryRoute("ask guardians", async (req, supabase, userId) => {
  const body = (await req.json().catch(() => null)) as { factor?: unknown } | null;
  if (!isFactor(body?.factor)) return NextResponse.json({ error: "factor required" }, { status: 400 });
  // Every ask mails the guardians: five a day per account, refused asks included, keep a stolen session from flooding them.
  const limit = checkRequestRateLimit(`mfa-recovery:ask:${userId}`, 5, 24 * 3600_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
  const out = await askGuardians(supabase, userId, body.factor);
  if (out.result === "asked") return NextResponse.json({ asked: true, needed: out.needed, emailed: out.emailed, notReached: out.notReached, wallets: out.wallets });
  const [error, status] = REFUSED[out.result];
  return NextResponse.json({ error }, { status });
});

export const DELETE = recoveryRoute("withdraw guardians", async (_req, supabase, userId) =>
  (await withdrawGuardianAsk(supabase, userId))
    ? NextResponse.json({ withdrawn: true })
    : NextResponse.json({ error: "Your guardians were not asked" }, { status: 404 }));
