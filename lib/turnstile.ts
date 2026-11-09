/**
 * Cloudflare Turnstile on the free render itself, checked by the server in the route: a gate on the site would not stop a
 * bot, which calls the API directly (Kev, 2026-10-30). A token is good once, so a retry brings a new one.
 *
 * Free costs money, so on every built deployment no check means no free render, a preview's and one with VERCEL_ENV unset
 * included (they can share the live database); only next dev and the tests skip it, said once.
 */
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5_000;
// Cloudflare's own limit for a token.
const TOKEN_MAX = 2048;
// These say the check itself is broken, not that the visitor failed it.
const OUR_SIDE = /^(internal-error|missing-input-secret|invalid-input-secret)$/;

export const FREE_RENDERS_PAUSED = "Free renders are paused right now. Nothing was generated.";
export const HUMAN_CHECK_REFUSED = "The human check did not pass. Try again. Nothing was generated.";

export type TurnstileVerdict = "pass" | "refused" | "paused";

let warned = false;

function noCheck(why: string): TurnstileVerdict {
  if (process.env.NODE_ENV === "production") {
    console.error(`[turnstile] ${why}: free renders are paused`);
    return "paused";
  }
  if (!warned) {
    warned = true;
    console.warn(`[turnstile] ${why}: the check is skipped outside a production build`);
  }
  return "pass";
}

export async function verifyTurnstile(token: unknown): Promise<TurnstileVerdict> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return noCheck("TURNSTILE_SECRET_KEY is not set");
  if (typeof token !== "string" || !token || token.length > TOKEN_MAX) return "refused";
  let answer: { success?: unknown; "error-codes"?: unknown } | null;
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (res.status >= 500) return noCheck(`siteverify answered ${res.status}`);
    answer = await res.json();
  } catch {
    return noCheck("siteverify did not answer");
  }
  if (answer?.success === true) return "pass";
  if (answer?.success !== false) return noCheck("siteverify answered something else");
  const codes = Array.isArray(answer["error-codes"]) ? answer["error-codes"].map(String) : [];
  if (codes.some((code) => OUR_SIDE.test(code))) return noCheck(`siteverify says ${codes.join(", ")}`);
  return "refused";
}
