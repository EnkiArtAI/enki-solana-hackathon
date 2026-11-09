import { describe, expect, it } from "vitest";
import { MAX_COMMUNITIES_PER_WORK } from "@/lib/communities/types";
import { addPick, createOffer, dropPick, idsOfKey, isFull, pickKey, unpicked } from "../picker";

/**
 * The Communities picker's rules (Kev, 2026-10-30: "ein bild kann auch mehreren communities zugeteilt werden ... max 18
 * communities pro werk"; "man eine aufmachen kann, wenn es keine dazu gibt").
 */
const chip = (i: number | string) => ({ id: `id${i}`, handle: `c${i}`, name: `C ${i}` });
const many = (n: number) => Array.from({ length: n }, (_, i) => chip(i));

describe("picks", () => {
  it("add once each, up to 18 (a prompt's ones counted), never a 19th", () => {
    expect(MAX_COMMUNITIES_PER_WORK).toBe(18);
    expect(addPick([chip(1)], chip(1))).toEqual([chip(1)]);
    expect(addPick([chip(1)], chip(2))).toEqual([chip(1), chip(2)]);
    expect(addPick(many(17), chip("x"))).toHaveLength(18);
    expect(addPick(many(18), chip("x"))).toEqual(many(18));
    expect([isFull(many(17)), isFull(many(18))]).toEqual([false, true]);
  });

  it("in single mode, replace the pick and are never full", () => {
    expect(addPick([chip(1)], chip(2), "single")).toEqual([chip(2)]);
    expect(addPick(many(18), chip("x"), "single")).toEqual([chip("x")]);
    expect(isFull(many(18), "single")).toBe(false);
  });

  it("drop by id; a list offers only what is not picked, in its order", () => {
    expect(dropPick([chip(1), chip(2), chip(3)], "id2")).toEqual([chip(1), chip(3)]);
    expect(unpicked([chip(3), chip(1), chip(2)], [chip(1)])).toEqual([chip(3), chip(2)]);
  });

  it("are one key in any order, and back", () => {
    expect(pickKey(["b", "a", "b"])).toBe("a,b");
    expect(pickKey([])).toBe("");
    expect([idsOfKey("a,b"), idsOfKey("")]).toEqual([["a", "b"], []]);
  });
});

describe("+ Create c/<typed>", () => {
  it("offers the typed words' handle while the ones found start with them or carry them in their name", () => {
    expect(createOffer("Gundam Wing!", [{ handle: "gundam_wing_zero", name: "Wing Zero" }, { handle: "mecha", name: "Gundam Wing! fans" }])).toBe("gundam_wing");
    expect(createOffer("Pеpe", [])).toBe("pepe");
  });

  it("offers none for a look-alike of one found, a name Enki keeps, or words without a handle", () => {
    expect(createOffer("gund4m", [{ handle: "gundam", name: "Gundam" }])).toBeNull();
    expect(createOffer("Gundam", [{ handle: "pepe", name: "Pepe" }, { handle: "gundam", name: "Gundam" }])).toBeNull();
    expect(createOffer("admin", [])).toBeNull();
    expect(createOffer("x", [])).toBeNull();
    expect(createOffer("!!!", [])).toBeNull();
  });

  // Review 2026-10-30: c/btc, its search word "bitcoin", came up for "bitcoin", and "+ Create c/bitcoin" was offered first.
  it("offers none when one came up by a search word or a merged handle (neither its handle nor its name explains it)", () => {
    expect(createOffer("bitcoin", [{ handle: "btc", name: "BTC" }])).toBeNull();
    expect(createOffer("gundam_fans", [{ handle: "gundam", name: "Gundam" }])).toBeNull();
    expect(createOffer("bitcoin", [{ handle: "bitcoin_maxis", name: "Maxis" }, { handle: "orange", name: "Bitcoin art" }])).toBe("bitcoin");
  });
});
