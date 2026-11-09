import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Review of 18f949b6 (FE-5a): the refactor into use-guardians dropped the sign-out clear that RecoveryPanel had
// (4139a05c:components/settings/RecoveryPanel.tsx:106), so a signed-out panel kept the last account's guardians (DEC-2026-11-08-44).
describe("Settings' recovery panel on sign-out", () => {
  it("clears the guardians with the passkeys, as before the refactor", () => {
    const src = readFileSync("components/settings/RecoveryPanel.tsx", "utf8");
    expect(src).toContain("if (!authed) { setPasskeys([]); setGuardians([]); return; }");
    expect(readFileSync("components/settings/use-guardians.ts", "utf8")).toMatch(/return \{\n\s+guardians, setGuardians,/);
  });
});
