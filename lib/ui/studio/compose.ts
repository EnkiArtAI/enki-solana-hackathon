import type { MasterPrompt, Style } from "@/lib/studio/types";

/**
 * A content piece's brand words in Create's bar (Kev, 2026-10-30: "styles and master prompts must also be set up there,
 * so that the brand ID stays the same"). They go in as words the bar shows, never sent beside it: what Generate sends
 * is what the bar reads.
 */

/** A style as words: its own, then its colours ("Colour palette: #7d1d33, #cba24a"). */
export function styleBlock(style: Pick<Style, "words" | "palette">): string {
  return [style.words.trim(), style.palette.length ? `Colour palette: ${style.palette.join(", ")}` : ""].filter(Boolean).join("\n");
}

/** What an empty bar opens with in a content piece: its master prompt, a blank line, its style. */
export function contextText(master: Pick<MasterPrompt, "prompt"> | null, style: Pick<Style, "words" | "palette"> | null): string {
  return [master?.prompt.trim() ?? "", style ? styleBlock(style) : ""].filter(Boolean).join("\n\n");
}

/** `block` after the bar's words, a blank line between; the words stay as they are. */
export function appendBlock(text: string, block: string): string {
  const add = block.trim();
  if (!add) return text;
  return text.trim() ? `${text.trimEnd()}\n\n${add}` : add;
}
