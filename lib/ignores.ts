import type { SupabaseClient } from "@supabase/supabase-js";
import { DbUnreachableError, isDbUnreachable } from "@/lib/db-error";

/**
 * Ignoring people (Kev, 2026-10-29: "i also want an 'ignore' function so that i dont see the prompts and images of the
 * person anymore, but can still stumble over his creations later through comments or so ... no ban function";
 * migrations/2026-10-29-user-ignores.sql). The feed, search and a prompt's images leave out whom the viewer ignores;
 * comments, notifications, the Hall of Fame, profiles and direct links do not. Nobody is told.
 */

/** As many as one account ignores, held by SQL 48's trigger: each browse read carries the whole list in its URL. */
export const MAX_IGNORED = 150;

export const IGNORES_NOT_READY = "Ignoring is not available yet.";

/** The table is not there yet (SQL 48 not run). */
export const ignoresNotReady = (e: { code?: string } | null) => e?.code === "PGRST205" || e?.code === "42P01";

/**
 * Whom this viewer ignores. A guest ignores nobody and costs no read; a read that fails ignores nobody, so browsing
 * stays as it was (before SQL 48 every read fails); a database that cannot be reached throws DbUnreachableError, so
 * the route answers 503.
 */
export async function ignoredIds(supabase: SupabaseClient, viewerId: string | null): Promise<string[]> {
  if (!viewerId) return [];
  const { data, error } = await supabase.from("user_ignores").select("ignored_id").eq("user_id", viewerId).limit(MAX_IGNORED);
  if (isDbUnreachable(error)) throw new DbUnreachableError();
  // A failed read has no data: nobody.
  return (data ?? []).map((r) => String(r.ignored_id));
}

/** Leaves out the rows whose `column` is someone ignored; the read is unchanged when nobody is. */
export function withoutIgnored<Q extends { not(column: string, operator: string, value: unknown): Q }>(query: Q, column: string, ids: string[]): Q {
  return ids.length ? query.not(column, "in", `(${ids.join(",")})`) : query;
}
