import type { TextStore } from "./draft-store";
import { namedValues } from "./named-values";
import { varNames } from "./prompt-tokens";
import type { EditorDoc } from "./undo";

export type EditorSeed = { kind: "library"; title: string; promptText: string; media?: "video" };

/** The new editor imports text, not the old node graph (plan I2). */
export function librarySeed(item: { name: string; prompt_text: string | null; media?: "video" }): EditorSeed | null {
  const text = item.prompt_text;
  // Create > Video hands over its medium whether or not it has words yet.
  if (!text?.trim() && !item.media) return null;
  if (/\{\{wf:[^}]*\}\}/i.test(text ?? "")) return null;
  return { kind: "library", title: item.name, promptText: text ?? "", ...(item.media ? { media: item.media } : {}) };
}

/** Where a handover to the editor waits, per account; a logout takes them all (draft-store forgetDrafts). */
export const SEED_PREFIX = "enki-editor-seed:v1:";
const key = (owner: string) => SEED_PREFIX + owner;

export function stashSeed(storage: TextStore | null, owner: string | null, seed: EditorSeed): boolean {
  if (!storage || !owner) return false;
  try {
    storage.setItem(key(owner), JSON.stringify(seed));
    return true;
  } catch { return false; }
}

/** Read once, after this account's draft has been restored. */
export function takeSeed(storage: TextStore | null, owner: string | null): EditorSeed | null {
  if (!storage || !owner) return null;
  try {
    const raw = storage.getItem(key(owner));
    storage.removeItem(key(owner));
    const seed: unknown = JSON.parse(raw ?? "null");
    if (!seed || typeof seed !== "object") return null;
    const s = seed as Partial<EditorSeed>;
    return s.kind === "library" && typeof s.title === "string" && typeof s.promptText === "string"
      ? librarySeed({ name: s.title, prompt_text: s.promptText, media: s.media === "video" ? "video" : undefined }) : null;
  } catch { return null; }
}

/** The imported text, its brackets as variables named and filled with their content (lib/editor/named-values). */
export function seedDoc(seed: EditorSeed): EditorDoc {
  const names = varNames(seed.promptText);
  return {
    prompt: seed.promptText,
    vars: namedValues(seed.promptText, {}),
    kinds: Object.fromEntries(names.map((n) => [n, "text" as const])),
    aiNames: [],
    refIds: [],
  };
}
