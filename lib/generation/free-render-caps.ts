import { isIPv6 } from "node:net";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDbUnreachable, DbUnreachableError } from "@/lib/db-error";
import { hashIp } from "@/lib/ip-hash";
import { sendMail } from "@/lib/mailer";
import { getClientIp } from "@/lib/rate-limit";

/**
 * The daily caps on free renders (Kev, 2026-10-30: "only humans are allowed to have 1 for free"; a founder lost $4k to
 * bots farming free credits). All accounts together, and one per address, per UTC day, atomically in SQL 63, before any
 * model call and before the account's own claim. Every account is capped, team roles too.
 */
const DEFAULT_RENDERS_PER_DAY = 200;
const RENDERS_PER_IP_PER_DAY = 1;

export const FREE_RENDERS_USED_UP = "Free renders are used up for today. Try again tomorrow or choose a paid model. Nothing was generated.";
export const FREE_RENDER_IP_USED = "This network has had its free render today. Try again tomorrow or choose a paid model. Nothing was generated.";

function rendersPerDay(): number {
  const set = process.env.FREE_RENDERS_PER_DAY?.trim();
  const n = set ? Number(set) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_RENDERS_PER_DAY;
}

export type FreeRenderCaps =
  | { allowed: true; claimId: string | null }
  | { allowed: false; reason: "day" | "ip"; firstRefusal: boolean };

let warnedMissing = false;

/**
 * What "one network" is: an IPv6 address's /64, since one host may rotate through all of it, written one way (the URL
 * parser's canonical form), and a v4-mapped address as the plain IPv4 it is. Anything else stays as it came.
 */
function networkOf(ip: string): string {
  const address = ip.split("%")[0];
  if (!isIPv6(address)) return ip;
  const [left, right = ""] = new URL(`http://[${address}]`).hostname.slice(1, -1).split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  if (groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") {
    const [high, low] = [parseInt(groups[6], 16), parseInt(groups[7], 16)];
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return groups.slice(0, 4).join(":");
}

/**
 * The address the rate limiter trusts (x-real-ip, else the edge's right-most hop), hashed as lib/ip-hash hashes it:
 * lib/ip-hash's own reader takes the left-most x-forwarded-for entry, which a caller writes itself. An address that
 * cannot be told, or a missing pepper, counts under one shared bucket and bypasses nothing.
 */
export const ipBucket = (request: NextRequest) => hashIp(networkOf(getClientIp(request))) ?? "unknown";

/** Before SQL 63 there is no function: today's limits stand, said once, and nothing is refused for it. */
export async function claimFreeRenderCaps(supabase: SupabaseClient, request: NextRequest): Promise<FreeRenderCaps> {
  const { data, error } = await supabase.rpc("claim_free_render", {
    p_ip_bucket: ipBucket(request),
    p_day_limit: rendersPerDay(),
    p_ip_limit: RENDERS_PER_IP_PER_DAY,
  });
  if (isDbUnreachable(error)) throw new DbUnreachableError();
  if (error?.code === "PGRST202" || error?.code === "42883") {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn("[free-render-caps] SQL 63 has not run: no daily caps on free renders");
    }
    return { allowed: true, claimId: null };
  }
  if (error) throw new Error("free render caps failed");
  const row = Array.isArray(data) && data.length === 1 ? data[0] : null;
  if (typeof row?.claim_id === "string") return { allowed: true, claimId: row.claim_id };
  // A malformed reply must not grant a free render.
  if (row?.refused === "day" || row?.refused === "ip") {
    return { allowed: false, reason: row.refused, firstRefusal: row.first_refusal === true };
  }
  throw new Error("free render caps failed");
}

/** Every answer that delivered no image gives the day's place back. */
export async function releaseFreeRenderCaps(supabase: SupabaseClient | null, claimId: string | null): Promise<void> {
  if (!supabase || !claimId) return;
  const { error } = await supabase.from("free_render_claims").delete().eq("id", claimId);
  if (error) console.warn("[free-render-caps] place not given back");
}

/**
 * One mail a day, on the day's first refusal (SQL 63), to the outage mails' recipients. A lost mail is not sent again. The
 * cap was reached, not spent: renders still running hold places, and a failed one gives its place back.
 */
export async function tellFreeRendersFull(): Promise<void> {
  console.warn("[free-render-caps] the daily cap on free renders was reached");
  const to = (process.env.OPS_ALERT_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  await Promise.all(to.map((address) => sendMail({
    to: address,
    subject: "Enki: the daily cap on free renders was reached",
    text: `The cap of ${rendersPerDay()} free renders a UTC day was reached at ${new Date().toISOString()}. Requests are refused while it stands; the places of renders that fail come back, so some may still pass. FREE_RENDERS_PER_DAY sets the number. If this comes often, it is time for a stronger human proof (public.free_render_full_days lists the days).`,
  })));
}
