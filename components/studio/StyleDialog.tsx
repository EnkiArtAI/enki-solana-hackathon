"use client";

import { useState } from "react";
import AutosizeTextarea from "@/components/kit/AutosizeTextarea";
import { notify } from "@/components/kit/notify";
import { Icon } from "@/components/enki-shell/icons";
import { useStudioApi } from "@/hooks/useStudio";
import { MAX_PALETTE, NAME_NEEDED, STUDIO_TEXT, type Style } from "@/lib/studio/types";
import { counter, paletteProblem } from "@/lib/ui/studio/fields";
import { Field } from "./DetailFields";
import StudioDialog from "./StudioDialog";

/**
 * A project's style (Kev, 2026-10-30: "styles and master prompts must also be set up there, so that the brand ID stays
 * the same ... as the color schema might also switch between contents"): a name, the words it adds to a prompt, and up to
 * six colours, each a native colour picker with its hex beside it.
 */
export default function StyleDialog({ project, style, onClose }: { project: string; style?: Style; onClose: () => void }) {
  const api = useStudioApi();
  const [name, setName] = useState(style?.name ?? "");
  const [words, setWords] = useState(style?.words ?? "");
  const [palette, setPalette] = useState<string[]>(style?.palette ?? []);
  const [error, setError] = useState<{ field: "name" | "palette"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    if (!name.trim()) return setError({ field: "name", message: NAME_NEEDED });
    const bad = paletteProblem(palette);
    if (bad) return setError({ field: "palette", message: bad });
    setBusy(true);
    const input = { name: name.trim(), words: words.trim(), palette: palette.map((c) => c.toLowerCase()) };
    try {
      await (style ? api.updateStyle(style.id, input) : api.addStyle(project, input));
      onClose();
    } catch (e) {
      notify((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const setColour = (i: number, c: string) => { setPalette((p) => p.map((x, j) => (j === i ? c : x))); setError(null); };

  return (
    <StudioDialog title={style ? "Edit style." : "New style."} onClose={onClose}
      foot={<>
        <button type="button" className="st-btn st-btn--quiet" onClick={onClose}>Cancel</button>
        <button type="button" className="st-btn st-btn--cta" aria-disabled={!name.trim() || busy || undefined} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <Field label="Name" count={counter(name, STUDIO_TEXT.name, STUDIO_TEXT.name - 10)} error={error?.field === "name" ? error.message : null}>
        <input className="st-input" data-autofocus value={name} maxLength={STUDIO_TEXT.name} placeholder="Warm film" autoComplete="off"
          onChange={(e) => { setName(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />
      </Field>
      <Field label="Words" count={counter(words, STUDIO_TEXT.words, STUDIO_TEXT.words - 40)}>
        <AutosizeTextarea className="st-input st-area" value={words} onChange={setWords} min={72} max={180} growOnly={false}
          maxLength={STUDIO_TEXT.words} placeholder="warm film grain, soft daylight" />
      </Field>
      <div className="st-field">
        <span className="st-field-head"><span className="kit-label">Palette</span><span className="st-count">{palette.length} / {MAX_PALETTE}</span></span>
        <div className="st-palette">
          {palette.map((c, i) => (
            <span key={i} className="st-swatch">
              <input type="color" value={c} aria-label={`Colour ${i + 1}`} onChange={(e) => setColour(i, e.target.value)} />
              <span className="st-hex">{c.toLowerCase()}</span>
              <button type="button" className="st-x st-x--inline kit-hit" aria-label={`Remove colour ${i + 1}`}
                onClick={() => setPalette((p) => p.filter((_, j) => j !== i))}><Icon name="x" size={11} stroke={2.4} /></button>
            </span>
          ))}
          {palette.length < MAX_PALETTE && (
            <button type="button" className="st-btn st-btn--small" onClick={() => setPalette((p) => [...p, "#7d1d33"])}>
              <Icon name="plus" size={13} stroke={2} />Colour
            </button>
          )}
        </div>
        {error?.field === "palette" && <span className="st-err" role="alert">{error.message}</span>}
      </div>
    </StudioDialog>
  );
}
