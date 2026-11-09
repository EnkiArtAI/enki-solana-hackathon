"use client";

import { useState } from "react";
import { useVideoQuotes, useVideoRoutes } from "@/hooks/useVideoRoutes";
import { useVideoRun } from "@/hooks/useVideoRun";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import { microToUsd, type GenerationQuote } from "@/lib/generation-checkout";
import { defaultModel, modelOptions } from "@/lib/ui/image-view/models";
import { microQuote, promptVideoSettings, videoRowOf } from "@/lib/ui/image-view/video";
import { VIDEO_MAKING, jobRunning } from "@/lib/video/job-view";
import { fitSettings, startSettings, videoCanRun, videoCents, type Resolution, type VideoModel, type VideoSettings } from "@/lib/video/models";

const usd = (micro: number | null | undefined) => (!micro ? "…" : `$${microToUsd(micro)}`);

/**
 * The composer's foot on a video prompt: its generators (the video rows on offer), the settings, and every price around them
 * in one server batch (the chip, each resolution, each generator), so what stands on Generate is POST /api/video/quote's
 * answer, the artist's share in it. A guest gets no chip, as on an image, and each generator's rate on its menu from the
 * public rates. Nothing is asked while `on` is false: an image prompt reads no video route.
 */
export function useVideoPrompt({ on, catalogue, pick, prompt, premium, offered, promptId, guest }: {
  on: boolean;
  catalogue: CatalogueEntry[];
  /** The buyer's pick, by name: the view keeps one, whatever the medium. */
  pick: string;
  prompt: Parameters<typeof promptVideoSettings>[1] & { ai_model?: string | null } | undefined;
  premium: boolean;
  offered: readonly string[];
  promptId: string | null;
  guest: boolean;
}) {
  const models = on ? modelOptions(catalogue, premium, offered, "video") : [];
  const own = { catalogue, aiModel: prompt?.ai_model, premium, offered, medium: "video" as const };
  const ownName = on ? defaultModel({ ...own, pick: "" }) : "";
  const name = on ? defaultModel({ ...own, pick }) : "";
  const model = videoRowOf(name);
  const [picked, setPicked] = useState<Partial<VideoSettings>>({});
  const { rateOf } = useVideoRoutes(on);
  const settings = model && fitSettings(model, { ...promptVideoSettings(model, prompt), ...picked });
  const ask = (m: VideoModel, s: VideoSettings) => ({ promptId: promptId ?? undefined, modelId: m.id, settings: s });
  const rows = models.map((e) => videoRowOf(e.name));
  const tiers = model?.resolutions ?? [];
  const { totals, pending } = useVideoQuotes(guest || !model || !settings ? [] : [
    ask(model, settings),
    ...tiers.map((resolution) => ask(model, fitSettings(model, { ...settings, resolution }))),
    ...rows.flatMap((m) => (m ? [ask(m, fitSettings(m, settings))] : [])),
  ]);
  const rateQuote = (m: VideoModel | null): GenerationQuote | null => {
    const cents = m && videoCents(m, rateOf(m.id), startSettings(m));
    return cents == null ? null : microQuote(cents * 10_000);
  };
  const listed = rows.filter(Boolean);
  // This prompt's own videos, newest first; asked only once the view is a video's and the viewer is signed in.
  const run = useVideoRun({ enabled: on && !guest && Boolean(promptId), promptId });
  const newest = run.jobs[0];
  return {
    models,
    entry: models.find((e) => e.name === name),
    /** The prompt's own generator, for the viewer's panel. */
    ownName,
    /** Null on an image prompt, and before SQL 67, where the catalogue has no such row. */
    foot: model && settings ? {
      model,
      settings,
      set: (next: Partial<VideoSettings>) => setPicked((p) => ({ ...p, ...next })),
      price: (r: Resolution) => usd(totals[1 + tiers.indexOf(r)]),
    } : null,
    /** The chip: "…" until the server has a number, which before SQL 68 it does not. */
    chip: guest ? null : usd(totals[0]),
    pending,
    modelPrices: rows.map((m) => {
      if (guest) return rateQuote(m);
      const total = m && totals[1 + tiers.length + listed.indexOf(m)];
      return total ? microQuote(total) : null;
    }),
    changed: name !== ownName || Object.keys(picked).length > 0,
    reset: () => setPicked({}),
    /** Its operator is set for these settings: Generate presses `press`, one video. */
    available: Boolean(model && settings && videoCanRun(model, rateOf(model.id), settings)),
    busy: run.busy,
    delivered: run.jobs.filter((j) => j.video),
    /** What stands under Generate: the newest video under way, or how it ended. */
    line: newest && jobRunning(newest.status) ? VIDEO_MAKING : newest?.why ?? null,
    press: (words: string | undefined, variableValues: Record<string, unknown> | undefined) =>
      (model && settings ? run.press({ modelId: model.id, settings, promptId: promptId ?? undefined, words, variableValues }) : Promise.resolve(null)),
  };
}
