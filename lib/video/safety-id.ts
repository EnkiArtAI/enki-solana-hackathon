import { createHmac } from "node:crypto";

/**
 * The per-user hash an operator's safety field takes (Kev, 2026-10-30: "die pflichten sollten wir alle einbauen"): 64 hex
 * characters, the same for one person and unreadable without AUTH_PEPPER, so an operator can name a repeat offender and never
 * who it is. Null without the pepper: nothing is submitted then.
 */
export function endUserHash(userId: string): string | null {
  const pepper = process.env.AUTH_PEPPER;
  return pepper ? createHmac("sha256", pepper).update(userId).digest("hex") : null;
}
