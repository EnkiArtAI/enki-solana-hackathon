import type { Bg } from "./doc";

/** The colours a template paints with: the theme's own, as plain values a saved card and a canvas can hold. */
export type Tokens = { paper: string; alt: string; ink: string; ink2: string; ga: string; gb: string; on: string };

export const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.3 * (n >> 16) + 0.59 * ((n >> 8) & 255) + 0.11 * (n & 255)) / 255;
};

/** The current theme's tokens (--enki-* on the root), normalised through a canvas's fillStyle, which answers "#rrggbb". */
const reader = () => {
  const style = getComputedStyle(document.documentElement);
  const ctx = document.createElement("canvas").getContext("2d")!;
  return (name: string) => {
    ctx.fillStyle = "#000000";
    ctx.fillStyle = style.getPropertyValue(`--enki-${name}`).trim();
    return String(ctx.fillStyle);
  };
};

export function readTokens(): Tokens {
  const read = reader();
  const paper = read("paper"), ember = read("ember");
  // The mock's gradient: on white the accent to its pale ring, at night the raised paper up to the accent.
  const [ga, gb] = lum(paper) > 0.5 ? [ember, read("photo-ring")] : [read("paper-3"), ember];
  return { paper, alt: read("paper-2"), ink: read("ink"), ink2: read("ink-2"), ga, gb, on: read("on-stage") };
}

/** The Background sheet's swatches and the inks a new text can take, the mock's sets by token name. */
export type Palette = { solids: string[]; grads: [string, string][]; dark: string; light: string };

export function readPalette(): Palette {
  const read = reader(), t = readTokens();
  const solids = ["paper", "paper-2", "paper-3", "stage", "ink", "ink-2", "ember", "turq", "vary-3", "vary-5", "vary-6", "amber", "ref-a"].map(read);
  const grads = ([["paper-3", "ember"], ["stage", "paper-3"], ["paper-2", "turq"], ["ember", "amber"], ["paper-3", "vary-6"], ["paper", "vary-3"], ["vary-3", "amber"], ["turq", "vary-6"], ["vary-5", "vary-6"], ["stage", "vary-5"], ["ember", "vary-3"], ["ink-2", "ink"], ["ref-a", "ref-b"]] as const).map(([a, b]): [string, string] => [read(a), read(b)]);
  return { solids: [...new Set(solids)], grads: [[t.ga, t.gb], ...grads], dark: read("stage"), light: lum(t.paper) > 0.5 ? t.on : t.ink };
}

/** Relative luminance, by the WCAG formula. */
const wcag = (hex: string) => {
  const n = parseInt(hex.slice(1), 16), ch = (v: number) => (v <= 10.31 ? v / 3294.6 : ((v + 14.025) / 269.025) ** 2.4);
  return 0.2126 * ch(n >> 16) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};
export const contrast = (a: string, b: string) => {
  const [x, y] = [wcag(a), wcag(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The ink a new text takes on a background: whichever of the two reads better on it. */
export const inkOn = (bg: Bg, p: Pick<Palette, "dark" | "light">) => {
  const on = bg.mode === "solid" ? bg.c : bg.a;
  return contrast(on, p.dark) >= contrast(on, p.light) ? p.dark : p.light;
};
