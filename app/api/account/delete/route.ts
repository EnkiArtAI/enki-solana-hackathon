/**
 * Account deletion.
 *
 *   POST { confirm } — confirm = the user's own handle.
 *     • No confirmed guardians → soft-delete immediately.
 *     • Confirmed guardians    → create a deletion request, email each guardian
 *       a one-click approve link, return { pending, requestId, ownerKey }.
 *   GET ?id=&key= — owner poll: { status, approved, threshold }. Once approvals
 *     reach the threshold, this finalizes the soft-delete and returns done. While a
 *     ban is active it does not: a banned account's funds door is /banned, so the
 *     request stays open and answers { status: "held", message }. A ban that cannot
 *     be read refuses too. POST needs no such check: a banned session resolves to nobody.
 *
 * Soft-delete = users.deleted_at + account_status='deleted' + every session
 * evicted. An admin can still recover the row; nothing is hard-erased here.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { activeBanFor, resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { sha256 } from "@/lib/password-reset";
import { sendMail } from "@/lib/mailer";
import { requireStepUp } from "@/lib/webauthn";
import { revokeGateCookie } from "@/lib/allowlist";

type Supabase = ReturnType<typeof getSupabaseServerClient>;
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function softDelete(supabase: Supabase, userId: string) {
  await supabase
    .from("users")
    .update({ deleted_at: new Date().toISOString(), account_status: "deleted" })
    .eq("id", userId);
  // Evict every session tied to this user (their wallets + the uuid bridge value).
  const { data: wallets } = await supabase
    .from("user_wallets")
    .select("address")
    .eq("user_id", userId)
    .is("removed_at", null);
  const keys = [userId, ...((wallets ?? []).map((w) => String(w.address)))];
  await supabase.from("auth_sessions").delete().in("wallet_address", keys);
  // Its Google and X logins go too: the X account can sign in and claim its posts' shares from a new account,
  // and a deleted claimant stops holding an author's money (review, 2026-10-17).
  await supabase.from("auth_identities").delete().eq("user_id", userId);
  // Sessions again, as the password reset does: a provider login racing the deletion ends on one side or the other.
  await supabase.from("auth_sessions").delete().in("wallet_address", keys);
}

export async function POST(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "account:delete"), 5, 60 * 60 * 1000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let confirm: string;
  try {
    ({ confirm } = (await req.json()) as { confirm: string });
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const { data: me } = await supabase.from("users").select("handle").eq("id", userId).maybeSingle();
  if (!me) return NextResponse.json({ error: "No user for session" }, { status: 404 });
  // Confirm by typing the exact handle (case-insensitive).
  if (!me.handle || String(confirm ?? "").trim().toLowerCase() !== String(me.handle).toLowerCase()) {
    return NextResponse.json({ error: "That doesn't match your username" }, { status: 400 });
  }
  // MFA-3: a stolen session alone must not end the account. Asked once a
  // factor is enrolled, after the typed handle (a typo asks for nothing) and
  // before a deletion starts or a guardian is mailed.
  const blocked = await requireStepUp(req, userId, "delete-account");
  if (blocked) return blocked;

  const { data: guardians } = await supabase
    .from("recovery_guardians")
    .select("id, value, guardian_type")
    .eq("user_id", userId)
    .eq("status", "confirmed");
  const emailGuardians = (guardians ?? []).filter((g) => g.guardian_type === "email" && g.value);

  // No guardians to consult → delete now.
  if (!guardians || guardians.length === 0) {
    await softDelete(supabase, userId);
    // A deleted account opens nothing more on this browser (DEC-434; review wf_866ba07b-01a).
    return revokeGateCookie(NextResponse.json({ deleted: true }));
  }

  // Guardians must approve first. Create a request + one approve link each.
  const ownerKey = randomBytes(24).toString("hex");
  const { data: request, error } = await supabase
    .from("deletion_requests")
    .insert({ user_id: userId, owner_key_hash: sha256(ownerKey), expires_at: new Date(Date.now() + REQUEST_TTL_MS).toISOString() })
    .select("id")
    .single();
  if (error || !request) return NextResponse.json({ error: "Could not start deletion" }, { status: 500 });

  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://enki.gallery";
  for (const g of guardians) {
    const token = randomBytes(24).toString("hex");
    await supabase.from("deletion_approvals").insert({ request_id: request.id, guardian_id: g.id, approve_token: token });
    const eg = emailGuardians.find((x) => x.id === g.id);
    if (eg) {
      const link = `${origin}/guardian?delete=${token}`;
      await sendMail({
        to: eg.value,
        subject: "A friend wants to delete their Enki Art account",
        text:
          `Someone who trusts you as a recovery guardian wants to permanently delete their Enki Art account.\n\n` +
          `If this is really them and you approve, open this link:\n${link}\n\n` +
          `If something feels off, do nothing — the request expires in 7 days.`,
      }).catch(() => {});
    }
  }

  return NextResponse.json({ pending: true, requestId: request.id, ownerKey });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const key = req.nextUrl.searchParams.get("key");
  if (!id || !key) return NextResponse.json({ error: "id and key required" }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const { data: request } = await supabase
    .from("deletion_requests")
    .select("id, user_id, status, expires_at, owner_key_hash")
    .eq("id", id)
    .maybeSingle();
  if (!request || request.owner_key_hash !== sha256(key)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // The owner's tab asks here: once deleted, the account opens nothing more on it (DEC-434).
  if (request.status === "completed") return revokeGateCookie(NextResponse.json({ status: "completed", done: true }));
  const expired = new Date(request.expires_at).getTime() <= Date.now();

  const [{ count: approved }, { data: settings }] = await Promise.all([
    supabase.from("deletion_approvals").select("guardian_id", { count: "exact", head: true }).eq("request_id", id).not("approved_at", "is", null),
    supabase.from("recovery_settings").select("threshold").eq("user_id", request.user_id).maybeSingle(),
  ]);
  const threshold = settings?.threshold ?? 2;

  // Threshold reached → finalize the soft-delete.
  if (!expired && (approved ?? 0) >= threshold) {
    let banned: boolean;
    try {
      banned = Boolean(await activeBanFor(supabase, request.user_id));
    } catch {
      return NextResponse.json({ status: "pending", error: "Could not check this account. Try again." }, { status: 503 });
    }
    if (banned) {
      return NextResponse.json({
        status: "held",
        message: "This account is suspended, so it is not deleted while the suspension runs. You can still reach your funds on the suspension page.",
        approved: approved ?? 0,
        threshold,
      });
    }
    await softDelete(supabase, request.user_id);
    await supabase.from("deletion_requests").update({ status: "completed" }).eq("id", id);
    return revokeGateCookie(NextResponse.json({ status: "completed", done: true, approved: approved ?? 0, threshold }));
  }

  return NextResponse.json({ status: expired ? "expired" : "pending", approved: approved ?? 0, threshold });
}
