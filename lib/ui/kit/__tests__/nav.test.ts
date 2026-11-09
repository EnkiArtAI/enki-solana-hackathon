import { describe, expect, it } from "vitest";
import { navFor, readStoredNav, widestNav, type NavState } from "../breakpoints";

const STATES: NavState[] = ["closed", "icons", "full"];

/** The menu a window `width` px wide shows for `pick`, as the shell computes it. */
const at = (width: number, pick: NavState | null) => navFor(widestNav(width), pick);

describe("widestNav", () => {
  it.each([
    [1440, "full"],
    [1360, "full"],
    [1359.99, "icons"],
    [1359, "icons"],
    [1180, "icons"],
    [1179.99, "closed"],
    [1024, "closed"],
    [0, "closed"],
  ] as const)("a %spx window fits %s at most", (width, nav) => {
    expect(widestNav(width)).toBe(nav);
  });
});

describe("navFor", () => {
  it("without a pick shows the widest that fits", () => {
    for (const widest of STATES) expect(navFor(widest, null)).toBe(widest);
  });

  it("keeps any pick where full fits", () => {
    for (const pick of STATES) expect(at(1440, pick)).toBe(pick);
  });

  it("keeps a narrower pick and drops a pick that no longer fits to the widest that does", () => {
    expect(at(1300, "closed")).toBe("closed");
    expect(at(1300, "icons")).toBe("icons");
    expect(at(1300, "full")).toBe("icons");
    for (const pick of STATES) expect(at(1100, pick)).toBe("closed");
  });

  it("never opens wider than the window fits, whatever the pick", () => {
    const rank = (nav: NavState) => STATES.indexOf(nav);
    for (let width = 1000; width <= 1500; width += 10) {
      for (const pick of STATES) {
        const nav = at(width, pick);
        expect(rank(nav)).toBeLessThanOrEqual(rank(at(width, null)));
        if (rank(pick) <= rank(at(width, null))) expect(nav).toBe(pick);
      }
    }
  });

  it("brings a stored full pick back once the window is wide again", () => {
    expect([1440, 1300, 1100, 1440].map((w) => at(w, "full"))).toEqual(["full", "icons", "closed", "full"]);
    expect([1100, 1300, 1440].map((w) => at(w, "closed"))).toEqual(["closed", "closed", "closed"]);
  });

  it("holds icons picked at 1440 through a reload", () => {
    expect(at(1440, readStoredNav("icons", null))).toBe("icons");
  });
});

describe("readStoredNav", () => {
  it("returns a stored ek-nav state as it is, ahead of the legacy key", () => {
    for (const nav of STATES) {
      expect(readStoredNav(nav, null)).toBe(nav);
      expect(readStoredNav(nav, "1")).toBe(nav);
    }
  });

  it("reads the legacy ek-menu-collapsed \"1\" as icons when ek-nav is absent", () => {
    expect(readStoredNav(null, "1")).toBe("icons");
  });

  it("is null for anything else in the legacy key", () => {
    for (const legacy of [null, "0", "", "true", "11"]) expect(readStoredNav(null, legacy), String(legacy)).toBeNull();
  });

  it("treats an unknown ek-nav value as absent", () => {
    for (const raw of ["", "rail", "FULL", " full"]) {
      expect(readStoredNav(raw, null), raw).toBeNull();
      expect(readStoredNav(raw, "1"), raw).toBe("icons");
    }
  });
});
