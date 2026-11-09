/**
 * Import a prompt from a post on X (Kev, 2026-10-13: "wenn jemand einen X
 * link postet, den content nehmen, den entire prompt extracten … put the
 * images into the image UI and allow all generators IF it is not specified").
 *
 * Heuristics only, no model: a prompt post is written in a few recognisable
 * ways, and reading them costs nothing. FxTwitter answers the browser directly
 * (CORS *), so the import never touches our server, and the photos load from
 * X's CDN the same way. FxTwitter carries no replies: a prompt "in the
 * comments" is reached by pasting that reply's link, whose parent post then
 * lends its pictures.
 */
import { parseReferralLink } from "@/lib/referral-link";

export interface PostPhoto {
  url: string;
  alt: string | null;
}

export interface Post {
  url: string;
  text: string;
  /** X's numeric user id is the stable name of an author; handles change hands. */
  author: { id: string; name: string; handle: string };
  /** At most the four X allows. */
  photos: PostPhoto[];
  /** The post this one answers, when it is a reply. */
  replyingTo: string | null;
  quote: { text: string; photos: PostPhoto[] } | null;
}

export type PostError = "not-x" | "private" | "gone" | "unreachable";

export const POST_ERROR_SAID: Record<PostError, string> = {
  "not-x": "Only links to posts on X can be imported for now.",
  private: "That post is private.",
  gone: "That post is gone, or the link is not a post.",
  unreachable: "X couldn't be read right now. Try again in a minute.",
};

/** The post's id on X, or null when the link is not a post on X. A pasted link may lack its scheme. */
export function postIdOf(url: string): string | null {
  const raw = url.trim();
  const link = parseReferralLink(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
  if (!link || link.platform !== "x") return null;
  return link.normalized.match(/\/status\/(\d+)$/)?.[1] ?? null;
}

const API = "https://api.fxtwitter.com/status/";

type FxPhoto = { url?: unknown; altText?: unknown };
type FxTweet = {
  url?: unknown;
  text?: unknown;
  author?: { id?: unknown; name?: unknown; screen_name?: unknown };
  media?: { photos?: FxPhoto[] };
  replying_to_status?: unknown;
  quote?: FxTweet | null;
};

const photosOf = (t: FxTweet | null | undefined): PostPhoto[] =>
  (t?.media?.photos ?? [])
    .flatMap((p) => (typeof p.url === "string" ? [{ url: p.url, alt: typeof p.altText === "string" && p.altText ? p.altText : null }] : []))
    .slice(0, 4);

/** One post as FxTwitter answers it; the three refusals a buyer can act on, and "unreachable" for the rest. */
export async function fetchPost(id: string, fetchFn: typeof fetch = fetch): Promise<{ ok: true; post: Post } | { ok: false; error: PostError }> {
  let res: Response;
  try {
    res = await fetchFn(API + id, { signal: AbortSignal.timeout(15_000) });
  } catch {
    return { ok: false, error: "unreachable" };
  }
  if (res.status === 401) return { ok: false, error: "private" };
  if (res.status === 404) return { ok: false, error: "gone" };
  if (!res.ok) return { ok: false, error: "unreachable" };
  const json = (await res.json().catch(() => null)) as { tweet?: FxTweet } | null;
  const t = json?.tweet;
  if (!t || typeof t.text !== "string") return { ok: false, error: "unreachable" };
  return {
    ok: true,
    post: {
      url: typeof t.url === "string" ? t.url : `https://x.com/i/status/${id}`,
      text: t.text,
      author: {
        id: typeof t.author?.id === "string" ? t.author.id : "",
        name: typeof t.author?.name === "string" ? t.author.name : "",
        handle: typeof t.author?.screen_name === "string" ? t.author.screen_name : "",
      },
      photos: photosOf(t),
      replyingTo: typeof t.replying_to_status === "string" && t.replying_to_status ? t.replying_to_status : null,
      quote: t.quote && typeof t.quote.text === "string" ? { text: t.quote.text, photos: photosOf(t.quote) } : null,
    },
  };
}

/** Shorter than this is a caption, not a prompt. */
const MIN = 40;

/** Links, the reply handles in front and the hashtag run at the end are not prompt text. */
export function cleanText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^(?:@\w+\s+)+/, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length && /^(?:\s*(?:#\w+|@\w+))*\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/(?:\s+#\w+)+\s*$/, "");
  return lines.join("\n").trim();
}

/** How the prompt was found in the text, or why it was not. */
export type Extraction =
  | { prompt: string; how: "block" | "label" | "quoted" | "whole" }
  | { prompt: null; why: "reply" | "none" };

/* "Prompt:", "Full prompt 👇", "Nano Banana Pro prompt:", "prompt used -", "Prompt 1:" — a short line ending in the label; the text after it is the prompt. */
const LABEL = /(?:^|\n)[^\n]{0,60}?\bprompt(?:[ \t]+(?:used|i used|below|here))?[ \t]*(?:\d+)?[ \t]*(?:[:：\-–—]|👇|⬇️|⤵️)[ \t]*(?:👇|⬇️|⤵️)?[ \t]*/i;
/* "prompt in the comments 👇", "full prompt below", "thread 🧵": the prompt is in another post. */
const HINT = /prompt[^\n]{0,40}?(?:in (?:the )?(?:(?:first )?comments?|(?:first )?repl(?:y|ies)|thread)|below|👇|⬇️|⤵️|🧵)|(?:comments?|replies|thread)[^\n]{0,20}?(?:👇|⬇️|⤵️)/i;

export function extractPrompt(raw: string): Extraction {
  const text = cleanText(raw);
  const block = text.match(/```(?:\w+\n)?([\s\S]*?)```/);
  if (block && block[1].trim().length >= MIN) return { prompt: block[1].trim(), how: "block" };
  const label = text.match(LABEL);
  if (label && label.index !== undefined) {
    const after = text.slice(label.index + label[0].length).trim();
    if (after.length >= MIN) return { prompt: after, how: "label" };
  }
  const quoted = text.match(/[“"„«]([^”"«»]{40,})[”"»]/);
  if (quoted) return { prompt: quoted[1].trim(), how: "quoted" };
  if (HINT.test(text)) return { prompt: null, why: "reply" };
  if (text.length >= MIN) return { prompt: text, how: "whole" };
  return { prompt: null, why: "none" };
}

/*
 * Posts name generators loosely. Each alias matches with any spacing, dots or
 * hyphens between its words, at word boundaries, longest first; what an alias
 * matched is blanked before the shorter ones look, so "nano banana pro" is
 * never also "nano banana". The names are the catalogue's.
 */
const ALIASES: Array<[alias: string, names: string[]]> = [
  ["gpt image 2.5 flare", ["GPT-Image-2.5 Flare"]],
  ["gpt image 2.5 sunburst", ["GPT-Image-2.5 Sunburst"]],
  ["gpt image 2.5", ["GPT-Image-2.5 Flare", "GPT-Image-2.5 Sunburst"]],
  ["chatgpt images 2.5", ["GPT-Image-2.5 Flare", "GPT-Image-2.5 Sunburst"]],
  ["gpt image 2", ["GPT-Image-2"]],
  ["gpt image 1.5", ["GPT-Image-2"]],
  ["gpt image 1", ["GPT-Image-2"]],
  ["gpt image", ["GPT-Image-2"]],
  ["chatgpt images", ["GPT-Image-2"]],
  ["chatgpt image", ["GPT-Image-2"]],
  ["4o image", ["GPT-Image-2"]],
  ["gpt 4o", ["GPT-Image-2"]],
  ["nano banana pro", ["Nano Banana Pro"]],
  ["nb pro", ["Nano Banana Pro"]],
  ["gemini 3 pro image", ["Nano Banana Pro"]],
  ["nano banana 2", ["Nano Banana 2"]],
  ["nb2", ["Nano Banana 2"]],
  ["gemini 3.1 flash image", ["Nano Banana 2"]],
  ["nano banana", ["Nano Banana Pro", "Nano Banana 2"]],
  ["flux", ["Flux (free)"]],
];

/** Every name an alias can produce: what a dialog without the catalogue asks for; the editor keeps the ones it offers. */
export const KNOWN_GENERATORS: string[] = [...new Set(ALIASES.flatMap(([, names]) => names))];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const aliasRe = (alias: string) => new RegExp("\\b" + alias.split(/[\s.\-]+/).map(escape).join("[\\s._-]*") + "\\b", "gi");

/** The catalogue names a text mentions; empty means the post names none, and every generator is offered. */
export function detectGenerators(text: string, catalogue: string[]): string[] {
  let rest = text;
  const found: string[] = [];
  for (const [alias, names] of ALIASES) {
    const re = aliasRe(alias);
    if (!re.test(rest)) continue;
    found.push(...names);
    rest = rest.replace(re, " ");
  }
  const byLower = new Map(catalogue.map((n) => [n.toLowerCase(), n]));
  return [...new Set(found)].flatMap((n) => {
    const c = byLower.get(n.toLowerCase());
    return c ? [c] : [];
  });
}

export interface ImportPlan {
  prompt: string;
  /** Catalogue names; empty = every generator. */
  generators: string[];
  photos: PostPhoto[];
  source: { url: string; handle: string; authorId: string };
  /** What the import did, for the row. */
  said: string;
}

export type ImportResult =
  | { ok: true; plan: ImportPlan }
  | { ok: false; why: PostError | "reply" | "none"; said: string };

export const IMPORT_SAID = {
  reply: "The prompt seems to be in a reply. Paste that reply's link.",
  none: "No prompt found in this post. If it is in a reply, paste that reply's link.",
} as const;

export function importSaid(p: { handle: string; photos: number; generators: string[] }): string {
  const who = p.handle ? `@${p.handle}` : "the post";
  const imgs = p.photos ? ` · ${p.photos} ${p.photos === 1 ? "image" : "images"}` : "";
  return `Imported from ${who}${imgs} · ${p.generators.length ? p.generators.join(", ") : "all generators"}`;
}

/**
 * The prompt from the post itself, else from the post it quotes. Pictures from
 * the post, else from the post it answers (the reply with the prompt, pasted
 * under the pictures), else from the quoted one. Generators from all three.
 */
export function planImport(post: Post, parent: Post | null, catalogue: string[]): ImportResult {
  const own = extractPrompt(post.text);
  const quoted = post.quote ? extractPrompt(post.quote.text) : null;
  const found = own.prompt !== null ? own : quoted && quoted.prompt !== null ? quoted : own;
  if (found.prompt === null) return { ok: false, why: found.why, said: IMPORT_SAID[found.why] };
  const photos = post.photos.length ? post.photos : parent?.photos.length ? parent.photos : post.quote?.photos ?? [];
  const generators = detectGenerators([post.text, post.quote?.text ?? "", parent?.text ?? ""].join("\n"), catalogue);
  return {
    ok: true,
    plan: {
      prompt: found.prompt,
      generators,
      photos,
      source: { url: post.url, handle: post.author.handle, authorId: post.author.id },
      said: importSaid({ handle: post.author.handle, photos: photos.length, generators }),
    },
  };
}

/** The whole import for a pasted link; the parent is fetched only when the post itself shows no pictures. */
export async function importPost(url: string, catalogue: string[], fetchFn: typeof fetch = fetch): Promise<ImportResult> {
  const id = postIdOf(url);
  if (!id) return { ok: false, why: "not-x", said: POST_ERROR_SAID["not-x"] };
  const got = await fetchPost(id, fetchFn);
  if (!got.ok) return { ok: false, why: got.error, said: POST_ERROR_SAID[got.error] };
  const parent = got.post.replyingTo && !got.post.photos.length ? await fetchPost(got.post.replyingTo, fetchFn) : null;
  return planImport(got.post, parent?.ok ? parent.post : null, catalogue);
}
