import { toModelFamily } from "@/lib/generation/model-family";
import type { GeneratorGroup } from "@/components/enki/EnkiFilters";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { Media } from "@/lib/ui/feed/world";

type Catalogue = readonly Pick<CatalogueEntry, "id" | "name" | "mediaType">[];

/* The tree's branches: Image and Video, each carrying the DB's models of
   that medium (models.media_type). A branch with no models does not
   render — the Video branch appears by itself the day the first video
   row (Seedance, Kling, …) lands in the table. Explore's Images and Videos
   show only their own branch. */
export function generatorGroups(catalogue: Catalogue, world: Media = "all"): GeneratorGroup[] {
  const branch = (label: string, media: "image" | "video") => {
    const entries = catalogue.filter((c) => c.mediaType === media).map((c) => ({ id: c.id, name: c.name }));
    return entries.length ? [{ label, entries }] : [];
  };
  return [...(world === "videos" ? [] : branch("Image", "image")), ...(world === "images" ? [] : branch("Video", "video"))];
}

/* Generator filter: send EVERY alias of the picked generators — the
   prompts table's ai_model carries names AND slugs mixed ("Flux
   (free)", "nano-banana-pro"), so one id would miss half the rows. */
export function generatorAliases(ids: readonly string[], catalogue: Catalogue): string[] {
  return ids.flatMap((id) => {
    const entry = catalogue.find((c) => c.id === id);
    return entry ? [...new Set([entry.id, entry.name, toModelFamily(entry.name)])].filter(Boolean).map(String) : [];
  });
}
