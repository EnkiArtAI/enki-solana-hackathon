"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { notify } from "@/components/kit/notify";
import { usePaymentSigner } from "@/hooks/usePaymentSigner";
import { CheckoutError, authorizePaidGeneration } from "@/lib/generation-checkout";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { JOB_WHY, jobRunning, type VideoJobView } from "@/lib/video/job-view";
import type { VideoSettings } from "@/lib/video/models";

/** How often a person's list is asked while a video of theirs is under way: the cron moves it on once a minute at most. */
const JOB_POLL_MS = 15_000;
export const VIDEO_INTENT_PATH = "/api/video/intent";

export interface VideoPress {
  modelId: string;
  settings: VideoSettings;
  promptId?: string;
  /** The buyer's own words; a premium prompt's are the artist's, filled on the server. */
  words?: string;
  variableValues?: Record<string, unknown>;
  frames?: { start?: string; end?: string };
  refs?: string[];
  consent?: boolean;
}

/**
 * One press, one video (Kev, 2026-11-03: "allow also only the creation of 1 video for premium prompts"): the held payment as an
 * image's checkout signs it, with one unit always, then the job. Charged only once its output is stored and checked (lib/video/jobs);
 * `jobs` follows it. `promptId` narrows the list to one prompt's; `enabled` false reads nothing, so an image prompt asks nothing.
 */
export function useVideoRun({ enabled, promptId }: { enabled: boolean; promptId?: string | null }) {
  const sign = usePaymentSigner();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const key = ["video-jobs", promptId ?? null];
  const { data } = useQuery<VideoJobView[]>({
    queryKey: key,
    enabled,
    refetchInterval: (query) => (query.state.data?.some((j) => jobRunning(j.status)) ? JOB_POLL_MS : false),
    queryFn: async () => {
      const res = await fetch(`/api/video/jobs${promptId ? `?promptId=${encodeURIComponent(promptId)}` : ""}`, { headers: sessionAuthHeaders(), cache: "no-store" });
      return res.ok ? (((await res.json()) as { jobs?: VideoJobView[] }).jobs ?? []) : [];
    },
  });
  /** The job's id once it is with the operator; null once the sentence was said. */
  const press = async ({ modelId, settings, promptId: forPrompt, words, variableValues, frames, refs, consent }: VideoPress): Promise<string | null> => {
    if (busy) return null;
    setBusy(true);
    try {
      const payment = await authorizePaidGeneration({ promptId: forPrompt, modelId, settings }, sign, 1, undefined, undefined, VIDEO_INTENT_PATH);
      const res = await fetch("/api/video/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ intentId: payment.intentId, words, variableValues, frames, refs, consent }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; job?: { id?: string } } | null;
      if (!res.ok) {
        notify(body?.error ?? JOB_WHY.failed, { tone: "error" });
        return null;
      }
      return body?.job?.id ?? null;
    } catch (e) {
      notify(e instanceof CheckoutError ? e.message : JOB_WHY.failed, { tone: "error" });
      return null;
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["video-jobs"] });
    }
  };
  return { jobs: data ?? [], busy, press };
}

export type VideoRun = ReturnType<typeof useVideoRun>;
