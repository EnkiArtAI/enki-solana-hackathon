import { NextRequest, NextResponse } from "next/server";
import { cronDenied } from "@/lib/cron";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { CHECK_NOT_READY, runGuardianChecks } from "@/lib/recovery/guardian-check";

// Up to lib/recovery/guardian-check.ts ASKS_PER_RUN mails one by one, then the owners' mails.
export const maxDuration = 60;

/**
 * Daily (vercel.json): the yearly check of each guardian (lib/recovery/guardian-check.ts). CRON_SECRET-gated, as every cron.
 * Before SQL 75 ran: 503, nothing read or sent, and the answer says why. A check mail that did not go out turns it red (502):
 * that guardian is due again the next day.
 */
export async function GET(req: NextRequest) {
  const denied = cronDenied(req);
  if (denied) return denied;
  try {
    const run = await runGuardianChecks(getSupabaseServerClient());
    if (!run.ready) return NextResponse.json({ error: CHECK_NOT_READY }, { status: 503 });
    return NextResponse.json(run, { status: run.failed ? 502 : 200 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[guardian-check] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "The guardian check did not finish." }, { status: 500 });
  }
}
