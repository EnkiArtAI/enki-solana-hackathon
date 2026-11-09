import type { PostBlock, ShareContent } from "./content";
import { regroup, type Bg, type CardStyle, type El, type ElKind, type SetStyle, type ShareDoc } from "./doc";
import type { Tokens } from "./tokens";

/**
 * The cards a first share offers (mock v15), coloured from the theme's tokens.
 * An element whose content is missing is left out and the card closes up, so a
 * prompt without a description (all 204 live, 2026-11-04) never shows a hole.
 */
export type NamedDoc = ShareDoc & { name: string; bk?: PostBlock[] };

const solid = (c: string): Bg => ({ mode: "solid", c });

function maker(t: Tokens) {
  let id = 1;
  return {
    tx: (k: ElKind, x: number, y: number, w: number, h: number, font = "Inter", color = t.ink): El => ({ id: id++, k, x, y, w, h, rot: 0, font, color, align: "left" }),
    md: (k: ElKind, x: number, y: number, w: number, h: number, extra?: Partial<El>): El => ({ id: id++, k, x, y, w, h, rot: 0, ...extra }),
  };
}

/** Takes out what this prompt has nothing for: no handle, no description, no generator, no variables on a premium prompt; and a picture whose reference is gone. */
export const present = (c: ShareContent) => (e: Pick<El, "k" | "src">) =>
  !(e.k === "up" && !e.src) && !(e.k === "handle" && !c.handle) && !(e.k === "desc" && !c.desc) && !(e.k === "gen" && !c.generator) && !(e.k === "prompt" && !c.words && !c.variables.length) && !(e.k === "setup" && !c.variables.length);

/** One card's templates for an image or a video prompt. */
export function cardsFor(t: Tokens, c: ShareContent, own?: CardStyle): NamedDoc[] {
  const { tx, md } = maker(t), paid = !c.words, n = c.images.length;
  const body = paid ? "the variables" : "the whole prompt", font = paid ? "Space Grotesk" : "DM Mono", color = paid ? t.ink : t.ink2;
  const yours = n === 1 ? "your image" : "your images", has = present(c);
  // A name says what the card holds on this prompt, no more.
  const named = (...parts: (string | false)[]) => { const s = parts.filter(Boolean).join(", "); return s[0].toUpperCase() + s.slice(1); };
  const hand = has({ k: "handle" }) && "your handle", said = has({ k: "prompt" }) && body;
  const docs: NamedDoc[] = [];
  if (c.media === "image") {
    // The row keeps its images square up to a limit; with fewer of them it takes room from the text above it.
    const rowH = Math.min(38, 70.4 / n), rowY = Math.min(58, 86 - rowH);
    const [gradY, gradH] = c.desc ? [36, 52] : [24, 64];
    docs.push(
      { name: named("title", said, yours, hand), ratio: "4:5", bg: solid(t.paper), els: [...(said ? [tx("prompt", 6, 16, 88, rowY - 19, font, color), md("results", 6, rowY, 88, rowH, { arr: "row", gap: 1 })] : [md("results", 6, 16, 88, 70.4, { arr: "grid", gap: 1 })]), tx("handle", 6, 88, 50, 6.5, "Space Grotesk"), tx("title", 6, 4, 88, 10, "Playfair Display")] },
      { name: named(yours, hand), ratio: "4:5", bg: solid(t.alt), els: [md("results", 6, 5, 88, 70.4, { arr: "grid", gap: 1 }), tx("handle", 6, 80, 60, 8, "Space Grotesk")] },
      { name: n === 1 ? "Only the image" : "Only the images", ratio: "1:1", bg: solid(t.paper), els: [md("results", 0, 0, 100, 100, { arr: "grid", gap: 0 })] },
      { name: "Title on a gradient", ratio: "4:5", bg: { mode: "gradient", a: t.ga, b: t.gb, dir: 135 }, els: [tx("title", 7, 5, 86, 16, "Playfair Display", t.on), ...(c.desc ? [tx("desc", 7, 22, 86, 11, "Inter", t.on)] : []), md("results", 7, gradY, 86, gradH, { arr: "hero", gap: 1 }), tx("handle", 7, 91, 60, 5.5, "Inter", t.on)] },
    );
  } else {
    docs.push(
      { name: said ? `Title and ${body} above the animation` : "Title above the animation", ratio: "4:5", bg: solid(t.paper), els: [...(said ? [tx("prompt", 6, 14, 88, 27, font, color), md("clip", 6, 44, 88, 44)] : [md("clip", 6, 14, 88, 74)]), tx("handle", 6, 91, 60, 5.5, "Space Grotesk"), tx("title", 6, 3.5, 88, 9, "Playfair Display")] },
      { name: "Only the animation", ratio: "9:16", bg: solid(t.alt), els: [md("clip", 0, 0, 100, 100)] },
    );
  }
  const held = (d: NamedDoc) => ({ ...d, els: d.els.filter(present(c)) });
  return [...(own ? [regroup(held({ ...own, name: "Your style" }), n)] : []), ...docs.map(held)];
}

/** An Instagram set: one slide with all the images, then one per image with its setup; one ratio throughout. Its slide index is its place here. A saved style holds the two designs and the post. */
export function setFor(t: Tokens, c: ShareContent, own?: SetStyle): NamedDoc[] {
  const { tx, md } = maker(t), n = c.images.length, of = n + 1;
  const ov: NamedDoc = { ...(own?.ov ?? { ratio: "4:5", bg: solid(t.paper), els: [tx("title", 6, 4, 88, 11, "Playfair Display"), md("results", 6, 17, 88, 70.4, { arr: "grid", gap: 1 }), tx("handle", 6, 90, 50, 6.5, "Space Grotesk")] }), bk: own?.bk, name: `Slide 1 of ${of}. ${n === 1 ? "Your image." : "All your images."}` };
  const per = (i: number): NamedDoc => ({ ...(own?.per ?? { ratio: "4:5", bg: solid(t.paper), els: [md("one", 0, 0, 100, 62), tx("setup", 6, 65, 88, 24, "Space Grotesk"), tx("handle", 6, 91.5, 50, 5.5, "Space Grotesk")] }), bk: own?.bk, name: `Slide ${i + 2} of ${of}. Image ${i + 1} and its setup.` });
  return [ov, ...c.images.map((_, i) => per(i))].map((d) => regroup({ ...d, els: d.els.filter(present(c)) }, n));
}

/** The tags a card can still take, in the rail's order: only what it has not got, only what this prompt has something for. `slide` is its place in a set, null outside one. */
export function railKinds(c: ShareContent, doc: Pick<ShareDoc, "els">, slide: number | null): ElKind[] {
  const used = new Set(doc.els.map((e) => e.k));
  const all: ElKind[] = slide ? ["title", "desc", "setup", "link", "tags", "handle", "gen", "one"] : ["title", "desc", "prompt", "link", "tags", "handle", "gen", c.media === "image" ? "results" : "clip"];
  return all.filter((k) => !used.has(k) && present(c)({ k }));
}

/** The fonts the templates use: Share loads these and no more. */
export const TEMPLATE_FONTS = ["Inter", "Playfair Display", "Space Grotesk", "DM Mono"];
