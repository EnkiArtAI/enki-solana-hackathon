"use client";

import { useQuery } from "@tanstack/react-query";
import { sessionAuthHeaders, viewerHeaders } from "@/lib/session-headers";
import type { VideoSettings } from "@/lib/video/models";
import type { PublicVideoRoute } from "@/lib/video/routes";

/** Each video generator's rate (GET /api/video/models), by its id; null until it answers, and before SQL 68: the chip says "…". */
export function useVideoRoutes(enabled = true) {
  const { data } = useQuery<PublicVideoRoute[]>({
    queryKey: ["/api/video/models"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch("/api/video/models", { headers: viewerHeaders() });
      return res.ok ? (((await res.json()) as { models?: PublicVideoRoute[] }).models ?? []) : [];
    },
  });
  return { rateOf: (id: string) => data?.find((r) => r.id === id) ?? null };
}

export interface VideoQuoteAsk { promptId?: string; modelId: string; settings: VideoSettings }

/** The server's total for each ask, in micro-USD, in one request (POST /api/video/quote); null for one it has no price for. */
export function useVideoQuotes(asks: VideoQuoteAsk[]): { totals: Array<number | null>; pending: boolean } {
  const { data, isPending } = useQuery<Array<number | null>>({
    queryKey: ["video-quotes", JSON.stringify(asks)],
    enabled: asks.length > 0,
    staleTime: 60_000,
    // Quotes expire server-side after 5 minutes; refresh a little sooner.
    refetchInterval: 4 * 60 * 1000,
    queryFn: async () => {
      const res = await fetch("/api/video/quote", { method: "POST", headers: { "Content-Type": "application/json", ...sessionAuthHeaders() }, body: JSON.stringify({ items: asks }) }).catch(() => null);
      const quotes = ((await res?.json().catch(() => null)) as { quotes?: Array<{ breakdown?: { totalAmount?: string } }> } | null)?.quotes;
      return asks.map((_, i) => (quotes?.[i]?.breakdown?.totalAmount ? Number(quotes[i].breakdown?.totalAmount) : null));
    },
  });
  return { totals: data?.length === asks.length ? data : asks.map(() => null), pending: asks.length > 0 && isPending };
}
