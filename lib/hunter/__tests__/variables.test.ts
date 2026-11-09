import { describe, it, expect } from "vitest";
import { importVariables, slotVariables, unwrap } from "../variables";

/** A hunted prompt's [variables] in Enki's form (Kev, 2026-10-31: "umgeformt werden in Variable_name = variable_value"). */
describe("importVariables", () => {
  it("turns definitions into NAME = [NAME] lines with variables, their values as defaults, a blank taking its own name (Kev, 2026-10-31: a release refuses an empty one)", () => {
    const got = importVariables("[ BRAND NAME = _____________]\n\n[ MATERIAL COLOR = vivid acid chartreuse]\n\nCreate a botanical logo installation for BRAND NAME in MATERIAL COLOR.");
    expect(got.prompt).toBe("BRAND NAME = [BRAND NAME]\n\nMATERIAL COLOR = [MATERIAL COLOR]\n\nCreate a botanical logo installation for BRAND NAME in MATERIAL COLOR.");
    expect(got.variables).toEqual([
      { name: "BRAND NAME", label: "BRAND NAME", description: "", type: "text", defaultValue: "BRAND NAME", required: true, position: 0 },
      { name: "MATERIAL COLOR", label: "MATERIAL COLOR", description: "", type: "text", defaultValue: "vivid acid chartreuse", required: true, position: 1 },
    ]);
  });

  // Every bracket on one line, as the release reads slots (Kev, 2026-11-01: "[LANDMARK/BUILDING NAME]" got no variable and
  // fifteen approvals answered 409).
  it("gives every [slot] in the text its variable, once, whatever its name holds, and leaves plain prompts alone", () => {
    const got = importVariables("A portrait of [subject] in [season] light, [subject] smiling, at [LANDMARK/BUILDING NAME], by [ PERSON / CHARACTER NAME ], --ar 4:5");
    expect(got.prompt).toBe("A portrait of [subject] in [season] light, [subject] smiling, at [LANDMARK/BUILDING NAME], by [ PERSON / CHARACTER NAME ], --ar 4:5");
    expect(got.variables.map((v) => [v.name, v.defaultValue, v.position])).toEqual([
      ["subject", "subject", 0], ["season", "season", 1], ["LANDMARK/BUILDING NAME", "LANDMARK/BUILDING NAME", 2], ["PERSON / CHARACTER NAME", "PERSON / CHARACTER NAME", 3],
    ]);
    expect(importVariables("A lighthouse keeper at dawn, soft fog")).toEqual({ prompt: "A lighthouse keeper at dawn, soft fog", variables: [] });
  });

  // Kev, 2026-11-01, @AmirMushich status 1993236623308341280 and 1996996638452208104 as FxTwitter gave them.
  it("takes off a pair of brackets around the whole prompt and an opening one that never closes, never a slot's", () => {
    const sketch = "[A hand-drawn infographic sketch on cream-colored sketchbook paper. Paper texture visible, slight shadows, organic and warm feel.]";
    expect(importVariables(sketch).prompt).toBe("A hand-drawn infographic sketch on cream-colored sketchbook paper. Paper texture visible, slight shadows, organic and warm feel.");
    const golf = importVariables("[Generate an ultra-detailed, drawing exploded technical view of [ANYTHING]\"");
    expect(golf.prompt).toBe("Generate an ultra-detailed, drawing exploded technical view of [ANYTHING]");
    // A quote that has its partner stays.
    expect(unwrap('[A sign that reads "open", [COLOR] paint')).toBe('A sign that reads "open", [COLOR] paint');
    expect(golf.variables.map((v) => v.name)).toEqual(["ANYTHING"]);
    for (const kept of ["[BRAND NAME] | [HEADLINE = AUTO] a hero page", "[PERSONE]. Act as a Senior Art Director.", "[PERSONE]", "A lighthouse [keeper]"]) expect(unwrap(kept), kept).toBe(kept);
    expect(unwrap("[a [slot] inside, then the end]")).toBe("a [slot] inside, then the end");
  });
  // A find made before every bracket was a slot, or edited by hand, still releases: each slot gets a variable then.
  it("gives a find's release a variable for every slot of its prompt as it stands, kept values first", () => {
    const kept = [
      { name: "HEADLINE", label: "HEADLINE", description: "", type: "text" as const, defaultValue: "user text or AUTO", required: true, position: 0 },
      { name: "GONE", label: "GONE", description: "", type: "text" as const, defaultValue: "x", required: true, position: 1 },
      { name: "COLOR", label: "COLOR", description: "", type: "text" as const, defaultValue: " ", required: true, position: 2 },
    ];
    const got = slotVariables("A poster of [LANDMARK/BUILDING NAME] with [HEADLINE] in [COLOR]", kept);
    expect(got.map((v) => [v.name, v.defaultValue, v.position])).toEqual([["LANDMARK/BUILDING NAME", "LANDMARK/BUILDING NAME", 0], ["HEADLINE", "user text or AUTO", 1], ["COLOR", "COLOR", 2]]);
  });
});
