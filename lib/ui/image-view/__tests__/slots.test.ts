import { describe, expect, it } from "vitest";
import { addPhoto, initialSlots, MAX_SLOTS, moveRef, photosMissing, pickExample, putPhoto, refsAt, removeSlot, resize, slotCount, type Slot, type Slots } from "../slots";

const R = (n: number) => `Reference image ${n}`;
const own = (id: number, photo: string): Slot => ({ id, photo, ex: false });
const ex = (id: number, photo: string): Slot => ({ id, photo, ex: true });
const empty = (id: number): Slot => ({ id, photo: null, ex: false });
const slots = (text: string | null, imgs: Slot[], stash: string[] = [], min = 1): Slots => ({ text, imgs, stash, min });

describe("slotCount", () => {
  it("is the text's highest reference, so every reference has a slot", () => {
    expect(slotCount(`A portrait of ${R(1)} and ${R(2)}.`)).toBe(2);
    expect(slotCount(`Only ${R(3)} here.`)).toBe(3);
    expect(slotCount(`${R(1)} twice: ${R(1)}.`)).toBe(1);
  });

  it("reads the text as a saved text writes it: a bracketed reference is a slot to type into, not an image", () => {
    expect(slotCount("A [Reference image 2] in [mood].")).toBe(0);
    expect(slotCount("No image at all.")).toBe(0);
  });

  it("asks for 14 at most", () => {
    expect(MAX_SLOTS).toBe(14);
    expect(slotCount(Array.from({ length: 15 }, (_, i) => R(i + 1)).join(" and "))).toBe(14);
  });
});

describe("initialSlots", () => {
  it("opens with one empty slot per reference, numbered from 1, the text as it is", () => {
    const text = `Both ${R(1)} and ${R(2)} on a bench.`;
    expect(initialSlots(text)).toEqual({ text, imgs: [empty(1), empty(2)], stash: [], min: 1 });
  });

  it("keeps no slot for a prompt that names no image, and none of it is required", () => {
    expect(initialSlots("A cat.")).toEqual({ text: "A cat.", imgs: [], stash: [], min: 0 });
    expect(initialSlots(null)).toEqual({ text: null, imgs: [], stash: [], min: 0 });
  });

  it("takes a count where the text is hidden (premium), clamped to 14", () => {
    expect(initialSlots(null, 2)).toEqual({ text: null, imgs: [empty(1), empty(2)], stash: [], min: 1 });
    expect(initialSlots(null, 20).imgs).toHaveLength(14);
  });
});

describe("addPhoto", () => {
  const text = `A portrait of ${R(1)} and ${R(2)}, photographed at dusk.`;

  it("fills the first free slot, an empty one, and leaves the text alone", () => {
    expect(addPhoto(slots(text, [own(1, "a"), empty(2), empty(3)]), "b")).toEqual(slots(text, [own(1, "a"), own(2, "b"), empty(3)]));
  });

  it("fills an example slot as a free one: the buyer's photo replaces the example's", () => {
    expect(addPhoto(slots(text, [ex(1, "e1"), empty(2)]), "b").imgs).toEqual([own(1, "b"), empty(2)]);
  });

  it("Easy: a new slot arrives filled, its reference after the last one with ' and '", () => {
    const next = addPhoto(slots(text, [own(1, "a"), own(2, "b")]), "c");
    expect(next.imgs).toEqual([own(1, "a"), own(2, "b"), own(3, "c")]);
    expect(next.text).toBe(`A portrait of ${R(1)} and ${R(2)} and ${R(3)}, photographed at dusk.`);
  });

  it("after the last reference in the text, wherever the numbers stand", () => {
    const next = addPhoto(slots(`${R(2)} beside ${R(1)}, at dusk.`, [own(1, "a"), own(2, "b")]), "c");
    expect(next.text).toBe(`${R(2)} beside ${R(1)} and ${R(3)}, at dusk.`);
  });

  it("after the text where it names no image", () => {
    expect(addPhoto(initialSlots("A cat."), "a")).toEqual({ text: `A cat. ${R(1)}`, imgs: [own(1, "a")], stash: [], min: 0 });
  });

  it("Expert: the new reference goes at the cursor, numbered as the next slot", () => {
    const at = "A portrait ".length;
    const next = addPhoto(slots(text, [own(1, "a"), own(2, "b")]), "c", at);
    expect(next.text).toBe(`A portrait ${R(3)} of ${R(1)} and ${R(2)}, photographed at dusk.`);
    expect(next.imgs.at(-1)).toEqual(own(3, "c"));
  });

  it("gives a new slot an id no slot has", () => {
    expect(addPhoto(slots(text, [own(4, "a"), own(2, "b")]), "c").imgs.at(-1)).toEqual(own(5, "c"));
  });

  it("is refused at 14 slots with none free", () => {
    const full = slots(null, Array.from({ length: 14 }, (_, i) => own(i + 1, `p${i}`)));
    expect(addPhoto(full, "x")).toBe(full);
  });

  it("adds a slot without a text on a premium prompt", () => {
    expect(addPhoto(slots(null, [own(1, "a")]), "b", 3)).toEqual(slots(null, [own(1, "a"), own(2, "b")]));
  });
});

describe("refsAt", () => {
  const text = `A portrait of ${R(1)} beside a lake at dusk.`;
  const at = text.indexOf(" at dusk");

  it("puts the new slots' references in at the cursor, ' and ' between them, one space on each side", () => {
    expect(refsAt(text, 2, at)).toBe(`A portrait of ${R(1)} beside a lake ${R(2)} at dusk.`);
    expect(refsAt(text, 3, at)).toBe(`A portrait of ${R(1)} beside a lake ${R(2)} and ${R(3)} at dusk.`);
  });

  it("leaves a text that already names that many as it was, and never names more than 14", () => {
    expect(refsAt(text, 1, at)).toBe(text);
    expect(refsAt(text, 40, at).match(/Reference image \d+/g)).toHaveLength(MAX_SLOTS);
  });
});

describe("putPhoto", () => {
  it("puts the buyer's photo into that slot only (a tap on an empty or example slot, Replace)", () => {
    expect(putPhoto(slots(null, [empty(1), ex(2, "e"), own(3, "c")]), 2, "b").imgs).toEqual([empty(1), own(2, "b"), own(3, "c")]);
    expect(putPhoto(slots(null, [own(1, "a")]), 1, "z").imgs).toEqual([own(1, "z")]);
  });
});

describe("removeSlot", () => {
  const three = `A of ${R(1)} and ${R(2)} and ${R(3)}, at dusk.`;
  const abc = [own(1, "a"), own(2, "b"), own(3, "c")];

  it("takes the reference with the ' and ' after it, and the later slots move up one", () => {
    const next = removeSlot(slots(three, abc), 1);
    expect(next.imgs).toEqual([own(2, "b"), own(3, "c")]);
    expect(next.text).toBe(`A of ${R(1)} and ${R(2)}, at dusk.`);
  });

  it("takes the ' and ' before it where none follows", () => {
    expect(removeSlot(slots(three, abc), 3).text).toBe(`A of ${R(1)} and ${R(2)}, at dusk.`);
  });

  it("takes ONE ' and ', never both", () => {
    expect(removeSlot(slots(three, abc), 2).text).toBe(`A of ${R(1)} and ${R(2)}, at dusk.`);
  });

  it("takes every place the reference stands, each with its own ' and '", () => {
    expect(removeSlot(slots(`${R(1)} and ${R(2)}, then ${R(1)} and ${R(2)}.`, [own(1, "a"), own(2, "b")]), 1).text).toBe(`${R(1)}, then ${R(1)}.`);
  });

  it("empties the last slot instead of deleting it, and keeps its reference", () => {
    const one = `A of ${R(1)}, at dusk.`;
    expect(removeSlot(slots(one, [own(1, "a")]), 1)).toEqual(slots(one, [empty(1)]));
    expect(removeSlot(slots(one, [ex(1, "e")]), 1).imgs).toEqual([empty(1)]);
  });

  it("lets the stash fill the emptied last slot", () => {
    expect(removeSlot(slots(null, [own(1, "a")], ["s1", "s2"]), 1)).toEqual(slots(null, [own(1, "s1")], ["s2"]));
  });

  it("lets a prompt that names no image go back to none, its text as it was", () => {
    const added = addPhoto(initialSlots("A cat."), "a");
    expect(removeSlot(added, added.imgs[0].id)).toEqual(initialSlots("A cat."));
  });

  it("leaves no double space where a reference went in at the cursor", () => {
    const text = `A of ${R(1)} at dusk.`;
    const added = addPhoto(slots(text, [own(1, "a")]), "b", "A ".length);
    expect(added.text).toBe(`A ${R(2)} of ${R(1)} at dusk.`);
    expect(removeSlot(added, 2).text).toBe(text);
  });

  it("changes nothing for a slot that is not there", () => {
    const s = slots(three, abc);
    expect(removeSlot(s, 9)).toBe(s);
  });
});

describe("resize", () => {
  const three = `A of ${R(1)} and ${R(2)} and ${R(3)}, at dusk.`;

  it("shrinks from the end, each slot with its reference, the buyer's own photos into the stash", () => {
    const next = resize(slots(three, [own(1, "a"), own(2, "b"), own(3, "c")], ["old"]), 1);
    expect(next.imgs).toEqual([own(1, "a")]);
    expect(next.text).toBe(`A of ${R(1)}, at dusk.`);
    expect(next.stash).toEqual(["old", "b", "c"]);
  });

  it("stashes no example photo and no empty slot", () => {
    expect(resize(slots(three, [own(1, "a"), ex(2, "e"), empty(3)]), 1).stash).toEqual([]);
  });

  it("grows with empty slots, their references after the last one", () => {
    const next = resize(slots(`A of ${R(1)}, at dusk.`, [own(1, "a")]), 3);
    expect(next.imgs).toEqual([own(1, "a"), empty(2), empty(3)]);
    expect(next.text).toBe(three);
  });

  it("lets the stash fill the next free slot first", () => {
    expect(resize(slots(null, [own(1, "a")], ["s1"]), 3)).toEqual(slots(null, [own(1, "a"), own(2, "s1"), empty(3)]));
    // A shrink that leaves a free slot gets the pushed-out photo straight back into it.
    expect(resize(slots(null, [empty(1), own(2, "b")]), 1)).toEqual(slots(null, [own(1, "b")]));
  });

  it("keeps at least one slot where the prompt names an image, and 14 at most", () => {
    expect(resize(slots(null, [own(1, "a"), own(2, "b")]), 0).imgs).toEqual([own(1, "a")]);
    expect(resize(slots(null, [], [], 0), 0).imgs).toEqual([]);
    expect(resize(slots(null, [empty(1)]), 20).imgs).toHaveLength(14);
  });
});

describe("pickExample", () => {
  const two = `A of ${R(1)} and ${R(2)}, at dusk.`;

  it("puts the example's photos into the free slots, by place, marked as the example's", () => {
    expect(pickExample(slots(two, [empty(1), empty(2)]), ["e1", "e2"]).imgs).toEqual([ex(1, "e1"), ex(2, "e2")]);
  });

  it("keeps the buyer's own photos where they are", () => {
    const next = pickExample(slots(two, [own(1, "a"), empty(2)]), ["e1", "e2"]);
    expect(next.imgs).toEqual([own(1, "a"), ex(2, "e2")]);
    expect(next.stash).toEqual([]);
  });

  it("replaces the last example's photos with this one's", () => {
    expect(pickExample(slots(two, [ex(1, "e1"), ex(2, "e2")]), ["f1", "f2"]).imgs).toEqual([ex(1, "f1"), ex(2, "f2")]);
  });

  it("follows the example's photo count: fewer push the buyer's own photos out into the stash", () => {
    const next = pickExample(slots(two, [own(1, "a"), own(2, "b")]), ["e1"]);
    expect(next.imgs).toEqual([own(1, "a")]);
    expect(next.text).toBe(`A of ${R(1)}, at dusk.`);
    expect(next.stash).toEqual(["b"]);
  });

  it("lets the stash fill a free slot before the example does", () => {
    const next = pickExample(slots(`A of ${R(1)}, at dusk.`, [own(1, "a")], ["b"]), ["e1", "e2", "e3"]);
    expect(next.imgs).toEqual([own(1, "a"), own(2, "b"), ex(3, "e3")]);
    expect(next.text).toBe(`A of ${R(1)} and ${R(2)} and ${R(3)}, at dusk.`);
    expect(next.stash).toEqual([]);
  });

  it("leaves one empty slot for an example without photos", () => {
    expect(pickExample(slots(two, [ex(1, "e1"), ex(2, "e2")]), []).imgs).toEqual([empty(1)]);
  });
});

describe("photosMissing", () => {
  it("counts every slot without the buyer's own photo: an example's photo does not count", () => {
    expect(photosMissing([own(1, "a"), ex(2, "e"), empty(3)])).toBe(2);
    expect(photosMissing([own(1, "a"), own(2, "b")])).toBe(0);
    expect(photosMissing([])).toBe(0);
  });
});

describe("moveRef (Kev, 2026-10-26: move the images in the text; their \"and\" goes when no other image is attached there)", () => {
  const R = (n: number) => `Reference image ${n}`;
  const RUN = `A cat with ${R(1)} and ${R(2)} and ${R(3)} by the sea`;
  const move = (text: string, n: number, to: number) => moveRef(text, text.indexOf(R(n)), to)?.text ?? null;

  it("takes the middle of three out with the \" and \" after it; the two left stay joined", () => {
    expect(move(RUN, 2, RUN.length)).toBe(`A cat with ${R(1)} and ${R(3)} by the sea ${R(2)}`);
  });
  it("takes the last of a run out with the \" and \" before it", () => {
    expect(move(RUN, 3, 5)).toBe(`A cat ${R(3)} with ${R(1)} and ${R(2)} by the sea`);
  });
  it("takes the first of a run out with the \" and \" after it", () => {
    expect(move(RUN, 1, RUN.length)).toBe(`A cat with ${R(2)} and ${R(3)} by the sea ${R(1)}`);
  });
  it("takes one space where there is no \" and \"", () => {
    const t = `${R(1)} standing on a hill`;
    expect(move(t, 1, t.length)).toBe(`standing on a hill ${R(1)}`);
  });
  it("moves nothing on a drop where it already is: its own \" and \", or across nothing but spaces (review 2026-10-26)", () => {
    const t = `A cat ${R(1)} and ${R(2)} in a box`;
    const s1 = t.indexOf(R(1));
    // Onto its own "and": the end of that word.
    expect(moveRef(t, s1, t.indexOf(" and ") + 4)).toBeNull();
    // Onto the word before it ("cat"): its end, a space before the image.
    expect(moveRef(t, s1, t.indexOf("cat") + 3)).toBeNull();
    // Image 2 onto the "and" before it.
    expect(moveRef(t, t.indexOf(R(2)), t.indexOf(" and ") + 4)).toBeNull();
    // One word further is a move, and its " and " goes.
    expect(moveRef(t, s1, t.indexOf("A") + 1)?.text).toBe(`A ${R(1)} cat ${R(2)} in a box`);
  });
  it("moves nothing on a drop on itself, an unknown start, or the same text back", () => {
    expect(moveRef(RUN, RUN.indexOf(R(2)), RUN.indexOf(R(2)) + 3)).toBeNull();
    expect(moveRef(RUN, 3, RUN.length)).toBeNull();
    const t = `on ${R(1)}`;
    expect(moveRef(t, 3, 2)).toBeNull();
  });
  it("keeps the number, so slot n keeps photo n", () => {
    expect(move(RUN, 2, 0)?.startsWith(`${R(2)} A cat`)).toBe(true);
  });
});
