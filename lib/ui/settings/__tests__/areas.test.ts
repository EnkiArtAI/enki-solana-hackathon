import { describe, expect, it } from "vitest";
import { AREAS, MONEY_TABS, SETTINGS_HOME, settingsAt } from "@/lib/ui/settings/areas";

// Kev, 2026-11-08: the Settings mock v64 replaces today's Settings, "so wie sie sind präzise verdrahtet" (DEC-2026-11-08-37).

describe("Settings' areas", () => {
  it("are the mock's bar, in its order, and Money's four tabs", () => {
    expect(AREAS.map((a) => a.label)).toEqual(["App", "Content", "Account", "Money", "Safety"]);
    expect(MONEY_TABS.map((t) => t.label)).toEqual(["Balance", "Usage", "API", "Billing"]);
  });

  it("open on Money's Balance, as the mock does, when nothing names a place", () => {
    expect(SETTINGS_HOME).toEqual({ area: "money", money: "balance" });
    for (const none of [undefined, null, ""]) expect(settingsAt(none)).toEqual(SETTINGS_HOME);
  });

  it("land today's three tabs where their functions moved", () => {
    expect(settingsAt("profile")).toEqual({ area: "account", money: "balance" });
    expect(settingsAt("payment")).toEqual({ area: "money", money: "balance" });
    expect(settingsAt("recovery")).toEqual({ area: "safety", money: "balance" });
  });

  it("keep ?tab=billing on Balance, where the old Add funds links and the onramp's way back mean to go, not on Money's Billing", () => {
    expect(settingsAt("billing")).toEqual({ area: "money", money: "balance" });
    expect(settingsAt("money/billing")).toEqual({ area: "money", money: "billing" });
  });

  it("take an area by its id and a Money tab as money/<tab>", () => {
    for (const a of AREAS) expect(settingsAt(a.key)).toEqual({ area: a.key, money: "balance" });
    for (const t of MONEY_TABS) expect(settingsAt(`money/${t.key}`)).toEqual({ area: "money", money: t.key });
  });

  it("send anything else home, an object's own names included", () => {
    for (const odd of ["nonsense", "money/nonsense", "app/usage", "Money", "constructor", "toString", "__proto__", "money/"]) {
      expect(settingsAt(odd)).toEqual(SETTINGS_HOME);
    }
  });
});
