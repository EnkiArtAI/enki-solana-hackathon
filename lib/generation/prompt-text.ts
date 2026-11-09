/**
 * The text of a marketplace prompt, read on the server.
 *
 * A paid prompt's body is encrypted at rest and never leaves the server: the
 * buyer pays for generations from it, not for the text. Both paid rails build
 * the final prompt here from the stored text and the buyer's variable values.
 * The human rail used to generate from whatever the client sent, which for a
 * paid prompt was the title plus the variables, so the buyer paid the artist
 * and got an image that was not made from the artist's prompt.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptPrompt } from "@/backend/encryption";
import { isListed, isPublicText } from "@/lib/prompt-visibility";
import { dbOutage, isDbUnreachable, type DbOutage } from "@/lib/db-error";
import { slug, storedName } from "@/lib/generation/stored-name";

export { storedName };

/** A stored variable, by the name app/api/prompt saved it under. */
export interface StoredVariable {
  name: string;
  /**
   * Its stored data_type (text when absent), whether a value is required, what the composer offers it as the
   * artist's own text (a pick's promptValues, a ticked checkbox's text), and its stored default as the composer
   * starts it (rounds 13 to 15, 2026-10-20).
   */
  type?: string;
  required?: boolean;
  choices?: string[];
  defaultValue?: string;
  /** A slider's stored range, where it has one. */
  min?: number;
  max?: number;
}

/** The types the composer asks as a pick when they carry options; without, it asks them as text (lib/ui/kit/fields.ts fieldKind). */
const CHOICE_TYPES: ReadonlySet<string> = new Set(["single_select", "radio", "multi_select"]);

function choicesOf(v: Record<string, unknown>): string[] {
  // A ticked checkbox sends its description, else its label, else its name (lib/ui/image-view/variables.ts sendValue).
  if (v.data_type === "checkbox") return [String(v.description || v.label || v.name)];
  if (!CHOICE_TYPES.has(String(v.data_type)) || !Array.isArray(v.options)) return [];
  return v.options.flatMap((o) => (o && typeof o.promptValue === "string" ? [o.promptValue as string] : []));
}

export type PromptTextResult =
  /** listed: on sale now; a buyer who quoted it before it left may not render it (DEC-441). */
  | { ok: true; text: string; variables: StoredVariable[]; adult: boolean; listed: boolean }
  | { ok: false; status: 422 | 500; error: string }
  | DbOutage;

export async function loadPromptText(supabase: SupabaseClient, promptId: string): Promise<PromptTextResult> {
  const { data: row, error } = await supabase
    .from("prompts")
    .select("public_prompt_text, encrypted_content, encrypted_content_iv, encrypted_content_tag, encrypted_content_kid, price_usd_cents, prompt_type, is_free_showcase, is_adult, is_listed, listing_status, deleted_at")
    .eq("id", promptId)
    .maybeSingle();
  if (isDbUnreachable(error)) return dbOutage();
  if (error || !row) return { ok: false, status: 500, error: "Failed to load prompt" };

  let text = "";
  let unreadable = false;
  if (row.encrypted_content) {
    try {
      text = decryptPrompt({
        encryptedContent: String(row.encrypted_content),
        iv: String(row.encrypted_content_iv ?? ""),
        authTag: String(row.encrypted_content_tag ?? ""),
        kid: row.encrypted_content_kid ? String(row.encrypted_content_kid) : undefined,
      });
    } catch {
      console.error("[prompt-text] could not decrypt prompt", promptId);
      unreadable = true;
    }
  }
  /* A priced prompt never falls back to its public excerpt (the first 220
     characters): the buyer would pay the artist for an image the artist's
     prompt never made. Refused before anything is charged. Free and showcase
     prompts are public text anyway. */
  const priced = Number(row.price_usd_cents) > 0 && !isPublicText(row);
  // A key that cannot open a priced text is Enki's (500); a priced text that is empty is its creator's, no readable
  // text (422, below) (round 11, 2026-10-20).
  if (unreadable && priced) {
    return { ok: false, status: 500, error: "This prompt's text cannot be read right now. Nothing was generated and nothing was charged." };
  }
  if (!text.trim() && !priced) text = String(row.public_prompt_text ?? "");
  if (!text.trim()) return { ok: false, status: 422, error: "This prompt has no readable text to generate from" };

  const { data: vars, error: varsError } = await supabase
    .from("prompt_variables")
    .select("name, data_type, is_required, options, default_value, description, label, min_value, max_value")
    .eq("prompt_id", promptId)
    .is("deleted_at", null)
    .order("position", { ascending: true });
  // A failed read is not "no variables": fillVariables would then miss a value stored under a slug or a tie-break
  // name, and the image would render without the buyer's input (round 10, 2026-10-20).
  if (isDbUnreachable(varsError)) return dbOutage();
  if (varsError) return { ok: false, status: 500, error: "Failed to load prompt" };
  const variables = ((vars ?? []) as Array<Record<string, unknown>>)
    .filter((v) => typeof v.name === "string")
    .map((v) => ({
      name: String(v.name), type: String(v.data_type ?? "text"), required: v.is_required === true, choices: choicesOf(v),
      // As the composer starts it: none is "" (lib/ui/image-view/variables.ts initialValues).
      defaultValue: v.default_value == null ? "" : String(v.default_value),
      ...(typeof v.min_value === "number" ? { min: v.min_value } : {}), ...(typeof v.max_value === "number" ? { max: v.max_value } : {}),
    }));
  return { ok: true, text, variables, adult: row.is_adult === true, listed: isListed(row) };
}

/**
 * The shortest value the web composer can send for a stored variable: an image's stored default (it takes no input,
 * so its default goes as it stands); nothing for a checkbox left unticked or an optional multi-select left empty; for a
 * pick, the shortest of its options and the default it starts with; one character for anything typed (rounds 13, 14,
 * 2026-10-20: round 12 sent one character for every field).
 */
export function shortestValue(v: StoredVariable): string {
  if (v.type === "reference_image") return v.defaultValue ?? "";
  if (v.type === "checkbox" || (v.type === "multi_select" && !v.required)) return "";
  const options = v.choices ?? [];
  const sendable = [...options, ...(options.length && v.defaultValue ? [v.defaultValue] : [])].filter((c) => c.trim() !== "");
  return sendable.length ? sendable.reduce((a, b) => (b.length < a.length ? b : a)) : "x";
}

/**
 * The values that are the buyer's own: every one a stored variable did not supply itself. Its stored default as the
 * composer starts it, one of its options (or a multi-select of them) and a ticked checkbox's text are the artist's
 * text, which the buyer at most chose; the prompt check judges them as the buyer's no more (round 15, 2026-10-20: an
 * artist's default an image field sends untouched struck the buyer, and three strikes ban).
 */
export function buyersOwn(values: unknown, variables: StoredVariable[]): Record<string, unknown> {
  if (!values || typeof values !== "object") return {};
  return Object.fromEntries(Object.entries(values as Record<string, unknown>).filter(([key, value]) => {
    const v = variables.find((x) => x.name === key);
    if (!v || typeof value !== "string") return true;
    return !artistsText(v, value);
  }));
}

/** What a buyer's typed text becomes when the artist's text is judged on its own (DEC-441). */
export const NEUTRAL_VALUE = "something";

/**
 * The artist's text as no buyer's words could have made it: every value the buyer typed (buyersOwn, not blank)
 * becomes NEUTRAL_VALUE; the artist's defaults and options stay as chosen, and so does a slider's number inside the
 * slider's own range. A number typed anywhere else is the buyer's words (an age into a text field; review
 * wf_866ba07b-01a). Our moderation judges this when the filled text was refused: blocked here, the refusal is the
 * artist's text (Kev's sketch, 2026-10-21).
 */
export function neutralFill(text: string, values: unknown, variables: StoredVariable[]): string {
  const vals = values && typeof values === "object" ? (values as Record<string, unknown>) : {};
  const own = buyersOwn(vals, variables);
  const inRange = (k: string, v: string) => {
    const field = variables.find((x) => x.name === k);
    const n = /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
    return (field?.type === "slider" || field?.type === "number") && Number.isFinite(n)
      && (field.min == null || n >= field.min) && (field.max == null || n <= field.max);
  };
  const typed = (k: string, v: unknown) => typeof v === "string" && v.trim() !== "" && !inRange(k, v);
  return fillVariables(text, Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, k in own && typed(k, v) ? NEUTRAL_VALUE : v])), variables).text;
}

/** A value as the agent rail cleans a paid prompt's text (lib/generation/agent-prompt-inputs.ts fit): one line, single spaces. */
const plain = (text: string) => text.replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Whether a value is the artist's own text for its field: its default or one of its options, as the web sends it or
 * as the agent rail cleans a paid prompt's text (rounds 15, 16), or several options joined (round 17).
 */
function artistsText(v: StoredVariable, value: string): boolean {
  const options = v.choices ?? [];
  const same = (text: string) => value === text || plain(value) === plain(text);
  return same(v.defaultValue ?? "") || options.some(same) || joinedOptions(value, options);
}

/**
 * Whether the value is options joined by commas, each read trimmed, as the web joins raw promptValues (",") and the
 * agent rail joins trimmed ones (", "); an option may hold a comma, and an empty piece counts only when the field has
 * a blank option. Read from the left, each position tried once, so no value can make it slow (round 17, 2026-10-20:
 * round 16 read the cleaned joined value, which an option ending in a space or a bracket broke, and its recursion
 * without a memo took exponential time).
 */
function joinedOptions(value: string, options: string[]): boolean {
  const trimmed = [...new Set(options.map((o) => o.trim()))];
  const blank = trimmed.includes("");
  const words = trimmed.filter(Boolean);
  const unreadable = new Set<number>();
  const skip = (i: number) => { while (i < value.length && /\s/.test(value[i])) i++; return i; };
  // Past one piece: the end, or a comma and the rest read from there.
  const after = (i: number): boolean => { const j = skip(i); return j === value.length || (value[j] === "," && from(j + 1)); };
  const from = (i: number): boolean => {
    if (unreadable.has(i)) return false;
    const k = skip(i);
    const read = words.some((w) => value.startsWith(w, k) && after(k + w.length)) || (blank && after(k));
    if (!read) unreadable.add(i);
    return read;
  };
  return value.trim() !== "" && from(0);
}

/**
 * The shortest prompt the web composer can send: the shortest value under every stored variable's name (round 12,
 * 2026-10-20). Unmatched, no web buyer can fill the text at all (a slot saved as var_N, a tie-break the text cannot
 * place); longer than a host takes, no web buyer's values can be short enough. Both are the artist's doing, not the
 * buyer's.
 */
export function shortestWebFill(text: string, variables: StoredVariable[]): Filled {
  return fillVariables(text, Object.fromEntries(variables.map((v) => [v.name, shortestValue(v)])), variables);
}

/**
 * The longest value a buyer may put into a slot (Kev, 2026-10-02: 300). A
 * length cap does not stop an extraction attempt, the checker on the values
 * does; it keeps the values a slot's worth of text.
 */
export const VALUE_MAX = 300;

/** The first buyer value longer than VALUE_MAX, refused before anything is charged. */
export function overLong(values: unknown): string | null {
  if (!values || typeof values !== "object") return null;
  const hit = Object.entries(values as Record<string, unknown>).find(([, v]) => typeof v === "string" && v.length > VALUE_MAX);
  return hit ? hit[0] : null;
}

export interface Filled {
  text: string;
  /** Slots no value was found for. */
  unfilled: string[];
  /** Stored variables a value arrived for that no slot took. */
  unused: string[];
  /** Two different slots answer to one stored name, so one would take the other's value. */
  ambiguous: boolean;
}

/**
 * Fill the [slots] with the buyer's values. The artist's text keeps a slot
 * as typed ("[Character Design]") while the stored name, and so the key the
 * buyer's values arrive under, is what toDbVarName made of it
 * ("character_design", "v_2nd_subject"). Each slot resolves by its exact
 * text, then by that stored name, then by its plain slug (an agent sending
 * its own keys). Labels are never used: they hold the text the artist
 * selected, not the slot, and could hand one variable's value to another.
 */
export function fillVariables(text: string, values: unknown, variables: StoredVariable[] = []): Filled {
  const vals = values && typeof values === "object" ? (values as Record<string, unknown>) : {};
  const names = new Set(variables.map((v) => v.name));
  const used = new Set<string>();
  const unfilled: string[] = [];
  /* Ambiguity, decided before filling. When two different slots slug alike
     ("[Hero]", "[hero!]"), toDbVarName saved the second as a tie-break
     (hero_2, hero_3, …) that no slot's own name produces. A tie-break name
     that no slot names itself therefore means the text cannot say which
     value belongs where. One slot written twice ("[subject]", "[ subject ]")
     is one variable and has no tie-break; a typed "hero 2" names hero_2
     itself and is not one. */
  const slotted = new Set<string>();
  for (const m of text.matchAll(/\[([^\]\n]+)\]/g)) {
    const sn = storedName(m[1]);
    if (sn && names.has(sn)) slotted.add(sn);
  }
  const tieBreakOf = (n: string, sn: string) => n.startsWith(`${sn}_`) && /^\d+$/.test(n.slice(sn.length + 1));
  const ambiguous = [...slotted].some((sn) => [...names].some((n) => tieBreakOf(n, sn) && !slotted.has(n)));

  const take = (key: string | null | undefined) => {
    const v = key ? vals[key] : undefined;
    if (typeof v !== "string" || v.length > VALUE_MAX) return undefined;
    used.add(key as string);
    return v;
  };

  const out = text.replace(/\[([^\]\n]+)\]/g, (slot, name: string) => {
    const sn = storedName(name);
    const v = take(name) ?? (sn && names.has(sn) ? take(sn) : undefined) ?? take(slug(name));
    if (v === undefined) {
      unfilled.push(name);
      return slot;
    }
    return v;
  });

  // Every value that reached no slot: a stored variable's, or any non-empty one under a key the text no longer has (a
  // slot renamed after the buyer loaded the prompt rendered literally and was charged) (round 12, 2026-10-20).
  const unused = [
    ...variables.map((v) => v.name).filter((n) => !used.has(n) && typeof vals[n] === "string"),
    ...Object.keys(vals).filter((n) => !names.has(n) && !used.has(n) && typeof vals[n] === "string" && (vals[n] as string).trim() !== ""),
  ];
  return { text: out, unfilled, unused, ambiguous };
}

/** True when the buyer's inputs cannot be matched to the text with certainty. */
export function inputsUnmatched(f: Filled): boolean {
  return f.ambiguous || (f.unfilled.length > 0 && f.unused.length > 0);
}
