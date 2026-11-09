import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { autoTitle } from "@/lib/generation/auto-title";

const pick = vi.hoisted(() => ({ at: null as "max" | "min" | null }));
vi.mock("node:crypto", async (original) => {
  const real = await original<typeof import("node:crypto")>();
  return { ...real, randomInt: (n: number) => (pick.at === "max" ? n - 1 : pick.at === "min" ? 0 : real.randomInt(n)) };
});

/* Every prompt has a title; one made on the side is "enki-" and a unique id (Kev, 2026-10-17). */
describe("autoTitle", () => {
  it("is enki- and eight base36 characters", () => {
    expect(autoTitle()).toMatch(/^enki-[0-9a-z]{8}$/);
  });

  it("never reads the same twice, as a parallel batch would ask", () => {
    const titles = Array.from({ length: 2000 }, () => autoTitle());
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("draws from all 36^8 ids, each eight characters long", () => {
    try {
      pick.at = "max";
      expect(autoTitle()).toBe("enki-zzzzzzzz");
      pick.at = "min";
      expect(autoTitle()).toBe("enki-00000000");
    } finally {
      pick.at = null;
    }
  });

  it("is what a prompt row made on the side is called", () => {
    const record = readFileSync(join(__dirname, "..", "record.ts"), "utf8");
    expect(record).toContain("title: autoTitle(),");
    expect(record).not.toContain('title: "Untitled"');
  });
});
