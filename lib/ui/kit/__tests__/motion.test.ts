import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";

// Kev, 2026-11-08: the Settings mock v64's App area, "Less motion · Fewer slides and fades." (DEC-2026-11-08-40).

type Motion = typeof import("@/lib/ui/kit/motion");
let motion: Motion;
let stored: Map<string, string>;
let classes: Set<string>;

beforeEach(async () => {
  vi.resetModules();
  motion = await import("@/lib/ui/kit/motion");
  stored = new Map();
  classes = new Set();
  vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); } });
  vi.stubGlobal("document", { documentElement: { classList: { toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); return on; } } } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("less motion, this device's choice", () => {
  it("is off until the reader turns it on, and boot leaves the page as it was", () => {
    expect(motion.lessMotion()).toBe(false);
    motion.applyLessMotion();
    expect([...classes]).toEqual([]);
  });

  it("stays off at boot where this device turned it off again", () => {
    stored.set("enki:less-motion", "0");
    motion.applyLessMotion();
    expect([motion.lessMotion(), [...classes]]).toEqual([false, []]);
  });

  it("comes back on at boot where this device chose it", () => {
    stored.set("enki:less-motion", "1");
    motion.applyLessMotion();
    expect([motion.lessMotion(), [...classes]]).toEqual([true, ["ek-less-motion"]]);
  });

  it("is stored, put on the page and told to whoever listens, both ways", () => {
    const heard = vi.fn();
    const stop = motion.subscribeLessMotion(heard);
    motion.setLessMotion(true);
    expect([stored.get("enki:less-motion"), motion.lessMotion(), [...classes], heard.mock.calls.length]).toEqual(["1", true, ["ek-less-motion"], 1]);
    motion.setLessMotion(false);
    expect([stored.get("enki:less-motion"), motion.lessMotion(), [...classes], heard.mock.calls.length]).toEqual(["0", false, [], 2]);
    stop();
    motion.setLessMotion(true);
    expect(heard.mock.calls.length).toBe(2);
  });

  it("holds for this visit where the browser refuses the storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(motion.lessMotion()).toBe(false);
    motion.setLessMotion(true);
    expect([motion.lessMotion(), [...classes]]).toEqual([true, ["ek-less-motion"]]);
  });

  it("does nothing where there is no page (the server's render)", () => {
    vi.stubGlobal("document", undefined);
    expect(() => motion.applyLessMotion()).not.toThrow();
  });
});

describe("what the switch does to the page", () => {
  it("cuts every transition and animation on the page to an instant, so their end events and end states still come", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const c = `html.${motion.LESS_MOTION_CLASS}`;
    expect(css).toContain([
      `${c},`, `${c} *,`, `${c} *::before,`, `${c} *::after {`,
      "  animation-duration: 0.01ms !important;",
      "  animation-iteration-count: 1 !important;",
      "  transition-duration: 0.01ms !important;",
      "  scroll-behavior: auto !important;",
      "}",
    ].join("\n"));
  });

  it("is put on the page once at boot, by the providers every page sits in", () => {
    const providers = readSource("providers/index.tsx");
    expect(providers).toContain('import { applyLessMotion } from "@/lib/ui/kit/motion";');
    expect(providers).toContain("useEffect(() => { applyLessMotion(); }, []);");
  });
});
