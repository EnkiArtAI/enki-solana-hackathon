"use client";

import { useEffect, useState } from "react";
import { sessionAuthHeaders } from "@/lib/session-headers";

// Shared DM store, mirroring useNotifications: one module-level cache + one
// poll timer no matter how many components subscribe (sidebar badge + panel).
// Same rationale as notifications: our custom session model doesn't fit
// Supabase Realtime + RLS, so it's polling + focus refresh.

export type DmPeer = { id: string; handle: string; name: string | null; avatarUrl: string | null };
export type DmLast = { body: string | null; hasImage: boolean; mine: boolean; at: string };
/** accepted false: the other member wrote and I have not taken it in, a message request (DEC-513). */
export type DmThread = { id: string; peer: DmPeer; last: DmLast | null; unread: number; accepted?: boolean };

type MsgState = { threads: DmThread[]; unreadTotal: number; loaded: boolean };

let cache: MsgState = { threads: [], unreadTotal: 0, loaded: false };
let inflight = false;
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
// Bumped when the cache takes a change the server already made (acceptThread, deleteThread): a poll that read before
// it is dropped.
let version = 0;

const POLL_MS = 15_000;
const EVENT = "enki-messages";
const emit = () => window.dispatchEvent(new Event(EVENT));

async function fetchNow() {
  if (inflight) return;
  inflight = true;
  const started = version;
  try {
    const headers = sessionAuthHeaders();
    if (Object.keys(headers).length === 0) {
      cache = { threads: [], unreadTotal: 0, loaded: true };
      emit();
      return;
    }
    const res = await fetch("/api/messages", { headers });
    if (res.ok) {
      const data = (await res.json()) as { threads?: DmThread[]; unreadTotal?: number };
      if (started !== version) return; // the next poll brings the rest
      cache = { threads: data.threads ?? [], unreadTotal: data.unreadTotal ?? 0, loaded: true };
      emit();
    }
  } catch {
    // keep the cached view; the next poll reconciles
  } finally {
    inflight = false;
  }
}

export function refreshMessages() {
  void fetchNow();
}

/**
 * Optimistically zero a thread's unread count and move the server cursor.
 * Pass `upTo` (the max created_at actually displayed, DB time) so clock skew
 * and the fetch→mark gap can't mark unseen messages read; server is forward-only.
 */
export function markThreadRead(threadId: string, upTo?: string | null) {
  const t = cache.threads.find((x) => x.id === threadId);
  if (t && t.unread > 0) {
    cache = {
      ...cache,
      threads: cache.threads.map((x) => (x.id === threadId ? { ...x, unread: 0 } : x)),
      unreadTotal: Math.max(0, cache.unreadTotal - t.unread),
    };
    emit();
  }
  void fetch("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
    body: JSON.stringify({ threadId, markRead: true, upTo: upTo ?? null }),
  }).catch(() => {}); // failures are fine — the next poll reconciles
}

/** Take a message request in (DEC-513): once the server says yes, the store moves it to the messages. Null, or what went wrong. */
export async function acceptThread(threadId: string): Promise<string | null> {
  try {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ threadId, accept: true }),
    });
    if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not accept the message.";
  } catch {
    return "Could not accept the message. Check your connection.";
  }
  version++;
  cache = { ...cache, threads: cache.threads.map((x) => (x.id === threadId ? { ...x, accepted: true } : x)) };
  emit();
  return null;
}

/**
 * Delete a message request for me, up to `upTo` (the newest message shown): once the server says yes, the store drops
 * it and its unread. A new message brings it back as a request. Null, or what went wrong.
 */
export async function deleteThread(threadId: string, upTo?: string): Promise<string | null> {
  try {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ threadId, delete: true, upTo }),
    });
    if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not delete the request.";
  } catch {
    return "Could not delete the request. Check your connection.";
  }
  const gone = cache.threads.find((x) => x.id === threadId);
  version++;
  cache = {
    ...cache,
    threads: cache.threads.filter((x) => x.id !== threadId),
    unreadTotal: cache.unreadTotal - (gone?.unread ?? 0),
  };
  emit();
  return null;
}

export function useMessages(enabled = true) {
  const [state, setState] = useState<MsgState>(cache);

  useEffect(() => {
    if (!enabled) return;
    const sync = () => setState({ ...cache });
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void fetchNow();
    };
    window.addEventListener(EVENT, sync);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    if (!cache.loaded) void fetchNow();
    else setState({ ...cache });

    subscribers++;
    if (!timer) timer = setInterval(fetchNow, POLL_MS);

    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      subscribers--;
      if (subscribers <= 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [enabled]);

  return state;
}
