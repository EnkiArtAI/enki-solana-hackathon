"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readReference } from "@/hooks/useReferenceReads";
import { sessionAuthHeaders } from "@/lib/session-headers";
import {
  NOT_SAVED, STUDIO_NOT_READY,
  type Asset, type CharacterInput, type ContentDetail, type ContentInput, type ItemKind, type MasterPromptInput,
  type ProjectDetail, type ProjectInput, type StudioResponses, type StyleInput,
} from "@/lib/studio/types";

/**
 * Studio's reads and writes (app/api/studio/**, Kev, 2026-10-30: "a collection of projects containing different
 * content pieces that all access the same reference images, characters, styles and master prompts"). Every failure is
 * thrown as the route's own sentence, for the caller to show inline or as a toast; every write reads Studio anew.
 * Before SQL 53 has run every answer is 503 STUDIO_NOT_READY: `notReady` says so.
 */
export const STUDIO_KEY = ["studio"];
/** Asset addresses are signed for an hour: read anew at half of it, as the saved references (REFERENCES_FRESH). */
const FRESH = 30 * 60_000;

export class StudioError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const notReady = (e: unknown) => e instanceof StudioError && e.status === 503 && e.message === STUDIO_NOT_READY;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/studio${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...sessionAuthHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  const out = (await res?.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res?.ok) throw new StudioError(out?.error ?? NOT_SAVED, res?.status ?? 0);
  return out as T;
}
const at = (id: string) => encodeURIComponent(id);

function useStudioRead<T>(key: unknown[], path: string, enabled: boolean) {
  /* A failed read read again drops its error while it runs (query-core fetchState: no data, so error null and pending),
     so pressing Studio emptied the menu's projects until the same answer came back (Kev, 2026-10-30: "wenn studio
     aufgeklappt und ich drücke auf studio erneut, so klappt sich das zu und öffnet sich erneut"). A page opening does
     not read a failed one again (retryOnMount), and a read again later (focus, interval) keeps the last answer. */
  const q = useQuery({
    queryKey: key, queryFn: () => call<T>("GET", path), enabled, staleTime: FRESH, refetchInterval: FRESH, retry: false, retryOnMount: false,
  });
  const [last, setLast] = useState<Error | null>(null);
  if (q.error && q.error !== last) setLast(q.error);
  else if (q.data !== undefined && last) setLast(null);
  const error = q.error ?? (q.isFetching ? last : null);
  return { data: q.data, notReady: notReady(error), error: error && !notReady(error) ? error.message : null };
}

/** The account's projects, newest first (the menu's submenu, the overview). */
export function useStudioProjects(signedIn: boolean) {
  return useStudioRead<StudioResponses["GET /projects"]>([...STUDIO_KEY, "projects"], "/projects", signedIn);
}
/** One project with everything it holds. */
export function useStudioProject(id: string | null) {
  return useStudioRead<ProjectDetail>([...STUDIO_KEY, "project", id], `/projects/${at(id ?? "")}`, !!id);
}
/** One content piece and its renders. */
export function useStudioContent(id: string | null) {
  return useStudioRead<ContentDetail>([...STUDIO_KEY, "content", id], `/contents/${at(id ?? "")}`, !!id);
}

/** The writes; each one answers once Studio is read anew, so what it changed is on screen when it resolves. */
export function useStudioApi() {
  const queryClient = useQueryClient();
  const write = <T>(method: string, path: string, body?: unknown) =>
    call<T>(method, path, body).then(async (out) => { await queryClient.invalidateQueries({ queryKey: STUDIO_KEY }); return out; });
  return {
    createProject: (input: ProjectInput) => write<StudioResponses["POST /projects"]>("POST", "/projects", input),
    updateProject: (id: string, input: Partial<ProjectInput>) => write<StudioResponses["PATCH /projects/[id]"]>("PATCH", `/projects/${at(id)}`, input),
    deleteProject: (id: string) => write<StudioResponses["DELETE /projects/[id]"]>("DELETE", `/projects/${at(id)}`),
    /** A picture as the reference picker reads it (shrunk to 1024 px), then stored; null when it could not be read. */
    addAsset: async (project: string, file: File): Promise<Asset | null> => {
      const image = await readReference(file);
      if (!image) return null;
      return (await write<StudioResponses["POST /projects/[id]/assets"]>("POST", `/projects/${at(project)}/assets`, { image })).asset;
    },
    addCharacter: (project: string, input: CharacterInput) => write<StudioResponses["POST /projects/[id]/characters"]>("POST", `/projects/${at(project)}/characters`, input),
    addStyle: (project: string, input: StyleInput) => write<StudioResponses["POST /projects/[id]/styles"]>("POST", `/projects/${at(project)}/styles`, input),
    addMasterPrompt: (project: string, input: MasterPromptInput) => write<StudioResponses["POST /projects/[id]/master-prompts"]>("POST", `/projects/${at(project)}/master-prompts`, input),
    addContent: (project: string, input: ContentInput) => write<StudioResponses["POST /projects/[id]/contents"]>("POST", `/projects/${at(project)}/contents`, input),
    updateStyle: (id: string, input: Partial<StyleInput>) => write<StudioResponses["PATCH /styles/[id]"]>("PATCH", `/styles/${at(id)}`, input),
    updateMasterPrompt: (id: string, input: Partial<MasterPromptInput>) => write<StudioResponses["PATCH /master-prompts/[id]"]>("PATCH", `/master-prompts/${at(id)}`, input),
    deleteItem: (kind: ItemKind, id: string) => write<StudioResponses["DELETE /[kind]/[id]"]>("DELETE", `/${kind}/${at(id)}`),
    updateContent: (id: string, input: Partial<ContentInput>) => write<StudioResponses["PATCH /contents/[id]"]>("PATCH", `/contents/${at(id)}`, input),
    deleteContent: (id: string) => write<StudioResponses["DELETE /contents/[id]"]>("DELETE", `/contents/${at(id)}`),
    fileImages: (content: string, imageIds: string[]) => write<StudioResponses["POST /contents/[id]/images"]>("POST", `/contents/${at(content)}/images`, { imageIds }),
    unfileImage: (content: string, imageId: string) => write<StudioResponses["DELETE /contents/[id]/images"]>("DELETE", `/contents/${at(content)}/images?imageId=${at(imageId)}`),
  };
}
export type StudioApi = ReturnType<typeof useStudioApi>;
