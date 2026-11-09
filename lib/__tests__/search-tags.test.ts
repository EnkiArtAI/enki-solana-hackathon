import { describe, it, expect } from "vitest";
import vocabulary from "../search/vocabulary.json";
import { extractTags, storedTags, phraseKey, pluralKeys, tagCount, TAGS_MIN, WORDS_PER_TAG } from "../search/tags";

/**
 * Zero cost search (Kev, 2026-09-24: "das muss dann kostenlos sein"): tags
 * come from a curated vocabulary matched in Node, never from a model. The
 * matcher runs on the plaintext inside the publish request, so what it
 * returns is the ONLY thing about a prompt body that ever reaches the index.
 * Every assertion here was broken on purpose once and seen red.
 */

type Entry = { tag: string; category: string; synonyms: string[] };
const entries = vocabulary as Entry[];
const CATEGORIES = ["subject", "format", "style", "medium", "mood", "color", "composition", "technique"];
const WHAT = /^(subject|format)$/;
const tags = new Set(entries.map((e) => e.tag));

describe("vocabulary", () => {
  it("has at least 1,500 entries in the eight categories, each tag lowercase and unique", () => {
    expect(entries.length).toBeGreaterThanOrEqual(1500);
    expect(tags.size).toBe(entries.length);
    for (const e of entries) {
      expect(CATEGORIES, `${e.tag}: unknown category ${e.category}`).toContain(e.category);
      expect(e.tag).toBe(e.tag.toLowerCase().trim());
      expect(Array.isArray(e.synonyms)).toBe(true);
    }
    for (const c of CATEGORIES) expect(entries.some((e) => e.category === c), `no entries in ${c}`).toBe(true);
  });

  it("has no spelling that points at two different tags, a term's plural included", () => {
    // A collision is silent: one of the two tags can never be matched again.
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const e of entries) {
      for (const phrase of [e.tag, ...e.synonyms]) {
        const k = phraseKey(phrase);
        const prev = owner.get(k);
        if (prev && prev !== e.tag) collisions.push(`'${phrase}' (${e.tag}) collides with '${prev}'`);
        else owner.set(k, e.tag);
      }
    }
    for (const e of entries) {
      for (const phrase of [e.tag, ...e.synonyms]) {
        for (const plural of pluralKeys(phraseKey(phrase))) {
          const prev = owner.get(plural);
          if (prev && prev !== e.tag) collisions.push(`the plural of '${phrase}' (${e.tag}) is '${prev}'`);
        }
      }
    }
    // Both meant: "valleys" lives only as the how (DEC-2026-11-02-09), and Canva is software, a canvas is not.
    expect(collisions).toEqual(["the plural of 'valley' (valley) is 'folds and valleys'", "the plural of 'canva' (canva) is 'canvas'"]);
  });

  it("carries British spellings and shorthands as synonyms", () => {
    expect(extractTags("watercolour")).toEqual(["watercolor"]);
    expect(extractTags("b&w")).toEqual(["black and white"]);
    expect(extractTags("shot on 35mm")).toEqual([]); // film stock, the how: never a tag (Kev, 2026-10-31)
  });
});

describe("extractTags", () => {
  it("strips [slot] placeholders, {{wf:...}} tokens and (word:1.3) weights", () => {
    const text = "portrait of a [dragon] in {{wf:node_7}} light, (golden hour:1.3), (oil painting)";
    const found = extractTags(text);
    expect(found).not.toContain("dragon");
    expect(found).toContain("golden hour");
    expect(found).toContain("oil painting");
    expect(found).toContain("portrait");
    // Without the weight rule the "1.1" would read as the 1:1 square format.
    expect(extractTags("(dragon:1.1)")).toEqual(["dragon"]);
    expect(extractTags("16:9")).toEqual([]); // framing, the how: never a tag (Kev, 2026-10-31)
  });

  it("matches a bigram as one tag", () => {
    expect(extractTags("shot during golden hour")).toContain("golden hour");
  });

  it("maps a synonym to its canonical tag", () => {
    expect(extractTags("a moody watercolour of a lorry")).toEqual(
      expect.arrayContaining(["moody", "watercolor", "truck"]),
    );
    expect(extractTags("a moody watercolour")).not.toContain("watercolour");
  });

  it("hits the base tag from a plural", () => {
    expect(extractTags("three paintings")).toContain("painting");
    expect(extractTags("two dragons flying")).toEqual(expect.arrayContaining(["dragon", "flying"]));
  });

  it("returns only vocabulary tags, never a word from the text", () => {
    expect(extractTags("florb quuxian zyzzyva gronk")).toEqual([]);
    const found = extractTags("a florb dragon in gronk light, cinematic, 8k, masterpiece, trending on artstation");
    for (const t of found) expect(tags.has(t), `${t} is not a vocabulary tag`).toBe(true);
    expect(found).not.toContain("masterpiece");
  });

  it("deduplicates and keeps the order of first appearance", () => {
    expect(extractTags("dragon, castle, dragon, castle, dragons")).toEqual(["dragon", "castle"]);
    expect(extractTags("castle then dragon")).toEqual(["castle", "dragon"]);
  });

  it("keeps a free body's look, a paid body's what only, and never how anything is made (Kev, 2026-10-31: the what, not the how)", () => {
    const text = "a dragon in teal and orange, close up, cross hatching, oil painting, moody";
    for (const free of [extractTags(text), extractTags(text, { body: true })]) {
      expect(free).toEqual(expect.arrayContaining(["dragon", "teal and orange", "oil painting", "moody"]));
      expect(free.filter((t) => ["close up", "cross hatching"].includes(t))).toEqual([]);
    }
    expect(extractTags(text, { body: true, paid: true })).toEqual(["dragon"]);
    // Renderer, camera, film and lighting setup are the how, filed under a look or not.
    expect(extractTags("octane render, unreal engine, 35mm, kodak portra, rim light, studio lighting, three point lighting, a dragon", { body: true })).toEqual(["dragon"]);
  });

  it("lets only what the piece is through a body: what it is for always, a thing said once only up to the floor", () => {
    const allText = entries.map((e) => e.tag).join(", ");
    const body = extractTags(allText, { body: true, paid: true });
    const formats = entries.filter((e) => e.category === "format").length;
    expect(body).toHaveLength(Math.min(tagCount(allText), Math.max(TAGS_MIN, formats)));
    for (const t of body) expect(entries.find((x) => x.tag === t)!.category, t).toMatch(WHAT);
    expect(body.filter((t) => entries.find((x) => x.tag === t)!.category !== "format")).toEqual([]); // what it is for comes first
    // Live 2026-10-31: a long logo prompt named a lawyer, an airplane and an elevator once each in its examples.
    const filler = "qwx zrt plk vbn. ".repeat(80);
    const logo = extractTags(`a logo. ${filler} the logo again. a dragon, a castle. the dragon. the castle. a lawyer, an airplane, an elevator, a mountain, a train, a mirror, a bridge, a fox.`, { body: true, paid: true });
    expect(logo.slice(0, 3)).toEqual(["logo", "dragon", "castle"]);
    expect(logo).toHaveLength(TAGS_MIN);
    // A free body is public: every look it names counts, past the paid count too; a thing it names once still only fills.
    const looks = "cinematic, moody, watercolor, neon, pastel, gothic, vintage, surreal, minimalist, baroque";
    const free = extractTags(`a logo. ${looks}. a lawyer, an airplane, an elevator, a mountain, a train.`, { body: true });
    expect(free.length).toBeGreaterThan(tagCount(looks));
    expect(free).toEqual(expect.arrayContaining(["logo", "cinematic", "moody", "watercolor"]));
    expect(free.filter((t) => ["lawyer", "airplane", "elevator", "mountain", "train"].includes(t))).toEqual([]);
    // A short paid body with more core than it earns: what it is for first, then the most said, named late or not.
    const many = ["castle", "lawyer", "airplane", "elevator", "mountain", "train", "mirror", "bridge", "fox"];
    const short = extractTags(`${many.join(", ")}. ${many.join(", ")}. the dragon, the dragon, the dragon. a logo.`, { body: true, paid: true });
    expect(short).toHaveLength(TAGS_MIN);
    expect(short.slice(0, 2)).toEqual(["logo", "dragon"]);
    // The core named late still beats a list named early.
    expect(extractTags(`a lawyer, an airplane, an elevator, a mountain, a train, a mirror, a bridge, a fox, a cat. ${filler} the dragon, the dragon.`, { body: true, paid: true })[0]).toBe("dragon");
    // Said twice, each counts however long the list: as many as the size earns.
    const twice = ["dragon", "castle", "lawyer", "airplane", "elevator", "mountain", "train", "mirror", "bridge", "fox"];
    expect(extractTags(`${twice.join(", ")}. ${filler} ${twice.join(", ")}.`, { body: true, paid: true })).toEqual(twice);
  });

  // Kev, 2026-10-31: "1/30", "dependent on the size", eight at the least.
  it("earns one tag per 30 words, eight at the least, with no ceiling", () => {
    expect([TAGS_MIN, WORDS_PER_TAG]).toEqual([8, 30]);
    expect([30, 299, 600, 1931].map((n) => tagCount("word ".repeat(n)))).toEqual([8, 10, 20, 64]);
  });

  // Kev, 2026-10-31, on a logo prompt tagged "latex, vinyl, embossed, glossy": a hidden prompt is found by what it is
  // for, and a thing described seven times is one tag ("stop motion ... nur 1x"); never how it is made.
  it("tags a hidden prompt by what it is for, each idea once, never by how it is made", () => {
    const logo = extractTags("an embossed logo on soft vinyl for a coffee brand, glossy latex finish, studio lighting, octane render, 85mm", { body: true, paid: true });
    expect(logo).toEqual(expect.arrayContaining(["logo", "branding", "coffee"]));
    for (const t of logo) expect(entries.find((x) => x.tag === t)!.category, t).toMatch(WHAT);
    const motion = extractTags(Array.from({ length: 7 }, (_, i) => `shot ${i}: the puppet moves in stop motion, stop-motion frames, claymation`).join(". "), { body: true, paid: true });
    expect(motion.filter((t) => t === "stop motion")).toHaveLength(1);
    expect(extractTags("wordmark and brand identity for a bakery, packaging and a flyer", { body: true, paid: true })).toEqual(
      expect.arrayContaining(["logo", "branding", "packaging design", "flyer"]),
    );
  });

  it("gives a buyer nothing to distil a paid recipe from (Kev, 2026-10-07)", () => {
    // Five recipe-heavy paid prompts: their lighting, lens, renderer, film
    // stock and director style must not survive, only their subjects.
    const recipes = [
      "portrait of an elderly fisherman, rembrandt lighting, chiaroscuro, 85mm lens, kodak portra 400, film grain, shallow depth of field",
      "a dragon over ruins of a church, storm clouds, god rays, volumetric lighting, octane render, unreal engine, trending on artstation",
      "macro still life of a glass bottle, caustics, rim light, high key lighting, reflections, gold and black palette, 16mm film",
      "a girl riding a bicycle through the countryside, ghibli style, cel shaded, soft pastel colors, wes anderson style, symmetrical composition",
      "a hotel lobby, kubrick style one point perspective, muted colors, natural light, long exposure, award winning photography",
    ];
    const RECIPE = /lighting|light|chiaroscuro|mm\b|portra\b|grain|depth|rays|volumetric|render|engine|caustic|key|reflection|palette|film|ghibli|cel|pastel|anderson|symmetr|kubrick|perspective|muted|exposure|award|photograph/;
    for (const r of recipes) {
      const paid = extractTags(r, { body: true, paid: true });
      expect(paid.length, r).toBeLessThanOrEqual(tagCount(r));
      for (const t of paid) {
        expect(entries.find((x) => x.tag === t)!.category, `${t} from: ${r}`).toMatch(WHAT);
        expect(t, `${t} carries the recipe`).not.toMatch(RECIPE);
      }
    }
    expect(extractTags(recipes[1], { body: true, paid: true })).toEqual(expect.arrayContaining(["dragon", "ruins", "church"]));
  });

  it("keeps named looks, era, gear and lighting out of a paid body's tags", () => {
    expect(extractTags("portrait of a woman, shot on iphone, candlelight, foggy 1980s mood, silhouetted, in the style of van gogh", { body: true, paid: true })).toEqual(["portrait", "woman"]);
    expect(extractTags("cinematic film still, blade runner aesthetic, eye contact, dust particles, neon", { body: true, paid: true })).toEqual([]);
    expect(extractTags("a knight, lord of the rings, game of thrones, star wars", { body: true, paid: true })).toEqual(["knight"]);
  });

  it("lets the longest term own its words", () => {
    expect(extractTags("god rays over the sea")).not.toContain("god");
    expect(extractTags("rendered in unreal engine")).not.toContain("engine");
    expect(extractTags("high key lighting")).not.toContain("key");
  });

  it("makes no tag out of ordinary prompt words", () => {
    const filler = (
      "the a an and or but of in on at to for with by from as is are was were be been being it its this that these those " +
      "very highly extremely more most less some any all each every other another such no not only just also too so than then " +
      "there here where when while into onto over under above below between through during before after about against among " +
      "around behind beside beyond near off out up down within without high quality resolution best perfect " +
      "sharp focus hyper hd professional shot image picture render rendered made create show showing " +
      "looking look looks style styled styles frame framed framing set setting settings long short soft softly wet clean natural " +
      "angle angled angles field fields ray award awarded shade shaded shading palette muted lots little big large small " +
      "huge tiny full half new old first last next one two three many few several wide narrow left right top bottom middle " +
      "side front back towards could would should might must will can may do does did done have has had get got take takes " +
      "taking give gives giving use uses using way ways thing things something nothing everything anything"
    ).split(" ");
    expect(filler.length).toBeGreaterThanOrEqual(150);
    const hits = filler.map((w) => [w, extractTags(w)] as const).filter(([, t]) => t.length > 0);
    expect(hits).toEqual([]);
  });
});

// Kev, 2026-11-02: "Generate" read as the tag "general", "valley" and "reading" on a logo prompt with no such thing. Every
// word below set off the tag next to it through the stemmer or as a one-word alias, on live prompts.
describe("a word says what it says", () => {
  it("meets a tag as the vocabulary spells it or as that word's plural, never through a stem", () => {
    const stems = ["generate", "generates", "generated", "generating", "generous", "generic", "generation", "generator", "read", "reads", "element", "elements", "iconic", "status",
      "even", "adding", "added", "expression", "symbol", "symbols", "orientation", "animal", "animals", "animated", "tone", "tones", "modern", "spacing", "elevated", "locked", "universe", "marketing", "training", "parking"];
    expect(stems.filter((w) => extractTags(w).length > 0)).toEqual([]);
    for (const [w, tag] of [["dragons", "dragon"], ["logos", "logo"], ["foxes", "fox"], ["beaches", "beach"], ["kittens", "cat"], ["neon signs", "neon sign"]] as const) {
      expect(extractTags(w), w).toEqual([tag]);
    }
    expect(pluralKeys("fox")).toEqual(["foxes"]);
    expect(pluralKeys("key")).toEqual(["keys"]);
    expect(pluralKeys("berry")).toEqual(["berries"]);
    expect(pluralKeys("dress")).toEqual(["dresses"]);
    expect(pluralKeys("beach")).toEqual(["beaches", "beachs"]);
    expect(pluralKeys("brush")).toEqual(["brushes"]);
    expect(pluralKeys("dragon")).toEqual(["dragons"]);
    expect(pluralKeys("volcano")).toEqual(["volcanos", "volcanoes"]);
    expect(pluralKeys("radio")).toEqual(["radios"]);
  });

  // Review 2026-11-02: regular English plurals the stemmer met and this rule lost: "giant mechs" had no mech.
  it("meets a plural English spells either way", () => {
    for (const [word, tag] of [["mechs", "mech"], ["battle mechs", "mech"], ["monarchs", "king"], ["volcanoes", "volcano"], ["volcanos", "volcano"], ["tornadoes", "tornado"], ["mosquitoes", "mosquito"], ["mangoes", "mango"], ["superheroes", "superhero"], ["buffaloes", "bison"], ["witches", "witch"], ["pianos", "piano"]] as const) {
      expect(extractTags(word), word).toContain(tag);
    }
    // The form nobody writes costs nothing, and takes no word from another tag.
    expect(extractTags("giant mechs", { body: true, paid: true })).toEqual(["giant", "mech"]);
    expect(extractTags("battle mechs", { body: true, paid: true })).toEqual(["mech"]);
  });

  it("goes one way: a word is not the plural it looks like, while a phrase has no second meaning", () => {
    expect(["glass", "leave", "scale", "root"].flatMap((w) => extractTags(w))).toEqual([]);
    expect(extractTags("glasses")).toEqual(["glasses"]);
    expect(extractTags("leaves")).toEqual(["leaves"]);
    expect(extractTags("warm color")).toEqual(["warm colors"]);
    expect(extractTags("warm colors")).toEqual(["warm colors"]);
    expect(extractTags("high heel")).toEqual(["high heels"]);
  });

  // Each word read in its live contexts: these all meant something else (art director, negative space, picture plane).
  it("has no one-word alias that mostly means something else", () => {
    const aliases = ["senior", "director", "space", "square", "present", "figure", "inside", "outside", "lift", "pupil", "tube", "underground", "circuit", "trunk", "sub",
      "plane", "planes", "spirit", "peak", "peaks", "brush", "chip", "stream", "people", "expressive", "clear", "crisp", "official", "still", "atmosphere", "atmospheric",
      "rich", "raw", "isolated", "harsh", "sparse", "tension", "void", "hearts", "preserves"];
    expect(aliases.filter((w) => extractTags(w).length > 0)).toEqual([]);
    // Newspaper was the tag of "magazine"; a magazine is a magazine now.
    expect(extractTags("a magazine")).toEqual(["magazine"]);
  });

  it("has no bare tag that mostly means something else, and finds the thing by its phrase", () => {
    const bare = ["reading", "key", "keys", "uniform", "band", "running", "scales", "anchor", "seal", "web", "tank", "hidden", "valleys", "camera", "studio", "the render engine", "a texture map", "general", "the general"];
    expect(bare.filter((w) => extractTags(w).length > 0)).toEqual([]);
    for (const [text, tag] of [["a woman reading a book", "reading a book"], ["a door key", "door key"], ["an old key", "door key"], ["an army uniform", "military uniform"], ["a police uniform", "police officer"], ["a character in an assassin uniform", "assassin"], ["generals", "army general"], ["a roman general", "army general"],
      ["a rock band", "music band"], ["a woman running", "person running"], ["sprinting", "person running"], ["the scales of justice", "balance scales"], ["a ship anchor", "ship anchor"], ["a walrus", "harbor seal"],
      ["a spider web", "spider web"], ["cobwebs", "spider web"], ["a battle tank", "military tank"], ["a white tank top", "tank top"], ["a long coat", "coat"], ["a vintage camera", "vintage camera"], ["an art studio", "art studio"],
      ["a green valley", "valley"], ["mountain valleys", "valley"], ["a town square", "plaza"], ["a passenger plane", "airplane"], ["a mountain peak", "mountain"], ["deep space", "outer space"]] as const) {
      expect(extractTags(text), text).toContain(tag);
    }
    // How, however it is said: a coat of varnish is no coat, a fur coat is one.
    expect(extractTags("a clear coat over the render")).toEqual([]);
    expect(extractTags("a coat of varnish, a thin coat of lacquer over a coat of paint", { body: true, paid: true })).toEqual([]);
    expect(extractTags("a long coat", { body: true, paid: true })).toEqual(["coat"]);
    expect(extractTags("Logo. Generate one. Reading direction, deep valleys, a senior art director, the camera, a studio, the figure, a square.", { body: true })).toEqual(["logo"]);
    expect(extractTags("Generate", { body: true, paid: true })).toEqual([]);
    // The adjective, spelled: the same public tag Kev reported through the stem.
    expect(extractTags("a general mood of unease, general purpose mark", { body: true, paid: true })).toEqual([]);
  });

  // Review 2026-11-02: an alias on a renamed tag said something else, and a retag would have stored it on every such row.
  it("has no phrase of a renamed tag that names something else: the words say what they say", () => {
    for (const [text, tags] of [
      ["iridescent fish scales on a mermaid", ["fish", "mermaid"]], ["a dragon covered in dragon scales", ["dragon"]],
      ["a nurse uniform", ["nurse"]], ["a sailor uniform", ["sailor"]], ["an assassin uniform", ["assassin"]],
      ["a dog running on a beach", ["dog", "beach"]], ["a recording studio", []], ["a music studio", []],
      ["a woman reading a magazine", ["woman", "magazine"]], ["a man reading a newspaper", ["man", "newspaper"]],
    ] as const) {
      expect(extractTags(text, { body: true, paid: true }), text).toEqual(tags);
    }
    for (const [text, tag] of [["the scales of justice", "balance scales"], ["weighing scales", "balance scales"], ["a soldier uniform", "military uniform"], ["a woman running", "person running"], ["an artist studio", "art studio"], ["reading a novel", "reading a book"]] as const) {
      expect(extractTags(text), text).toEqual([tag]);
    }
  });

  // Review 2026-11-02: with the stem gone a how-term fell apart, and "ring lighting" left the public subject tag "ring".
  it("keeps how-terms whole in a paid body, in their other forms too", () => {
    for (const how of ["ring lighting", "window lighting", "hazy lighting", "window framed", "door framed", "butterfly light", "concert lights", "concert light", "clay model rendered", "clay model rendering", "fur rendered", "fur rendering", "satellite imaging", "satellite imagery"]) {
      expect(extractTags(`a ${how}`, { body: true, paid: true }), how).toEqual([]);
    }
    expect(extractTags("a portrait in ring lighting, 85mm", { body: true, paid: true })).toEqual(["portrait"]);
    expect(extractTags("soft window lighting on a woman", { body: true, paid: true })).toEqual(["woman"]);
    // The words alone still say the thing.
    expect(extractTags("a ring by the window", { body: true, paid: true })).toEqual(["ring", "window"]);
    const other = (k: string) => (/\blights?$/.test(k) ? k.replace(/lights?$/, "lighting") : /\blighting$/.test(k) ? k.replace(/lighting$/, "light") : null);
    const left: string[] = [];
    for (const e of entries.filter((x) => x.category === "technique" || x.category === "composition")) {
      for (const term of [e.tag, ...e.synonyms]) {
        const form = other(phraseKey(term));
        if (form && extractTags(form, { body: true, paid: true }).length) left.push(`${term} -> ${form}`);
      }
    }
    expect(left).toEqual([]);
  });

  // Review 2026-11-02: gear is the how, and the new subject kept it as an alias.
  it("reads a camera shot with as the how and a camera shown as the thing", () => {
    for (const shot of ["shot on a polaroid camera, grainy", "shot on an old camera", "shot on a vintage camera", "shot on a retro camera", "shot on an antique camera", "shot with a polaroid camera", "shot with an old camera", "shot with a vintage camera", "shot with a retro camera", "shot with an antique camera", "shot on polaroid camera", "shot with polaroid camera"]) {
      expect(extractTags(shot, { body: true, paid: true }), shot).toEqual([]);
    }
    expect(extractTags("a polaroid camera on a table", { body: true, paid: true })).toEqual(["vintage camera", "table"]);
    expect(extractTags("an old camera")).toEqual(["vintage camera"]);
  });

  // Review 2026-11-02: the plural rule reaches a phrase's last word only, and these are common.
  it("knows a phrase with a plural on its first word where it is common", () => {
    for (const [text, tag] of [["groups of people", "group of people"], ["hands holding a phone", "hand holding"], ["girls running", "person running"], ["boys running", "person running"], ["men running", "person running"], ["women running", "person running"], ["children running", "person running"], ["kids running", "person running"]] as const) {
      expect(extractTags(text), text).toContain(tag);
    }
    expect(extractTags("dogs running")).toEqual(["dog"]);
  });

  // The stemmer's hits read one by one: these forms do mean the tag, so the vocabulary now says them.
  it("keeps the word forms that do mean the tag", () => {
    for (const [word, tag] of [["stands", "standing"], ["fight", "fighting"], ["jump", "jumping"], ["jumps", "jumping"], ["walks", "walking"], ["hugging", "hug"], ["hugs", "hug"], ["cry", "crying"], ["cries", "crying"], ["scream", "screaming"], ["stair", "staircase"],
      ["flooded", "flood"], ["jewel", "jewelry"], ["jeweled", "jewelry"], ["robotic", "robot"], ["haired", "hair"], ["antennae", "antenna"], ["skateboarding", "skateboard"], ["teenage", "teenager"], ["hooded", "hood"], ["wrinkled", "wrinkles"], ["wrinkle", "wrinkles"],
      ["cosmetic", "makeup"], ["soap bubble", "bubbles"], ["earring", "earrings"], ["crowded", "crowd"], ["outdoor", "exterior"], ["looks up", "looking up"], ["look up", "looking up"], ["looks down", "looking down"], ["look down", "looking down"], ["hand holds", "hand holding"], ["petals fall", "petals falling"],
      ["lip", "lips"], ["braid", "braids"], ["freckle", "freckles"], ["glove", "gloves"], ["boot", "boots"], ["sneaker", "sneakers"], ["sandal", "sandals"], ["pebble", "pebbles"], ["wildflower", "wildflowers"], ["reed", "reeds"], ["pipe", "pipes"], ["wire", "wires"], ["drum", "drums"], ["firework", "fireworks"],
      ["berry", "berries"], ["pancake", "pancakes"], ["waffle", "pancakes"], ["dumpling", "dumplings"], ["spice", "spices"], ["herb", "herbs"], ["raindrop", "raindrops"], ["ripple", "ripples"], ["footprint", "footprints"], ["finger", "hands"],
      ["branded", "branding"], ["3d animated", "3d animation"], ["photorealism", "photorealistic"], ["realistically", "realism"], ["surrealistic", "surrealism"], ["stylize", "stylized"], ["stylization", "stylized"], ["3d rendering", "3d render"], ["minimalistic", "minimalism"], ["screen printed", "screen print"], ["screen printing", "screen print"], ["vector graphic", "vector art"], ["hand lettered", "calligraphy"], ["collaged", "collage"], ["scanline", "scanlines"],
      ["metal", "metallic"], ["metals", "metallic"], ["translucency", "transparent"], ["transparency", "transparent"], ["color block", "color blocking"], ["dark tone", "dark palette"], ["light colored", "light palette"], ["color background", "colored background"],
      ["photographed", "photograph"], ["printed", "print"], ["printing", "print"], ["paint", "painting"], ["marker", "marker drawing"], ["knit", "knitting"], ["knitted", "knitting"], ["spray painted", "spray paint"], ["acrylic paint", "acrylic painting"], ["sculpt", "sculpture"],
      ["intensely", "intense"], ["organically", "organic"], ["dramatically", "dramatic"], ["polish", "polished"], ["magic", "magical"], ["blooming", "bloom"], ["clutter", "messy"], ["neon light", "neon lighting"], ["lone", "lonely"], ["freshness", "fresh"], ["golden lighting", "golden hour"]] as const) {
      expect(extractTags(word), word).toEqual([tag]);
    }
  });
});

// Kev, 2026-11-02: an import titled "Social media design graphic" got 0 tags, its title's words were not in the catalog.
describe("common design terms", () => {
  it("name what a design is for", () => {
    expect(extractTags("Social media design graphic")).toEqual(["social media", "graphic design"]);
    for (const [text, tag] of [["for instagram", "social media"], ["an Instagram post", "social media"], ["instagram story", "social media"], ["tiktok", "social media"], ["a social media post", "social media"], ["a social media graphic", "social media"], ["a social post", "social media"], ["an instagram carousel", "social media"],
      ["a senior graphic designer", "graphic design"], ["graphic design", "graphic design"], ["a tri-fold brochure", "brochure"], ["a streetwear lookbook", "lookbook"], ["a brand moodboard", "moodboard"], ["mood board", "moodboard"],
      ["a marketing campaign", "advertisement"], ["app design", "ui design"], ["an app interface", "ui design"], ["an app icon", "icon"]] as const) {
      expect(extractTags(text), text).toContain(tag);
      expect(entries.find((e) => e.tag === tag)!.category, tag).toBe("format");
    }
    // What it shows, not what it is for: said once it only fills, in a paid body too.
    for (const tag of ["magazine", "fashion", "campaign"]) {
      expect(extractTags(`a ${tag}`, { body: true, paid: true })).toEqual([tag]);
      expect(entries.find((e) => e.tag === tag)!.category, tag).toBe("subject");
    }
    expect(extractTags("an ad campaign")).toEqual(["advertisement", "campaign"]);
    // Read in their live contexts: "museum catalogue photograph", "the architecture of the edge", "UI overlay".
    expect(["graphic", "graphics", "design", "social", "media", "app", "layout", "catalogue", "architecture", "ui", "ux"].filter((w) => extractTags(w).length > 0)).toEqual([]);
  });
});

describe("storedTags", () => {
  it("deduplicates case insensitively and sorts, with no cap (Kev, 2026-10-31: the count follows the size)", () => {
    expect(storedTags([" Dragon ", "castle"], ["dragon", "moody"], [""])).toEqual(["castle", "dragon", "moody"]);
    const many = Array.from({ length: 70 }, (_, i) => `tag${String(i).padStart(2, "0")}`);
    expect(storedTags(["zebra"], many.slice().reverse())).toEqual([...many, "zebra"]);
  });
});

// Kev, 2026-10-30, on the "Basic character sheet" prompt: "does it have the tags? if not, then the bot isnt properly
// working, as it should've tagged it with it". It had "character design" (then the synonym's canonical tag).
describe("character sheets", () => {
  it("are tagged character sheet, from a title and from a paid body, by every usual name", () => {
    expect(extractTags("Basic character sheet")).toContain("character sheet");
    // Each usual name alone, in a paid body too.
    for (const name of ["character sheets", "model sheet", "reference sheet", "turnaround sheet", "character turnaround", "character reference sheet"]) {
      expect(extractTags(`a ${name} of a fox knight`, { body: true, paid: true }), name).toContain("character sheet");
    }
    // A concept is still a character design, not a sheet.
    const concept = extractTags("character concept of a fox knight");
    expect([concept.includes("character design"), concept.includes("character sheet")]).toEqual([true, false]);
  });
});
