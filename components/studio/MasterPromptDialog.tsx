"use client";

import { useState } from "react";
import AutosizeTextarea from "@/components/kit/AutosizeTextarea";
import { notify } from "@/components/kit/notify";
import { useStudioApi } from "@/hooks/useStudio";
import { NAME_NEEDED, PROMPT_NEEDED, STUDIO_TEXT, type MasterPrompt } from "@/lib/studio/types";
import { counter } from "@/lib/ui/studio/fields";
import { Field } from "./DetailFields";
import StudioDialog from "./StudioDialog";

/** A project's master prompt (Kev, 2026-10-30: "styles and master prompts must also be set up there"): a name and the
 *  words every content piece can open Create with. */
export default function MasterPromptDialog({ project, master, onClose }: { project: string; master?: MasterPrompt; onClose: () => void }) {
  const api = useStudioApi();
  const [name, setName] = useState(master?.name ?? "");
  const [prompt, setPrompt] = useState(master?.prompt ?? "");
  const [error, setError] = useState<{ field: "name" | "prompt"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    if (!name.trim()) return setError({ field: "name", message: NAME_NEEDED });
    if (!prompt.trim()) return setError({ field: "prompt", message: PROMPT_NEEDED });
    setBusy(true);
    try {
      const input = { name: name.trim(), prompt: prompt.trim() };
      await (master ? api.updateMasterPrompt(master.id, input) : api.addMasterPrompt(project, input));
      onClose();
    } catch (e) {
      notify((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <StudioDialog title={master ? "Edit master prompt." : "New master prompt."} onClose={onClose}
      foot={<>
        <button type="button" className="st-btn st-btn--quiet" onClick={onClose}>Cancel</button>
        <button type="button" className="st-btn st-btn--cta" aria-disabled={!name.trim() || !prompt.trim() || busy || undefined} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </>}>
      <Field label="Name" count={counter(name, STUDIO_TEXT.name, STUDIO_TEXT.name - 10)} error={error?.field === "name" ? error.message : null}>
        <input className="st-input" data-autofocus value={name} maxLength={STUDIO_TEXT.name} placeholder="Launch voice" autoComplete="off"
          onChange={(e) => { setName(e.target.value); setError(null); }} />
      </Field>
      <Field label="Prompt" count={counter(prompt, STUDIO_TEXT.prompt, STUDIO_TEXT.prompt - 400)} error={error?.field === "prompt" ? error.message : null}>
        <AutosizeTextarea className="st-input st-area" value={prompt} onChange={(v) => { setPrompt(v); setError(null); }} min={120} max={320} growOnly={false}
          maxLength={STUDIO_TEXT.prompt} placeholder="The words every content piece starts from" />
      </Field>
    </StudioDialog>
  );
}
