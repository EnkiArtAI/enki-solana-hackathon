/**
 * Everyone's picture on Enki (Kev, 2026-10-26: "avatar A, i dont want no
 * profile images on enki"): a seal drawn from the account's handle, the same
 * on every surface and every visit, different from person to person. No
 * upload and no AI: two of five motifs (sun, waves, horizon, cuneiform
 * wedges, the eight-pointed star) in one of six Enki palettes, the initial
 * on top. Drawn in a 96 x 96 box; the frame that holds it clips its shape.
 */
export type SealPart =
  | { kind: "circle"; cx: number; cy: number; r: number; fill: string }
  | { kind: "path"; d: string; fill: string; stroke?: string; width?: number; opacity?: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; width: number };
export type Seal = { bg: string; fg: string; parts: SealPart[]; initial: string };

/** Ground, ink and accent: bordeaux, ink, paper, the purple night, clay, the blue night. */
export const SEAL_PALETTES = [
  ["#7d1d33", "#f6efe6", "#e0a35c"],
  ["#111111", "#f6efe6", "#b8324f"],
  ["#efe7dc", "#111111", "#7d1d33"],
  ["#241a35", "#ece8f5", "#e0a35c"],
  ["#e7d6cc", "#7d1d33", "#111111"],
  ["#0a1825", "#e4edf1", "#e0a35c"],
] as const;

// FNV-1a into mulberry32: a handle always draws the same seal.
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The seal of a handle (any case, any spelling of the same handle draws the same one); "E" when it has no letter. */
export function sealOf(handle: string): Seal {
  const seed = handle.trim().toLowerCase();
  const r = random(hash(seed));
  const [bg, fg, accent] = SEAL_PALETTES[Math.floor(r() * SEAL_PALETTES.length)];
  const parts: SealPart[] = [];
  // In the order the preview Kev chose from picked them (2026-10-26), so every handle keeps the seal he saw.
  const motifs: Array<() => void> = [
    () => parts.push({ kind: "circle", cx: r1(28 + r() * 40), cy: r1(24 + r() * 30), r: r1(12 + r() * 10), fill: accent }),
    () => {
      const y0 = 56 + r() * 14, lift = 3 + r() * 3;
      for (let i = 0; i < 3; i++) {
        const y = r1(y0 + i * 8);
        parts.push({ kind: "path", d: `M -4 ${y} Q 8 ${r1(y - lift)} 20 ${y} T 44 ${y} T 68 ${y} T 92 ${y} T 116 ${y}`, fill: "none", stroke: fg, width: 2.4, opacity: 1 - i * 0.25 });
      }
    },
    () => {
      const rad = r1(26 + r() * 10);
      parts.push({ kind: "path", d: `M ${r1(48 - rad)} 96 A ${rad} ${rad} 0 0 1 ${r1(48 + rad)} 96 Z`, fill: fg, opacity: 0.92 });
    },
    () => {
      const x = r1(18 + r() * 50), y = r1(18 + r() * 40);
      for (let i = 0; i < 3; i++) parts.push({ kind: "path", d: `M ${r1(x + i * 9)} ${y} l 7 0 l -3.5 12 Z`, fill: fg });
    },
    () => {
      const x = r1(30 + r() * 36), y = r1(26 + r() * 26), len = r1(9 + r() * 6);
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        parts.push({ kind: "line", x1: x, y1: y, x2: r1(x + Math.cos(a) * len), y2: r1(y + Math.sin(a) * len), stroke: accent, width: 2.6 });
      }
    },
  ];
  // Back to front: horizon, waves, sun, wedges, star.
  const DEPTH = [2, 1, 0, 3, 4];
  const first = Math.floor(r() * motifs.length);
  let second = Math.floor(r() * (motifs.length - 1));
  if (second >= first) second++;
  for (const i of [first, second].sort((a, b) => DEPTH.indexOf(a) - DEPTH.indexOf(b))) motifs[i]();
  const letter = seed.match(/[a-z]/)?.[0];
  return { bg, fg, parts, initial: letter ? letter.toUpperCase() : "E" };
}
