import { NextRequest, NextResponse } from "next/server";
import { list, put, del } from "@vercel/blob";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { sendMail } from "@/lib/mailer";
import { cronDenied } from "@/lib/cron";

/* An open outage is a marker file in Blob storage, not a row: the database
   is the thing that is down. One mail when it appears, one when it goes. */
const MARKER = "ops/db-down.txt";
/* A run that got no answer leaves this, and the next run decides: still no
   answer is an outage, an answer was a blip. Two alerts in October were one
   lost request each, back on the next run (Kev, 2026-10-16). */
const SUSPECT = "ops/db-suspect.txt";
const TRIES = 3;
const RETRY_MS = 5_000;

// Three tries of up to 10 s with 5 s between them, after a start that took
// 42 s to its first mail on 2026-10-16: a run cut off before its marker
// would never report an outage.
export const maxDuration = 120;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Null when the database answered within TRIES, else the last error it gave. */
async function databaseError(): Promise<string | null> {
  let last = "no answer";
  for (let attempt = 0; attempt < TRIES; attempt++) {
    if (attempt) await sleep(RETRY_MS);
    try {
      const { error } = await getSupabaseServerClient()
        .from("users").select("id").limit(1)
        .abortSignal(AbortSignal.timeout(10_000));
      if (!error) return null;
      last = [error.code, error.message].filter(Boolean).join(" ") || last;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  return last.slice(0, 300);
}

async function tell(to: string[], subject: string, text: string): Promise<boolean> {
  const sent = await Promise.all(to.map((address) => sendMail({ to: address, subject, text })));
  return sent.some((r) => r.ok);
}

/**
 * Every minute (vercel.json): is the database answering? Supabase was
 * paused for days in September and nobody heard of it, because notifyAdmins
 * reads its recipients from the database it would have to report on (ENG-08).
 * Recipients come from OPS_ALERT_EMAILS instead. An outage is two runs in a
 * row without an answer, each after TRIES tries. The markers change only once
 * a mail went out, so a failed send is retried on the next run, never lost.
 */
export async function GET(req: NextRequest) {
  const denied = cronDenied(req);
  if (denied) return denied;
  const to = (process.env.OPS_ALERT_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // Without any of these the alert could never go out, so the run says so
  // instead of answering 200 every minute.
  if (!to.length || !process.env.BLOB_READ_WRITE_TOKEN || !process.env.RESEND_API_KEY) {
    return NextResponse.json({ error: "Outage alerts are not configured on this environment (OPS_ALERT_EMAILS, BLOB_READ_WRITE_TOKEN, RESEND_API_KEY)." }, { status: 503 });
  }

  const error = await databaseError();
  const up = error === null;
  if (!up) console.error("[db-health] the database did not answer:", error);
  const { blobs } = await list({ prefix: "ops/db-", limit: 10 });
  const open = blobs.find((b) => b.pathname === MARKER);
  const suspect = blobs.find((b) => b.pathname === SUSPECT);
  const host = new URL(process.env.SUPABASE_URL ?? "http://unset").host;
  const stamp = { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "text/plain" } as const;

  if (!up && !open) {
    if (!suspect) {
      // The first run without an answer: the next one decides.
      await put(SUSPECT, new Date().toISOString(), stamp);
    } else if (await tell(to, "Enki: database unreachable", `The database (${host}) has not answered since ${suspect.uploadedAt.toISOString()}, in two runs a minute apart (${TRIES} tries each). The app answers 503 to everything that needs it. Last error: ${error}. You get one more mail when it is back.`)) {
      await put(MARKER, suspect.uploadedAt.toISOString(), stamp);
      await del(suspect.url);
    }
  } else if (up && open) {
    if (await tell(to, "Enki: database back", `The database (${host}) answers again (${new Date().toISOString()}). It was reported unreachable at ${open.uploadedAt.toISOString()}.`)) {
      await del(open.url);
    }
  } else if (up && suspect) {
    // One run without an answer, the next with one: a blip, not an outage.
    await del(suspect.url);
  }
  return NextResponse.json(up ? { up } : { up, error });
}
