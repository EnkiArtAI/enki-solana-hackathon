import { describe, it, expect } from "vitest";
import { renderProgress, paintingLabel } from "../progress";

const E = 30_000;
const at = (ms: number, expected = E) => renderProgress(ms, expected);

describe("renderProgress", () => {
  it("is 0 at the press, and for a clock behind it or none at all", () => {
    expect(at(0)).toBe(0);
    expect(at(-5_000)).toBe(0);
    expect(at(NaN)).toBe(0);
  });

  it("only ever rises, visibly for the first four expected times", () => {
    let last = at(0);
    for (let ms = 250; ms <= 20 * E; ms += 250) {
      const f = at(ms);
      if (ms <= 4 * E) expect(f, `${ms} ms`).toBeGreaterThan(last);
      else expect(f, `${ms} ms`).toBeGreaterThanOrEqual(last);
      last = f;
    }
    expect(at(Infinity)).toBeGreaterThanOrEqual(last);
  });

  it("approaches 90 % but never passes it, however long the render runs", () => {
    for (const ms of [E, 5 * E, 10 * E, 100 * E, 1e15, Infinity]) expect(at(ms), `${ms} ms`).toBeLessThanOrEqual(0.9);
    expect(at(10 * E)).toBeGreaterThan(0.899);
  });

  it("rises fast at first: 78 % at the expected time, 88 % at twice it", () => {
    expect(at(E / 4) - at(0)).toBeGreaterThan(2 * (at(E) - at((3 * E) / 4)));
    expect(at(E / 4)).toBeCloseTo(0.354, 3);
    expect(at(E)).toBeCloseTo(0.778, 3);
    expect(at(2 * E)).toBeCloseTo(0.884, 3);
  });

  it("scales with the expected time: a longer render fills more slowly", () => {
    expect(renderProgress(60_000, 60_000)).toBeCloseTo(at(E), 12);
    expect(renderProgress(10_000, 60_000)).toBeLessThan(renderProgress(10_000, 30_000));
    expect(renderProgress(10_000, 60_000)).toBeCloseTo(0.255, 3);
  });

  it("assumes 30 s when no usable expected time is given", () => {
    for (const bad of [0, -1, -E, NaN, Infinity, -Infinity]) {
      for (const ms of [0, 7_500, E, 3 * E]) expect(renderProgress(ms, bad), `${ms} ms of ${bad}`).toBe(at(ms));
    }
  });

  it("is 1 once the job has resolved, whatever the clock says", () => {
    expect(renderProgress(0, E, true)).toBe(1);
    expect(renderProgress(E, E, true)).toBe(1);
    expect(renderProgress(Infinity, 0, true)).toBe(1);
    expect(renderProgress(-1, NaN, true)).toBe(1);
    expect(renderProgress(E, E)).toBeLessThan(0.9);
  });
});

describe("paintingLabel", () => {
  it("is the singular for one image", () => {
    expect(paintingLabel(1)).toBe("Painting your portrait…");
  });

  it("counts a batch, never the singular for it (D32)", () => {
    expect(paintingLabel(2)).toBe("Painting 2 portraits…");
    expect(paintingLabel(8)).toBe("Painting 8 portraits…");
  });

  it("never says 0 portraits", () => {
    expect(paintingLabel(0)).toBe("Painting your portrait…");
  });
});
