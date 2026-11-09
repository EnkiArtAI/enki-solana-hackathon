import { describe, it, expect } from "vitest";
import { lockedFor } from "../wheel";

describe("the balance lock (S:341)", () => {
  it("locks a count whose images cost more than the balance, and not one that costs it exactly", () => {
    expect(lockedFor(0.21, 20, 4.2)).toBe(false);
    expect(lockedFor(0.22, 20, 4.2)).toBe(true);
    expect(lockedFor(0.25, 1, 0.25)).toBe(false);
    expect(lockedFor(0.25, 1, 0.24)).toBe(true);
  });

  it("counts in whole micro-USDC, so 3 × $0.10 (0.30000000000000004 as a float) fits $0.30", () => {
    expect(lockedFor(0.1, 3, 0.3)).toBe(false);
    expect(lockedFor(0.1, 3, 0.1 + 0.2)).toBe(false);
    expect(lockedFor(0.1, 4, 0.3)).toBe(true);
  });
});
