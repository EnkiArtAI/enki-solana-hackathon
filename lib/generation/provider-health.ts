/**
 * Automatic failover between routes.
 *
 * The cheapest route is only the best route while it answers. This watches
 * each route, drops to the fallback when one stops answering, and comes back
 * on its own — so a buyer gets the good price when it is available and an
 * image regardless.
 *
 * ── The unit is the ROUTE, not the provider ─────────────────────────────
 * An aggregator hosts each model on a different upstream. AceData runs
 * nano-banana-pro through Google's own channel and gpt-image-2 through a
 * reverse channel their own docs distinguish from the "official, stable and
 * compliant" one. Those fail independently, so health is keyed per
 * model+provider row.
 *
 * The exception is failures that are statements about the ACCOUNT rather than
 * the model — a dead key, an empty balance, an unreachable host. Those open
 * every route of that provider at once, because rediscovering them model by
 * model costs a real customer a real generation each time.
 *
 * ── Why the probe is free, and why that changes the design ──────────────
 * An x402 provider quotes its price with an HTTP 402 before any payment
 * exists. That handshake runs no inference and settles nothing, so it is a
 * perfect liveness check: it proves the endpoint answers AND returns the
 * current price, for nothing. Recovery does not have to be time-based
 * guesswork — the breaker can ask.
 *
 * ── The failure that must NOT open the breaker ──────────────────────────
 * A prompt refused for content is the provider working correctly. Counting it
 * would let one policy-violating prompt disable a model for every user.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail } from "@/lib/mailer";

/** The keys each paid host needs, either one (ENV-01). Pollinations needs none. */
const PROVIDER_KEYS: Record<string, string[]> = {
  gemini: ["GOOGLE_GEMINI_API_KEY", "GEMINI_API_KEY"],
  openai: ["OPENAI_API_KEYS", "OPENAI_API_KEY"],
  wavespeed: ["WAVESPEED_API_KEY"],
};
/** How a host is named to a buyer, never by its key. */
export const PROVIDER_NAME: Record<string, string> = { gemini: "Google Gemini", openai: "OpenAI", wavespeed: "WaveSpeed" };

/**
 * Whether this environment has no key for a host (ENV-01). Read the way the
 * services read it (OPENAI_API_KEYS: the first of a comma list). A missing
 * key never opens a breaker, so routing skips the host instead, and a route
 * left with none says so before any money moves.
 */
export function providerKeyMissing(provider: string): boolean {
  const keys = PROVIDER_KEYS[provider];
  return Boolean(keys) && !keys.some((k) => process.env[k]?.split(",")[0]?.trim());
}

/** Consecutive infrastructure failures before a route's breaker opens. */
export const FAILURE_THRESHOLD = 3;

/** While open, probe at most this often — a dead host must not be hammered. */
export const PROBE_COOLDOWN_MS = 30_000;

/** A provider that flaps (half-open retries every 30 s) mails at most this often, however many of its routes flap. */
const MAIL_EVERY_MS = 60 * 60_000;

export type FailureKind = "infrastructure" | "content" | "request" | "config";
export type FailureScope = "route" | "provider";

export interface Classification {
  kind: FailureKind;
  /**
   * "provider" means every route of this provider is affected. Those are
   * unambiguous statements about the account, so they open immediately rather
   * than counting to the threshold: a revoked key does not get better on the
   * second attempt.
   */
  scope: FailureScope;
}

/**
 * What a failure says about the route, and how widely it applies.
 *
 * Getting this wrong is expensive in both directions: too broad and a bad
 * prompt takes a model down for everyone, too narrow and we keep routing
 * paying customers into a dead host.
 */
export function classifyFailure(message: string, status?: number): Classification {
  const m = message.toLowerCase();

  // This deployment has no key for the provider ("OPENAI_API_KEY is not set").
  // The host is fine, and breaker state lives in a database other deployments
  // share: a developer environment without the key must never take
  // production's routes down (ENV-01).
  if (/ is not set\b|not configured/.test(m)) return { kind: "config", scope: "route" };

  // Content refusals — the provider answered, and the answer was no.
  if (
    /content[_ ]policy|safety|moderation|blocked|prohibited|nsfw|violat/.test(m) &&
    // Whole words: "generated" holds "rate", and Gemini's own refusal ("No images generated. The request may have been
    // blocked by safety filters.") read as an outage, counted toward the breaker (round 5, 2026-10-20).
    !/\brate[ _-]?limit|\bquota\b|\bcredits?\b|\bbalance\b/.test(m)
  ) {
    return { kind: "content", scope: "route" };
  }

  // Account-wide: the credential or the balance, not this model.
  // Checked before the generic "invalid" rule below, because "invalid api key"
  // matches both and only one of those readings is useful.
  if (
    /insufficient credit|out of credit|quota exceeded|balance|payment required|invalid api key|unauthorized|forbidden|authentication/.test(m)
  ) {
    return { kind: "infrastructure", scope: "provider" };
  }

  // The host itself is unreachable — nothing on it can work.
  if (/enotfound|econnrefused|dns|getaddrinfo/.test(m)) {
    return { kind: "infrastructure", scope: "provider" };
  }

  // Our own fault: a request the provider was right to reject.
  // "too long": Gemini refuses a prompt over 5000 characters before any call, which an artist's prompt can reach; never
  // an outage (round 6, 2026-10-20).
  if (/invalid|unsupported|must be|required|malformed|too large|too long|not a valid/.test(m)) {
    return { kind: "request", scope: "route" };
  }

  if (typeof status === "number") {
    if (status === 401 || status === 403) return { kind: "infrastructure", scope: "provider" };
    if (status === 402) return { kind: "infrastructure", scope: "provider" };
    if (status === 429) return { kind: "infrastructure", scope: "provider" };
    if (status >= 500) return { kind: "infrastructure", scope: "route" };
    if (status >= 400) return { kind: "request", scope: "route" };
  }

  if (/timeout|timed out|econnreset|network|socket|fetch failed|aborted/.test(m)) {
    return { kind: "infrastructure", scope: "route" };
  }

  // Unknown: infrastructure, route-scoped. The threshold and the probe make a
  // false positive cheap (one fallback generation), while a false negative
  // keeps routing buyers into a hole.
  return { kind: "infrastructure", scope: "route" };
}

/**
 * Whether Enki may have been billed for this failure: an outage or an unknown answer may have run the model. A refused
 * prompt, a refused request, a missing key, a dead key and an empty balance were answered before any work (REPORTED/INFERRED,
 * no bill was read), so what they reserved goes back, or a dead host would fill the day's cap with bills it never charged.
 */
export function mayBeBilled(message: string): boolean {
  const c = classifyFailure(message);
  return c.kind === "infrastructure" && c.scope === "route";
}

export interface HealthRow {
  model_provider_id: string;
  provider_id: string;
  status: "healthy" | "down";
  consecutive_failures: number;
  last_probe_at: string | null;
  last_quoted_micro: number | null;
}

/**
 * Whether the breaker allows this route now, given its row and the clock.
 * Pure, so the state machine can be tested without a database or a network —
 * this is the part that decides where a customer's money goes.
 */
export function breakerVerdict(
  row: Pick<HealthRow, "status" | "last_probe_at"> | null,
  now: number,
): "use" | "skip" | "probe" {
  if (!row || row.status === "healthy") return "use";
  const last = row.last_probe_at ? Date.parse(row.last_probe_at) : 0;
  if (now - last >= PROBE_COOLDOWN_MS) return "probe";
  return "skip";
}

/** Whether this failure opens the breaker now. */
export function shouldOpen(c: Classification, consecutiveFailures: number): boolean {
  if (c.kind !== "infrastructure") return false;
  // Account-wide failures are unambiguous — no second opinion needed.
  if (c.scope === "provider") return true;
  return consecutiveFailures + 1 >= FAILURE_THRESHOLD;
}

/**
 * Liveness probes, per provider key. A probe must be FREE and must not
 * generate anything — an x402 quote with no payment header satisfies both,
 * because the gateway cannot run work it has not been paid for.
 */
export type Probe = (providerModel: string) => Promise<{ alive: boolean; quotedMicro?: number }>;

/**
 * AceData serves the nano-banana family and the OpenAI-shaped family on
 * different paths, and a quote is only meaningful on the path the route
 * actually uses — asking the wrong one would report a working model as broken.
 */
function acedataPath(providerModel: string): string {
  return providerModel.startsWith("nano-banana")
    ? "/nano-banana/images"
    : "/openai/images/generations";
}

const PROBES: Record<string, Probe> = {
  acedata: async (providerModel) => {
    const res = await fetch(`https://x402.acedata.cloud${acedataPath(providerModel)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No PAYMENT-SIGNATURE header: the gateway answers 402 with its price
      // and runs nothing. Deliberately no prompt either, so there is nothing
      // to generate even if that assumption were ever wrong.
      body: JSON.stringify({ model: providerModel }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status !== 402) return { alive: false };
    const body = (await res.json()) as {
      accepts?: { network?: string; maxAmountRequired?: string }[];
    };
    const sol = body.accepts?.find((a) => String(a.network).startsWith("solana"));
    return sol ? { alive: true, quotedMicro: Number(sol.maxAmountRequired) } : { alive: false };
  },
};

export function probeFor(providerKey: string): Probe | null {
  return PROBES[providerKey] ?? null;
}

/** Health rows for the given routes, keyed by model_provider id. */
export async function loadHealth(
  supabase: SupabaseClient,
  modelProviderIds: string[],
): Promise<Map<string, HealthRow>> {
  if (modelProviderIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("model_provider_health")
    .select("model_provider_id, provider_id, status, consecutive_failures, last_probe_at, last_quoted_micro")
    .in("model_provider_id", modelProviderIds);
  if (error) {
    // Health is an optimisation, never a gate: if we cannot read it, every
    // route is assumed usable rather than none.
    console.warn("[provider-health] could not read:", error.message);
    return new Map();
  }
  return new Map((data ?? []).map((r) => [r.model_provider_id, r as HealthRow]));
}

export async function reportSuccess(
  supabase: SupabaseClient,
  modelProviderId: string,
  providerId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("model_provider_health").upsert(
    {
      model_provider_id: modelProviderId,
      provider_id: providerId,
      status: "healthy",
      consecutive_failures: 0,
      last_success_at: now,
      last_error: null,
      updated_at: now,
    },
    { onConflict: "model_provider_id" },
  );
  if (error) console.warn("[provider-health] success not recorded:", error.message);
}

/**
 * Whether this caller is the one to tell, and if so the row is stamped. opened_at means "last told" and stays through a close.
 * Nobody hears twice about one provider within the hour. Past it, a route is due when nobody was told yet, or when it answered
 * since the last mail. So an outage mails once however long it lasts, a flap at most hourly, and an outage that begins inside
 * another's hour is told by its first failure past that hour, never lost to it. Compare-and-set on the value read: under
 * Postgres's row locks a second writer re-reads the WHERE and finds no row, so one function wins each row.
 */
async function yoursToTell(supabase: SupabaseClient, providerId: string, routeId?: string): Promise<boolean> {
  const { data } = await supabase.from("model_provider_health").select("model_provider_id, opened_at, last_success_at").eq("provider_id", providerId);
  const rows = (data ?? []) as { model_provider_id: string; opened_at: string | null; last_success_at: string | null }[];
  const now = Date.now();
  if (rows.some((r) => r.opened_at && now - Date.parse(r.opened_at) < MAIL_EVERY_MS)) return false;
  const due = rows.find((r) => (!routeId || r.model_provider_id === routeId) && (!r.opened_at || (r.last_success_at && Date.parse(r.last_success_at) > Date.parse(r.opened_at))));
  if (!due) return false;
  const stamp = supabase.from("model_provider_health").update({ opened_at: new Date(now).toISOString() }).eq("model_provider_id", due.model_provider_id);
  const { data: won } = await (due.opened_at ? stamp.eq("opened_at", due.opened_at) : stamp.is("opened_at", null)).select("model_provider_id");
  return Boolean(won?.length);
}

/**
 * To the outage mails' recipients. Never the error text: it can echo what we sent the provider. sendMail answers rather than
 * throws, so one that no recipient got gives the hour back, and the next failure tries again.
 */
async function tellBreakerOpen(supabase: SupabaseClient, column: "model_provider_id" | "provider_id", id: string, providerId: string, route: string): Promise<void> {
  const to = (process.env.OPS_ALERT_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const sent = await Promise.all(to.map((address) => sendMail({
    to: address,
    subject: "Enki: a provider breaker opened",
    text: `Provider ${providerId}, ${route}, at ${new Date().toISOString()}. Traffic goes to another route where one exists. The detail is in public.model_provider_health. No further mail about this provider within the hour.`,
  })));
  if (sent.some((r) => r.ok)) return;
  console.warn("[provider-health] breaker mail not sent");
  if (to.length) await supabase.from("model_provider_health").update({ opened_at: null }).eq(column, id);
}

/**
 * Record a failure and open the breaker if this was the last straw.
 * Returns what was opened, so the caller can log it meaningfully.
 */
export async function reportFailure(
  supabase: SupabaseClient,
  modelProviderId: string,
  providerId: string,
  message: string,
  status?: number,
): Promise<{ opened: "none" | "route" | "provider" }> {
  const c = classifyFailure(message, status);
  if (c.kind !== "infrastructure") return { opened: "none" };

  const now = new Date().toISOString();
  const error = message.slice(0, 300);

  // Account-wide: every route of this provider is affected, and waiting to
  // rediscover that per model costs a customer a generation each time.
  if (c.scope === "provider") {
    // The row must exist before the read, or a route never seen before has nothing to win.
    await supabase.from("model_provider_health").upsert(
      { model_provider_id: modelProviderId, provider_id: providerId, status: "healthy" },
      { onConflict: "model_provider_id", ignoreDuplicates: true },
    );
    const tell = await yoursToTell(supabase, providerId);
    await supabase
      .from("model_provider_health")
      .update({ status: "down", ...(tell ? { opened_at: now } : {}), last_failure_at: now, last_error: error, updated_at: now })
      .eq("provider_id", providerId);
    // The row for THIS route may not exist yet — the update above only
    // touches rows that do.
    await supabase.from("model_provider_health").upsert(
      {
        model_provider_id: modelProviderId,
        provider_id: providerId,
        status: "down",
        consecutive_failures: FAILURE_THRESHOLD,
        ...(tell ? { opened_at: now } : {}),
        last_failure_at: now,
        last_error: error,
        updated_at: now,
      },
      { onConflict: "model_provider_id" },
    );
    // Never the error text, here or below: it can echo what we sent the provider. last_error holds it, in the table.
    console.error(`[provider-health] breaker OPEN for ALL routes of provider ${providerId}`);
    if (tell) await tellBreakerOpen(supabase, "provider_id", providerId, providerId, "all routes");
    return { opened: "provider" };
  }

  const { data } = await supabase
    .from("model_provider_health")
    .select("consecutive_failures")
    .eq("model_provider_id", modelProviderId)
    .maybeSingle();

  const failures = (data?.consecutive_failures ?? 0) + 1;
  const open = shouldOpen(c, failures - 1);
  // Only when open: by the third failure the row exists.
  const tell = open && (await yoursToTell(supabase, providerId, modelProviderId));

  await supabase.from("model_provider_health").upsert(
    {
      model_provider_id: modelProviderId,
      provider_id: providerId,
      status: open ? "down" : "healthy",
      consecutive_failures: failures,
      last_failure_at: now,
      // Truncated: a provider's error body is not a place to store megabytes,
      // and it can echo back things we sent it.
      last_error: error,
      updated_at: now,
    },
    { onConflict: "model_provider_id" },
  );

  if (open) console.error(`[provider-health] breaker OPEN for route ${modelProviderId}`);
  if (tell) await tellBreakerOpen(supabase, "model_provider_id", modelProviderId, providerId, `route ${modelProviderId}`);
  return { opened: open ? "route" : "none" };
}

/** Run the probe and write the outcome. Returns whether the route is alive. */
export async function runProbe(
  supabase: SupabaseClient,
  modelProviderId: string,
  providerId: string,
  providerKey: string,
  providerModel: string,
): Promise<boolean> {
  const probe = probeFor(providerKey);
  const now = new Date().toISOString();

  // No probe available: half-open — let one real request decide.
  if (!probe) {
    await supabase
      .from("model_provider_health")
      .upsert(
        { model_provider_id: modelProviderId, provider_id: providerId, last_probe_at: now, updated_at: now },
        { onConflict: "model_provider_id" },
      );
    return true;
  }

  let alive = false;
  let quotedMicro: number | undefined;
  try {
    const result = await probe(providerModel);
    alive = result.alive;
    quotedMicro = result.quotedMicro;
  } catch {
    alive = false;
  }

  await supabase.from("model_provider_health").upsert(
    {
      model_provider_id: modelProviderId,
      provider_id: providerId,
      status: alive ? "healthy" : "down",
      ...(alive ? { consecutive_failures: 0, last_success_at: now } : {}),
      last_probe_at: now,
      ...(quotedMicro !== undefined ? { last_quoted_micro: quotedMicro } : {}),
      updated_at: now,
    },
    { onConflict: "model_provider_id" },
  );

  if (alive) console.warn(`[provider-health] breaker CLOSED for ${providerKey}/${providerModel} — back on the cheap route`);
  return alive;
}
