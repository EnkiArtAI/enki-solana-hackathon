"use client";

import { useQuery } from "@tanstack/react-query";
import { sessionAuthHeaders } from "@/lib/session-headers";

export type IgnoredPerson = { id: string; handle: string; displayName: string; avatarUrl: string | null };

export const IGNORES_KEY = ["/api/ignores"];

/**
 * The people I ignore (Kev, 2026-10-29), from GET /api/ignores: the one source for the profile's Ignore button, the
 * feed's Show ignored pill and the list in Settings. A failed read is an error, never an empty list.
 */
export function useIgnores(signedIn: boolean) {
  return useQuery({
    queryKey: IGNORES_KEY,
    queryFn: async (): Promise<IgnoredPerson[]> => {
      const res = await fetch("/api/ignores", { headers: sessionAuthHeaders() });
      const body = (await res.json().catch(() => ({}))) as { people?: IgnoredPerson[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? "The people you ignore could not be loaded.");
      return body.people ?? [];
    },
    enabled: signedIn,
  });
}
