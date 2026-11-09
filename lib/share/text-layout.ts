import { rn, type Align, type El } from "./doc";

/**
 * Text on a share card, laid out once for the page and for the export. The
 * mock's fit kept the browser's wrapping, which a canvas does not have, so this
 * search measures with an injected function at a logical card 1000 wide and
 * returns the explicit lines; both then draw those lines. Wrapping matches by
 * construction, at every size.
 */
export type FitBlock = {
  text: string;
  /** Its size against the fitted one: a variable's name is .76. */
  scale?: number;
  opacity?: number;
  /** Space above it, in the fitted size's em. */
  before?: number;
  /** Line height against its own size. */
  lh?: number;
  /** One line, never wrapped, centred in the box, this many em taken by an icon in front of it. */
  lead?: number;
  /** A variable's name and example belong together. */
  group?: number;
  mark?: "vn" | "vx";
};
export type FitLine = { text: string; block: number; size: number; top: number; height: number; width: number; lead: number; opacity: number; group?: number; mark?: "vn" | "vx" };
export type Fit = { size: number; lines: FitLine[]; boxW: number; boxH: number };
export type Measure = (text: string, size: number) => number;

/** Line height of plain text (the mock's .fb). */
export const LINE = 1.16;

/** Where to cut a string near i: never inside a surrogate pair, which would draw as a replacement mark. */
export const cutAt = (text: string, i: number) => ((text.charCodeAt(i - 1) & 0xfc00) === 0xd800 ? (i > 1 ? i - 1 : i + 1) : i);

/** Greedy lines; a word wider than the box breaks where it must, as overflow-wrap does. */
function wrap(text: string, size: number, W: number, measure: Measure): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, size) <= W) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    line = word;
    while (line.length > 1 && measure(line, size) > W) {
      let i = line.length - 1;
      while (i > 1 && measure(line.slice(0, i), size) > W) i--;
      i = cutAt(line, i);
      out.push(line.slice(0, i));
      line = line.slice(i);
    }
  }
  if (line) out.push(line);
  return out;
}

function layout(blocks: FitBlock[], size: number, W: number, measure: Measure) {
  const lines: FitLine[] = [];
  let y = 0, width = 0;
  blocks.forEach((b, block) => {
    const s = size * (b.scale ?? 1), height = s * (b.lh ?? LINE), lead = b.lead ?? 0;
    if (lines.length) y += (b.before ?? 0) * size;
    const texts = b.lead !== undefined ? [b.text] : wrap(b.text, s, W, measure);
    for (const text of texts) {
      const w = lead * s + (text ? measure(text, s) : 0);
      width = Math.max(width, w);
      lines.push({ text, block, size: s, top: y, height, width: w, lead: lead * s, opacity: b.opacity ?? 1, group: b.group, mark: b.mark });
      y += height;
    }
  });
  return { lines, height: y, width };
}

/**
 * The largest size at which the blocks fit a box, by nine halvings as in the
 * mock (a size above the box's own height never fits). Sizes and places are
 * logical units: a card 1000 wide.
 */
export function fitText(blocks: FitBlock[], boxW: number, boxH: number, measure: Measure): Fit {
  const shown = blocks.filter((b) => b.text || b.lead);
  let lo = 4, hi = Math.max(boxH * 1.1, 8);
  for (let i = 0; i < 9; i++) {
    const m = (lo + hi) / 2, { height, width } = layout(shown, m, boxW, measure);
    if (height > boxH + 0.5 || width > boxW + 0.5) hi = m;
    else lo = m;
  }
  const { lines, height } = layout(shown, lo, boxW, measure);
  // A single line with an icon stands centred in its box; running text starts at its top.
  const down = shown.some((b) => b.lead !== undefined) ? (boxH - height) / 2 : 0;
  return { size: lo, lines: lines.map((l) => ({ ...l, top: l.top + down })), boxW, boxH };
}

/** An element's fit on a card of a ratio. */
export const fitEl = (e: El, ratio: string, blocks: FitBlock[], measure: Measure) => fitText(blocks, e.w * 10, ((e.h / 100) * 1000) / rn(ratio), measure);

/** Where a line starts in its box. */
export const lineX = (line: Pick<FitLine, "width">, boxW: number, align: Align = "left") => (align === "center" ? (boxW - line.width) / 2 : align === "right" ? boxW - line.width : 0);
