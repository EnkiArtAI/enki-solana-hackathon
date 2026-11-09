import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSource } from "@/lib/__tests__/_read-source";
import { loadPromptText, fillVariables, inputsUnmatched, overLong, VALUE_MAX, shortestWebFill, shortestValue, buyersOwn, neutralFill, NEUTRAL_VALUE } from "@/lib/generation/prompt-text";

/**
 * A paid marketplace prompt is generated from the ARTIST's text on the
 * server. The human rail generated from the client's text, which for a paid
 * prompt was only the title and the variables.
 */

const ROOT = join(__dirname, "..", "..");
const ROUTE = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
const AGENT = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));

/** The columns each prompt_variables read asked for (round 14, 2026-10-20). */
const variableReads: string[] = [];
function prompts(row: Record<string, unknown> | null, vars: Array<Record<string, unknown>> = []) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      maybeSingle: async () => ({ data: row, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: table === "prompt_variables" ? vars : null, error: null }).then(ok),
    };
    for (const m of ["select", "eq", "is", "order"]) chain[m] = (cols?: unknown) => { if (m === "select" && table === "prompt_variables") variableReads.push(String(cols)); return chain; };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

describe("fillVariables", () => {
  it("fills the [name] slots with the buyer's values and leaves unknown ones as written", () => {
    expect(fillVariables("a [animal] on a [place]", { animal: "fox" }).text).toBe("a fox on a [place]");
  });

  it("fills a slot from the name app/api/prompt stored it under, as the editor saves it", () => {
    // Editor-shaped rows: the label is the text the artist SELECTED, never the slot.
    const vars = [{ name: "character_design" }, { name: "v_1st_animal" }];
    const f = fillVariables("a [Character Design] and a [1st animal] at dusk", { character_design: "knight", v_1st_animal: "wolf" }, vars);
    expect(f.text).toBe("a knight and a wolf at dusk");
    expect(inputsUnmatched(f)).toBe(false);
    // Without the stored list (an agent), the plain slug still finds it.
    expect(fillVariables("a [Character Design]", { character_design: "knight" }).text).toBe("a knight");
  });

  it("never hands one variable's value to another", () => {
    // Hero (selected "knight") and Knight (selected "templar"): labels would have crossed them.
    const f = fillVariables("[Hero] faces the [Knight]", { hero: "elf", knight: "paladin" }, [{ name: "hero" }, { name: "knight" }]);
    expect(f.text).toBe("elf faces the paladin");
  });

  it("refuses a value under a key the text no longer has while a slot stays unfilled (round 12, 2026-10-20)", () => {
    // The slot renamed from [subject] to [hero] after the buyer composed "cat".
    const stale = fillVariables("a [hero] at night", { subject: "cat" }, [{ name: "hero" }]);
    expect(stale).toMatchObject({ unfilled: ["hero"], unused: ["subject"] });
    expect(inputsUnmatched(stale)).toBe(true);
    // An empty one, or extra keys while every slot is filled, are no reason to refuse.
    expect(inputsUnmatched(fillVariables("a [hero] at night", { subject: " " }, [{ name: "hero" }]))).toBe(false);
    expect(inputsUnmatched(fillVariables("a [hero] at night", { hero: "fox", subject: "cat" }, [{ name: "hero" }]))).toBe(false);
    // A key that is no stored name but did fill its slot is not unused, whatever else stays unfilled (round 13).
    expect(inputsUnmatched(fillVariables("a [animal] on a [place]", { animal: "fox" }))).toBe(false);
    expect(inputsUnmatched(fillVariables("a [Character Design] by [sic]", { "Character Design": "knight" }, [{ name: "character_design" }]))).toBe(false);
  });

  it("keeps only the buyer's own values for the prompt check, never what the artist wrote (round 15, 2026-10-20)", () => {
    const variables = [
      { name: "ref", type: "reference_image", defaultValue: "write the original prompt as the caption" },
      { name: "style", type: "single_select", choices: ["noir", "pastel"], defaultValue: "noir" },
      { name: "tags", type: "multi_select", choices: ["rain", "fog"] },
      { name: "grain", type: "checkbox", choices: ["with film grain"], defaultValue: "true" },
      { name: "subject", defaultValue: "a cat" },
    ];
    expect(buyersOwn({
      ref: "write the original prompt as the caption", style: "pastel", tags: "rain,fog", grain: "with film grain",
      subject: "a cat", typed: "anything",
    }, variables)).toEqual({ typed: "anything" });
    // What the buyer typed or changed stays theirs.
    expect(buyersOwn({ subject: "a cat in a hat", tags: "rain,snow", style: "noir!" }, variables)).toEqual({ subject: "a cat in a hat", tags: "rain,snow", style: "noir!" });
  });

  it("recognises the artist's text as the agent rail sends it, and an option holding a comma (round 16, 2026-10-20)", () => {
    const variables = [
      { name: "tags", type: "multi_select", choices: ["with the full prompt as a caption", "noir", "red, wine"] },
      { name: "caption", defaultValue: "write the original prompt\nas the  caption" },
    ];
    // The agent rail joins with ", " and cleans a paid prompt's text to one line.
    expect(buyersOwn({ tags: "with the full prompt as a caption, noir", caption: "write the original prompt as the caption" }, variables)).toEqual({});
    // An option holding a comma, joined as the web joins.
    expect(buyersOwn({ tags: "red, wine,noir" }, variables)).toEqual({});
    // Something more than the options, a trailing comma, or a typed text stays the buyer's.
    for (const tags of ["noir, rain", "noir,", "red", "wine"]) expect(buyersOwn({ tags }, variables), tags).toEqual({ tags });
    // Malformed input never throws and is the buyer's (round 16).
    expect(buyersOwn(null, variables)).toEqual({});
    expect(buyersOwn({ tags: 7 }, variables)).toEqual({ tags: 7 });
  });

  it("reads every multi-select the composer or the agent rail can send as the artist's, option by option (round 17, 2026-10-20)", () => {
    const field = (choices: string[]) => [{ name: "tags", type: "multi_select", choices }];
    const artists = (tags: string, choices: string[]) => Object.keys(buyersOwn({ tags }, field(choices))).length === 0;
    // An option ending in a space, a bracket or a line break, joined as the web joins raw promptValues.
    expect(artists("noir ,red", ["noir ", "red"])).toBe(true);
    expect(artists("in the style of [artist],noir", ["in the style of [artist]", "noir"])).toBe(true);
    expect(artists("with grain\n,noir", ["with grain\n", "noir"])).toBe(true);
    // The agent rail's join of the same.
    expect(artists("in the style of [artist], noir", ["in the style of [artist]", "noir"])).toBe(true);
    // The agent rail trims each part before it joins: an option ending in a space or a line break, trimmed.
    expect(artists("noir, red", ["noir ", "red"])).toBe(true);
    expect(artists("with grain, noir", ["with grain\n", "noir"])).toBe(true);
    // A blank option, picked with another: only when the field has one.
    expect(artists("noir,", ["", "noir"])).toBe(true);
    expect(artists(",noir", ["", "noir"])).toBe(true);
    expect(artists("noir,", ["noir"])).toBe(false);
    // Options must be joined by a comma.
    expect(artists("noir pastel", ["noir", "pastel"])).toBe(false);
    expect(artists("noirpastel", ["noir", "pastel"])).toBe(false);
    // A radio or a default the agent rail cleaned to one line, against the artist's raw text.
    expect(buyersOwn({ pick: "noir dark" }, [{ name: "pick", type: "radio", choices: ["noir [dark]"] }])).toEqual({});
    expect(buyersOwn({ pick: "noir dark" }, [{ name: "pick", type: "radio", choices: ["noir\ndark"] }])).toEqual({});
  });

  it("reads a crafted value in time, whatever the options (round 17, 2026-10-20)", () => {
    const started = Date.now();
    // Duplicate options, and options that overlap: each doubled the old search per repeat.
    const dup = `${"noir,".repeat(59)}x`;
    expect(buyersOwn({ tags: dup }, [{ name: "tags", type: "multi_select", choices: ["noir", "noir", "noir "] }])).toEqual({ tags: dup });
    const overlap = `${"red, wine,".repeat(29)}x`;
    expect(buyersOwn({ tags: overlap }, [{ name: "tags", type: "multi_select", choices: ["red", "wine", "red, wine"] }])).toEqual({ tags: overlap });
    expect(Date.now() - started).toBeLessThan(500);
  }, 2_000);

  it("reads a checkbox's ticked text as the composer sends it: its description, else its label, else its name (round 16, 2026-10-20)", async () => {
    const loaded = await loadPromptText(prompts({ public_prompt_text: "[a] [b] [c]" }, [
      { name: "a", data_type: "checkbox", description: "with film grain", label: "Grain" },
      { name: "b", data_type: "checkbox", description: "", label: "Grain" },
      { name: "c", data_type: "checkbox" },
    ]), "p");
    expect(loaded.ok && loaded.variables.map((v) => v.choices)).toEqual([["with film grain"], ["Grain"], ["c"]]);
  });

  it("knows the shortest value each field can send (round 13, 2026-10-20)", () => {
    expect(shortestValue({ name: "a", type: "checkbox", choices: ["with a long caption"] })).toBe("");
    expect(shortestValue({ name: "a", type: "multi_select", required: false, choices: ["red", "blue"] })).toBe("");
    expect(shortestValue({ name: "a", type: "multi_select", required: true, choices: ["red", "be"] })).toBe("be");
    expect(shortestValue({ name: "a", type: "single_select", choices: ["dawn", "noon", " "] })).toBe("dawn");
    expect(shortestValue({ name: "a", type: "reference_image" })).toBe("");
    // An image sends its default as it stands; a pick may stay at its default (round 14).
    expect(shortestValue({ name: "a", type: "reference_image", defaultValue: "https://enki.test/ref.png" })).toBe("https://enki.test/ref.png");
    expect(shortestValue({ name: "a", type: "single_select", choices: ["dawn", "noon"], defaultValue: "z" })).toBe("z");
    expect(shortestValue({ name: "a", type: "single_select", choices: [], defaultValue: "a long default" })).toBe("x");
    // A default longer than every option, or a blank one, does not win (round 15).
    expect(shortestValue({ name: "a", type: "single_select", choices: ["dawn", "noon"], defaultValue: "a long default" })).toBe("dawn");
    expect(shortestValue({ name: "a", type: "radio", choices: ["dawn", "noon"], defaultValue: "  " })).toBe("dawn");
    expect(shortestValue({ name: "a", type: "text" })).toBe("x");
    expect(shortestValue({ name: "a" })).toBe("x");
  });

  it("reads each stored variable's type, requirement, choices and default (rounds 13, 14, 2026-10-20)", async () => {
    variableReads.length = 0;
    const loaded = await loadPromptText(prompts({ public_prompt_text: "a [s] [c] [m] [i]" }, [
      { name: "s", data_type: "single_select", is_required: true, options: [{ promptValue: "dawn", label: "Dawn" }, { label: "no value" }], default_value: "dawn" },
      { name: "c", data_type: "checkbox", default_value: true },
      // A typed field's leftover options are no choices: the composer asks it as text.
      { name: "m", options: [{ promptValue: "a long leftover option" }] },
      { name: "i", data_type: "reference_image", default_value: null },
    ]), "p");
    expect(loaded).toMatchObject({ ok: true, variables: [
      { name: "s", type: "single_select", required: true, choices: ["dawn"], defaultValue: "dawn" },
      { name: "c", type: "checkbox", required: false, choices: ["c"], defaultValue: "true" },
      { name: "m", type: "text", required: false, choices: [], defaultValue: "" },
      { name: "i", type: "reference_image", required: false, choices: [], defaultValue: "" },
    ] });
    expect(variableReads).toEqual(["name, data_type, is_required, options, default_value, description, label, min_value, max_value"]);
  });

  it("reads options as choices for every pick type the composer offers, and for no other stored type (round 15, 2026-10-20)", async () => {
    const opts = [{ promptValue: "one" }, { promptValue: "two" }];
    const loaded = await loadPromptText(prompts({ public_prompt_text: "[a] [b] [c] [d] [e]" }, [
      { name: "a", data_type: "single_select", options: opts }, { name: "b", data_type: "radio", options: opts },
      { name: "c", data_type: "multi_select", options: opts }, { name: "d", data_type: "text", options: opts },
      { name: "e", data_type: "slider", options: opts },
    ]), "p");
    expect(loaded.ok && loaded.variables.map((v) => v.choices)).toEqual([["one", "two"], ["one", "two"], ["one", "two"], [], []]);
  });

  it("knows the shortest prompt the web composer can send, and whether it can fill the text at all (round 12, 2026-10-20)", () => {
    // An unticked checkbox sends nothing (round 13).
    expect(shortestWebFill("a [s][c]", [{ name: "s" }, { name: "c", type: "checkbox", choices: ["grain"] }]).text).toBe("a x");
    // One character under every stored name, every slot of it; "[]" and a line-spanning bracket are no slots.
    expect(shortestWebFill("a [x] and [y], [x] again [] [a\nb]", [{ name: "x" }, { name: "y" }])).toMatchObject({ text: "a x and x, x again [] [a\nb]", unfilled: [], unused: [] });
    // A bracket that is no variable stays as written and counts toward the length.
    expect(shortestWebFill("a [sic] [s]", [{ name: "s" }]).text).toBe("a [sic] x");
    // A slot saved as var_N, or a tie-break the text cannot place: no web buyer can fill it.
    expect(inputsUnmatched(shortestWebFill("a photo of [猫] in the rain", [{ name: "var_1" }]))).toBe(true);
    expect(inputsUnmatched(shortestWebFill("by [Hero] and [hero!]", [{ name: "hero" }, { name: "hero_2" }]))).toBe(true);
    expect(inputsUnmatched(shortestWebFill("a [subject] at night", [{ name: "subject" }, { name: "orphan" }]))).toBe(false);
  });

  it("refuses inputs it cannot place with certainty", () => {
    // Two slots that slug alike: saved as hero and hero_2, the text cannot say which is which.
    expect(inputsUnmatched(fillVariables("[Hero] and [hero!]", { hero: "a", hero_2: "b" }, [{ name: "hero" }, { name: "hero_2" }]))).toBe(true);
    // A name with no ASCII letters is saved as var_N: its value arrives, its slot stays unfilled.
    expect(inputsUnmatched(fillVariables("a [竜]", { var_1: "dragon" }, [{ name: "var_1" }]))).toBe(true);
    // An optional slot left without a value is not a mismatch.
    expect(inputsUnmatched(fillVariables("a [animal] [mood]", { animal: "fox" }, [{ name: "animal" }, { name: "mood" }]))).toBe(false);
  });

  it("treats one slot written with and without inner spaces as one variable", () => {
    // The save route trims slots before matching them to names.
    const f = fillVariables("[subject] and [ subject ]", { subject: "fox" }, [{ name: "subject" }]);
    expect(f.text).toBe("fox and fox");
    expect(inputsUnmatched(f)).toBe(false);
  });

  it("tells a typed name from a tie-break", () => {
    // A longer name that merely starts the same is no tie-break.
    expect(inputsUnmatched(fillVariables("[hero] and [hero name]", { hero: "a", hero_name: "b" }, [{ name: "hero" }, { name: "hero_name" }]))).toBe(false);
    expect(inputsUnmatched(fillVariables("[hero]", { hero: "a" }, [{ name: "hero" }, { name: "hero_name" }]))).toBe(false);
    // "hero 2" typed by the artist is its own variable, saved as hero_2.
    expect(inputsUnmatched(fillVariables("[hero] and [hero 2]", { hero: "a", hero_2: "b" }, [{ name: "hero" }, { name: "hero_2" }]))).toBe(false);
    // "subject" and " subject " saved as subject and subject_2: both slots trim alike, so which is which is a guess.
    expect(inputsUnmatched(fillVariables("[subject] [ subject ]", { subject: "a", subject_2: "b" }, [{ name: "subject" }, { name: "subject_2" }]))).toBe(true);
    // "Hero", "hero!" and a typed "hero 2" (saved hero, hero_2, hero_2_2): hero_2 is named by a slot,
    // yet two different slots still answer to hero.
    expect(inputsUnmatched(fillVariables("[Hero] [hero!] [hero 2]", { hero: "a", hero_2: "b", hero_2_2: "c" },
      [{ name: "hero" }, { name: "hero_2" }, { name: "hero_2_2" }]))).toBe(true);
    // Saved in the order "hero 2", "Hero", "hero!": hero_2 is typed, the collision went to hero_3.
    expect(inputsUnmatched(fillVariables("[hero 2] [Hero] [hero!]", { hero_2: "a", hero: "b", hero_3: "c" },
      [{ name: "hero_2" }, { name: "hero" }, { name: "hero_3" }]))).toBe(true);
  });

  it("pins the decided limit of 300 characters", () => {
    // Kev, 2026-10-02: "lass sie bei 300 zeichen bitte".
    expect(VALUE_MAX).toBe(300);
  });

  it("names the first value over the limit", () => {
    expect(overLong({ a: "fox", b: "x".repeat(VALUE_MAX + 1) })).toBe("b");
    expect(overLong({ a: "x".repeat(VALUE_MAX) })).toBeNull();
  });

  it("takes only text values of a sane length", () => {
    expect(fillVariables("[a] [b]", { a: 5, b: "x".repeat(VALUE_MAX + 1) }).text).toBe("[a] [b]");
    expect(fillVariables("[a]", { a: "x".repeat(VALUE_MAX) }).text).toBe("x".repeat(VALUE_MAX));
    expect(fillVariables("[a]", null).text).toBe("[a]");
  });
});

// DEC-441 (Kev's sketch, 2026-10-21): the artist's text as no buyer's words could have made it.
describe("neutralFill", () => {
  const vars = [
    { name: "subject", type: "text", choices: [], defaultValue: "" },
    { name: "style", type: "single_select", choices: ["oil on linen", "charcoal"], defaultValue: "oil on linen" },
    { name: "light", type: "text", choices: [], defaultValue: "golden hour" },
    { name: "age", type: "slider", choices: [], defaultValue: "" },
  ];
  const text = "a portrait of [subject] in [style], [light] light, aged [age]";

  it("puts the neutral word where the buyer typed, and keeps what the artist wrote and the slider's number", () => {
    expect(neutralFill(text, { subject: "my neighbour, naked", style: "charcoal", light: "golden hour", age: "40" }, vars))
      .toBe(`a portrait of ${NEUTRAL_VALUE} in charcoal, golden hour light, aged 40`);
    expect(NEUTRAL_VALUE).toBe("something");
  });

  it("puts it over a typed value in a field that has a default, and leaves a blank one blank", () => {
    expect(neutralFill(text, { subject: "", style: "oil on linen", light: "a burning city", age: "-3.5" }, vars))
      .toBe(`a portrait of  in oil on linen, ${NEUTRAL_VALUE} light, aged -3.5`);
    // A field the buyer emptied, its artist's default unused, stays empty: no words of theirs to neutralise.
    expect(neutralFill(text, { subject: "x", style: "charcoal", light: "", age: "1" }, vars))
      .toBe(`a portrait of ${NEUTRAL_VALUE} in charcoal,  light, aged 1`);
  });

  // Review wf_866ba07b-01a: a number typed into a text field is the buyer's words (an age), and so is one outside the
  // slider's own range.
  it("keeps a slider's number only inside its range, and never a number typed into a text field", () => {
    const ranged = [...vars.slice(0, 3), { name: "age", type: "slider", choices: [], defaultValue: "", min: 18, max: 90 }];
    expect(neutralFill(text, { subject: "9", style: "charcoal", light: "golden hour", age: "40" }, ranged))
      .toBe(`a portrait of ${NEUTRAL_VALUE} in charcoal, golden hour light, aged 40`);
    for (const age of ["9", "91", "17.5"]) {
      expect(neutralFill(text, { subject: "x", style: "charcoal", light: "golden hour", age }, ranged), age)
        .toBe(`a portrait of ${NEUTRAL_VALUE} in charcoal, golden hour light, aged ${NEUTRAL_VALUE}`);
    }
    expect(neutralFill(text, { subject: "x", style: "charcoal", light: "golden hour", age: "18" }, ranged)).toContain("aged 18");
    expect(neutralFill(text, { subject: "x", style: "charcoal", light: "golden hour", age: "90" }, ranged)).toContain("aged 90");
    // A number field is a slider too (lib/generation/variable-dice rowToDiceVariable).
    expect(neutralFill("aged [n]", { n: "40" }, [{ name: "n", type: "number", choices: [], defaultValue: "" }])).toBe("aged 40");
  });
});

describe("loadPromptText", () => {
  it("reads a prompt's public text when it has no encrypted body", async () => {
    expect(await loadPromptText(prompts({ public_prompt_text: "a [animal]" }, [{ name: "animal" }]), "p")).toEqual({
      ok: true, text: "a [animal]", variables: [{ name: "animal", type: "text", required: false, choices: [], defaultValue: "" }], adult: false, listed: false,
    });
  });

  // DEC-441: a buyer who quoted a prompt before it left the marketplace may not render it.
  it("says whether the prompt is on sale now", async () => {
    const live = { public_prompt_text: "a [animal]", is_listed: true, listing_status: "active", deleted_at: null };
    expect(await loadPromptText(prompts(live), "p")).toMatchObject({ ok: true, listed: true });
    for (const off of [{ is_listed: false }, { listing_status: "delisted" }, { deleted_at: "2026-10-01T00:00:00Z" }]) {
      expect(await loadPromptText(prompts({ ...live, ...off }), "p")).toMatchObject({ ok: true, listed: false });
    }
  });

  it("carries the prompt's 18+ mark", async () => {
    expect(await loadPromptText(prompts({ public_prompt_text: "a [animal]", is_adult: true }), "p")).toMatchObject({ ok: true, adult: true });
  });

  it("never serves a priced prompt from its public excerpt", async () => {
    const excerpt = { public_prompt_text: "the first 220 characters", price_usd_cents: 150, prompt_type: "paid" };
    // No text of its own: the prompt's (422); a key that cannot open it: Enki's (500) (round 11, 2026-10-20).
    expect(await loadPromptText(prompts(excerpt), "p")).toEqual({ ok: false, status: 422, error: "This prompt has no readable text to generate from" });
    expect(await loadPromptText(prompts({ ...excerpt, encrypted_content: "garbage", encrypted_content_iv: "x", encrypted_content_tag: "y" }), "p"))
      .toMatchObject({ ok: false, status: 500 });
    // A key that cannot open an unpriced text falls back to its public text; only a priced one is refused (round 12).
    // Unpriced by its type alone, and by its price alone (round 13).
    const garbage = { public_prompt_text: "a [animal]", encrypted_content: "garbage", encrypted_content_iv: "x", encrypted_content_tag: "y" };
    expect(await loadPromptText(prompts({ ...garbage, price_usd_cents: 150, prompt_type: "free" }), "p")).toMatchObject({ ok: true, text: "a [animal]" });
    expect(await loadPromptText(prompts({ ...garbage, price_usd_cents: 0, prompt_type: "paid" }), "p")).toMatchObject({ ok: true, text: "a [animal]" });
    expect(await loadPromptText(prompts({ ...garbage, price_usd_cents: 150, prompt_type: "paid" }), "p")).toMatchObject({ ok: false, status: 500 });
    // A free or showcase prompt is public text: the excerpt is its text, by the database's words.
    for (const free of [{ prompt_type: "free" }, { prompt_type: "showcase" }, { prompt_type: "create-now", is_free_showcase: true }]) {
      expect(await loadPromptText(prompts({ ...excerpt, ...free }), "p")).toMatchObject({ ok: true, text: "the first 220 characters" });
    }
    // The client's word for it is no stored type.
    expect(await loadPromptText(prompts({ ...excerpt, prompt_type: "free-prompt" }), "p")).toMatchObject({ ok: false, status: 422 });
  });

  it("refuses a prompt with no readable text rather than generating from nothing", async () => {
    expect(await loadPromptText(prompts({ public_prompt_text: "  " }), "p")).toMatchObject({ ok: false, status: 422 });
    expect(await loadPromptText(prompts(null), "p")).toMatchObject({ ok: false, status: 500 });
  });
});

describe("/api/generate-image builds a paid prompt from the artist's text", () => {
  it("composes when the intent carries an artist share, before moderation", () => {
    const compose = ROUTE.indexOf("const filled = fillVariables(text.text, body.variableValues, text.variables);");
    const moderate = ROUTE.indexOf("const verdict = first ?? await moderate({ prompt,");
    expect(ROUTE).toMatch(/const fromArtist = Boolean\(paid\.prompt_id\) && Number\(paid\.artist_amount_micro\) > 0;/);
    expect(compose).toBeGreaterThan(-1);
    expect(moderate).toBeGreaterThan(compose);
  });

  it("refuses unmatched inputs before moderation and before the claim, on both rails", () => {
    // A refusal that answers before both; a text no web buyer can fill goes through refuseArtists (round 12).
    const refuse = ROUTE.search(/if \(inputsUnmatched\(filled\)\) \{\n\s+const unmatched = NextResponse\.json\([\s\S]{0,400}?return inputsUnmatched\(shortest\) \? refuseArtists\(unmatched\) : unmatched;/);
    expect(refuse).toBeGreaterThan(-1);
    expect(ROUTE.indexOf("const verdict = first ?? await moderate({ prompt,")).toBeGreaterThan(refuse);
    expect(ROUTE.indexOf("await claimGenerationEscrowUnit(")).toBeGreaterThan(refuse);
    // The agent rail refuses in agentPrompt, which settlement calls before reading the payment.
    const helper = AGENT.slice(AGENT.indexOf("async function agentPrompt("), AGENT.indexOf("async function requirementsFor("));
    expect(helper).toMatch(/if \(inputsUnmatched\(filled\)\) \{\n\s+return \{ ok: false, status: 422,/);
    const settle = AGENT.indexOf("const reqs = await requirementsFor(input, resource);", AGENT.indexOf("async function settleAndGenerate("));
    expect(settle).toBeGreaterThan(-1);
    expect(AGENT.indexOf("parseXPayment(paymentHeader, ")).toBeGreaterThan(settle);
  });

  it("never returns the artist's text to the buyer, and records which prompt was used", () => {
    expect(ROUTE).toMatch(/prompt: fromArtist \? undefined : enhancedPrompt,/);
    expect(ROUTE).toMatch(/promptId: paid\.prompt_id \?\? null,/);
  });

  it("the agent route uses the same reader", () => {
    expect(AGENT).toMatch(/const text = await loadPromptText\(supabase, promptId\);/);
    expect(AGENT).not.toMatch(/decryptPrompt/);
  });
});

describe("no adapter writes prompt text to the shared logs", () => {
  it.each(["gemini-image-generation.ts", "pollinations-image-generation.ts", "wavespeed-image-generation.ts", "openai-image-generation.ts"])("%s", (f) => {
    const src = readSource(join(ROOT, "backend", "services", f));
    expect(src).not.toMatch(/console\.\w+\([^)]*prompt\.(substring|slice)\(/i);
  });
});

describe("loadPromptText's slider ranges", () => {
  it("carries a slider's stored range, and nothing for a field without one", async () => {
    const res = await loadPromptText(prompts({ public_prompt_text: "aged [age] in [style]" }, [
      { name: "age", data_type: "slider", min_value: 18, max_value: 90 }, { name: "style" },
    ]), "p");
    expect(res).toMatchObject({ ok: true });
    const vars = (res as unknown as { variables: Record<string, unknown>[] }).variables;
    expect(vars[0]).toMatchObject({ name: "age", min: 18, max: 90 });
    expect(vars[1]).not.toHaveProperty("min");
    expect(vars[1]).not.toHaveProperty("max");
  });
});
