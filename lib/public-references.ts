import type { getSupabaseServerClient } from "@/lib/supabaseServer";

type Supabase = ReturnType<typeof getSupabaseServerClient>;

/**
 * The reference images of public renders whose owner chose to show them (Kev, 2026-10-29: "after checking an image to
 * be public, i should as well check if the reference images used to render shall also made public"; DEC-514), by
 * image id, in the order they were sent. Everyone else's stay their owner's (DEC-2026-10-17-51). An 18+ reference
 * makes its render 18+ (generate-image), so a caller that hides 18+ images hides their references too. Best effort:
 * before SQL 43 the column is missing and none are shown, as after any failed read.
 */
export async function publicReferences(supabase: Supabase, imageIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!imageIds.length) return out;
  // A failed read answers no rows (data null).
  const { data: shown } = await supabase
    .from("generated_images")
    .select("id, generation_id")
    .in("id", imageIds)
    .eq("visibility", "public")
    .eq("references_public", true);
  // One render can make several images.
  const imagesOf = new Map<string, string[]>();
  for (const r of shown ?? []) {
    if (typeof r.generation_id === "string") imagesOf.set(r.generation_id, [...(imagesOf.get(r.generation_id) ?? []), String(r.id)]);
  }
  if (!imagesOf.size) return out;
  const { data: refs, error: refsError } = await supabase
    .from("generation_reference_images")
    .select("generation_id, sequence_index, storage_url")
    .in("generation_id", [...imagesOf.keys()])
    .order("sequence_index", { ascending: true });
  if (refsError) return out;
  for (const r of refs ?? []) {
    if (typeof r.storage_url !== "string") continue;
    for (const image of imagesOf.get(r.generation_id) ?? []) out.set(image, [...(out.get(image) ?? []), r.storage_url]);
  }
  return out;
}
