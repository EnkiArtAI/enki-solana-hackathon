import type { HuntVariable } from "@/lib/hunter/creator-types";

/**
 * A hunted prompt's variables in Enki's form (Kev, 2026-10-31: "bei so nen klammern im prompt muss dabei das umgeformt
 * werden in Variable_name = variable_value und das im prompt dann implementiert werden. manche prompts werden das bereits
 * haben"). A definition "[ BRAND NAME = _____ ]" becomes the line "BRAND NAME = [BRAND NAME]" with a variable of that
 * name, its value as the default ("[ MATERIAL COLOR = vivid acid chartreuse]" keeps "vivid acid chartreuse"); a plain
 * "[slot]" already in the text gets its variable too. A slot without a value ("[PERSONE]", a blank of underscores) takes
 * its own name: a release refuses an empty one, and the prompt then reads as its creator wrote it (Kev, 2026-10-31:
 * "Every [slot] needs a variable with a value — missing or empty: PERSONE ... das muss gefixt werden"). Client-safe.
 */
const DEFINITION = /\[\s*([A-Za-z][\w \-]{0,39}?)\s*=\s*([^\]\n]*)\]/g;
const blank = (v: string) => /^[\s_.\-–—]*$/.test(v);

/**
 * A prompt written inside one pair of brackets is no slot: the pair goes, as does an opening bracket that never closes
 * (Kev, 2026-11-01: @AmirMushich's "[A hand-drawn infographic sketch ... warm feel.]" kept its brackets; "[Generate ...
 * of [ANYTHING]\"" opens one it never closes). A prompt that starts with a slot ("[BRAND NAME] | ...") stays.
 */
export function unwrap(prompt: string): string {
  const text = prompt.trim();
  if (!text.startsWith("[")) return prompt;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") depth += 1;
    else if (text[i] === "]" && --depth === 0) return i === text.length - 1 && !SLOT_ONLY.test(text) ? text.slice(1, -1).trim() : prompt;
  }
  // Its stray closing quote goes with it: the bracket and the quote were the pair ("[Generate ... [ANYTHING]\"").
  const open = text.slice(1).trim();
  return (open.match(/"/g)?.length ?? 0) % 2 ? open.replace(/"$/, "") : open;
}
const SLOT_ONLY = /^\[[A-Za-z][\w \-]{0,39}\]$/;

/**
 * The [slots] a release asks a value for, read as app/api/prompt/route.ts reads them: any text in brackets on one line,
 * trimmed. A narrower read gave "[LANDMARK/BUILDING NAME]" no variable, and the release refused the find (Kev,
 * 2026-11-01: fifteen approvals answered 409).
 */
export const slotNames = (prompt: string): string[] =>
  [...new Set(Array.from(prompt.matchAll(/\[([^\]\n]+)\]/g), (m) => m[1].trim()).filter(Boolean))];

const variableOf = (name: string, value: string, position: number): HuntVariable =>
  ({ name, label: name, description: "", type: "text", defaultValue: blank(value) ? name : value.trim(), required: true, position });

/**
 * A find's variables for its release: one for every slot of its prompt as it stands (perhaps edited by hand), the ones
 * it kept first with their values (a blank one takes its name), a slot without one its own name.
 */
export function slotVariables(prompt: string, kept: HuntVariable[]): HuntVariable[] {
  const byName = new Map(kept.map((v) => [v.name.trim(), v]));
  return slotNames(prompt).map((name, i) => {
    const v = byName.get(name);
    return v ? { ...v, position: i, defaultValue: String(v.defaultValue ?? "").trim() || name } : variableOf(name, "", i);
  });
}

export function importVariables(prompt: string): { prompt: string; variables: HuntVariable[] } {
  const vars = new Map<string, HuntVariable>();
  const add = (raw: string, value: string) => {
    const name = raw.trim();
    if (!name || vars.has(name)) return;
    vars.set(name, variableOf(name, value, vars.size));
  };
  const text = unwrap(prompt).replace(DEFINITION, (_m, name: string, value: string) => {
    add(name, value);
    return `${name.trim()} = [${name.trim()}]`;
  });
  for (const name of slotNames(text)) add(name, "");
  return { prompt: text, variables: [...vars.values()] };
}
