import vocabulary from "./vocabulary.json";

/*
 * Vocabulary matching for search (Kev, 2026-09-24: "das muss dann kostenlos
 * sein"). No model, no paid API: a curated vocabulary of canonical tags with
 * synonyms, matched against the prompt text by n-grams, entirely in
 * this process. Runs inside the publish request on the plaintext the client
 * sent, before the body is encrypted, so only the canonical tags ever reach
 * prompts.tags and the search index. The prompt body itself is never stored
 * or indexed in the clear.
 */

export type VocabularyCategory =
  | "subject" | "format" | "style" | "medium" | "mood" | "color" | "composition" | "technique";

type Entry = { tag: string; category: VocabularyCategory; synonyms: string[] };

/* Tags say WHAT a piece is and looks like, never HOW it is made: framing and
   technique (renderer, camera, film, lighting setup, grading) are never a tag
   (Kev, 2026-10-31: "beschreibe the what, not the how", "nie high quality
   sachen verraten"). A paid body is the artist's product and tags are public:
   whoever collects them across a creator's prompts would read the recipe back
   out of them (Kev, 2026-10-07), so it yields only what it is or is for
   (format: logo, branding, poster, stop motion...) and what it shows
   (subject). Every idea is one tag (stop motion described seven times is
   one); a thing a body names once only fills up to eight; a paid body's tags
   grow with it, one per 30 words and eight at the least (Kev, 2026-10-31:
   "1/30"), while a free body, public anyway, keeps every look it names. */
const WHAT = new Set<VocabularyCategory>(["subject", "format"]);
const HOW = new Set<VocabularyCategory>(["composition", "technique"]);
export const TAGS_MIN = 8;
export const WORDS_PER_TAG = 30;
/** How many tags a text earns by its size. */
export const tagCount = (text: string) => Math.max(TAGS_MIN, Math.round(tokens(text).length / WORDS_PER_TAG));

const ENTRIES = vocabulary as Entry[];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/\[[^\]\n]*\]/g, " ")
    .replace(/\(([^()]*):\s*\d+(?:\.\d+)?\)/g, "$1")
    .replace(/'/g, "")
    .split(/[^a-z0-9&]+/)
    .filter(Boolean);
}

export const phraseKey = (phrase: string) => tokens(phrase).join(" ");

/* A term's regular plural, on its last word. A stemmer read "generate" as
   "general", "element" as "elemental" and "status" as "statue" (live
   2026-11-02: a fifth of all hits came through it), and any -ing or -ed form
   meets the noun's other meaning ("read" as "reading", "added" as "ad"), so a
   word now matches as the vocabulary spells it or as that word's plural. One
   way only: "glass" and "leave" are not "glasses" and "leaves". Where English
   has two spellings both count: "volcanos" and "volcanoes", "witches" and
   "mechs". The one nobody writes ("witchs") never occurs in a text. */
export const pluralKeys = (k: string): string[] =>
  /[^aeiou]o$/.test(k) ? [`${k}s`, `${k}es`]
    : /ch$/.test(k) ? [`${k}es`, `${k}s`]
      : [/(s|x|z|sh)$/.test(k) ? `${k}es` : /[^aeiou]y$/.test(k) ? `${k.slice(0, -1)}ies` : `${k}s`];

/* Spelling -> entry. Tags are indexed before synonyms so a tag always beats
   another entry's synonym, and every spelled term before any plural; the test
   suite proves no spelling points at two different tags. */
const INDEX = new Map<string, Entry>();
let LONGEST = 1;
function index(k: string, entry: Entry) {
  if (!INDEX.has(k)) INDEX.set(k, entry);
  LONGEST = Math.max(LONGEST, k.split(" ").length);
}
for (const entry of ENTRIES) index(phraseKey(entry.tag), entry);
for (const entry of ENTRIES) for (const synonym of entry.synonyms) index(phraseKey(synonym), entry);
for (const entry of ENTRIES) for (const term of [entry.tag, ...entry.synonyms]) {
  const k = phraseKey(term);
  for (const plural of pluralKeys(k)) index(plural, entry);
  // A phrase has no second meaning to meet: "warm color" is "warm colors".
  if (k.includes(" ") && k.endsWith("s")) index(k.slice(0, -1), entry);
}

/**
 * Canonical vocabulary tags found in the text, in order of first appearance.
 * The longest term at each position wins and owns its words: "god rays" is
 * a lighting term, never also the subject "god", and "unreal engine" never
 * leaves an "engine" behind. A body is ranked and sized (see above); a paid
 * body keeps only what it is and shows.
 */
export function extractTags(text: string, options: { body?: boolean; paid?: boolean } = {}): string[] {
  const words = tokens(text);
  const found = new Map<string, { said: number; format: boolean; subject: boolean }>();
  for (let i = 0; i < words.length; ) {
    let n = Math.min(LONGEST, words.length - i);
    let entry: Entry | undefined;
    for (; n > 0; n--) if ((entry = INDEX.get(words.slice(i, i + n).join(" ")))) break;
    if (!entry) { i++; continue; }
    i += n;
    if (HOW.has(entry.category) || (options.paid && !WHAT.has(entry.category))) continue;
    found.set(entry.tag, { said: (found.get(entry.tag)?.said ?? 0) + 1, format: entry.category === "format", subject: entry.category === "subject" });
  }
  const tags = [...found.keys()];
  if (!options.body) return tags;
  // What it is first, then by how often the body says it, first said first. A thing said once is a list's example, not
  // the prompt's core: it only fills up to the floor (live 2026-10-31: a 1,218-word logo prompt named "lawyer",
  // "airplane" and "elevator" once each).
  const ranked = tags
    .map((t, i) => ({ t, i, ...found.get(t)! }))
    .sort((a, b) => Number(b.format) - Number(a.format) || b.said - a.said || a.i - b.i);
  const once = (x: (typeof ranked)[number]) => x.said === 1 && (options.paid ? !x.format : x.subject);
  const core = ranked.filter((x) => !once(x));
  const fill = ranked.filter(once).slice(0, Math.max(0, TAGS_MIN - core.length));
  // A paid body as many as its size earns; a free body's text is public anyway, so every look it names counts.
  return [...core, ...fill].slice(0, options.paid ? tagCount(text) : undefined).map((x) => x.t);
}

/** What prompts.tags stores: the groups deduplicated, then sorted so the
    order says nothing about where in the prompt a word stood. No cap: the
    count follows the prompt's size (a body's is set in extractTags). */
export function storedTags(...groups: string[][]): string[] {
  return [...new Set(groups.flat().map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}
