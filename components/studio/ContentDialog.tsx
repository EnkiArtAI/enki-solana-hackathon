"use client";

import { useState } from "react";
import { notify } from "@/components/kit/notify";
import { useStudioApi } from "@/hooks/useStudio";
import type { Content, ProjectDetail } from "@/lib/studio/types";
import { plural } from "@/lib/ui/studio/copy";
import { detailsInput, detailsProblem, fieldOf, type DetailField, type Details } from "@/lib/ui/studio/fields";
import DetailFields from "./DetailFields";
import StudioDialog from "./StudioDialog";

/**
 * "+ Content" (Kev, 2026-10-30: "in that folder of a project i can click "+ Content" and then another popup comes up
 * where i set up as well Name, Description, and Link. There I have access to my reference images from that project and
 * characters"): the piece's details and what it brings along. No style or master prompt is picked here (Kev,
 * 2026-10-30: "style oder master prompts wähle ich da noch nicht aus. diese leiste da ist eher die ganze zeit
 * sichtbar"): Create's strip (StudioStrip) offers them the whole time. A new piece has none; Edit leaves a piece's own.
 */
export default function ContentDialog({ project, content, onClose, onDone }: {
  project: ProjectDetail;
  content?: Content;
  onClose: () => void;
  /** The piece as saved. */
  onDone: (content: Content) => void;
}) {
  const api = useStudioApi();
  const [details, setDetails] = useState<Details>({ name: content?.name ?? "", description: content?.description ?? "", link: content?.link ?? "" });
  const [problem, setProblem] = useState<{ field: DetailField; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const p = detailsProblem(details);
    if (p) return setProblem(p);
    setBusy(true);
    const input = detailsInput(details);
    try {
      onDone((content ? await api.updateContent(content.id, input) : await api.addContent(project.project.id, input)).content);
    } catch (e) {
      const message = (e as Error).message;
      const field = fieldOf(message);
      if (field) setProblem({ field, message });
      else notify(message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const { assets, characters } = project;

  return (
    <StudioDialog title={content ? "Edit content." : "New content."} onClose={onClose}
      foot={<>
        <button type="button" className="st-btn st-btn--quiet" onClick={onClose}>Cancel</button>
        <button type="button" className="st-btn st-btn--cta" aria-disabled={!details.name.trim() || busy || undefined} onClick={() => void save()}>
          {busy ? "Saving…" : content ? "Save" : "Create"}
        </button>
      </>}>
      <DetailFields value={details} onChange={(v) => { setDetails(v); setProblem(null); }} problem={problem} onEnter={() => void save()} />
      <p className="st-line">Brings along {plural(assets.length, "asset")}, {plural(characters.length, "character")}.</p>
    </StudioDialog>
  );
}
