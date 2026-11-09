import { describe, expect, it, vi } from "vitest";
import { DESKTOP_SCALE, pieces } from "../confetti";

/* The handoff's guns and palette (S:534-536), written out here so a change in
   the module turns a test red instead of moving the expectation with it. */
const GUNS = [
  { left: 0, top: 100, dir: 1, up: 1 },
  { left: 100, top: 100, dir: -1, up: 1 },
  { left: 0, top: 62, dir: 1, up: 0.55 },
  { left: 100, top: 62, dir: -1, up: 0.55 },
];
const PALETTE = ["#7d1d33", "#e9b8c2", "#2f7a4f", "#8db3c9", "#111111", "#e3e2df"];

/* Twenty runs, so every range is checked on 1920 pieces and a range drawn too narrow shows at its ends. */
const runs = Array.from({ length: 20 }, (_, i) => pieces(`run-${i}`));
const all = runs.flat();
const burst = pieces("job-7f3a");
const span = (xs: number[]) => [Math.min(...xs), Math.max(...xs)];

describe("pieces", () => {
  it("makes 96 by default, or the count asked for", () => {
    expect(burst).toHaveLength(96);
    expect(pieces("job-7f3a", 10)).toHaveLength(10);
    expect(pieces("job-7f3a", 0)).toEqual([]);
  });

  it("fires from four guns in turn, 24 pieces each, every gun toward the middle", () => {
    burst.forEach((p, q) => expect(p.gun).toBe(q % 4));
    for (let gun = 0; gun < 4; gun++) expect(burst.filter((p) => p.gun === gun)).toHaveLength(24);
    for (const p of all) {
      const g = GUNS[p.gun];
      expect(p.start).toEqual({ left: g.left, top: g.top });
      expect(Math.sign(p.end.x)).toBe(g.dir);
    }
  });

  it("shoots 60-360 px across, up 180-600 px (the side guns .55 of that), and falls 260-520 px", () => {
    for (const p of all) {
      const up = GUNS[p.gun].up;
      expect(Math.abs(p.end.x)).toBeGreaterThanOrEqual(60);
      expect(Math.abs(p.end.x)).toBeLessThanOrEqual(360);
      expect(p.peak).toBeGreaterThanOrEqual(Math.floor(180 * up));
      expect(p.peak).toBeLessThanOrEqual(Math.ceil(600 * up));
      // end.y is the fall less the climb, each rounded once.
      expect(p.end.y + p.peak).toBeGreaterThanOrEqual(259);
      expect(p.end.y + p.peak).toBeLessThanOrEqual(521);
    }
    const [xLo, xHi] = span(all.map((p) => Math.abs(p.end.x)));
    expect(xLo).toBeLessThan(75);
    expect(xHi).toBeGreaterThan(345);
    const [cornerLo, cornerHi] = span(all.filter((p) => p.gun < 2).map((p) => p.peak));
    expect(cornerLo).toBeLessThan(200);
    expect(cornerHi).toBeGreaterThan(580);
    const [sideLo, sideHi] = span(all.filter((p) => p.gun >= 2).map((p) => p.peak));
    expect(sideLo).toBeLessThan(110);
    expect(sideHi).toBeGreaterThan(320);
    const [fallLo, fallHi] = span(all.map((p) => p.end.y + p.peak));
    expect(fallLo).toBeLessThan(275);
    expect(fallHi).toBeGreaterThan(505);
  });

  it("colours the pieces from the handoff's palette, in turn", () => {
    burst.forEach((p, q) => expect(p.colour).toBe(PALETTE[q % PALETTE.length]));
    expect(new Set(all.map((p) => p.colour))).toEqual(new Set(PALETTE));
  });

  it("makes every seventh piece a round 8 x 8 dot, the rest 6-11 x 10-19 px strips", () => {
    burst.forEach((p, q) => expect(p.round).toBe(q % 7 === 0));
    for (const p of all.filter((x) => x.round)) expect([p.width, p.height]).toEqual([8, 8]);
    const strips = all.filter((p) => !p.round);
    expect(span(strips.map((p) => p.width))).toEqual([6, 11]);
    expect(span(strips.map((p) => p.height))).toEqual([10, 19]);
  });

  it("sends every third piece in a second wave .32 s later, flies 1.6-2.5 s and turns up to 540 deg either way", () => {
    const second = runs.flatMap((run) => run.filter((_, q) => q % 3 === 2)).map((p) => p.delay);
    const first = runs.flatMap((run) => run.filter((_, q) => q % 3 !== 2)).map((p) => p.delay);
    expect(span(first)).toEqual([0, 0.12]);
    expect(span(second)).toEqual([0.32, 0.44]);
    for (const p of all) {
      expect(p.duration).toBeGreaterThanOrEqual(1.6);
      expect(p.duration).toBeLessThanOrEqual(2.5);
      expect(Math.abs(p.rot)).toBeLessThanOrEqual(540);
    }
    expect(span(all.map((p) => p.duration))).toEqual([1.6, 2.5]);
    const [rotLo, rotHi] = span(all.map((p) => p.rot));
    expect(rotLo).toBeLessThan(-520);
    expect(rotHi).toBeGreaterThan(520);
  });

  it("draws the same burst for the same run id, and another for another", () => {
    expect(pieces("job-7f3a")).toEqual(burst);
    expect(pieces("job-7f3b")).not.toEqual(burst);
    expect(pieces("")).not.toEqual(burst);
    const runs = Array.from({ length: 20 }, (_, i) => JSON.stringify(pieces(`run-${i}`)));
    expect(new Set(runs).size).toBe(20);
  });

  it("never asks Math.random", () => {
    const random = vi.spyOn(Math, "random");
    pieces("job-7f3a");
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it("flies 1.4 times as far on desktop, with the same draws for everything else", () => {
    expect(DESKTOP_SCALE).toBe(1.4);
    const desk = pieces("job-7f3a", 96, DESKTOP_SCALE);
    desk.forEach((p, q) => {
      const m = burst[q];
      // Each side rounded once: at most .5 + 1.4 × .5 apart.
      expect(Math.abs(p.end.x - m.end.x * 1.4)).toBeLessThanOrEqual(1.2);
      expect(Math.abs(p.end.y - m.end.y * 1.4)).toBeLessThanOrEqual(1.2);
      expect(Math.abs(p.peak - m.peak * 1.4)).toBeLessThanOrEqual(1.2);
      expect({ ...p, peak: 0, end: null }).toEqual({ ...m, peak: 0, end: null });
    });
  });
});
