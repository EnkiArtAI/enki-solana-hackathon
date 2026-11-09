import { describe, expect, it } from "vitest";
import { affixes, checkHandle, closest, coreWord, handleKey, rankMatches, slugify, textKeys } from "@/lib/communities/handle";
import { BAD_HANDLE, CLOSEST_LIMIT, HANDLE_MAX, HANDLE_RESERVED_SAID } from "@/lib/communities/types";

/**
 * lib/communities/handle.ts: one handle c/<handle> per community that "cant be duplicated" (Kev, 2026-10-30; agreed:
 * "case, separators, confusable letters collide"), duplicates such as "gundam 1, gundam 2" grouped by a core word for the
 * merge queue, the soft suggestion's keys, the typeahead's order and what a new community is asked about first.
 * handleKey against SQL 54's community_key() is lib/__tests__/communities-migration.test.ts.
 */
describe("slugify", () => {
  it("makes a handle of typed text: accents dropped, look-alikes folded, lower case, separators one underscore", () => {
    expect(slugify("Gundam Wing!")).toBe("gundam_wing");
    expect(slugify("Pеpe")).toBe("pepe"); // a Cyrillic е
    expect(slugify("Apu Apustaja")).toBe("apu_apustaja");
    expect(slugify("  Pokémon -- Fans  ")).toBe("pokemon_fans");
    expect(slugify("ΡΕΡΕ")).toBe("pepe"); // Greek capitals, folded once lower-cased
    expect(slugify("Straßenkunst")).toBe("strassenkunst");
    expect(slugify("Ｇｕｎｄａｍ")).toBe("gundam"); // full-width
    expect(slugify("__a__")).toBe("a");
    expect(slugify("!!!")).toBe("");
    expect(slugify("ガンダム")).toBe("");
  });

  it(`cuts at ${HANDLE_MAX} characters and never ends on an underscore`, () => {
    expect(slugify("a".repeat(40))).toBe("a".repeat(HANDLE_MAX));
    expect(slugify(`${"a".repeat(HANDLE_MAX - 1)} b`)).toBe("a".repeat(HANDLE_MAX - 1));
  });
});

describe("handleKey", () => {
  it("is one key for a handle and its look-alikes: separators, rn/m, vv/w, 0 1 3 4 5 7", () => {
    for (const h of ["gund4m", "Gundam_", "gundam", "g_u_n_d_a_m"]) expect(handleKey(h), h).toBe("gundam");
    expect(handleKey("b0ss")).toBe("boss");
    expect(handleKey("2b")).toBe("2b");
    expect(handleKey("rnrn")).toBe("mm");
    expect(handleKey("vvv")).toBe("wv");
    expect(handleKey("0_1_3")).toBe("ole");
    expect(handleKey("l33t_57")).toBe("leetst");
    expect(handleKey("g6_8_9")).toBe("g689");
  });
});

describe("checkHandle", () => {
  it("takes 2 to 30 letters or digits with single underscores between, and nothing of Enki's, look-alikes included", () => {
    for (const ok of ["gundam", "2b", "apu_apustaja", "a".repeat(HANDLE_MAX), "pepe_official"]) expect(checkHandle(ok), ok).toBeNull();
    for (const bad of ["a", "a".repeat(HANDLE_MAX + 1), "Gundam", "gundam_", "_gundam", "gun__dam", "gun-dam", "gün", ""]) expect(checkHandle(bad), bad).toBe(BAD_HANDLE);
    for (const reserved of ["enki", "admin", "links", "0fficial", "m0d", "enki_art", "enkiart"]) expect(checkHandle(reserved), reserved).toBe(HANDLE_RESERVED_SAID);
  });
});

describe("coreWord", () => {
  it("groups numbered, versioned, numeral and filler variants of one name", () => {
    for (const h of ["gundam", "gundam_1", "gundam2", "gundam_ii", "gundam_xx", "gundam_fans", "the_gundam_club", "gundam_v2", "gund4m"]) expect(coreWord(h), h).toBe("gundam");
    for (const h of ["the_pepe_club", "pepe_coin", "pepe_official", "pepe_cto", "pepe_on_sol"]) expect(coreWord(h), h).toBe("pepe");
  });

  it("groups filler glued to a name too (Kev: \"there are vamps\"), while 3 letters or more stay", () => {
    for (const h of ["gundamfans", "fansgundam", "gundam2fans", "the_gundamclub"]) expect(coreWord(h), h).toBe("gundam");
    for (const h of ["pepecoin", "thepepe", "pepetoken", "thepepecoin", "pepe2coin", "realpepe", "pepesolana"]) expect(coreWord(h), h).toBe("pepe");
    expect(coreWord("apucoin")).toBe("apu");
    // Under 3 letters left, or a filler word under 3 letters, stays a name; a word of glued filler only is filler.
    expect(coreWord("anime")).toBe("anime");
    expect(coreWord("ogre")).toBe("ogre");
    expect(coreWord("arts")).toBe("arts");
    expect(coreWord("artclub")).toBe("artclub");
    expect(coreWord("solana")).toBe("solana");
  });

  it("keeps what is a name: a sub-community, a numeral above xx or of one letter, digits before letters, a filler-only handle", () => {
    expect(coreWord("gundam_wing")).toBe("gundamwing");
    expect(coreWord("gundam_xxi")).toBe("gundamxxi");
    expect(coreWord("gundam_x")).toBe("gundamx");
    expect(coreWord("gundam_v")).toBe("gundamv");
    expect(coreWord("art_club")).toBe("artclub");
    expect(coreWord("2b")).toBe("2b");
    expect(coreWord("ab2")).toBe("ab2"); // two letters and a digit: a name, not a number
    expect(coreWord("mix_vi")).toBe("mix");
  });
});

describe("textKeys", () => {
  it("names a text's words alone and in runs of two and three, as keys of 3 or more, filler out, each once", () => {
    expect(textKeys("Apu and Pepe animated, apu!")).toEqual(["apu", "apuand", "apuandpepe", "andpepe", "andpepeanimated", "pepe", "pepeanimated", "pepeanimatedapu", "animated", "animatedapu"]);
    expect(textKeys("Gundam Wing")).toEqual(["gundam", "gundamwing", "wing"]);
    expect(textKeys("the art of 2b")).toEqual(["theart", "theartof", "artof", "artof2b", "of2b"]);
    expect(textKeys("")).toEqual([]);
  });

  it("stops at 300 keys", () => {
    const text = Array.from({ length: 400 }, (_, i) => `word${i}x`).join(" ");
    expect(textKeys(text)).toHaveLength(300);
  });
});

describe("rankMatches", () => {
  const c = (handle: string, name: string, members = 0, works = 0, words?: string[]) => ({ handle, name, members, works, words });
  it("orders the exact key, handle prefixes, search-word prefixes, then names; the biggest first in each; the rest out", () => {
    const items = [
      c("gundam_wing", "Wing", 5, 5),
      c("gundam_seed", "Seed", 50, 0),
      c("mecha", "Gundam lovers", 900, 0),
      c("robots", "Robots", 1, 0, ["gundams"]),
      c("gundam", "Gundam", 0, 0),
      c("pepe", "Pepe", 999, 999),
    ];
    expect(rankMatches("Gundam", items).map((x) => x.handle)).toEqual(["gundam", "gundam_seed", "gundam_wing", "robots", "mecha"]);
    // A look-alike is the exact key.
    expect(rankMatches("Gund4m", items)[0].handle).toBe("gundam");
    // A tie in size goes by handle.
    expect(rankMatches("gun", [c("gun_b", "B", 1, 1), c("gun_a", "A", 2, 0)]).map((x) => x.handle)).toEqual(["gun_a", "gun_b"]);
  });

  it("matches only names when the text has no key", () => {
    expect(rankMatches("ガンダム", [c("gundam", "ガンダム fans"), c("pepe", "Pepe")]).map((x) => x.handle)).toEqual(["gundam"]);
    expect(rankMatches("   ", [c("gundam", "Gundam")])).toEqual([]);
  });
});

describe("closest", () => {
  const c = (handle: string, members = 0, works = 0) => ({ handle, core: coreWord(handle), members, works });
  it("asks about the same core first, then a key an edit or two away, then a key that starts the other within 3", () => {
    const found = closest("gundam_fans", [c("gundam", 10), c("gundam_2", 1200), c("gundam_fanz", 3), c("pepe", 999), c("gundam_fans_club_x", 0)]);
    expect(found.map((x) => x.handle)).toEqual(["gundam_2", "gundam", "gundam_fanz", "gundam_fans_club_x"]);
    expect(closest("pepe", [c("pepi"), c("pope_x"), c("pepe_fr"), c("pepe_frog")]).map((x) => x.handle)).toEqual(["pepi", "pepe_fr", "pepe_frog"]);
    // Under 6 characters one edit, from 6 on two.
    expect(closest("bonk", [c("bunks")])).toEqual([]);
    expect(closest("dogwif", [c("dogwfx")]).map((x) => x.handle)).toEqual(["dogwfx"]);
  });

  it("asks about a vamp last: a key that starts or ends with the other's core, that core a word", () => {
    expect(closest("babypepe", [c("pepe"), c("pepe_frog"), c("bobo")]).map((x) => x.handle)).toEqual(["pepe"]);
    expect(closest("pepe", [c("babypepe"), c("pepewifhat")]).map((x) => x.handle)).toEqual(["babypepe", "pepewifhat"]);
    expect(closest("babyapu", [c("apu")]).map((x) => x.handle)).toEqual(["apu"]);
    // "ory" is what c/theory keeps once "the" is off, no word: c/history is not asked about.
    expect(coreWord("theory")).toBe("ory");
    expect(closest("history", [c("theory")])).toEqual([]);
    expect(closest("theory", [c("history")])).toEqual([]);
    expect(closest("capuchin", [c("apu")])).toEqual([]);
  });

  it("names a key's starts and ends of 3 or more, each once", () => {
    expect(affixes("babypepe")).toEqual(["bab", "epe", "baby", "pepe", "babyp", "ypepe", "babype", "bypepe", "babypep", "abypepe", "babypepe"]);
    expect(affixes("ab")).toEqual([]);
    expect(affixes("abc")).toEqual(["abc"]);
  });

  it(`answers up to ${CLOSEST_LIMIT}`, () => {
    expect(closest("gundam", Array.from({ length: 9 }, (_, i) => c(`gundam_${i}`)))).toHaveLength(CLOSEST_LIMIT);
  });
});
