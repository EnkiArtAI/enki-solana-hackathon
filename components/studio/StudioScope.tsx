"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useStudioContent, useStudioProject } from "@/hooks/useStudio";
import type { Content, ProjectDetail } from "@/lib/studio/types";
import type { ImageViewSeed } from "@/lib/ui/image-view/seed";
import { PANEL_BACK } from "@/lib/ui/kit/shell-nav";
import { withoutSheet, type CreateAt } from "@/lib/ui/studio/links";

/**
 * The project Create works in (Kev, 2026-10-30: "in that folder of a project i can click "+ Content" ... There I have
 * access to my reference images from that project and characters"): the project with all it holds, the content piece
 * when there is one (its renders' ids in `filed`), and the character sheet open in the image view. CreateView provides
 * it around Create > Image only; React hands it through portals, so the reference picker, the viewer and the sheet's
 * image view read it too. Null everywhere else: the feed and the profiles do not change.
 */
export interface StudioScopeValue {
  project: ProjectDetail;
  content: Content | null;
  filed: ReadonlySet<string>;
  sheet: string | null;
}

const Scope = createContext<StudioScopeValue | null>(null);

export function StudioScope({ value, children }: { value: StudioScopeValue | null; children: ReactNode }) {
  return <Scope.Provider value={value}>{children}</Scope.Provider>;
}

export const useStudioScope = () => useContext(Scope);

/** The scope an address names (lib/ui/studio/links createAt), once its project is read; a content piece of another
 *  project is none. */
export function useCreateScope(at: CreateAt | null): StudioScopeValue | null {
  const project = useStudioProject(at?.project ?? null).data;
  const content = useStudioContent(at?.content ?? null).data;
  const sheet = at?.sheet ?? null;
  return useMemo(() => {
    if (!project || project.project.id !== at?.project) return null;
    const piece = content?.content.projectId === project.project.id ? content : null;
    return { project, content: piece?.content ?? null, filed: new Set(piece?.images.map((i) => i.imageId) ?? []), sheet };
  }, [project, content, sheet, at?.project]);
}

/* The sheet the picker has just opened (useOpenSheet), until its view shows and marks its entry. */
let opening: string | null = null;
export const openingSheet = (sheet: string) => { opening = sheet; };

/**
 * The character sheet the address names, open in the real image view over Create > Image (its fields, generator, price
 * and Generate are the image view's own; the project's pictures lead its picker). Picked in Studio, its entry carries the
 * shell's mark (PANEL_BACK, kept by the view's own writes), so its Back is the browser's, to the page it was picked on
 * (DEC-548's rule). A sheet's link opened fresh has no mark and closes in place, Create staying in the project (review
 * 2026-10-30: history.length counted the pages of the site before, and Esc left Enki for it).
 */
export function useSheet(): { seed: ImageViewSeed; close: () => void } | null {
  const sheet = useStudioScope()?.sheet;
  const router = useRouter();
  useEffect(() => {
    if (!sheet || opening !== sheet) return;
    opening = null;
    // Not spread from history.state: Next's patched history copies its own state in (as the shell's writePanel).
    window.history.replaceState({ [PANEL_BACK]: 1 }, "", window.location.href);
  }, [sheet]);
  if (!sheet) return null;
  return {
    seed: { promptId: sheet },
    close: () => {
      const steps = Number(window.history.state?.[PANEL_BACK]) || 0;
      if (steps) window.history.go(-steps);
      else router.replace(withoutSheet(window.location.href));
    },
  };
}
