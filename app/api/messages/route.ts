import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { DM_MAX_BODY, UUID_RE, acceptColFor, acceptOnSend, clearColFor, loadThreadFor, readColFor, shapeMessages, type DmMessageRow } from "@/lib/dm";

// Direct messages.
// GET            → conversation overview: { threads, unreadTotal, requests }
// GET ?thread=id[&after=iso] → messages of one thread (ascending)
// POST { to }                → open/find the thread with a user
// POST { threadId, body }    → send a text message
// POST { threadId, markRead } → move my read cursor to now
// POST { threadId, accept }   → take a message request in (DEC-513)
// POST { threadId, delete, upTo } → delete a message request for me, up to the newest message I was shown

type OverviewRow = {
  thread_id: string; peer_id: string; peer_handle: string; peer_name: string | null;
  peer_avatar: string | null; last_at: string | null; last_body: string | null;
  last_sender: string | null; last_has_image: boolean | null; unread: number | string | null;
  /** Have I taken it in (SQL 42); missing before it runs, read as yes. */
  accepted?: boolean | null;
};

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const threadId = req.nextUrl.searchParams.get("thread");
  if (threadId) {
    if (!UUID_RE.test(threadId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const thread = await loadThreadFor(supabase, threadId, userId);
    if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const after = req.nextUrl.searchParams.get("after");
    const incremental = typeof after === "string" && !Number.isNaN(Date.parse(after));
    let q = supabase
      .from("dm_messages")
      .select("id, sender_id, body, image_path, created_at")
      .eq("thread_id", threadId);
    // What I deleted stays gone from my view (SQL 47; before it the column is missing and nothing is left out).
    const cleared = thread[clearColFor(thread, userId)];
    if (cleared) q = q.gt("created_at", cleared);
    q = incremental
      ? q.gt("created_at", after as string).order("created_at", { ascending: true }).limit(200)
      : q.order("created_at", { ascending: false }).limit(100);
    const { data, error } = await q;
    // Real error, not "empty thread" — the client must NOT render an empty
    // state or mark anything read off the back of this.
    if (error) return NextResponse.json({ error: "Could not load messages" }, { status: 500 });
    const rows = (incremental ? (data ?? []) : [...(data ?? [])].reverse()) as DmMessageRow[];
    return NextResponse.json({ messages: await shapeMessages(supabase, rows, userId) });
  }

  const { data, error } = await supabase.rpc("dm_overview", { p_user: userId });
  // Pre-migration graceful degrade: an empty inbox beats a broken shell.
  if (error) return NextResponse.json({ threads: [], unreadTotal: 0, requests: 0 });
  const rows = ((data ?? []) as OverviewRow[])
    // A request only once there is something in it: a conversation someone opened and never wrote in is not shown.
    .filter((r) => r.accepted !== false || r.last_at);
  const threads = rows.map((r) => ({
    id: r.thread_id,
    peer: { id: r.peer_id, handle: r.peer_handle, name: r.peer_name, avatarUrl: r.peer_avatar },
    last: r.last_at
      ? { body: r.last_body, hasImage: !!r.last_has_image, mine: r.last_sender === userId, at: r.last_at }
      : null,
    unread: Number(r.unread ?? 0),
    accepted: r.accepted !== false,
  }));
  const unreadTotal = threads.reduce((n, t) => n + t.unread, 0);
  return NextResponse.json({ threads, unreadTotal, requests: threads.filter((t) => !t.accepted).length });
}

export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { to?: string; threadId?: string; body?: string; markRead?: boolean; upTo?: string; accept?: boolean; delete?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // ── Open (or find) the thread with another user ──
  if (typeof body.to === "string") {
    const limit = checkRequestRateLimit(rateLimitKey(req, "dm:open", userId), 10, 60_000);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const to = body.to.toLowerCase();
    if (!UUID_RE.test(to)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (to === userId.toLowerCase()) return NextResponse.json({ error: "That's you" }, { status: 400 });

    const { data: peer } = await supabase
      .from("users")
      .select("id, handle, display_name, avatar_url")
      .eq("id", to)
      .is("deleted_at", null)
      .maybeSingle();
    if (!peer?.handle) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Lowercased uuid strings sort exactly like Postgres uuids, so this pair is
    // canonical (user_a < user_b) and unique per pair.
    const [a, b] = [userId.toLowerCase(), to].sort();
    const ins = await supabase
      .from("dm_threads")
      .upsert({ user_a: a, user_b: b }, { onConflict: "user_a,user_b", ignoreDuplicates: true })
      .select("id")
      .maybeSingle();
    let threadId = ins.data?.id ?? null;
    if (!threadId) {
      const { data: found } = await supabase
        .from("dm_threads").select("id").eq("user_a", a).eq("user_b", b).maybeSingle();
      threadId = found?.id ?? null;
    }
    if (!threadId) return NextResponse.json({ error: "Could not open the conversation" }, { status: 500 });

    return NextResponse.json({
      threadId,
      peer: { id: peer.id, handle: peer.handle, name: peer.display_name, avatarUrl: peer.avatar_url },
    });
  }

  const threadId = body.threadId ?? "";
  if (!UUID_RE.test(threadId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const thread = await loadThreadFor(supabase, threadId, userId);
  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ── Move my read cursor ──
  if (body.markRead === true) {
    // Prefer the client's max displayed created_at (DB time) over our wall
    // clock — avoids app↔DB clock skew and never marks unfetched messages.
    const upTo = typeof body.upTo === "string" && !Number.isNaN(Date.parse(body.upTo))
      ? body.upTo
      : new Date().toISOString();
    const col = readColFor(thread, userId);
    // Forward-only: a stale client must not rewind the cursor.
    await supabase
      .from("dm_threads")
      .update({ [col]: upTo })
      .eq("id", threadId)
      .or(`${col}.is.null,${col}.lt.${upTo}`);
    return NextResponse.json({ ok: true });
  }

  // ── Take a message request in: it moves to my messages and I can answer (DEC-513) ──
  if (body.accept === true) {
    const col = acceptColFor(thread, userId);
    const { error } = await supabase.from("dm_threads").update({ [col]: new Date().toISOString() }).eq("id", threadId).is(col, null);
    if (error) return NextResponse.json({ error: "Message requests are not available yet" }, { status: 503 });
    return NextResponse.json({ ok: true });
  }

  // ── Delete a request for me (Kev, 2026-10-29: "just add a delete button, no decline button") ──
  // What was written up to upTo, the newest message I was shown, leaves my view only; a new message brings it back.
  if (body.delete === true) {
    const upTo = body.upTo;
    if (typeof upTo !== "string" || !(Date.parse(upTo) <= Date.now())) return NextResponse.json({ error: "Bad request" }, { status: 400 });
    const col = clearColFor(thread, userId);
    // Forward-only, like the read cursor: a stale tab must not bring deleted messages back.
    const { error } = await supabase.from("dm_threads").update({ [col]: upTo }).eq("id", threadId).or(`${col}.is.null,${col}.lt.${upTo}`);
    if (error) return NextResponse.json({ error: "Deleting requests is not available yet" }, { status: 503 });
    return NextResponse.json({ ok: true });
  }

  // ── Send a text message ──
  const limit = checkRequestRateLimit(rateLimitKey(req, "dm:send", userId), 30, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return NextResponse.json({ error: "Message is empty" }, { status: 400 });
  if (text.length > DM_MAX_BODY) {
    return NextResponse.json({ error: `Keep it under ${DM_MAX_BODY} characters` }, { status: 400 });
  }

  const { data: msg, error } = await supabase
    .from("dm_messages")
    .insert({ thread_id: threadId, sender_id: userId, body: text })
    .select("id, sender_id, body, image_path, created_at")
    .single();
  if (error || !msg) return NextResponse.json({ error: "Could not send" }, { status: 500 });

  // Sending implies I've seen the thread — bump both cursors in one update.
  await supabase
    .from("dm_threads")
    .update({ last_message_at: msg.created_at, [readColFor(thread, userId)]: msg.created_at })
    .eq("id", threadId);
  await acceptOnSend(supabase, thread, userId, msg.created_at);

  return NextResponse.json(
    { message: (await shapeMessages(supabase, [msg as DmMessageRow], userId))[0] },
    { status: 201 },
  );
}
