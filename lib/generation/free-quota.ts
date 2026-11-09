import type { SupabaseClient } from "@supabase/supabase-js";
import { isDbUnreachable, DbUnreachableError } from "@/lib/db-error";

/**
 * Two free baseline-model images per account, ever (Kev, 2026-10-31: "mach bitte einfach 2 bilder gratis pro account for
 * ever. danach ist auffüllen angesagt."; it was one per UTC day). Premium models remain paid. SQL 57 holds the count.
 */
export const FREE_GENERATIONS_PER_ACCOUNT = 2;

/**
 * The free host (Pollinations) renders for admins only, to test with (Kev, 2026-10-26: "damit nur admins das vllt iwo
 * nutzen können zu testzwecken"; 2026-10-27: "pollination ja nur für admins freigeben"). The Image View offers it to
 * admins alone (lib/ui/image-view/models forViewer); this is the server's half, for a request sent past it.
 */
export async function mayUseFreeHost(supabase: SupabaseClient, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await supabase.from("users").select("role").eq("id", userId).maybeSingle();
  if (isDbUnreachable(error)) throw new DbUnreachableError();
  if (error) throw new Error("role lookup failed");
  return data?.role === "admin";
}

export interface FreeQuota {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
  /** Nothing resets: the allowance is for the account's lifetime (null). */
  resetsAt: null;
}

/** Reads the account's claims, rather than deletable image history. */
export async function freeQuotaFor(
  supabase: SupabaseClient,
  userId: string,
): Promise<FreeQuota> {
  const { data, error } = await supabase.rpc("free_generation_quota", { p_user_id: userId });
  if (isDbUnreachable(error)) throw new DbUnreachableError();
  if (error) throw new Error("free quota lookup failed");
  const row = Array.isArray(data) && data.length === 1 ? data[0] : null;
  // Missing migration or a malformed reply must not grant a free generation.
  if (!row || !Number.isSafeInteger(row.used) || row.used < 0
      || row.limit !== FREE_GENERATIONS_PER_ACCOUNT
      || row.remaining !== Math.max(0, row.limit - row.used)
      || row.exhausted !== (row.used >= row.limit)
      || row.resets_at !== null) {
    throw new Error("free quota lookup failed");
  }
  return { used: row.used, limit: row.limit, remaining: row.remaining,
    exhausted: row.exhausted, resetsAt: null };
}

export type FreeDecision =
  | { allowed: true; claimId: string }
  | { allowed: false; reason: "sign-in" | "quota"; quota: FreeQuota | null };

/**
 * Claims before the provider is called, under the database's per-account lock.
 * Every account is capped, including team roles. Failed renders release the
 * claim; delivered images keep it even if their history is deleted later.
 */
export async function freeGenerationDecision(
  supabase: SupabaseClient,
  userId: string | null,
): Promise<FreeDecision> {
  if (!userId) return { allowed: false, reason: "sign-in", quota: null };
  const { data: claimId, error } = await supabase.rpc("claim_free_generation", {
    p_user_id: userId,
    p_limit: FREE_GENERATIONS_PER_ACCOUNT,
  });
  if (isDbUnreachable(error)) throw new DbUnreachableError();
  if (error) throw new Error("free claim failed");
  if (claimId !== null && (typeof claimId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claimId))) {
    throw new Error("free claim failed");
  }
  return claimId
    ? { allowed: true, claimId }
    : { allowed: false, reason: "quota", quota: await freeQuotaFor(supabase, userId) };
}

/** A failed render gives its claim back; the allowance counts delivered images. */
export async function releaseFreeClaim(supabase: SupabaseClient | null, claimId: string | null): Promise<void> {
  if (!supabase || !claimId) return;
  const { error } = await supabase.from("free_generation_claims").delete().eq("id", claimId);
  if (error) console.warn("[free-quota] claim not given back");
}
