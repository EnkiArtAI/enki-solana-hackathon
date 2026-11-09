import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A human's false alarm on a child-safety image case (Kev, 2026-11-02, the case of an imported creator's post): the
 * moderation owner looks at the case's image by the logged reveal and overturns it, and exactly those bytes, by the
 * checksum the case has held since it was filed (lib/moderation/image-case: prompt_hash, sha256 of the judged bytes), then
 * count as reviewed on the hunter's import alone (lib/referral/judge-post). Every other route keeps refusing them, other
 * bytes are judged as ever, the judges' other findings still apply, and the case, its verdict and its evidence copy stay.
 * Every release is one logged decision: SQL 61's row, and the overturn's row in the admin log. Upholding takes it back,
 * and that reaches what it let through: a find still waiting is refused at its publish (casedImages), a prompt it was
 * published to is taken down (noteClearedPublish, takeBackClearance).
 */
export const CLEARANCE_NOT_READY = "Clearing an image needs SQL 61 (sql-to-run/61-image-clearances.sql). Nothing was changed.";
export const NOT_THE_OWNER = "Only the moderation owner can clear a child-safety image.";
export const NOT_LOOKED_AT = "You cannot clear what you have not looked at. Reveal the image first.";
export const NO_CHECKSUM = "This case holds no checksum of its image, so it cannot be cleared.";

const CHECKSUM = /^[0-9a-f]{64}$/;
const missingTable = (e: { code?: string } | null) => e?.code === "PGRST205" || e?.code === "42P01";

/** A case recordImageCase filed: its image is what a clearance would let through. */
export const isImageCase = (ev: { category?: unknown; matched_rules?: unknown }) =>
  ev.category === "csam" && Array.isArray(ev.matched_rules) && ev.matched_rules.includes("image-check");

type Refused = { error: string; status: number };
/** answer goes into the route's answer, and so into the admin log (lib/admin/audit). */
type Done = { answer: Record<string, string | number> };

/** Whether these bytes were cleared and not taken back. A failed read, or SQL 61 not run yet, is no: the image stays refused. */
export async function imageCleared(supabase: SupabaseClient, sha256: string): Promise<boolean> {
  const { data, error } = await supabase.from("image_clearances").select("id").eq("sha256", sha256).is("revoked_at", null).limit(1);
  return !error && (data?.length ?? 0) > 0;
}

/**
 * Of these bytes, those a child-safety image case holds back, and those that pass on a clearance still standing. No model
 * is asked, and whatever state the case is in, overturned included, only a clearance lets them through. null: not readable.
 */
export async function casedImages(supabase: SupabaseClient, sha256s: string[]): Promise<{ held: string[]; cleared: string[] } | null> {
  if (!sha256s.length) return { held: [], cleared: [] };
  const { data, error } = await supabase.from("automod_events").select("prompt_hash, category, matched_rules").in("prompt_hash", sha256s);
  if (error) return null;
  const cased = [...new Set((data ?? []).filter(isImageCase).map((ev) => String(ev.prompt_hash)))];
  const stands = await Promise.all(cased.map((sha256) => imageCleared(supabase, sha256)));
  return { held: cased.filter((_, i) => !stands[i]), cleared: cased.filter((_, i) => stands[i]) };
}

/**
 * Before a prompt that holds cleared bytes is listed: the note that lets a take-back reach it. Asked again after the note:
 * a take-back before it saw no prompt, so nothing may be listed; one after it takes the prompt down, and the listing leaves
 * what is taken down. false: taken back meanwhile.
 */
export async function noteClearedPublish(supabase: SupabaseClient, sha256s: string[], promptId: string): Promise<boolean> {
  const { error } = await supabase.from("image_clearance_prompts").insert(sha256s.map((sha256) => ({ sha256, prompt_id: promptId })));
  if (error) throw new Error(`The cleared image's prompt could not be noted: ${error.message}`);
  return (await Promise.all(sha256s.map((sha256) => imageCleared(supabase, sha256)))).every(Boolean);
}

/**
 * The owner's overturn of an image case. An image reveal is a reveal row without a prompt_id (app/api/admin), written only
 * once the image was read: their own, of this case. The clearance and the case's review are one transaction (SQL 61).
 */
export async function clearImageCase(supabase: SupabaseClient, eventId: string, ev: { prompt_hash?: unknown }, userId: string, notes: string | null): Promise<Done | Refused> {
  const { data: policy } = await supabase.from("moderation_policy").select("owner_user_id").eq("id", 1).maybeSingle();
  if (!policy?.owner_user_id || String(policy.owner_user_id) !== userId) return { error: NOT_THE_OWNER, status: 403 };
  const sha256 = typeof ev.prompt_hash === "string" && CHECKSUM.test(ev.prompt_hash) ? ev.prompt_hash : null;
  if (!sha256) return { error: NO_CHECKSUM, status: 409 };
  // A look from before these bytes were last taken back does not count: clearing them again takes a new logged look.
  const { data: taken, error: takenError } = await supabase.from("image_clearances").select("revoked_at")
    .eq("sha256", sha256).not("revoked_at", "is", null).order("revoked_at", { ascending: false }).limit(1);
  const reveals = supabase.from("artist_text_reveals").select("id").eq("event_id", eventId).eq("revealed_by", userId).is("prompt_id", null);
  const { data: looked, error: logError } = await (taken?.[0] ? reveals.gt("created_at", taken[0].revoked_at) : reveals).limit(1);
  if (logError || (takenError && !missingTable(takenError))) return { error: "The reveal log could not be read, so nothing was cleared. Try again.", status: 503 };
  if (!looked?.length) return { error: NOT_LOOKED_AT, status: 403 };
  const { error } = await supabase.rpc("clear_image_case", { p_event_id: eventId, p_sha256: sha256, p_cleared_by: userId, p_notes: notes });
  if (error?.code === "PGRST202") return { error: CLEARANCE_NOT_READY, status: 503 };
  if (error) return { error: `Could not clear the image${error.message ? `: ${error.message}` : ""}`, status: 500 };
  return { answer: { cleared: sha256 } };
}

/**
 * An uphold: these bytes count as unreviewed again, whichever of their cases the clearance came from, and the prompts they
 * were published to come down, as a report's delist does; a later clearance does not put them back. A press that found
 * them down already, or failed halfway and is pressed again, finishes the job. Before SQL 61 there is nothing to take back.
 */
export async function takeBackClearance(supabase: SupabaseClient, ev: { prompt_hash?: unknown }, userId: string): Promise<Done | Refused> {
  const sha256 = String(ev.prompt_hash);
  const now = new Date().toISOString();
  const { data, error } = await supabase.from("image_clearances").update({ revoked_at: now, revoked_by: userId })
    .eq("sha256", sha256).is("revoked_at", null).select("id");
  if (error && !missingTable(error)) return { error: `Could not take the clearance back: ${error.message}`, status: 500 };
  const answer: Done["answer"] = { revoked: data?.length ?? 0 };
  const { data: notes, error: notesError } = await supabase.from("image_clearance_prompts").select("prompt_id").eq("sha256", sha256);
  if (notesError && !missingTable(notesError)) return { error: `The clearance is taken back, but its prompts could not be read, so none came down. Press again: ${notesError.message}`, status: 500 };
  if (notes?.length) {
    const { data: down, error: downError } = await supabase.from("prompts").update({ is_listed: false, delisted_at: now })
      .in("id", notes.map((n) => String(n.prompt_id))).is("delisted_at", null).select("id");
    if (downError) return { error: `The clearance is taken back, but its prompts did not come down. Press again: ${downError.message}`, status: 500 };
    if (down?.length) {
      answer.unlisted = down.length;
      answer.prompts = down.map((p) => String(p.id)).join(",");
    }
  }
  return { answer };
}
