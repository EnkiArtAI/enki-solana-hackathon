/**
 * Buyers' reference images on a premium prompt, its creator's to switch off (SQL 62, prompts.allow_references; Kev,
 * 2026-11-01: "die sind bei jedem free image ein muss, wobei bei premium images das eingestellt werden kann"). A free
 * prompt ignores it. Read on its own: before SQL 62 only this read misses its column, and it answers as today, allowed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPublicText } from "@/lib/prompt-visibility";

export const REFERENCES_OFF = "This prompt does not take reference images.";

/** A column SQL has not added yet: 42703 on a read, PGRST204 on a write (VERIFIED live 2026-11-02). */
export const columnMissing = (error: { code?: string } | null) => error?.code === "42703" || error?.code === "PGRST204";

/** Whether this prompt takes a buyer's references. Any other failed read throws: no paid route goes on without the answer. */
export async function allowsReferences(supabase: SupabaseClient, promptId: string): Promise<boolean> {
  const { data, error } = await supabase.from("prompts").select("allow_references, prompt_type, is_free_showcase").eq("id", promptId).maybeSingle();
  if (error) {
    if (columnMissing(error)) return true;
    throw error;
  }
  return data?.allow_references !== false || isPublicText(data);
}
