import type { El } from "./doc";
import { cutAt, type FitBlock } from "./text-layout";

/**
 * What a share card may say about a prompt. Built only from the public answer
 * of GET /api/prompts/<id>, which never holds a paid prompt's words, not even
 * for its creator; it names each field it takes, so nothing else passes. A
 * premium prompt is told by the words being absent, never by its type.
 */
export type ShareVariable = { name: string; example: string | null };
export interface ShareContent {
  title: string;
  desc: string | null;
  /** The whole prompt, free prompts only. */
  words: string | null;
  variables: ShareVariable[];
  /** Shown on the page, drawn into the export. */
  images: { src: string; full: string }[];
  media: "image" | "video";
  poster: string | null;
  generator: string | null;
  handle: string | null;
  link: string;
  hashtags: string;
  /** Per image: each variable with the value that image was made with. */
  setups: ShareVariable[][];
  /** Stands in for a prompt, and says so: a creator without one lays out their style on it. */
  sample?: boolean;
}

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === "object") : []);

/**
 * The example a variable shows: its default (an option's name when it is one of
 * the options), else the first option's, else nothing, and the name stands
 * alone. A default that only repeats the name shows once (hunted prompts). A
 * checkbox shows what it sends.
 */
export function exampleOf(v: Rec): string | null {
  if (v.type === "image") return null;
  if (v.type === "checkbox") return str(v.description) ?? str(v.label);
  const name = str(v.name), label = str(v.label), options = recs(v.options);
  const optionText = (o: Rec | undefined) => (o ? str(o.visibleName) ?? str(o.promptValue) : null);
  const stored = v.defaultValue === null || v.defaultValue === undefined ? null : str(String(v.defaultValue));
  const example = stored ? optionText(options.find((o) => o.promptValue === stored)) ?? stored : optionText(options[0]);
  return example === name || example === label ? null : example;
}

const nameOf = (v: Rec) => (v.type === "checkbox" ? str(v.name) : str(v.label) ?? str(v.name)) ?? "";
const squash = (name: string) => name.replace(/\(.*?\)/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** A real description; an import's stored note ("Imported from ...") is none. */
const realDesc = (v: unknown) => {
  const d = str(v);
  return d && !d.startsWith("Imported from ") ? d : null;
};

/** A value an image was made with as a person reads it: an option's name, not what it sends. */
const valueShown = (v: Rec, value: string | null) => (value && str(recs(v.options).find((o) => o.promptValue === value)?.visibleName)) ?? value;

/**
 * The card's content. `values` holds, per image, the values its render was made
 * with by variable name (imageValues in after-release); a row that does not name
 * every variable, or a list that does not match the images, gives way to the examples.
 */
export function contentFrom(api: Rec, handle: string | null | undefined, origin: string, values?: Record<string, string>[]): ShareContent {
  const media = api.mediaType === "video" ? "video" : "image";
  const showcase = recs(api.showcaseImages).filter((im) => str(im.url));
  const images = media === "image" ? showcase.map((im) => ({ src: str(im.preview) ?? str(im.view) ?? str(im.url)!, full: str(im.url)! })) : [];
  const video = api.showcaseVideo && typeof api.showcaseVideo === "object" ? (api.showcaseVideo as Rec) : null;
  const stored = recs((api.promptData as Rec | undefined)?.variables).sort((a, b) => Number(a.position) - Number(b.position));
  const shown = stored.filter((v) => v.type !== "image");
  const variables = shown.map((v) => ({ name: nameOf(v), example: exampleOf(v) }));
  const rows = values?.length === images.length ? values : null;
  const setups = images.map((_, i) => {
    const row = rows?.[i] && shown.every((v) => Object.hasOwn(rows[i], String(v.name))) ? rows[i] : null;
    return shown.map((v, s) => ({ name: nameOf(v), example: row ? valueShown(v, str(row[String(v.name)])) : variables[s].example }));
  });
  const generator = str(api.ai_model);
  return {
    title: str(api.title) ?? "",
    desc: realDesc(api.description),
    words: str(api.publicPromptText),
    variables,
    images,
    media,
    poster: media === "video" ? str(video?.poster) ?? str(showcase[0]?.url) : null,
    generator,
    handle: str(handle),
    link: `${origin}/generator/${String(api.id)}`,
    hashtags: [media === "video" ? "#aivideo" : "#aiart", ...(generator && squash(generator) ? [`#${squash(generator)}`] : [])].join(" "),
    setups,
  };
}

const sampleImage = (hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='800' height='1000'><defs><linearGradient id='g' x2='1' y2='1'><stop stop-color='hsl(${hue} 85% 62%)'/><stop offset='1' stop-color='hsl(${hue + 60} 70% 18%)'/></linearGradient></defs><rect width='800' height='1000' fill='url(#g)'/></svg>`)}`;

/** What Personalize shows from Edit profile when the creator has no prompt to show: every word its own label, no prompt's text. Shaped as a premium prompt, so a set can be laid out on it too. */
export function sampleContent(handle: string | null | undefined, origin: string): ShareContent {
  const images = [200, 320, 30, 150].map(sampleImage).map((src) => ({ src, full: src }));
  const variables = [{ name: "Your variable", example: "An example of it" }, { name: "Another variable", example: "Another example" }];
  return { title: "Your prompt's title", desc: "Your short description.", words: null, variables, images, media: "image", poster: null, generator: "Your generator", handle: str(handle), link: `${origin}/generator/your-prompt`, hashtags: "#aiart #yourgenerator", setups: images.map(() => variables), sample: true };
}

const varBlocks = (vars: ShareVariable[]): FitBlock[] =>
  vars.flatMap((v, group): FitBlock[] => {
    const before = group ? 0.62 : 0;
    return v.example
      ? [{ text: v.name, scale: 0.76, opacity: 0.8, lh: 1.22, before, group, mark: "vn" }, { text: v.example, lh: 1.22, group, mark: "vx" }]
      : [{ text: v.name, lh: 1.22, before, group, mark: "vx" }];
  });

/** What a text element says on the slide it stands on (slide 0: not an image's own). */
export function blocksFor(e: Pick<El, "k" | "show">, c: ShareContent, slide: number): FitBlock[] {
  const plain = (text: string | null) => (text ? [{ text: text.replace(/\s+/g, " ") }] : []);
  switch (e.k) {
    case "title": return plain(c.title);
    case "desc": return plain(c.desc);
    case "prompt": return c.words ? plain(c.words) : varBlocks(c.variables);
    case "setup": return varBlocks(c.setups[slide - 1] ?? c.variables);
    case "link": return plain(c.link.replace(/^https?:\/\//, ""));
    case "tags": return plain(c.hashtags);
    case "handle": return c.handle ? [{ text: `@${c.handle}`, lead: 1.7, lh: 1.3 }] : [];
    case "gen": {
      if (!c.generator) return [];
      if (e.show === "logo") return [{ text: "", lead: 1.3, lh: 1.3 }];
      return e.show === "name" ? [{ text: c.generator, lead: 0, lh: 1.1 }] : [{ text: c.generator, lead: 1.7, lh: 1.3 }];
    }
    default: return [];
  }
}

export type CaptionKey = "title" | "desc" | "prompt" | "link" | "tags";
export type CaptionBlock = { key: CaptionKey; text: string };
/** A block of the post in a style: its place and whether it shows; never its text. */
export type PostBlock = { key: CaptionKey; on: boolean };

const variablesText = (vars: ShareVariable[]) => vars.map((v) => (v.example ? `${v.name}: ${v.example}` : v.name)).join("\n");

/**
 * The text around the card, in the mock's order. A text stands in one place
 * (Kev, 2026-11-03): one that is on the card leaves the caption, and a set's
 * slides carry the setups themselves.
 */
export const postBlocks = (onCard: ReadonlySet<string>, isSet: boolean): PostBlock[] =>
  (["title", "desc", "prompt", "link", "tags"] as const).map((key) => ({ key, on: !onCard.has(key) && !(isSet && key === "prompt") }));

export const blockText = (c: ShareContent, key: CaptionKey): string =>
  key === "title" ? c.title : key === "desc" ? c.desc ?? "" : key === "prompt" ? c.words ?? variablesText(c.variables) : key === "link" ? c.link : c.hashtags;

/** The blocks of a post that show, in its order; a style's order and leaving-out decide, a prompt with nothing for one skips it. */
export const captionOf = (c: ShareContent, bk: PostBlock[]): CaptionBlock[] =>
  bk.filter((b) => b.on && blockText(c, b.key)).map((b) => ({ key: b.key, text: blockText(c, b.key) }));

export const captionBlocks = (c: ShareContent, onCard: ReadonlySet<string>, isSet: boolean): CaptionBlock[] => captionOf(c, postBlocks(onCard, isSet));

export const caption = (blocks: CaptionBlock[]) => blocks.map((b) => b.text).join("\n\n");

/** The text for a destination's own address: the link goes apart, and past its limit the long parts give way. */
export function shortText(blocks: CaptionBlock[], limit: number): string {
  const without = (...keys: CaptionBlock["key"][]) => caption(blocks.filter((b) => b.key !== "link" && !keys.includes(b.key)));
  const text = [without(), without("prompt"), without("prompt", "desc")].find((t) => t.length <= limit);
  // A lone half of a character would throw in encodeURIComponent.
  const rest = without("prompt", "desc");
  return text ?? rest.slice(0, cutAt(rest, limit));
}
