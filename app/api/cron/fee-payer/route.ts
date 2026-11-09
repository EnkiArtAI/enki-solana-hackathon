import { NextRequest, NextResponse } from "next/server";
import { del, list, put } from "@vercel/blob";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { cronDenied } from "@/lib/cron";
import { sendMail } from "@/lib/mailer";
import { FEE_PAYER_LOW_LAMPORTS, feePayerBalance, solanaChainKey, solanaConnection, x402ChainKey } from "@/lib/payments/solana";

/* The last mail per chain is a marker in Blob storage, as in db-health. Written only once a mail went out, so a failed send
   tries again next hour, and removed once the chain reads fine, so the next drop mails at once. */
const REMIND_EVERY_MS = 24 * 60 * 60_000;
const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(3);

// One or two chains, each up to two RPC endpoints at 10 s (lib/payments/solana.ts RPC_ATTEMPT_MS).
export const maxDuration = 60;

/**
 * Hourly (vercel.json): the fee payer fronts every nonce account, and an empty one halts all generations. One getBalance on the
 * deployment's chain and, where x402 settles elsewhere, one there. At most one mail per chain per 24 h while low, and none when
 * it recovers. No answer from the RPC is not "fine": that chain gets no mail and no marker, and never the RPC's own error, whose
 * text can hold the endpoint's address and its key. Whatever could be read is still told, then a 503 turns the cron red, as does
 * a mail nobody got. A Blob store that is down is no reason for silence: the mail goes without the marker.
 */
export async function GET(req: NextRequest) {
  const denied = cronDenied(req);
  if (denied) return denied;
  const to = (process.env.OPS_ALERT_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length || !process.env.BLOB_READ_WRITE_TOKEN || !process.env.RESEND_API_KEY) {
    return NextResponse.json({ error: "Fee payer alerts are not configured on this environment (OPS_ALERT_EMAILS, BLOB_READ_WRITE_TOKEN, RESEND_API_KEY)." }, { status: 503 });
  }

  // A deployment whose chain cannot be named throws here, before any is asked: nothing is known of either.
  let read: PromiseSettledResult<{ chain: string; lamports: number; low: boolean }>[];
  try {
    read = await Promise.allSettled([...new Set([solanaChainKey(), x402ChainKey()])].map(async (chain) => ({ chain, ...(await feePayerBalance(solanaConnection(chain))) })));
  } catch {
    read = [{ status: "rejected", reason: null }];
  }
  const balances = read.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const unread = balances.length < read.length;
  if (unread) console.error("[fee-payer] the balance could not be read");

  const blobs = await list({ prefix: "ops/fee-payer-low-", limit: 10 }).then((r) => r.blobs, () => {
    console.error("[fee-payer] the markers could not be read");
    return [];
  });
  let unsent = false;
  for (const { chain, lamports, low } of balances) {
    const marker = `ops/fee-payer-low-${chain}.txt`;
    const told = blobs.find((b) => b.pathname === marker);
    if (!low) {
      if (told) await del(told.url).catch(() => console.error("[fee-payer] a marker could not be removed"));
      continue;
    }
    if (told && Date.now() - told.uploadedAt.getTime() < REMIND_EVERY_MS) continue;
    const sent = await Promise.all(to.map((address) => sendMail({
      to: address,
      subject: "Enki: the fee payer is running low",
      text: `The fee payer on ${chain} holds ${sol(lamports)} SOL, under the mark of ${sol(FEE_PAYER_LOW_LAMPORTS)} SOL. When it is empty every generation stops. Top it up. You get this once a day while it stays low.`,
    })));
    if (sent.some((r) => r.ok)) await put(marker, new Date().toISOString(), { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "text/plain" }).catch(() => console.error("[fee-payer] a marker could not be written"));
    else unsent = true;
  }
  const chains = balances.map(({ chain, lamports, low }) => ({ chain, sol: sol(lamports), low }));
  if (unread) return NextResponse.json({ error: "The fee payer's balance could not be read.", chains }, { status: 503 });
  if (unsent) return NextResponse.json({ error: "The fee payer is low and the mail did not go out.", chains }, { status: 503 });
  return NextResponse.json({ chains });
}
