/**
 * Whether the text read off a render repeats an artist's hidden words (ENC review, 2026-10-27: a buyer's value can
 * tell the image model to typeset the prompt around it, and the judge on the inputs can miss a paraphrase). Only the
 * artist's own words count: every [slot] holds a buyer's value, and a short quoted phrase is text the artist wrote to
 * be shown in the image. Words are compared within one stretch of the artist's text, never across a slot or a quote.
 */
const SLOT = /\[[^\]\n]+\]/g;
/* Double quotes not after a digit (6" is an inch), typographic ones, and single ones that open and close outside a
   word, so an apostrophe (artist's) never opens one (review wf_866ba07b-01a). */
const QUOTE = /(?<!\d)"[^"\n]*"|“[^”\n]*”|„[^“”\n]*[“”]|«[^»\n]*»|(?<![\p{L}\p{N}])['‘][^'’\n]+['’](?![\p{L}\p{N}])/gu;
/** A quoted phrase this long or shorter is lettering the artist wrote to be shown; a longer one is compared (a JSON-style text). */
export const QUOTE_MAX_WORDS = 12;

const words = (s: string): string[] =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const grams = (ws: string[], n: number): string[] =>
  ws.length < n ? [] : Array.from({ length: ws.length - n + 1 }, (_, i) => ws.slice(i, i + n).join(" "));

/** The artist's own words, a stretch between two slots or quotes at a time; a long quote is a stretch of its own. */
function stretchesOf(template: string): string[][] {
  return template.split(SLOT).flatMap((part) => {
    const out: string[][] = [];
    let last = 0;
    for (const m of part.matchAll(QUOTE)) {
      out.push(words(part.slice(last, m.index)));
      const quoted = words(m[0]);
      if (quoted.length > QUOTE_MAX_WORDS) out.push(quoted);
      last = (m.index ?? 0) + m[0].length;
    }
    out.push(words(part.slice(last)));
    return out;
  });
}

/** A run of this many of the artist's words in a row, read off the image, is their text. */
export const HIDDEN_RUN = 6;
/** Or this share of the artist's three-word runs, once there are enough of them to say so. */
export const HIDDEN_SHARE = 0.3;
const MIN_TRIGRAMS = 10;

export function showsHiddenText(visible: string, template: string): boolean {
  const seen = words(visible);
  if (seen.length < 3) return false;
  const stretches = stretchesOf(template);
  const seenRuns = new Set(grams(seen, HIDDEN_RUN));
  if (stretches.some((ws) => grams(ws, HIDDEN_RUN).some((g) => seenRuns.has(g)))) return true;
  const artist = new Set(stretches.flatMap((ws) => grams(ws, 3)));
  if (artist.size < MIN_TRIGRAMS) return false;
  const seenTri = new Set(grams(seen, 3));
  let shared = 0;
  for (const g of artist) if (seenTri.has(g)) shared++;
  return shared / artist.size >= HIDDEN_SHARE;
}
