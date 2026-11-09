"use client";

import { useState } from "react";
import { notify } from "@/components/kit/notify";
import type { Shot } from "@/components/image-view/useImageViewModel";
import { useStudioApi } from "@/hooks/useStudio";
import { STUDIO_TEXT } from "@/lib/studio/types";
import { useStudioScope } from "./StudioScope";
import "./studio.css";

/**
 * "Keep in <Project>" in the viewer's panel, while Create works in a project (Kev, 2026-10-30: "the result is then being
 * saved in Characters for this specific project"): one of the viewer's own renders kept as a character (named here,
 * with the sheet it was made on), or filed in the content piece by hand. A render whose row is not read yet waits; an
 * upload, someone else's picture and a guest get none of it.
 */
export default function KeepInStudio({ shot, promptId, guest }: { shot: Shot; promptId: string | null; guest: boolean }) {
  const scope = useStudioScope();
  const api = useStudioApi();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const record = shot.record;
  if (!scope || guest || (record ? record.isUploaded : shot.job?.status !== "ready")) return null;
  const { project: { project }, content, filed } = scope;
  const waiting = !record;
  const inPiece = !!record && !!content && filed.has(record.id);

  const keep = async () => {
    const n = name.trim();
    if (!record || !n || busy) return;
    setBusy(true);
    try {
      await api.addCharacter(project.id, { name: n, imageId: record.id, sheetPromptId: promptId });
      notify(`${n} is one of ${project.name}'s characters.`);
      setNaming(false);
      setName("");
    } catch (e) {
      notify((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const file = async () => {
    if (!record || !content || busy) return;
    setBusy(true);
    try {
      await api.fileImages(content.id, [record.id]);
      notify(`Filed in ${content.name}.`);
    } catch (e) {
      notify((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="st-keep" aria-label={`Keep in ${project.name}`}>
      <span className="kit-label">Keep in {project.name}</span>
      {naming ? (
        <form className="st-keep-name" onSubmit={(e) => { e.preventDefault(); void keep(); }}>
          <input className="st-input" autoFocus value={name} maxLength={STUDIO_TEXT.name} placeholder="Name, like Mira" aria-label="The character's name"
            onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="st-btn st-btn--cta" aria-disabled={!name.trim() || busy || undefined}>Keep</button>
        </form>
      ) : (
        <div className="st-keep-acts">
          <button type="button" className="st-btn" disabled={waiting} onClick={() => setNaming(true)}>As a character</button>
          {content && (
            <button type="button" className="st-btn" disabled={waiting || inPiece || busy} onClick={() => void file()}>
              {inPiece ? `In ${content.name} ✓` : `In ${content.name}`}
            </button>
          )}
        </div>
      )}
      {waiting && <p className="st-note">Saving your render…</p>}
    </section>
  );
}
