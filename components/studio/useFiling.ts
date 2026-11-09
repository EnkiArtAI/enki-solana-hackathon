"use client";

import { useEffect, useRef } from "react";
import { notify } from "@/components/kit/notify";
import { useStudioApi } from "@/hooks/useStudio";
import type { GenerationRow } from "@/lib/ui/image-view/history";
import type { Job } from "@/lib/ui/kit/render-queue";
import { fileKey, noteJobs, toFile, type StartedIn } from "@/lib/ui/studio/filing";
import { useStudioScope } from "./StudioScope";

/**
 * Files Create > Image's renders into the content piece they were started in (lib/ui/studio/filing), once each, as
 * their rows come in. A failed filing is said once per piece; the render stays in the gallery and can be filed by hand
 * from the viewer (KeepInStudio).
 */
export function useFiling(jobs: ReadonlyArray<Job<unknown>>, rows: GenerationRow[]) {
  const content = useStudioScope()?.content ?? null;
  const api = useStudioApi();
  const startedIn = useRef<StartedIn | null>(null);
  const sent = useRef(new Set<string>());
  const names = useRef(new Map<string, string>());
  const told = useRef(new Set<string>());

  useEffect(() => {
    if (content) names.current.set(content.id, content.name);
    startedIn.current = noteJobs(startedIn.current, jobs, content?.id ?? null);
    for (const { content: piece, imageIds } of toFile(jobs, rows, startedIn.current, sent.current)) {
      for (const id of imageIds) sent.current.add(fileKey(piece, id));
      api.fileImages(piece, imageIds).catch(() => {
        if (told.current.has(piece)) return;
        told.current.add(piece);
        notify(`Couldn't file that image in ${names.current.get(piece) ?? "its content piece"}`, { tone: "error" });
      });
    }
    // api is new each render; the jobs, their rows and the piece decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, rows, content?.id]);
}

/** useFiling as an element of Create > Image, so the page itself calls no hook of Studio's. */
export function StudioFiling({ jobs, rows }: { jobs: ReadonlyArray<Job<unknown>>; rows: GenerationRow[] }) {
  useFiling(jobs, rows);
  return null;
}
