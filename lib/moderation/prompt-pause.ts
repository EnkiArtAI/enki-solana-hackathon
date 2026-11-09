/**
 * A paid prompt refused for its own text (Kev, 2026-10-27: "ja go" on the sketch of DEC-145/266). The buyer never sees
 * that text, so the refusal is Enki's unit and never counts against them; the refusal is recorded, and the prompt
 * leaves the marketplace (is_listed false) until an admin releases or delists it. Table: prompt_refusals (SQL 39).
 * Every function here fails quietly toward "nothing recorded, nothing paused": the unit stays Enki's either way.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** What the buyer reads (Kev's sketch, 2026-10-21: "Dieser Prompt kann gerade nicht erzeugt werden. Nichts wurde abgebucht."). */
export const PROMPT_UNAVAILABLE = "This prompt can't be generated right now. Nothing was generated and nothing was charged.";

/**
 * A provider refusal gives no reason, and a render that spells out the hidden text may be the artist's own lettering or
 * one buyer's extraction: either way one buyer's values could be the cause, so this many different buyers pause.
 */
export const PROVIDER_PAUSE_BUYERS = 2;
export const PROVIDER_PAUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RefusalCause = "moderation" | "provider" | "render";
export type PausedPrompt = { promptId: string; title: string; creatorId: string | null; refusals: { cause: RefusalCause; detail: string; at: string }[] };

/**
 * Records a refusal of an artist's text and, when due, takes the prompt off sale. Due: always for our moderation (the
 * re-judge with the buyer's values neutralised already found the artist's text); for a provider once
 * PROVIDER_PAUSE_BUYERS different buyers were refused within the window, this one included. A prompt not on sale stays
 * as it is. Returns whether this refusal paused the prompt.
 */
export async function refusePrompt(
  supabase: SupabaseClient,
  r: { promptId: string; cause: RefusalCause; detail: string; buyerUserId: string | null },
): Promise<boolean> {
  try {
    // On this server's clock, as the two-buyer window below is read.
    const { data: row, error } = await supabase.from("prompt_refusals")
      .insert({ prompt_id: r.promptId, cause: r.cause, detail: r.detail.slice(0, 120), buyer_user_id: r.buyerUserId, created_at: new Date().toISOString() })
      .select("id").single();
    if (error || !row) {
      console.error("[prompt-pause] refusal not recorded:", error?.message ?? "no row");
      return false;
    }
    if (r.cause !== "moderation" && !(await buyersPauseDue(supabase, r.promptId, r.cause))) return false;
    const { data: paused, error: pauseError } = await supabase.from("prompts")
      .update({ is_listed: false }).eq("id", r.promptId).eq("is_listed", true).is("delisted_at", null).select("id");
    if (pauseError || !paused?.length) return false;
    const { error: markError } = await supabase.from("prompt_refusals").update({ paused: true }).eq("id", row.id);
    // Off sale either way; unmarked, it would not show in the admin's list, so the prompt goes back on sale.
    if (markError) {
      await supabase.from("prompts").update({ is_listed: true }).eq("id", r.promptId).is("delisted_at", null);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[prompt-pause] refusal not recorded:", e instanceof Error ? e.message : e);
    return false;
  }
}

async function buyersPauseDue(supabase: SupabaseClient, promptId: string, cause: RefusalCause): Promise<boolean> {
  const since = new Date(Date.now() - PROVIDER_PAUSE_WINDOW_MS).toISOString();
  const { data, error } = await supabase.from("prompt_refusals").select("buyer_user_id")
    .eq("prompt_id", promptId).eq("cause", cause).is("reviewed_at", null).gt("created_at", since);
  if (error) return false;
  return new Set((data ?? []).flatMap((d) => (d.buyer_user_id ? [String(d.buyer_user_id)] : []))).size >= PROVIDER_PAUSE_BUYERS;
}

/**
 * Whether an admin released this prompt after its renders spelled out its text: its lettering is meant to show, and
 * the hidden-text check leaves it alone. Asked only on a hit. A failed read is "not released".
 */
export async function letteringReleased(supabase: SupabaseClient, promptId: string): Promise<boolean> {
  const { data, error } = await supabase.from("prompt_refusals").select("id")
    .eq("prompt_id", promptId).eq("cause", "render").eq("decision", "released").limit(1);
  return !error && (data ?? []).length > 0;
}

/** Whether the prompt waits for an admin: an open refusal took it off sale. A failed read is "not paused". */
export async function isPaused(supabase: SupabaseClient, promptId: string): Promise<boolean> {
  const { data, error } = await supabase.from("prompt_refusals").select("id")
    .eq("prompt_id", promptId).eq("paused", true).is("reviewed_at", null).limit(1);
  return !error && (data ?? []).length > 0;
}

/** The prompts waiting for an admin, each with its open refusals, newest first. Empty when the table cannot be read. */
export async function pausedPrompts(supabase: SupabaseClient): Promise<PausedPrompt[]> {
  // The paused ones first, so no number of other open refusals can hide one (review wf_866ba07b-01a).
  const { data: paused, error } = await supabase.from("prompt_refusals").select("prompt_id").eq("paused", true).is("reviewed_at", null);
  if (error || !paused?.length) return [];
  const ids = [...new Set(paused.map((r) => String(r.prompt_id)))];
  const [{ data: openRows }, { data: prompts }] = await Promise.all([
    supabase.from("prompt_refusals").select("prompt_id, cause, detail, created_at").is("reviewed_at", null).in("prompt_id", ids),
    supabase.from("prompts").select("id, title, creator_id").in("id", ids),
  ]);
  const open = [...(openRows ?? [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const byId = new Map((prompts ?? []).map((p) => [String(p.id), p]));
  return ids.map((id) => ({
    promptId: id,
    title: String(byId.get(id)?.title ?? "Untitled"),
    creatorId: byId.get(id)?.creator_id ? String(byId.get(id)!.creator_id) : null,
    refusals: open.filter((r) => String(r.prompt_id) === id)
      .map((r) => ({ cause: r.cause as RefusalCause, detail: String(r.detail ?? ""), at: String(r.created_at) })),
  }));
}

/**
 * An admin's decision on a paused prompt: back on sale, or taken down for good (as a report's delist). Every open
 * refusal of the prompt is decided with it.
 */
export async function decidePause(
  supabase: SupabaseClient, promptId: string, decision: "released" | "delisted", adminId: string,
): Promise<{ ok: true } | { ok: false; status: 400 | 409 | 500; error: string }> {
  if (!(await isPaused(supabase, promptId))) return { ok: false, status: 400, error: "This prompt is not waiting for a decision" };
  const now = new Date().toISOString();
  const { data: changed, error } = decision === "released"
    ? await supabase.from("prompts").update({ is_listed: true }).eq("id", promptId).is("delisted_at", null).is("deleted_at", null).select("id")
    : await supabase.from("prompts").update({ is_listed: false, delisted_at: now }).eq("id", promptId).select("id");
  if (error) return { ok: false, status: 500, error: "Could not update the prompt" };
  // Taken down or deleted meanwhile: nothing went back on sale, and the refusals stay open for what comes next.
  if (!changed?.length) return { ok: false, status: 409, error: "This prompt was taken down or deleted meanwhile. Nothing was released." };
  const { error: decideError } = await supabase.from("prompt_refusals")
    .update({ reviewed_at: now, reviewed_by: adminId, decision }).eq("prompt_id", promptId).is("reviewed_at", null);
  return decideError ? { ok: false, status: 500, error: "Could not record the decision" } : { ok: true };
}

/** Why a prompt was paused, in one line for the admin: each cause once, with how often and what (DEC-441). */
export function pauseSummary(refusals: PausedPrompt["refusals"]): string {
  const counts = new Map<string, number>();
  for (const r of refusals) {
    const key = `${r.cause}${r.detail ? ` (${r.detail})` : ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([what, n]) => `${n}× ${what}`).join(" · ");
}
