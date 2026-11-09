import { CLOSEST_LIMIT, CORE_FILLER, HANDLE_MAX, HANDLE_MIN, HANDLE_RE, RESERVED_HANDLES, BAD_HANDLE, HANDLE_RESERVED_SAID } from "@/lib/communities/types";

/**
 * A community's handle rules, shared by the server and the client (pure; agreed 2026-10-30: one handle c/<handle> that
 * "cant be duplicated": "case, separators, confusable letters collide"; Kev: "ich hab kb, dass es aber auch duplikate
 * gibt wie gundam 1, gundam 2"). slugify makes a handle of typed text, handleKey is what a handle is unique and found by
 * (SQL 54's community_key() is the same function; lib/__tests__/communities-migration.test.ts compares them), coreWord
 * groups possible duplicates for the merge queue, textKeys feeds the soft suggestion, rankMatches orders the typeahead
 * and closest picks what a new community is asked about first.
 */

/** Look-alike letters folded to Latin: lib/moderation/normalize.ts's Cyrillic and Greek table (copied: that one is a
 *  security file), and Latin letters NFKD does not take apart. */
const FOLD: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "і": "i", "с": "c", "р": "p", "х": "x", "у": "y", "к": "k", "м": "m", "н": "h", "т": "t", "в": "b",
  "α": "a", "ε": "e", "ο": "o", "ι": "i", "ν": "v", "ρ": "p", "τ": "t", "υ": "u", "κ": "k", "χ": "x",
  "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "ł": "l", "đ": "d",
};

/** Typed text as handle tokens joined by "_", uncut: accents dropped, look-alikes folded, lower case, every other
 *  character a separator. */
function tokens(raw: string): string {
  const folded = [...raw.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()].map((ch) => FOLD[ch] ?? ch).join("");
  return folded.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** A handle candidate of typed text: "Gundam Wing!" → gundam_wing, "Pеpe" (a Cyrillic е) → pepe; "" when nothing is left.
 *  A search word is cut at its own length. */
export function slugify(raw: string, max: number = HANDLE_MAX): string {
  return tokens(raw).slice(0, max).replace(/_+$/, "");
}

/** What a handle (or a search word) is unique and found by: separators gone, rn → m, vv → w, the digits 0 1 3 4 5 7 read
 *  as o l e a s t. gund4m, Gundam_ and gundam are one key. Exactly SQL 54's community_key(). */
export function handleKey(h: string): string {
  const DIGITS: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t" };
  return h.toLowerCase().replaceAll("_", "").replaceAll("rn", "m").replaceAll("vv", "w").replace(/[013457]/g, (d) => DIGITS[d]);
}

const RESERVED_KEYS = new Set(RESERVED_HANDLES.map(handleKey));

/** Why a handle cannot be taken, or null when it can: its shape, or a name of Enki's (look-alikes included: c/0fficial). */
export function checkHandle(h: string): string | null {
  if (h.length < HANDLE_MIN || h.length > HANDLE_MAX || !HANDLE_RE.test(h)) return BAD_HANDLE;
  return RESERVED_KEYS.has(handleKey(h)) ? HANDLE_RESERVED_SAID : null;
}

const FILLER = new Set<string>(CORE_FILLER);
// Filler glued to a name counts too (Kev, 2026-10-30: "there are vamps"; pepecoin, thepepe, gundamfans), the longest word
// first; one under 3 letters (a, an, of, on, og, hq) only apart, or "anime" would lose its "an".
const GLUED = CORE_FILLER.filter((f) => f.length >= 3).sort((a, b) => b.length - a.length);
// ii to xx; a single letter is a word (c/x, c/v), never a numeral.
const ROMAN = /^(?=[ivx]{2,}$)(xx|x?(ix|iv|v?i{0,3}))$/;

/** A handle's word without trailing digits and without filler glued to its front or end, while 3 letters or more stay:
 *  gundam2 → gundam, pepecoin → pepe, thepepe → pepe, artclub → art (filler itself, so it goes; solana stays solana). */
function bare(word: string): string {
  for (let w = word; ; ) {
    if (FILLER.has(w)) return w;
    const next = GLUED.reduce((s, f) => (s.length - f.length < 3 ? s : s.startsWith(f) ? s.slice(f.length) : s.endsWith(f) ? s.slice(0, -f.length) : s),
      w.replace(/^([a-z]{3,})\d+$/, "$1"));
    if (next === w) return w;
    w = next;
  }
}

/** What the merge queue groups by: the handle without filler words (apart or glued on), numbers, numerals and versions, as
 *  a key. gundam_1, gundam2, gundam_ii, gundam_fans and gundamfans are "gundam"; the_pepe_club, pepe_coin, pepecoin and
 *  thepepe are "pepe"; gundam_wing is "gundamwing". A handle of filler only keeps its own key (art_club → artclub). */
export function coreWord(handle: string): string {
  const kept = handle.split("_").map(bare).filter((t) => t && !FILLER.has(t) && !/^\d+$/.test(t) && !ROMAN.test(t) && !/^v\d+$/.test(t));
  return handleKey(kept.length ? kept.join("_") : handle);
}

/** The starts and ends of a key, 3 characters or longer: the cores a new community's key could hold (c/pepe's in
 *  babypepe), read by POST /api/communities before closest() judges. */
export function affixes(key: string): string[] {
  const out = new Set<string>();
  for (let n = 3; n <= key.length; n++) out.add(key.slice(0, n)).add(key.slice(-n));
  return [...out];
}

const FILLER_KEYS = new Set(CORE_FILLER.map(handleKey));
/** Keys a text could name a community by: its words, alone and in runs of two and three, as keys of three characters or
 *  more, filler left out, each once, the first 300. Only ever compared, never stored or logged. */
export function textKeys(text: string): string[] {
  const words = tokens(text).split("_").filter(Boolean);
  const keys = new Set<string>();
  for (let i = 0; i < words.length && keys.size < 300; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length && keys.size < 300; n++) {
      const key = handleKey(words.slice(i, i + n).join("_"));
      if (key.length >= 3 && !FILLER_KEYS.has(key)) keys.add(key);
    }
  }
  return [...keys];
}

const size = (c: { members: number; works: number }) => c.members + c.works;
const bySize = (a: { handle: string; members: number; works: number }, b: typeof a) => size(b) - size(a) || (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0);

export interface Rankable { handle: string; name: string; members: number; works: number; /** Keys of its search words and of the handles merged into it. */ words?: string[] }
/**
 * The typeahead's order for what was typed: the exact key, then handles that start with it, then search words that do,
 * then names that hold the text; the biggest first within each. What matches none of them is left out.
 */
export function rankMatches<T extends Rankable>(query: string, items: T[]): T[] {
  const key = handleKey(slugify(query));
  const needle = query.trim().toLowerCase();
  const classOf = (c: T) => {
    const own = handleKey(c.handle);
    if (key && own === key) return 0;
    if (key && own.startsWith(key)) return 1;
    if (key && c.words?.some((w) => w.startsWith(key))) return 2;
    return needle && c.name.toLowerCase().includes(needle) ? 3 : -1;
  };
  return items.map((c) => [classOf(c), c] as const).filter(([k]) => k >= 0)
    .sort(([ka, a], [kb, b]) => ka - kb || bySize(a, b)).map(([, c]) => c);
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

export interface Closable { handle: string; core: string; members: number; works: number }
/** Whether `key` starts or ends with another community's core, that core a word: 4 letters or more, or 3 when it is that
 *  community's whole key (c/apu's "apu" in babyapu; not the "ory" c/theory keeps once its "the" is off). */
const holds = (key: string, core: string, ofKey: string) =>
  key !== core && (core.length >= 4 || (core.length === 3 && core === ofKey)) && (key.startsWith(core) || key.endsWith(core));

/**
 * The communities a new one is asked about first (agreed 2026-10-30: "Es gibt schon c/gundam (1.2k) - trotzdem neu?"):
 * the same core word, then a key one or two edits away (one under 6 characters), then a key that starts the other with
 * at most 3 characters more, then a key that starts or ends with the other's core (a vamp: babypepe and c/pepe); the
 * biggest first within each, up to CLOSEST_LIMIT.
 */
export function closest<T extends Closable>(handle: string, candidates: T[]): T[] {
  const key = handleKey(handle);
  const core = coreWord(handle);
  const classOf = (c: T) => {
    const other = handleKey(c.handle);
    if (c.core === core) return 0;
    if (distance(key, other) <= (key.length < 6 ? 1 : 2)) return 1;
    const [short, long] = key.length <= other.length ? [key, other] : [other, key];
    if (long.startsWith(short) && long.length - short.length <= 3) return 2;
    return holds(key, c.core, other) || holds(other, core, key) ? 3 : -1;
  };
  return candidates.map((c) => [classOf(c), c] as const).filter(([k]) => k >= 0)
    .sort(([ka, a], [kb, b]) => ka - kb || bySize(a, b)).slice(0, CLOSEST_LIMIT).map(([, c]) => c);
}
