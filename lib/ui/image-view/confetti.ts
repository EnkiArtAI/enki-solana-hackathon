/**
 * The confetti on the done screen (handoff S:534-538): four guns, one in each
 * bottom corner and one on each side at 62 % height, fire 96 pieces in an arc
 * toward the result; the pieces then fall and fade. The burst is drawn from
 * the run id, so the same run always shows the same burst (the prototype drew
 * it once per run id) and nothing calls Math.random.
 */

/** Where each gun stands (% of the screen), which way it fires, and how high: the side guns lob lower. */
const GUNS = [
  { left: 0, top: 100, dir: 1, up: 1 },
  { left: 100, top: 100, dir: -1, up: 1 },
  { left: 0, top: 62, dir: 1, up: 0.55 },
  { left: 100, top: 62, dir: -1, up: 0.55 },
] as const;

/** The handoff's palette, in its order. */
const COLOURS = ["#7d1d33", "#e9b8c2", "#2f7a4f", "#8db3c9", "#111111", "#e3e2df"] as const;

/** How much further the pieces fly on desktop; mobile is 1. */
export const DESKTOP_SCALE = 1.4;

export interface Piece {
  /** Which gun fired it: 0 bottom left, 1 bottom right, 2 left side, 3 right side. */
  gun: number;
  /** The gun's mouth, % of the screen. */
  start: { left: number; top: number };
  /** px the arc climbs above the start; the keyframe reaches it at 38 % of the flight, at end.x × .72. */
  peak: number;
  /** Where it has faded out, px from the start (the prototype's --dx, and --fall − --peak). */
  end: { x: number; y: number };
  /** The turn over the flight, deg. */
  rot: number;
  /** s; every third piece leaves in a second wave. */
  delay: number;
  /** s */
  duration: number;
  colour: string;
  /** px; every seventh piece is a round 8 × 8 dot. */
  width: number;
  height: number;
  round: boolean;
}

/* FNV-1a over the id, then mulberry32: the same stream for the same id on every device. */
function stream(seed: string): () => number {
  let a = 2166136261;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The burst for a run: `count` pieces, the guns and colours taken in turn; distances times `scale` (DESKTOP_SCALE on desktop). */
export function pieces(seed: string, count = 96, scale = 1): Piece[] {
  const r = stream(seed);
  const px = (v: number) => Math.round(v * scale);
  const sec = (v: number) => Math.round(v * 100) / 100;
  return Array.from({ length: count }, (_, q) => {
    const g = GUNS[q % 4], round = q % 7 === 0;
    const dx = g.dir * (60 + r() * 300), peak = (180 + r() * 420) * g.up, fall = 260 + r() * 260;
    const width = 6 + r() * 5, height = 10 + r() * 9;
    return {
      gun: q % 4,
      start: { left: g.left, top: g.top },
      peak: px(peak),
      end: { x: px(dx), y: px(fall - peak) },
      rot: Math.round(r() * 1080 - 540),
      delay: sec((q % 3 === 2 ? 0.32 : 0) + r() * 0.12),
      duration: sec(1.6 + r() * 0.9),
      colour: COLOURS[q % COLOURS.length],
      width: round ? 8 : Math.round(width),
      height: round ? 8 : Math.round(height),
      round,
    };
  });
}
