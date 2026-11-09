import { describe, expect, it } from "vitest";
import { wallItems, type OwnRow } from "@/lib/ui/create/image";
import { ALL, MENU, PAIR, PAIR_MIN_W, RAIL, referenceRefusal, refusal, shareLink, sharePlatforms, tileFacts, tileLayout } from "@/lib/ui/create/tile-actions";
import type { ImageSetup } from "@/lib/ui/image-view/setups";
import type { Job } from "@/lib/ui/kit/render-queue";

/**
 * A finished picture's actions on Create > Image's wall (Kev, 2026-10-30: "bei higgsfield zb haste oben rechts zb herz,
 * bei uns gibts rechts daneben bookmark ... darunter ist download, dieses copy symbol ist dann recreate ... dann Create
 * prompt auch so klein. und dann diese 3 dots ... und dann auch ganz unten das bild und video").
 */
const setup = (prompt: string, over: Partial<ImageSetup> = {}) => ({ prompt, aspectRatio: "1:1", ...over } as unknown as ImageSetup);
const job = (id: string, over: Partial<Job<ImageSetup>> = {}): Job<ImageSetup> =>
  ({ id, createdAt: 1, status: "ready", sent: true, setup: setup(`words ${id}`), seen: false, imageUrl: `https://cdn/${id}.png`, ...over });
const row = (id: string, over: Partial<OwnRow> = {}): OwnRow => ({
  id, image_url: `https://cdn/${id}.png`, image_urls: [`https://cdn/${id}.webp`], thumbnail_url: `https://cdn/${id}-t.webp`, isUploaded: false,
  visibility: "private", prompt_id: null, settings: null, prompt_text: `words of ${id}`, created_at: "2026-10-30", ...over,
});
const one = (jobs: Job<ImageSetup>[], rows: OwnRow[]) => wallItems(jobs, rows)[0];

describe("where the actions stand", () => {
  it("puts the rail's four and ⋯ on a tall tile, Reference and Animate at its foot, Studio, Communities, Share and Delete under ⋯", () => {
    expect(RAIL).toEqual(["bookmark", "download", "recreate", "prompt"]);
    expect(PAIR).toEqual(["reference", "animate"]);
    expect(MENU).toEqual(["studio", "communities", "share", "delete"]);
    expect(tileLayout(300, 300)).toEqual({ rail: [...RAIL], pair: [...PAIR], more: [...MENU] });
    // Five buttons of 28 px, 4 px apart, 8 px from the edges: 172 px hold them all, 171 px one fewer.
    expect(tileLayout(300, 172).rail).toEqual([...RAIL]);
    expect(tileLayout(300, 171)).toEqual({ rail: ["bookmark", "download", "recreate"], pair: [...PAIR], more: ["prompt", ...MENU] });
  });

  it("moves what a short tile cannot hold under ⋯, ⋯ itself always stays", () => {
    expect(tileLayout(300, 108)).toEqual({ rail: ["bookmark", "download"], pair: [...PAIR], more: ["recreate", "prompt", ...MENU] });
    expect(tileLayout(300, 40)).toEqual({ rail: [], pair: [...PAIR], more: [...RAIL, ...MENU] });
  });

  it("moves Reference and Animate under ⋯ on a tile too narrow for them beside the rail", () => {
    expect(PAIR_MIN_W).toBe(120);
    expect(tileLayout(120, 300).pair).toEqual([...PAIR]);
    expect(tileLayout(119, 300)).toEqual({ rail: [...RAIL], pair: [], more: [...PAIR, ...MENU] });
  });

  it("lists every action on a touch screen's sheet, in the rail's order", () => {
    expect(ALL).toEqual(["bookmark", "download", "recreate", "prompt", "reference", "animate", "studio", "communities", "share", "delete"]);
  });
});

describe("what each picture gives its actions", () => {
  it("a recorded render: its original to save and animate, its shown picture as reference, its row, its words, its prompt", () => {
    expect(tileFacts(one([], [row("r1", { prompt_id: "p1" })]))).toEqual({
      url: "https://cdn/r1.png", src: "https://cdn/r1.webp", thumb: "https://cdn/r1-t.webp", rowId: "r1", promptId: "p1", words: "words of r1", page: null,
    });
  });

  it("a render of this visit before its row: the words it sent, no row, no prompt (the blank composer has none)", () => {
    expect(tileFacts(one([job("j")], []))).toEqual({
      url: "https://cdn/j.png", src: "https://cdn/j.png", thumb: "https://cdn/j.png", rowId: null, promptId: null, words: "words j", page: null,
    });
    // A job made from a prompt carries that prompt.
    expect(tileFacts(one([job("p", { setup: setup("x", { promptId: "p7" }) })], []))?.promptId).toBe("p7");
  });

  it("nothing while it renders or after it failed", () => {
    expect(tileFacts(one([job("busy", { status: "rendering", imageUrl: undefined })], []))).toBeNull();
    expect(tileFacts(one([job("f", { status: "failed", imageUrl: undefined })], []))).toBeNull();
  });

  it("no words on someone's listed prompt, nor on a row whose words are empty", () => {
    expect(tileFacts(one([], [row("m", { prompt_kind: "market", prompt_id: "p9", prompt_text: "theirs" })]))?.words).toBeNull();
    expect(tileFacts(one([], [row("e", { prompt_text: "   " })]))?.words).toBeNull();
    expect(tileFacts(one([], [row("n", { prompt_text: null })]))?.words).toBeNull();
  });

  it("a public render has its page; an 18+ one has none (that page refuses it) and shares its picture", () => {
    expect(tileFacts(one([], [row("pub", { visibility: "public" })]))?.page).toBe("/i/pub");
    const adult = tileFacts(one([], [row("adult", { visibility: "public", isAdult: true })]))!;
    expect(adult.page).toBeNull();
    expect(shareLink(adult, "https://enki.gallery")).toBe("https://cdn/adult.png");
    expect(tileFacts(one([], [row("pub2", { visibility: "public", isAdult: false })]))?.page).toBe("/i/pub2");
  });
});

describe("what an action says it cannot do", () => {
  const f = { promptId: "p1", words: "w", rowId: "r1" };
  it("Bookmark needs a prompt (the route keeps prompts), Make it a prompt words of the viewer's own, Delete a saved row", () => {
    expect(refusal("bookmark", { ...f, promptId: null })).toBe("Bookmarks keep prompts. This image was made from your own words: Make it a prompt to keep it.");
    expect(refusal("prompt", { ...f, words: null })).toBe("Its words belong to the prompt's creator.");
    expect(refusal("delete", { ...f, rowId: null })).toBe("Saving your render… It can be deleted once it is saved.");
    // A render's communities are its row's (PUT /api/communities/links takes the row's id).
    expect(refusal("communities", { ...f, rowId: null })).toBe("Saving your render… It can join communities once it is saved.");
    for (const a of ALL) expect(refusal(a, f)).toBeNull();
  });
});

describe("Share", () => {
  it("carries a public picture's page, else the picture's own address, nothing for one not stored", () => {
    expect(shareLink({ page: "/i/pub", url: "https://cdn/pub.png" }, "https://enki.gallery")).toBe("https://enki.gallery/i/pub");
    expect(shareLink({ page: null, url: "https://cdn/a.png" }, "https://enki.gallery")).toBe("https://cdn/a.png");
    expect(shareLink({ page: null, url: "data:image/png;base64,AAAA" }, "https://enki.gallery")).toBeNull();
  });

  it("opens each platform's own share address with the link and the words", () => {
    const p = sharePlatforms("https://enki.gallery/i/a b", "An image on Enki Art");
    expect(p.map((x) => x.label)).toEqual(["X", "Facebook", "Reddit", "WhatsApp", "Telegram", "Email"]);
    expect(Object.fromEntries(p.map((x) => [x.key, x.href]))).toEqual({
      x: "https://x.com/intent/tweet?url=https%3A%2F%2Fenki.gallery%2Fi%2Fa%20b&text=An%20image%20on%20Enki%20Art",
      facebook: "https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fenki.gallery%2Fi%2Fa%20b",
      reddit: "https://www.reddit.com/submit?url=https%3A%2F%2Fenki.gallery%2Fi%2Fa%20b&title=An%20image%20on%20Enki%20Art",
      whatsapp: "https://wa.me/?text=An%20image%20on%20Enki%20Art%20https%3A%2F%2Fenki.gallery%2Fi%2Fa%20b",
      telegram: "https://t.me/share/url?url=https%3A%2F%2Fenki.gallery%2Fi%2Fa%20b&text=An%20image%20on%20Enki%20Art",
      email: "mailto:?subject=An%20image%20on%20Enki%20Art&body=An%20image%20on%20Enki%20Art%0Ahttps%3A%2F%2Fenki.gallery%2Fi%2Fa%20b",
    });
  });
});

describe("Reference", () => {
  const bar = { cap: 4, room: 2, refs: [{ id: "https://cdn/a.webp" }], pending: ["https://cdn/b.webp#read-1"], name: "Nano Banana Pro" };
  it("goes in while the generator has room; says why not otherwise", () => {
    expect(referenceRefusal(bar, "https://cdn/c.webp")).toBeNull();
    expect(referenceRefusal({ ...bar, cap: 0 }, "https://cdn/c.webp")).toBe("Nano Banana Pro takes no reference images");
    expect(referenceRefusal({ ...bar, room: 0 }, "https://cdn/c.webp")).toBe("Nano Banana Pro takes up to 4 reference images. Remove one first.");
    expect(referenceRefusal({ ...bar, cap: 1, room: 0 }, "https://cdn/c.webp")).toBe("Nano Banana Pro takes up to 1 reference image. Remove one first.");
  });
  it("never twice: one already in, or one still being read", () => {
    expect(referenceRefusal(bar, "https://cdn/a.webp")).toBe("It is already one of the references");
    expect(referenceRefusal(bar, "https://cdn/b.webp")).toBe("It is already one of the references");
  });
});
