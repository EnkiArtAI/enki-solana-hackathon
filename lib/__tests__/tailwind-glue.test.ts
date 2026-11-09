import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Tailwind's scanner does not read an arbitrary-value class glued to a template expression ("z-[2001]${…}"), so it writes no
// rule for it. That left the wallet picker with no z-index under its own veil, the whole login blurred (DEC-2026-11-08-46).
describe("class strings", () => {
  it("never glue an arbitrary-value class to a template expression", () => {
    const files = execSync("git ls-files -- \"*.tsx\"", { encoding: "utf8" }).split("\n").filter((f) => f && !f.includes("__tests__"));
    const glued = files.filter((f) => /\]\$\{/.test(readFileSync(f, "utf8")));
    expect(glued).toEqual([]);
  });

  it("the wallet picker's card keeps its layer above the veil", () => {
    const src = readFileSync("components/WalletPickerModal.tsx", "utf8");
    expect(src).toContain('className={inApp ? "sm:max-w-[400px] gap-0 border-0 p-0 overflow-hidden z-[2001] wp-app" : "sm:max-w-[400px] gap-0 border-0 p-0 overflow-hidden z-[2001]"}');
  });
});
