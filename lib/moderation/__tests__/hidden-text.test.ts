import { describe, expect, it } from "vitest";
import { showsHiddenText } from "@/lib/moderation/hidden-text";

/**
 * The text read off a render against an artist's hidden words (ENC review, 2026-10-27). Only the artist's own words
 * count: never a buyer's [slot], never a "quoted" phrase the artist wrote to be shown.
 */
const TEMPLATE =
  "Cinematic portrait of [subject] standing in golden hour backlight, shot on Portra 400 with a soft halation glow, " +
  "shallow depth of field, muted teal shadows and warm skin tones, a sign that reads \"Fresh Bread Daily\" behind them";

describe("the artist's words read off a render", () => {
  it("are found in six words of theirs in a row, whatever the case, accents or punctuation", () => {
    expect(showsHiddenText("SHOT ON PORTRA-400, WITH A SOFT HALATION... glow", TEMPLATE)).toBe(true);
    expect(showsHiddenText("chalkboard: soft halátion glow shallow depth of field", TEMPLATE)).toBe(true);
  });

  it("are found in a large share of their three-word runs, in another order", () => {
    // Five words at most in a row (no stretch follows the one it follows in the text), so only the share can find it.
    const shuffled = "warm skin tones a sign. halation glow shallow depth of. golden hour backlight shot on. field muted teal shadows and. portra 400 with a soft";
    expect(showsHiddenText(shuffled, TEMPLATE)).toBe(true);
    expect(showsHiddenText("warm skin tones a sign. golden hour backlight shot on", TEMPLATE)).toBe(false);
  });

  it("are not a few common words, the buyer's own value, or the phrase the artist quoted to be shown", () => {
    expect(showsHiddenText("golden hour", TEMPLATE)).toBe(false);
    expect(showsHiddenText("FRESH BREAD DAILY", TEMPLATE)).toBe(false);
    expect(showsHiddenText("a knight in silver armour holding a red lantern", TEMPLATE)).toBe(false);
    expect(showsHiddenText("", TEMPLATE)).toBe(false);
  });

  it("never count a slot's own words, which are where the buyer's value goes", () => {
    expect(showsHiddenText("a big red fox standing in the snow", "photo of [a big red fox] standing in the snow at dusk")).toBe(false);
    expect(showsHiddenText("a big red fox standing in the snow", "photo of a big red fox standing in the snow at dusk, [style]")).toBe(true);
  });

  it("never count a long quoted phrase the artist wrote to be shown", () => {
    const poster = 'a bakery poster that reads "Every Morning We Bake Fresh Bread For You" on a brick wall, [style]';
    expect(showsHiddenText("EVERY MORNING WE BAKE FRESH BREAD FOR YOU", poster)).toBe(false);
    expect(showsHiddenText("EVERY MORNING WE BAKE FRESH BREAD FOR YOU", poster.replace(/"/g, ""))).toBe(true);
    expect(showsHiddenText("EVERY MORNING WE BAKE FRESH BREAD FOR YOU", poster.replace(/"([^"]*)"/, "“$1”"))).toBe(false);
  });

  it("never run across a slot: the words on either side of a value are two stretches", () => {
    // "portrait of" + "standing in golden hour" would make six only across [subject].
    expect(showsHiddenText("cinematic portrait of standing in golden hour", TEMPLATE)).toBe(false);
  });

  it("need enough of a text to compare by share: a short one counts by runs only", () => {
    expect(showsHiddenText("a red fox in the snow", "a red fox in snow, [style]")).toBe(false);
    expect(showsHiddenText("a red fox in snow at night", "a red fox in snow at night, [style]")).toBe(true);
  });
});

// Review wf_866ba07b-01a: more ways an artist writes the lettering they mean to show, and texts that only look quoted.
describe("quotes", () => {
  it("count single and typographic single quotes as lettering to show", () => {
    for (const q of [["'", "'"], ["‘", "’"]]) {
      const t = `a hotel lobby with brass lettering reading ${q[0]}Welcome to the Grand Budapest Hotel lobby${q[1]}, [subject]`;
      expect(showsHiddenText("WELCOME TO THE GRAND BUDAPEST HOTEL LOBBY", t), q.join("")).toBe(false);
    }
  });

  it("never take an apostrophe for a quote, nor an inch mark", () => {
    expect(showsHiddenText("the artist's secret lighting recipe with a girl's red hat", "the artist's secret lighting recipe with a girl's red hat, [style]")).toBe(true);
    // A plural possessive ends in an apostrophe too.
    expect(showsHiddenText("secret lighting recipe with the girls red hats", "the artists' secret lighting recipe with the girls' red hats, [style]")).toBe(true);
    const inches = 'a 6" knight on a marble plinth beside a 10" vase, cinematic light, [style]';
    expect(showsHiddenText("knight on a marble plinth beside", inches)).toBe(true);
  });

  it("compare a long quoted text, as a JSON-style prompt is written", () => {
    const json = '{"prompt": "a lone red fox crossing a frozen river at dawn in thick fog with soft volumetric light", "style": "oil"}';
    expect(showsHiddenText("a lone red fox crossing a frozen river", json)).toBe(true);
    expect(showsHiddenText("PROMPT STYLE OIL", json)).toBe(false);
  });
});
