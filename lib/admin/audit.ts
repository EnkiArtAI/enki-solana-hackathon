import { createHmac } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getClientIp, hashIp } from "@/lib/ip-hash";

/**
 * The admin log (Kev, 2026-10-17): one row per admin or mod action that went
 * through, written by POST /api/admin after the action (migration
 * 2026-10-17-admin-actions.sql, append-only). Kept: who, their role,
 * "<resource>.<action>", the target, whitelisted settings and the outcome.
 * Never free text (reasons, violations, notes), emails, prompt text or raw
 * IPs: those stay on the target rows, and this log cannot be erased. One row
 * did not go through: hunter.knownLink, a link Enki knew already, which the
 * hunter's log reads back; the admin log's own tab leaves it out.
 */
export interface AdminActor { userId: string; role: string }

/** Settings an action carries that say what it did; nothing else of the body is kept. */
const SETTINGS = ["status", "severity", "days", "permanent", "vote", "kind", "enabled", "quorum", "ttlDays", "maxConcurrentPerUser", "what", "signature"] as const;
/** What the answer says happened. */
const OUTCOME = ["executed", "status", "published", "outcome", "mailed", "added", "removed", "failed", "handle", "cleared", "revoked", "unlisted", "prompts"] as const;

const scalar = (v: unknown): v is string | number | boolean | null =>
  v === null || typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 200);

/** Arrays become their length: a list of ids or failures is counted, not copied. */
function pick(from: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = from[k];
    if (Array.isArray(v)) out[k] = v.length;
    else if (scalar(v)) out[k] = v;
  }
  return out;
}

/** An email or wallet address, kept only as a keyed hash: matchable, never readable. */
function keyed(value: string): string | null {
  const pepper = process.env.AUTH_PEPPER;
  return pepper ? `h:${createHmac("sha256", pepper).update(`admin-target:${value.trim().toLowerCase()}`).digest("hex").slice(0, 32)}` : null;
}

/** What the action was on: ids, a user, a public handle, or a hashed email or address. */
export function targetOf(body: Record<string, unknown>): string | null {
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length) return ids.join(",").slice(0, 2000);
  for (const k of ["id", "userId", "handle"] as const) if (typeof body[k] === "string" && body[k]) return String(body[k]).slice(0, 200);
  for (const k of ["email", "address"] as const) if (typeof body[k] === "string" && body[k]) return keyed(String(body[k]));
  return null;
}

export async function recordAdminAction(
  supabase: SupabaseClient,
  req: { headers: { get(name: string): string | null } },
  actor: AdminActor,
  body: Record<string, unknown>,
  res: Response,
): Promise<void> {
  try {
    const answer = (await res.clone().json().catch(() => ({}))) as Record<string, unknown>;
    const config = body.config && typeof body.config === "object" ? pick(body.config as Record<string, unknown>, Object.keys(body.config as object)) : null;
    const { error } = await supabase.from("admin_actions").insert({
      actor_id: actor.userId,
      actor_role: actor.role,
      action: `${String(body.resource ?? "?")}.${String(body.action ?? "?")}`.slice(0, 80),
      target: targetOf(body),
      detail: { ...pick(body, SETTINGS), ...(config ? { config } : {}), outcome: { httpStatus: res.status, ...pick(answer, OUTCOME) } },
      ip_hash: hashIp(getClientIp(req)),
    });
    // The action stands either way; a missing log row must be visible, not silent.
    if (error) console.error("[admin-log] not recorded:", error.message);
  } catch (e) {
    console.error("[admin-log] not recorded:", e instanceof Error ? e.message : e);
  }
}
