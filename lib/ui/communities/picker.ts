import { checkHandle, handleKey, slugify } from "@/lib/communities/handle";
import { MAX_COMMUNITIES_PER_WORK, type CommunityChip } from "@/lib/communities/types";

/**
 * The Communities picker's rules (CommunityPicker; Kev, 2026-10-30: "ein bild kann auch mehreren communities zugeteilt
 * werden ... max 18 communities pro werk"; "es wäre schon sinnvoll, wenn man nach der community suchen könnte, wobei
 * einem diese vorgeschlagen wird und man eine aufmachen kann, wenn es keine dazu gibt"). Several picks, up to 18 with
 * the ones a render's prompt brings; or one, which a new pick replaces (Explore's filter, "Merge into…").
 */
export type PickMode = "multi" | "single";

/** No more picks: 18, inherited ones counted. A single pick is never full (a new one replaces it). */
export const isFull = (picks: readonly CommunityChip[], mode: PickMode = "multi") =>
  mode === "multi" && picks.length >= MAX_COMMUNITIES_PER_WORK;

/** The picks with `chip` added: once each, never past the cap; in single mode it replaces the pick. */
export function addPick(picks: readonly CommunityChip[], chip: CommunityChip, mode: PickMode = "multi"): CommunityChip[] {
  if (mode === "single") return [chip];
  if (picks.some((p) => p.id === chip.id) || isFull(picks, mode)) return [...picks];
  return [...picks, chip];
}

export const dropPick = (picks: readonly CommunityChip[], id: string) => picks.filter((p) => p.id !== id);

/** The rows a list offers: what is not picked yet, in the server's order. */
export const unpicked = <T extends { id: string }>(rows: readonly T[], picks: readonly CommunityChip[]) =>
  rows.filter((r) => !picks.some((p) => p.id === r.id));

/** The handle "+ Create c/<handle>" offers for typed words (agreed 2026-10-30: "man eine aufmachen kann, wenn es keine
 *  dazu gibt"), or null: no handle in them, one Enki keeps, a community found has that very key already (gund4m when
 *  c/gundam came up), or one came up that neither its handle nor its name explains. The typeahead finds by handle,
 *  name, search word and merged handle (app/api/communities GET), so that one came by a search word or an old handle
 *  starting with the words: they name it already, and c/bitcoin beside c/btc ("bitcoin" its search word) is the
 *  duplicate Kev ruled out ("something, that cant be duplicated"). */
export function createOffer(typed: string, found: ReadonlyArray<{ handle: string; name: string }>): string | null {
  const slug = slugify(typed);
  if (checkHandle(slug)) return null;
  const key = handleKey(slug);
  const words = typed.trim().toLowerCase();
  const byOther = (c: { handle: string; name: string }) => !handleKey(c.handle).startsWith(key) && !c.name.toLowerCase().includes(words);
  return found.some((c) => handleKey(c.handle) === key || byOther(c)) ? null : slug;
}

/** One set of picks as a key (the same communities in any order are one key): Create > Image links each render
 *  started under it once its row is in (CommunityLinking), as Studio files them into a content piece. */
export const pickKey = (ids: readonly string[]) => [...new Set(ids)].sort().join(",");
export const idsOfKey = (key: string) => (key ? key.split(",") : []);
