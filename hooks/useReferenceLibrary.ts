"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { notify } from "@/components/kit/notify";
import { sessionAuthHeaders } from "@/lib/session-headers";

/** A saved reference: `src` is its tile, `url` what is read as the reference, `hash` the picture's sha256. */
export type SavedReference = { id: string; url: string; src: string; hash: string };
/** The saved ones newest first, and the hashes of those deleted. */
type Library = { saved: SavedReference[]; deleted: string[] };

export const REFERENCES_KEY = ["references"];
/** Read anew at half the hour its addresses are signed for (lib/reference-library REFERENCE_SIGN_TTL). */
export const REFERENCES_FRESH = 30 * 60_000;

type Row = { id: string; url: string; thumb: string; hash: string };
const asSaved = (r: Row): SavedReference => ({ id: r.id, url: r.url, src: r.thumb, hash: r.hash });

/** The sha256 a render's stored reference is named by (lib/generation/reference-images: references/<user>/<sha256>.<ext>). */
export const storedHash = (url: string) => /\/references\/[^/]+\/([0-9a-f]{64})\.[a-z0-9]+$/.exec(url)?.[1];

/**
 * The account's saved references (Kev, 2026-10-29: "the images uploaded via ref image uploading must remain in that
 * image upload UI until i delete them, this must be the database of uploaded referenced images"; app/api/references).
 * A guest has none and saves none: their uploads live for the visit, as before. A failed read lists none, so the picker
 * stands as it did before SQL 51.
 */
export function useReferenceLibrary(signedIn: boolean) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: REFERENCES_KEY,
    queryFn: async (): Promise<Library> => {
      const res = await fetch("/api/references", { headers: sessionAuthHeaders() });
      const body = (await res.json().catch(() => ({}))) as { references?: Row[]; deleted?: string[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Your references could not be loaded.");
      return { saved: (body.references ?? []).map(asSaved), deleted: body.deleted ?? [] };
    },
    enabled: signedIn,
    staleTime: REFERENCES_FRESH,
    refetchInterval: REFERENCES_FRESH,
  });
  const reload = () => void queryClient.invalidateQueries({ queryKey: REFERENCES_KEY });

  return {
    saved: list.data?.saved ?? [],
    deleted: list.data?.deleted ?? [],
    /** Saves a picture as the picker read it; null when it was not saved (a guest, SQL 51 not run, a failure). */
    save: async (image: string): Promise<SavedReference | null> => {
      if (!signedIn) return null;
      const res = await fetch("/api/references", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ image }),
      }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as (Partial<Row> & { error?: string }) | null;
      // A full account is told why this one was not kept; it still works for this visit.
      if (res?.status === 409 && body?.error) notify(body.error, { tone: "error" });
      // Only a save answers an address.
      if (!body?.url) return null;
      const saved = asSaved(body as Row);
      // At the top at once, where the next read puts it too, and no longer among the deleted.
      queryClient.setQueryData<Library>(REFERENCES_KEY, (old) => ({
        saved: [saved, ...(old?.saved ?? []).filter((r) => r.id !== saved.id)],
        deleted: (old?.deleted ?? []).filter((h) => h !== saved.hash),
      }));
      reload();
      return saved;
    },
    /** Gone from the list at once, among the deleted; back with a sentence when the delete fails (one already gone is no
     *  failure). */
    remove: (id: string) => {
      queryClient.setQueryData<Library>(REFERENCES_KEY, (old) => old && {
        saved: old.saved.filter((r) => r.id !== id),
        deleted: [...old.saved.filter((r) => r.id === id).map((r) => r.hash), ...old.deleted],
      });
      void fetch(`/api/references/${encodeURIComponent(id)}`, { method: "DELETE", headers: sessionAuthHeaders() })
        .then((res) => { if (!res.ok && res.status !== 404) throw new Error(String(res.status)); })
        .catch(() => notify("Couldn't delete that reference", { tone: "error" }))
        .finally(reload);
    },
  };
}
