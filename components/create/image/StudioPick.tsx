"use client";

import { useState } from "react";
import type { Shot } from "@/components/image-view/useImageViewModel";
import KeepInStudio from "@/components/studio/KeepInStudio";
import { StudioScope, useStudioScope } from "@/components/studio/StudioScope";
import { useStudioProject, useStudioProjects } from "@/hooks/useStudio";
import { STUDIO_NOT_READY } from "@/lib/studio/types";

const NONE: ReadonlySet<string> = new Set();

/**
 * Add to Studio (Kev, 2026-10-30: "Add to Studio -> studio auswahl"): the account's projects, then the one picked keeps
 * the render as Studio keeps one from the viewer (KeepInStudio: as a character, or into the content piece Create works
 * in when that is this project's). Before SQL 53 has run every Studio route answers 503 and this says so, as the wizard
 * does.
 */
export default function StudioPick({ shot, promptId }: { shot: Shot; promptId: string | null }) {
  const [id, setId] = useState<string | null>(null);
  const { data, notReady, error } = useStudioProjects(true);
  if (id) return <StudioKeep id={id} shot={shot} promptId={promptId} />;
  const said = notReady ? STUDIO_NOT_READY : error ?? (!data ? "Loading your projects…" : data.projects.length ? null : "No projects yet. Start one in Studio.");
  if (said || !data) return <p className="ci-menu-note" role="status">{said}</p>;
  return (
    <div className="kit-opts" role="menu" aria-label="Your projects">
      {data.projects.map((p) => (
        <button key={p.id} type="button" role="menuitem" className="kit-opt" onClick={() => setId(p.id)}>
          <span>{p.name}</span>
        </button>
      ))}
    </div>
  );
}

/** The project picked, read whole, around the viewer's own Keep. */
function StudioKeep({ id, shot, promptId }: { id: string; shot: Shot; promptId: string | null }) {
  const here = useStudioScope();
  const { data, notReady, error } = useStudioProject(id);
  if (!data) return <p className="ci-menu-note" role="status">{notReady ? STUDIO_NOT_READY : error ?? "Loading the project…"}</p>;
  const same = here?.project.project.id === id ? here : null;
  return (
    <div className="ci-keep">
      <StudioScope value={{ project: data, content: same?.content ?? null, filed: same?.filed ?? NONE, sheet: null }}>
        <KeepInStudio shot={shot} promptId={promptId} guest={false} />
      </StudioScope>
    </div>
  );
}
