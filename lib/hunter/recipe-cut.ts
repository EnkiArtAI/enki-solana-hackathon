import { ctaTail, promptLike, showsExample, sureHit } from "@/lib/hunter/distill";
import type { XPost } from "@/lib/hunter/x-api";
import type { Recipe } from "@/lib/hunter/recipe";

/** Manual mode's prompt: the post's text and the author's replies after it, as written. */
export const rawText = (post: XPost, replies: XPost[]): string =>
  [post.text, ...replies.map((r) => r.text)].map((t) => t.trim()).filter(Boolean).join("\n\n");

const lineOf = (lines: string[], text: string, from = 0): number => {
  const want = text.toLowerCase();
  for (let i = from; i < lines.length; i++) if (lines[i].toLowerCase().includes(want)) return i;
  return -1;
};
/** A line of nothing but links, mentions and hashtags: never the prompt's. Token by token: one pattern over the whole
 *  line backtracked exponentially on a long credits line (review 2026-11-01). */
const TOKEN = /^(?:https?:\/\/\S+|@\w+|#\S+)$/;
const bare = (line: string) => { const t = line.trim().split(/\s+/); return t[0] !== "" && t.every((w) => TOKEN.test(w)); };

/** Empty lines, bare link lines and calls to action taken off the end. */
const offTail = (lines: string[]): string[] => {
  const body = [...lines];
  while (body.length && (!body[body.length - 1].trim() || bare(body[body.length - 1]) || ctaTail(body[body.length - 1]))) body.pop();
  return body;
};

export type RecipeCut =
  | { ok: true; prompt: string; from: "text" | "reply"; reply: XPost | null; title: string }
  | { ok: false; reason: string };

/**
 * The prompt by the recipe, or why it could not be cut: the source holding the start marker, from the line after it
 * (and after a parenthesis that line opens, "(access ...: <link>)") to the line before the end marker, with calls to
 * action and bare link lines taken off its end.
 */
export function cutByRecipe(post: XPost, replies: XPost[], r: Recipe): RecipeCut {
  const sources = r.from === "text" ? [post] : replies;
  if (!sources.length) return { ok: false, reason: "the author left no reply" };
  // No start marker: the post, or the author's longest reply (a prompt outweighs their promotion replies).
  const source = r.after ? sources.find((s) => lineOf(s.text.split("\n"), r.after) >= 0) : sources.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  if (!source) return { ok: false, reason: `no ${r.from === "text" ? "post text" : "reply"} holds "${r.after}"` };
  const lines = source.text.split("\n");
  let start = 0;
  if (r.after) {
    const at = lineOf(lines, r.after);
    start = at + 1;
    // A parenthesis the marker line opens closes on a later line: those lines are the marker's too.
    let open = (lines[at].match(/\(/g)?.length ?? 0) - (lines[at].match(/\)/g)?.length ?? 0);
    while (open > 0 && start < lines.length) {
      open += (lines[start].match(/\(/g)?.length ?? 0) - (lines[start].match(/\)/g)?.length ?? 0);
      start += 1;
    }
  }
  const stop = r.before ? lineOf(lines, r.before, start) : -1;
  const prompt = offTail(lines.slice(start, stop >= 0 ? stop : lines.length)).join("\n").trim();
  if (!promptLike(prompt)) return { ok: false, reason: "the cut is too short for a prompt" };
  const titled = r.titleLine ? post.text.split("\n").map((l) => l.trim()).filter(Boolean)[r.titleLine - 1] ?? "" : "";
  return { ok: true, prompt, from: source === post ? "text" : "reply", reply: source === post ? null : source, title: titled.slice(0, 80) };
}

/**
 * Manual mode's cut, no model and $0 (Kev, 2026-11-03: "meistens ist es dann eifnach der gesamte text ab der letzten
 * vorherigen leeren zeile. manchmal mit oder ohne überschrift in einer der ersten zeilen"). A labelled prompt or a code block
 * in the post itself, as auto reads it first too; else the author's longest direct reply that could be a prompt and shows
 * no example, as most prompts sit in one and promotion replies are shorter; else the post with its first block off,
 * where one block stays whole; the tail of links and calls to action off either. A short first line with a line under it is
 * the heading: the title, not the prompt. Prompts hold empty lines themselves, so the literal last block would cut them short.
 * named: the reply a link named as where the prompt sits, which comes before any longer one that could be a prompt.
 */
export function manualCut(post: XPost, replies: XPost[], named?: XPost): RecipeCut {
  const sure = named ? null : sureHit(post.text);
  if (sure) return { ok: true, prompt: sure.prompt, from: "text", reply: null, title: "" };
  const longest = (rs: XPost[]) => rs.reduce<XPost | null>((a, b) => (!a || b.text.length > a.text.length ? b : a), null);
  const could = replies.filter((r) => promptLike(r.text) && !showsExample(r));
  const reply = named && promptLike(named.text) ? named : longest(could.filter((r) => r.replyingTo === post.id));
  let lines = offTail((reply ?? post).text.split("\n"));
  const gap = reply ? -1 : lines.findIndex((l) => !l.trim());
  if (gap >= 0) lines = lines.slice(gap + 1);
  while (lines.length && !lines[0].trim()) lines.shift();
  const first = lines[0]?.trim() ?? "";
  // Not a line opening with a brace, a bracket or a fence: those open the prompt, whatever word follows ("```json").
  const heading = !promptLike(first) && /\p{L}/u.test(first) && !/^(?:[{[]|```)/.test(first);
  const prompt = (heading ? lines.slice(1) : lines).join("\n").trim();
  if (promptLike(prompt)) return { ok: true, prompt, from: reply ? "reply" : "text", reply, title: heading ? first.slice(0, 80) : "" };
  // Further down their thread a long reply is more often its own post: only when neither a direct reply nor the post gives a prompt.
  const deep = longest(could.filter((r) => r !== reply));
  return deep ? manualCut(post, [], deep) : { ok: false, reason: "the cut is too short for a prompt: the whole text" };
}
