/**
 * Username (users.handle) API.
 *
 *   GET  ?name=foo → { valid, available }        (live check while typing)
 *   GET            → { handle, handleAuto }       (session user's own handle; handleAuto = Enki picked it)
 *   POST { candidates: string[] } → { available } (batch check for suggestions)
 *   PUT  { handle } → sets it once for the session user, or replaces the one Enki picked (409 if taken/chosen)
 *   PATCH { hideFromLeaderboard?, adultConfirmed? } → the session user's preferences
 *
 * handle is citext in the DB, so equality checks are case-insensitive; we
 * normalize to lowercase anyway so display is consistent.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId, resolveSessionUserWithBan } from "@/lib/session-user";
import { revokeGateCookie } from "@/lib/allowlist";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { normalizeHandle as normalize, usableHandle as usable } from "@/lib/handle-rules";
import { activeTrial } from "@/lib/trial";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  const supabase = getSupabaseServerClient();

  if (name === null) {
    // Own identity bits (handle + role) for the session user — role drives the
    // Admin section's visibility client-side. Admin APIs must re-check server-side.
    const { userId, ban } = await resolveSessionUserWithBan(supabase, req.headers.get("X-Session-Token"));
    // Said, not hidden behind a 401: BetaGate sends a banned account to
    // /banned, and the cookie from before the ban goes.
    if (ban) return revokeGateCookie(NextResponse.json({ error: "This account is suspended.", banned: true }, { status: 403 }));
    // A session the server no longer knows takes the access cookie with it (DEC-434).
    if (!userId) return revokeGateCookie(NextResponse.json({ error: "Not signed in" }, { status: 401 }));
    const wantStats = req.nextUrl.searchParams.get("stats") === "1";
    const read = (cols: string) => supabase.from("users").select(cols).eq("id", userId).maybeSingle<{
      handle: string | null;
      handle_auto?: boolean | null;
      role?: string;
      bio?: string | null;
      avatar_url?: string | null;
      cover_image_url?: string | null;
      hide_from_leaderboard?: boolean | null;
      adult_confirmed_at?: string | null;
    }>();
    const FULL = "handle, role, bio, avatar_url, cover_image_url, hide_from_leaderboard, adult_confirmed_at";
    // Row + count run in parallel — the profile header waits on this response.
    const [first, countRes] = await Promise.all([
      read(`${FULL}, handle_auto`),
      wantStats
        ? supabase.from("prompts").select("id", { count: "exact", head: true }).eq("creator_id", userId)
        : Promise.resolve({ count: null as number | null }),
    ]);
    // A column the full read names may be missing (a migration not run yet,
    // a stale schema cache): handle_auto until SQL 46 runs, then the rest
    // without it. Keep handle and role, which exist: dropping the role locked
    // every beta user out at the gate, and a null handle would re-trigger the
    // first-login name picker for everyone.
    let res = first;
    for (const cols of [FULL, "handle, role"]) if (res.error) res = await read(cols);
    const row = res.data;
    if (!row) return NextResponse.json({ error: "No user for session" }, { status: 404 });
    // ?stats=1 → the user's total prompt count (profile header). A plain COUNT
    // on prompts.creator_id — cheap with an index, never drifts.
    const promptCount = wantStats ? (countRes.count ?? 0) : null;
    // A trial tester's running trial: the client wall admits the account only while it runs, and shows its end and
    // what is left of its budget (lib/trial).
    const trial = row.role === "trial" ? await activeTrial(supabase, userId) : null;
    return NextResponse.json({
      // The caller's own id. Not a secret to them, and the recovery file needs
      // it: it is the mapping our database holds, so a user who keeps it can be
      // re-linked to their wallet even if that database is lost.
      id: userId,
      handle: row.handle ?? null,
      // Enki picked the name (SQL 46) and its owner has not chosen one yet: the first-login picker asks.
      handleAuto: row.handle_auto === true,
      role: row.role ?? "user",
      bio: row.bio ?? null,
      avatarUrl: row.avatar_url ?? null,
      coverUrl: row.cover_image_url ?? null,
      hideFromLeaderboard: row.hide_from_leaderboard ?? false,
      adultConfirmed: Boolean(row.adult_confirmed_at),
      promptCount,
      trial: trial ? { endsAt: trial.endsAt, budgetMicro: trial.budgetMicro, spentMicro: trial.spentMicro } : null,
    });
  }

  const limit = checkRequestRateLimit(rateLimitKey(req, "handle:check"), 60, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const handle = normalize(name);
  if (!usable(handle)) return NextResponse.json({ valid: false, available: false });
  const { data } = await supabase.from("users").select("id").eq("handle", handle).maybeSingle();
  // One's own name is free to keep (the one Enki picked, SQL 46): who asks is read only when the name is taken.
  const own = data ? (await resolveSessionUserId(supabase, req.headers.get("X-Session-Token")).catch(() => null)) === data.id : false;
  return NextResponse.json({ valid: true, available: !data || own });
}

export async function POST(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "handle:batch"), 20, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  let candidates: unknown;
  try {
    ({ candidates } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!Array.isArray(candidates)) return NextResponse.json({ error: "candidates must be an array" }, { status: 400 });

  const cleaned = [...new Set(candidates.filter((c): c is string => typeof c === "string").map(normalize))]
    .filter(usable)
    .slice(0, 12);
  if (cleaned.length === 0) return NextResponse.json({ available: [] });

  const supabase = getSupabaseServerClient();
  const { data } = await supabase.from("users").select("handle").in("handle", cleaned);
  const taken = new Set((data ?? []).map((r) => String(r.handle).toLowerCase()));
  return NextResponse.json({ available: cleaned.filter((c) => !taken.has(c)) });
}

export async function PUT(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "handle:set"), 10, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let raw: unknown;
  try {
    ({ handle: raw } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (typeof raw !== "string") return NextResponse.json({ error: "handle required" }, { status: 400 });
  const handle = normalize(raw);
  if (!usable(handle)) {
    return NextResponse.json({ error: "3–20 characters: letters, numbers or _" }, { status: 400 });
  }

  // A name Enki picked (handle_auto, SQL 46) is replaced once, like none at all; until SQL 46 runs the column is
  // missing and a name that is set stays set.
  const mine = (cols: string) =>
    supabase.from("users").select(cols).eq("id", userId).maybeSingle<{ handle: string | null; handle_auto?: boolean }>();
  let read = await mine("handle, handle_auto");
  if (read.error) read = await mine("handle");
  const me = read.data;
  if (!me) return NextResponse.json({ error: "No user for session" }, { status: 404 });
  const auto = me.handle_auto === true;
  if (me.handle && !auto) return NextResponse.json({ error: "You already have a username" }, { status: 409 });

  // Only while the account is still as read (no name, or Enki's), so two saves at once cannot both land. The owner's
  // choice clears handle_auto, keeping Enki's name too (SQL 46's trigger only sees a change of the name).
  const set = supabase.from("users").update(auto ? { handle, handle_auto: false } : { handle }).eq("id", userId);
  const { error } = await (auto ? set.eq("handle_auto", true) : set.is("handle", null));
  if (error) {
    const dup = error.code === "23505";
    return NextResponse.json(
      { error: dup ? "That name was just taken — pick another" : "Could not save" },
      { status: dup ? 409 : 500 }
    );
  }
  return NextResponse.json({ handle });
}

/** PATCH { hideFromLeaderboard } → user preference flags. */
export async function PATCH(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "user:prefs"), 20, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { hideFromLeaderboard?: unknown; adultConfirmed?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const update: { hide_from_leaderboard?: boolean; adult_confirmed_at?: string | null } = {};
  if (typeof body.hideFromLeaderboard === "boolean") update.hide_from_leaderboard = body.hideFromLeaderboard;
  // The user's own word that they are 18 or older (Kev, 2026-10-03), kept
  // with its time. Withdrawing it hides 18+ again.
  if (typeof body.adultConfirmed === "boolean") update.adult_confirmed_at = body.adultConfirmed ? new Date().toISOString() : null;
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "hideFromLeaderboard or adultConfirmed must be a boolean" }, { status: 400 });
  }

  const { error } = await supabase.from("users").update(update).eq("id", userId);
  if (error) return NextResponse.json({ error: "Could not save" }, { status: 500 });
  return NextResponse.json({
    ...("hide_from_leaderboard" in update && { hideFromLeaderboard: update.hide_from_leaderboard }),
    ...("adult_confirmed_at" in update && { adultConfirmed: update.adult_confirmed_at !== null }),
  });
}
