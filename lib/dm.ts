import type { getSupabaseServerClient } from "@/lib/supabaseServer";

type Supabase = ReturnType<typeof getSupabaseServerClient>;

// DM images live in a PRIVATE bucket; clients only ever see signed URLs.
// Signed on the initial thread load only (incremental polls sign just new
// rows), so the TTL is generous; the client force-reloads once on img error.
export const DM_BUCKET = "dm";
export const DM_SIGN_TTL = 86_400; // seconds
export const DM_MAX_BODY = 2000; // mirrors the dm_messages_body_len CHECK

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DmThreadRow = {
  id: string;
  user_a: string;
  user_b: string;
  a_last_read_at: string | null;
  b_last_read_at: string | null;
  /** Up to when each member deleted the conversation for themselves (SQL 47); missing before it runs. */
  a_cleared_at?: string | null;
  b_cleared_at?: string | null;
};

export type DmMessageRow = {
  id: string;
  sender_id: string;
  body: string | null;
  image_path: string | null;
  created_at: string;
};

/** Load a thread and verify membership; null = missing or not yours (both 404). */
export async function loadThreadFor(supabase: Supabase, threadId: string, userId: string): Promise<DmThreadRow | null> {
  // Every column: the cleared times are read once SQL 47 adds them, and naming them before would fail the whole read.
  const { data } = await supabase
    .from("dm_threads")
    .select("*")
    .eq("id", threadId)
    .maybeSingle();
  if (!data || (data.user_a !== userId && data.user_b !== userId)) return null;
  return data as DmThreadRow;
}

/** The read-cursor column belonging to this member. */
export function readColFor(thread: DmThreadRow, userId: string): "a_last_read_at" | "b_last_read_at" {
  return thread.user_a === userId ? "a_last_read_at" : "b_last_read_at";
}

/** The accept column belonging to this member (migrations/2026-10-29-dm-requests.sql). */
export function acceptColFor(thread: DmThreadRow, userId: string): "a_accepted_at" | "b_accepted_at" {
  return thread.user_a === userId ? "a_accepted_at" : "b_accepted_at";
}

/** The deleted-up-to column belonging to this member (migrations/2026-10-29-dm-delete-follow.sql). */
export function clearColFor(thread: DmThreadRow, userId: string): "a_cleared_at" | "b_cleared_at" {
  return thread.user_a === userId ? "a_cleared_at" : "b_cleared_at";
}

/**
 * Writing in a conversation takes it in (DEC-513): the sender's first message opens it on their side, and a request
 * answered from a profile is accepted. Before SQL 42 the column is missing and the update fails quietly.
 */
export async function acceptOnSend(supabase: Supabase, thread: DmThreadRow, userId: string, at: string): Promise<void> {
  const col = acceptColFor(thread, userId);
  await supabase.from("dm_threads").update({ [col]: at }).eq("id", thread.id).is(col, null);
}

/** Shape DB rows for the client, signing image paths in one batch. */
export async function shapeMessages(supabase: Supabase, rows: DmMessageRow[], userId: string) {
  const paths = rows.filter((r) => r.image_path).map((r) => r.image_path as string);
  const signed = new Map<string, string>();
  if (paths.length) {
    const { data } = await supabase.storage.from(DM_BUCKET).createSignedUrls(paths, DM_SIGN_TTL);
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
  }
  return rows.map((r) => ({
    id: r.id,
    mine: r.sender_id === userId,
    body: r.body,
    imageUrl: r.image_path ? (signed.get(r.image_path) ?? null) : null,
    at: r.created_at,
  }));
}
