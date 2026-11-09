import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Kev, 2026-11-08: on a short balance, "Generate" stands in the middle between the button's left edge and the balance (DEC-2026-11-08-47).
describe("the Generate button with a short balance", () => {
  it("wraps its label in .kit-gen-label, which takes the room left of the balance and centres in it", () => {
    expect(readFileSync("components/kit/GenerateButton.tsx", "utf8")).toContain('{short !== null ? <span className="kit-gen-label">{label}</span> : label}');
    expect(readFileSync("components/kit/kit-controls.css", "utf8")).toMatch(/\.kit-gen-label \{ flex: 1 1 auto; display: inline-flex; align-items: center; justify-content: center;/);
  });
});
