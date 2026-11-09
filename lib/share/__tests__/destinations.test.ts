import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionBlock } from "../content";
import { DEST, deliver, deskSentence, destAddress, pasteSentence, sheetFits, sheetSentence, wantsPng } from "../destinations";

const blocks: CaptionBlock[] = [{ key: "title", text: "Neon koi" }, { key: "link", text: "https://enki.gallery/generator/p1" }, { key: "tags", text: "#aiart #flux" }];
const LINK = "https://enki.gallery/generator/p1";

describe("the destinations' formats", () => {
  it("are the decided ones", () => {
    expect(DEST).toEqual({ X: "16:9", Instagram: "4:5", Pinterest: "2:3", Threads: "4:5", TikTok: "9:16" });
  });
});

describe("destAddress", () => {
  it("X takes text and link, the link apart", () => {
    const u = new URL(destAddress("X", blocks, LINK));
    expect(u.origin + u.pathname).toBe("https://x.com/intent/tweet");
    expect(u.searchParams.get("url")).toBe(LINK);
    expect(u.searchParams.get("text")).toBe("Neon koi\n\n#aiart #flux");
  });
  it.each(["X", "Threads"] as const)("%s: a link left out of the post, or on the card, stays away", (d) => {
    const u = new URL(destAddress(d, blocks.filter((b) => b.key !== "link"), LINK));
    expect(u.searchParams.has("url")).toBe(false);
    expect(u.searchParams.get("text")).toBe("Neon koi\n\n#aiart #flux");
  });
  it("X's room is the whole 280 with no link to count", () => {
    const long: CaptionBlock[] = [{ key: "title", text: "x".repeat(270) }];
    expect(new URL(destAddress("X", long, LINK)).searchParams.get("text")).toHaveLength(270);
    expect(new URL(destAddress("X", [...long, { key: "link", text: LINK }], LINK)).searchParams.get("text")).toHaveLength(256);
  });
  it("X's text keeps to its limit, a long prompt gives way", () => {
    const long: CaptionBlock[] = [{ key: "prompt", text: "x".repeat(900) }, ...blocks];
    expect(new URL(destAddress("X", long, LINK)).searchParams.get("text")).toBe("Neon koi\n\n#aiart #flux");
    expect(new URL(destAddress("Threads", long, LINK)).searchParams.get("text")).toBe("Neon koi\n\n#aiart #flux");
  });
  it("Threads names text and url", () => {
    const u = new URL(destAddress("Threads", blocks, LINK));
    expect(u.origin + u.pathname).toBe("https://www.threads.com/intent/post");
    expect(u.searchParams.get("url")).toBe(LINK);
    expect(u.searchParams.get("text")).toBe("Neon koi\n\n#aiart #flux");
  });
  it("the others open their own page", () => {
    expect(destAddress("Instagram", blocks, LINK)).toBe("https://www.instagram.com/");
    expect(destAddress("Pinterest", blocks, LINK)).toBe("https://www.pinterest.com/");
    expect(destAddress("TikTok", blocks, LINK)).toBe("https://www.tiktok.com/upload");
  });
});

describe("the sentences say what happened", () => {
  it("nothing says a card was saved, or sends anyone to Save", () => {
    const all = [
      ...(["X", "Threads"] as const).flatMap((d) => [pasteSentence(d, true, true), pasteSentence(d, false, true), pasteSentence(d, true, false), pasteSentence(d, false, false), pasteSentence(d, true, true, false, false, true)]),
      ...(["X", "Instagram", "Pinterest", "Threads", "TikTok"] as const).flatMap((d) => [1, 5].flatMap((n) => [deskSentence(d, n, true, true), deskSentence(d, n, false, false), deskSentence(d, n, true, true, true, "touch"), sheetSentence(d, n, true), sheetSentence(d, n, true, true, "pc")])),
    ];
    for (const s of all) expect(s).not.toMatch(/\bsav(e|ed)\b|download/i);
  });
  it("X and Threads: opened with the words, the card to paste, as decided", () => {
    expect(pasteSentence("X", true, true)).toBe("X opened with your text and link; your card is copied, paste it with Ctrl+V.");
    expect(pasteSentence("Threads", true, true)).toBe("Threads opened with your text and link; your card is copied, paste it with Ctrl+V.");
  });
  it("the paste key is the device's", () => {
    expect(pasteSentence("X", true, true, true, true, false, "mac")).toContain("paste it with Cmd+V.");
    expect(pasteSentence("X", true, true, true, true, false, "touch")).toContain("paste it into your post.");
  });
  it("no link, no words: the opening claims neither", () => {
    expect(pasteSentence("X", true, true, false)).toBe("X opened with your text; your card is copied, paste it with Ctrl+V.");
    expect(pasteSentence("X", true, true, true, false)).toBe("X opened with your link; your card is copied, paste it with Ctrl+V.");
    expect(pasteSentence("X", true, true, false, false)).toBe("X opened; your card is copied, paste it with Ctrl+V.");
  });
  it("a card not on the clipboard: never says copied", () => {
    const s = pasteSentence("X", false, true);
    expect(s).toBe("X opened with your text and link; copying your card failed, so X has no card yet: post it from your phone.");
    expect(s).not.toMatch(/is copied|Ctrl\+V/);
  });
  it("a blocked tab: never says opened, and the words stand below", () => {
    const s = pasteSentence("X", true, false, true, true, true);
    expect(s).toBe("Your browser blocked the new tab, so open X yourself; your card is copied, paste it with Ctrl+V. Your text stands below.");
    expect(s).not.toContain("opened");
  });
  it("text cut to fit: says so", () => {
    expect(pasteSentence("X", true, true, true, true, true)).toBe("X opened with your text and link; your card is copied, paste it with Ctrl+V. Your text was cut to fit: the whole of it stands below.");
  });
  it("no sheet on a desktop: says the card cannot reach the site, and the way out", () => {
    expect(deskSentence("Instagram", 1, true, true)).toBe("Instagram opened. This browser cannot hand your card to Instagram: post it from your phone. Your text is copied: paste it as the caption.");
    expect(deskSentence("Instagram", 5, true, true)).toBe("Instagram opened. This browser cannot hand these 5 images to Instagram: post them from your phone. Your text is copied: paste it as the caption.");
    expect(deskSentence("Pinterest", 1, true, true)).toBe("Pinterest opened. This browser cannot hand your card to Pinterest: post it from your phone. Your text is copied: paste it as the description.");
    expect(deskSentence("TikTok", 1, true, true)).toBe("TikTok opened. This browser cannot hand your card to TikTok: post it from your phone. Your text is copied: paste it as the caption.");
  });
  it("no sheet on a phone: not sent to its own phone", () => {
    const s = deskSentence("TikTok", 1, true, true, true, "touch");
    expect(s).toContain("try another browser");
    expect(s).not.toContain("your phone");
  });
  it("the sheet's way out: on a desktop for an app it may not list, on a phone for a set", () => {
    expect(sheetSentence("TikTok", 1, true, true, "pc")).toBe("Pick TikTok in the sheet. If it is not listed, post it from your phone. Your text is copied: paste it as the caption.");
    expect(sheetSentence("Instagram", 5, true, true, "pc")).toBe("Pick Instagram in the sheet. If it is not listed or takes only one image, post them from your phone. Your text is copied: paste it as the caption.");
    expect(sheetSentence("Instagram", 5, true)).toBe("Pick Instagram in the sheet. If it takes only one image, send all 5 to your photos from the sheet and add them on Instagram. Your text is copied: paste it as the caption.");
    expect(sheetSentence("X", 1, true)).toBe("Pick X in the sheet. Your text is copied: paste it as the caption.");
  });
  it("no promise that Instagram takes a dropped post", () => {
    for (const s of [deskSentence("Instagram", 5, true, true), sheetSentence("Instagram", 5, true)]) expect(s).not.toMatch(/ready to drop|one post|Drop them/i);
  });
  it("text not on the clipboard: never says copied", () => {
    for (const d of ["Instagram", "Pinterest", "TikTok"] as const) {
      const s = deskSentence(d, 1, false, true);
      expect(s).not.toMatch(/is copied/);
      expect(s).toContain("Copying your text failed");
    }
    expect(sheetSentence("X", 1, false)).not.toMatch(/is copied/);
  });
  it("a blocked tab: never says opened", () => {
    const s = deskSentence("TikTok", 1, true, false);
    expect(s).toContain("Your browser blocked the new tab, so open TikTok yourself.");
    expect(s).not.toContain("opened");
  });
  it.each(["Instagram", "Pinterest", "TikTok"] as const)("no text in the post: %s's sentence claims none", (d) => {
    for (const s of [deskSentence(d, 1, true, true, false), deskSentence(d, 1, true, false, false), sheetSentence(d, 1, true, false)]) {
      expect(s).not.toMatch(/text|copied|caption|description/i);
      expect(s).toBe(s.trim());
    }
  });
});

describe("deliver", () => {
  const file = (name: string) => new File(["x"], name, { type: "image/jpeg" });
  const png = new Blob(["p"], { type: "image/png" });
  class Item { constructor(readonly items: Record<string, Blob>) {} }
  let made: string[], urls: number, opened: string[], shared: ShareData[], copied: string[], cards: Record<string, Blob>[], coarse: boolean, canShare: boolean, opens: boolean, writes: boolean, cardWrites: boolean, share: () => Promise<void>, order: string[];

  beforeEach(() => {
    made = [];
    urls = 0;
    opened = [];
    shared = [];
    copied = [];
    cards = [];
    order = [];
    coarse = false;
    canShare = true;
    opens = true;
    writes = true;
    cardWrites = true;
    share = () => Promise.resolve();
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: coarse }),
      open: (url: string) => { order.push("open"); opened.push(url); return opens ? {} : null; },
    });
    // Any element made, any object URL: the way a page leaves a file on a device.
    vi.stubGlobal("document", {
      createElement: (tag: string) => { made.push(tag); return { click() {}, remove() {} }; },
      body: { append() {} },
    });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => { urls++; return "blob:x"; }, revokeObjectURL: () => {} }));
    vi.stubGlobal("ClipboardItem", Item);
    vi.stubGlobal("navigator", {
      platform: "Win32",
      canShare: () => canShare,
      share: (d: ShareData) => { shared.push(d); return share(); },
      clipboard: {
        writeText: (t: string) => { copied.push(t); return writes ? Promise.resolve() : Promise.reject(new Error("denied")); },
        write: (items: Item[]) => { order.push("write"); cards.push(items[0].items); return cardWrites ? Promise.resolve() : Promise.reject(new Error("denied")); },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  describe.each([
    ["touch, a sheet", true, true],
    ["touch, no sheet", true, false],
    ["a mouse, canShare yes", false, true],
    ["a mouse, canShare no", false, false],
  ])("%s", (_name, isCoarse, can) => {
    it.each(["X", "Instagram", "Pinterest", "Threads", "TikTok"] as const)("%s never makes a link or an object URL, for one card or for several", async (d) => {
      coarse = isCoarse;
      canShare = can;
      for (const files of [[file("a.jpg")], [file("1.jpg"), file("2.jpg"), file("3.jpg")]]) await deliver(d, files, blocks, LINK, () => {}, png);
      expect(made).toEqual([]);
      expect(urls).toBe(0);
    });
  });

  it("no text on a touch device: the sheet gets none, the clipboard stays, nothing speaks of text", async () => {
    coarse = true;
    const said: string[] = [];
    await expect(deliver("Instagram", [file("a.jpg")], [], LINK, (s) => said.push(s))).resolves.toEqual({ byHand: false });
    expect(shared[0]).not.toHaveProperty("text");
    expect(copied).toEqual([]);
    expect(said).toEqual(["Pick Instagram in the sheet.", "Handed to the app you picked."]);
    share = () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }));
    said.length = 0;
    await deliver("Instagram", [file("a.jpg")], [], LINK, (s) => said.push(s));
    expect(said.at(-1)).toBe("Nothing was shared.");
  });

  it.each(["X", "Threads"] as const)("%s on a desktop: the PNG on the clipboard and the address open, before the first wait, the write first", async (d) => {
    const said: string[] = [];
    const running = deliver(d, [file("a.jpg")], blocks, LINK, (s) => said.push(s), png);
    // Nothing has been awaited yet: this is still the press.
    expect(order).toEqual(["write", "open"]);
    expect(cards).toEqual([{ "image/png": png }]);
    expect(opened[0]).toContain(d === "X" ? "https://x.com/intent/tweet" : "https://www.threads.com/intent/post");
    expect(said).toEqual([]);
    await expect(running).resolves.toEqual({ byHand: false });
    expect(said).toEqual([pasteSentence(d, true, true)]);
    expect(shared).toEqual([]);
    expect(copied).toEqual([]);
  });

  it("X on a Mac says Cmd+V", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
    const said: string[] = [];
    await deliver("X", [file("a.jpg")], blocks, LINK, (s) => said.push(s), png);
    expect(said[0]).toContain("Cmd+V");
  });

  it("text cut to fit the address: the whole of it goes to the block by hand", async () => {
    const long: CaptionBlock[] = [{ key: "prompt", text: "x".repeat(900) }, ...blocks];
    const said: string[] = [];
    await expect(deliver("X", [file("a.jpg")], long, LINK, (s) => said.push(s), png)).resolves.toEqual({ byHand: true });
    expect(said[0]).toContain("cut to fit");
  });

  it("only a link in the post: the sentence says the link, no text; nothing was cut", async () => {
    const said: string[] = [];
    await expect(deliver("X", [file("a.jpg")], [{ key: "link", text: LINK }], LINK, (x) => said.push(x), png)).resolves.toEqual({ byHand: false });
    expect(said[0]).toBe("X opened with your link; your card is copied, paste it with Ctrl+V.");
  });

  it("a blocked tab: the words went nowhere, so they go to the block by hand", async () => {
    opens = false;
    const said: string[] = [];
    await expect(deliver("X", [file("a.jpg")], blocks, LINK, (s) => said.push(s), png)).resolves.toEqual({ byHand: true });
    expect(said[0]).toBe(pasteSentence("X", true, false, true, true, true));
  });

  it.each<[string, () => void]>([
    ["no PNG", () => {}],
    ["no ClipboardItem", () => vi.stubGlobal("ClipboardItem", undefined)],
    ["no clipboard", () => vi.stubGlobal("navigator", { platform: "Win32", canShare: () => false })],
  ])("%s: says the card was not copied, and the tab still opens", async (name, setUp) => {
    setUp();
    const said: string[] = [];
    await expect(deliver("X", [file("a.jpg")], blocks, LINK, (s) => said.push(s), name === "no PNG" ? undefined : png)).resolves.toEqual({ byHand: false });
    expect(said[0]).toBe(pasteSentence("X", false, true));
    expect(opened).toHaveLength(1);
  });

  it("a refused write says the card was not copied", async () => {
    cardWrites = false;
    const said: string[] = [];
    await deliver("Threads", [file("a.jpg")], blocks, LINK, (s) => said.push(s), png);
    expect(said[0]).toBe(pasteSentence("Threads", false, true));
  });

  it.each(["Instagram", "Pinterest", "TikTok"] as const)("%s, a mouse, canShare yes: the OS sheet with the files, no tab", async (d) => {
    const said: string[] = [];
    const files = [file("1.jpg"), file("2.jpg")];
    const running = deliver(d, files, blocks, LINK, (s) => said.push(s));
    expect(shared).toHaveLength(1);
    expect(shared[0].files).toEqual(files);
    expect(opened).toEqual([]);
    await running;
    expect(said).toEqual([sheetSentence(d, 2, true, true, "pc"), "Handed to the app you picked. Your text is copied too."]);
  });

  it.each(["Instagram", "Pinterest", "TikTok"] as const)("%s, a mouse, canShare no: opens the site, copies the text, says the card stays", async (d) => {
    canShare = false;
    const said: string[] = [];
    const running = deliver(d, [file("a.jpg")], blocks, LINK, (s) => said.push(s));
    expect(copied).toEqual(["Neon koi\n\nhttps://enki.gallery/generator/p1\n\n#aiart #flux"]);
    expect(opened).toHaveLength(1);
    await expect(running).resolves.toEqual({ byHand: false });
    expect(said).toEqual([deskSentence(d, 1, true, true)]);
    expect(shared).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("a set, a mouse, canShare no: its sentence counts them", async () => {
    canShare = false;
    const said: string[] = [];
    await deliver("Instagram", [file("1.jpg"), file("2.jpg"), file("3.jpg")], blocks, LINK, (s) => said.push(s));
    expect(said[0]).toBe(deskSentence("Instagram", 3, true, true));
  });

  it("on a touch device: the sheet with files and text inside the press, the text copied too", async () => {
    coarse = true;
    const said: string[] = [];
    const running = deliver("Instagram", [file("1.jpg"), file("2.jpg")], blocks, LINK, (s) => said.push(s));
    expect(shared).toHaveLength(1);
    expect(shared[0].files!.map((f) => f.name)).toEqual(["1.jpg", "2.jpg"]);
    expect(shared[0].text).toContain("Neon koi");
    expect(copied).toHaveLength(1);
    expect(opened).toEqual([]);
    await running;
    expect(said).toEqual([sheetSentence("Instagram", 2, true), "Handed to the app you picked. Your text is copied too."]);
  });

  it("the sheet on a desktop: for the sites without an address only; X and Threads keep to the coarse pointer", () => {
    for (const d of ["X", "Threads"] as const) {
      expect(sheetFits(d, [file("a.jpg")])).toBe(false);
      coarse = true;
      expect(sheetFits(d, [file("a.jpg")])).toBe(true);
      coarse = false;
    }
    for (const d of ["Instagram", "Pinterest", "TikTok"] as const) {
      expect(sheetFits(d, [file("a.jpg")])).toBe(true);
      canShare = false;
      expect(sheetFits(d, [file("a.jpg")])).toBe(false);
      canShare = true;
    }
  });

  it("a PNG is wanted only for what X and Threads paste, and not where their sheet fits", () => {
    expect(wantsPng(DEST.X, [file("a.jpg")])).toBe(true);
    expect(wantsPng(DEST.Threads, [file("a.jpg")])).toBe(true);
    expect(wantsPng(DEST.Pinterest, [file("a.jpg")])).toBe(false);
    expect(wantsPng(DEST.TikTok, [file("a.jpg")])).toBe(false);
    coarse = true;
    expect(wantsPng(DEST.X, [file("a.jpg")])).toBe(false);
    canShare = false;
    expect(wantsPng(DEST.X, [file("a.jpg")])).toBe(true);
  });

  it("a sheet put away shares nothing and says so", async () => {
    coarse = true;
    share = () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }));
    const said: string[] = [];
    await deliver("X", [file("a.jpg")], blocks, LINK, (s) => said.push(s));
    expect(said.at(-1)).toBe("Nothing was shared. Your text is copied.");
  });

  it("a sheet that fails says nothing was shared, and sends nobody to Save", async () => {
    coarse = true;
    share = () => Promise.reject(new Error("no"));
    const said: string[] = [];
    await deliver("X", [file("a.jpg")], blocks, LINK, (s) => said.push(s));
    expect(said.at(-1)).toBe("The share sheet failed, so nothing was shared. Press again to retry.");
  });

  it("a refused clipboard and a blocked tab are told as they are", async () => {
    canShare = false;
    writes = false;
    opens = false;
    const said: string[] = [];
    await expect(deliver("TikTok", [file("a.jpg")], blocks, LINK, (s) => said.push(s))).resolves.toEqual({ byHand: true });
    expect(said[0]).toBe(deskSentence("TikTok", 1, false, false));
    expect(said[0]).toContain("blocked");
    expect(said[0]).toContain("Copying your text failed");
  });

  it("a tab it opened cannot reach back", async () => {
    const tab: { opener: unknown } = { opener: "the page" };
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), open: () => tab });
    await deliver("X", [file("a.jpg")], blocks, LINK, () => {}, png);
    expect(tab.opener).toBeNull();
  });
});
