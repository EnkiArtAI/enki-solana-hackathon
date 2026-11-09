/**
 * The click-check of a wallet NFT (Kev, 2026-11-03). Display and convenience only: the generation routes judge every
 * reference on every request, whatever is saved here.
 *
 *   GET → { checks: { [nft id]: { verdict, why, left, opensAt, picture } } }, this account's saved verdicts
 *   POST { id, image, proof, renew? } → { check }
 *
 * id, image and proof are what the list named (app/api/wallet/nfts): the proof shows the list read this NFT, with this
 * picture, in a wallet of this account, and no index call is made. A press on an NFT with a verdict and no renew answers
 * the verdict, judging nothing, and so does a renew on an allowed one: only a refused NFT renews (lib/nft-check). One that judges reads the picture as a picked reference is read (lib/wallet-nfts) and
 * judges it with checkImageBytes, as generate-image judges a reference: a child-safety verdict becomes its private case
 * and the answer says only refused. A read or a judge that fails saves nothing and costs no renewal.
 *
 * A renewal is claimed before anything is paid for, and given back when the check fails. The judges are asked with no signal
 * of the client's: a client that left would read as a judge that failed, get its renewal back and press again, unlimited.
 */
import { after, NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { httpSource, readNftPicture, solanaWallets } from "@/lib/wallet-nfts";
import { checkImageBytes } from "@/lib/moderation/image-check-bytes";
import { recordImageCase } from "@/lib/moderation/image-case";
import { NFT_CHECK_NOT_READY, nftCheckOf, nftVerdict, readNftProof, utcDay, type NftCheckRow } from "@/lib/nft-check";

const COLUMNS = "nft_id, verdict, why, no_picture, first_checked_at, renew_day, renewals";
const NO_STORE = { "Cache-Control": "no-store" };

const fail = (error: string, status: number, extra?: object) => NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
/** SQL 65 not run yet, or the database could not answer: nothing is judged either way. */
const unsaved = (e: { code?: string }) =>
  e.code === "PGRST205" || e.code === "42P01" ? fail(NFT_CHECK_NOT_READY, 503, { run: "65-nft-checks.sql" }) : fail("The NFT check is unavailable right now. Try again in a moment.", 503);

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return fail("Not signed in", 401);
  const limit = checkRequestRateLimit(rateLimitKey(req, "nfts:checks", userId), 120, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
  // Past PostgREST's 1000 rows a tile looks grey, and its press answers the saved verdict without judging.
  const { data, error } = await supabase.from("nft_checks").select(COLUMNS).eq("user_id", userId).order("checked_at", { ascending: false });
  if (error) return unsaved(error);
  const now = new Date();
  const rows = (data ?? []) as unknown as NftCheckRow[];
  return NextResponse.json({ checks: Object.fromEntries(rows.map((row) => [row.nft_id, nftCheckOf(row, now)])) }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return fail("Not signed in", 401);
  // A person's presses; each that judges is a paid model call.
  const limit = checkRequestRateLimit(rateLimitKey(req, "nfts:check", userId), 30, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const body = (await req.json().catch(() => null)) as { id?: unknown; image?: unknown; proof?: unknown; renew?: unknown } | null;
  const { id, image } = body ?? {};
  const source = httpSource(image);
  if (typeof id !== "string" || !id || typeof image !== "string" || !source) return fail("Bad request", 400);
  const owner = readNftProof(body?.proof, userId, id, image);
  if (!owner) return fail("This list is out of date. Close it and open it again.", 403);
  const wallets = await solanaWallets(supabase, userId);
  if (!wallets) return fail("Wallets unavailable", 503);
  if (!wallets.includes(owner)) return fail("This NFT is not in a wallet of this account any more.", 403);

  const saved = await supabase.from("nft_checks").select(COLUMNS).eq("user_id", userId).eq("nft_id", id).maybeSingle();
  if (saved.error) return unsaved(saved.error);
  const row = saved.data as unknown as NftCheckRow | null;
  const answer = (check: NftCheckRow) => NextResponse.json({ check: nftCheckOf(check) }, { headers: NO_STORE });
  if (row && (!body?.renew || row.verdict === "allowed")) return answer(row);

  const now = new Date();
  const today = utcDay(now);
  // The day's count, moved on only from what was read: of two presses at once one claims, and neither runs past the limit.
  let claimed = 0;
  if (row) {
    const state = nftCheckOf(row, now);
    if (!state.left) return fail("No renewals left today.", 429, { check: state });
    claimed = (utcDay(row.renew_day) === today ? row.renewals : 0) + 1;
    const claim = await supabase.from("nft_checks").update({ renewals: claimed, renew_day: today })
      .eq("user_id", userId).eq("nft_id", id).eq("renewals", row.renewals).eq("renew_day", utcDay(row.renew_day)).select("nft_id");
    if (claim.error) return unsaved(claim.error);
    if (!claim.data?.length) return fail("This NFT is being checked already.", 409);
  }
  // A check that failed costs nothing. Only from what was claimed: a press after this one keeps its own count.
  const giveBack = async () => {
    if (!claimed) return;
    await supabase.from("nft_checks").update({ renewals: claimed - 1 })
      .eq("user_id", userId).eq("nft_id", id).eq("renewals", claimed).eq("renew_day", today);
  };

  // Inside the 20 s a browser waits for a picture, as the picker's read.
  const picture = await readNftPicture(source, AbortSignal.any([req.signal, AbortSignal.timeout(15_000)]));
  if (!picture) {
    await giveBack();
    return fail("This NFT's picture could not be read. Nothing was saved, so you can try again.", 502);
  }
  const bytes = Buffer.from(await picture.bytes.arrayBuffer());
  const seen = await checkImageBytes(bytes);
  // A child-safety picture becomes a case, as a reference at generate-image: never shown, no sanction, a human decides.
  if (seen.verdict === "child_safety") {
    after(recordImageCase(getSupabaseServerClient(), { surface: "nft-check", request: req, bytes, scores: seen.scores, about: JSON.stringify({ nft: id }) }));
  }
  const verdict = nftVerdict(seen);
  if (!verdict) {
    await giveBack();
    return fail("This NFT could not be checked right now. Nothing was saved, so you can try again.", 503);
  }

  const at = now.toISOString();
  // A red answer that does not set no_picture leaves the column to the database: it cannot lift a flag, not even one a press
  // saved while this one waited for its judge. Only a green one lifts it (lib/nft-check nftVerdict).
  const { no_picture, ...said } = verdict;
  const written = row
    ? await supabase.from("nft_checks").update({ ...said, ...(no_picture || said.verdict === "allowed" ? { no_picture } : {}), checked_at: at }).eq("user_id", userId).eq("nft_id", id).select(COLUMNS).single()
    : await supabase.from("nft_checks").insert({ user_id: userId, nft_id: id, ...verdict, first_checked_at: at, checked_at: at, renew_day: today, renewals: 0 }).select(COLUMNS).single();
  if (written.error?.code === "23505") {
    // A first press in another tab saved first: its verdict stands, and it costs no renewal.
    const first = await supabase.from("nft_checks").select(COLUMNS).eq("user_id", userId).eq("nft_id", id).single();
    return first.error ? unsaved(first.error) : answer(first.data as unknown as NftCheckRow);
  }
  if (written.error) {
    await giveBack();
    return unsaved(written.error);
  }
  return answer(written.data as unknown as NftCheckRow);
}
