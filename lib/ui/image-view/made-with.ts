import type { Job } from "@/lib/ui/kit/render-queue";
import type { GenerationRow } from "./history";
import type { ImageSetup } from "./setups";
import type { Field, ValueRow } from "./variables";

/**
 * What the viewer's panel says an image was made with (Kev, 2026-10-29: "always show the prompt there for images in
 * image UI. if premium prompt, show the settings in there"; DEC-508), from what this browser already holds:
 * - a free prompt: its words, the exact text sent where the image is the viewer's own, else the prompt's public text;
 * - a premium prompt (its text is the artist's): the settings, the image's own where it is the viewer's (with the
 *   values they filled in), else the prompt's own, said as such. Someone else's settings and values are theirs
 *   (owner-view.ts), so another maker's image shows the prompt's.
 * null where nothing is known: the panel keeps its note.
 */
export type MadeWith =
  | { kind: "text"; text: string }
  | { kind: "settings"; label: string; settings: string[]; rows: ValueRow[] };

export function madeWith(
  shot: { job?: Job<ImageSetup>; record?: GenerationRow },
  p: { premium: boolean; publicText: string | null; promptSettings: string[]; fields: Field[] },
): MadeWith | null {
  const { job, record } = shot;
  if (!p.premium) {
    const text = job?.setup.prompt || record?.prompt_text || p.publicText;
    return text ? { kind: "text", text } : null;
  }
  if (job) {
    const s = job.setup;
    return { kind: "settings", label: "Made with", settings: [s.model.name, s.aspectRatio, s.resolution], rows: s.rows };
  }
  if (record?.settings) {
    const s = record.settings;
    const settings = [record.model_name, s.aspectRatio, s.resolution].filter((x): x is string => !!x);
    // By the prompt's own fields: their labels, and never an image variable's data.
    const made = record.variable_values ?? {};
    const rows = p.fields.flatMap((f) => (f.key in made ? [{ name: f.label, value: made[f.key] }] : []));
    if (settings.length || rows.length) return { kind: "settings", label: "Made with", settings, rows };
  }
  return p.promptSettings.length ? { kind: "settings", label: "This prompt's settings", settings: p.promptSettings, rows: [] } : null;
}
