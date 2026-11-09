import { beforeEach, describe, expect, it, vi } from "vitest";
import { sampleContent } from "../content";
import { cardsFor } from "../templates";
import type { CardStyle, El, ShareStyle } from "../doc";

/** The page's side of a saved style: what a popup opens with, whatever the two routes answer, and what Done sends. Fetch is stubbed; the routes have their own test. */
const REF = "6f9d2c1e-3b4a-4c5d-8e7f-0a1b2c3d4e5f";
const bk = [{ key: "title", on: true }];
const title: El = { id: 1, k: "title", x: 6, y: 4, w: 88, h: 10, rot: 0, font: "Lora", color: "#111111", align: "left" };
const up: El = { id: 2, k: "up", x: 20, y: 20, w: 60, h: 40, rot: 0, ref: REF };
const card = (ratio: string, els: El[] = [title]) => ({ ratio, bg: { mode: "solid", c: "#ffffff" }, els, bk } as unknown as CardStyle);

type Answer = { status?: number; body?: unknown } | "offline";
let routes: Record<string, Answer>;
let calls: { url: string; init?: RequestInit }[];

beforeEach(() => {
  vi.resetModules();
  routes = {};
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = routes[`${init?.method ?? "GET"} ${url}`] ?? routes[url];
    if (!a || a === "offline") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
  });
});
const store = () => import("../after-release");
const STYLE = "/api/users/share-style", REFS = "/api/references";

describe("loadStyle", () => {
  it("before SQL 71 and nothing kept: nothing, no read of the references", async () => {
    routes[STYLE] = { body: { style: null, run: "71-share-style.sql" } };
    const { loadStyle } = await store();
    expect(await loadStyle("mira")).toEqual({});
    expect(calls.map((c) => c.url)).toEqual([STYLE]);
  });

  it("the account's style, read with a time limit", async () => {
    routes[STYLE] = { body: { style: { image: card("4:5") } } };
    const { loadStyle, yourStyle } = await store();
    expect(await loadStyle("mira")).toEqual({ image: card("4:5") });
    expect(yourStyle()).toEqual({ image: card("4:5") });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each<[string, Answer]>([["offline", "offline"], ["a 500", { status: 500 }], ["a 500 with a style in it", { status: 500, body: { style: { image: card("4:5") } } }], ["an answer that does not hold", { body: { style: { image: { ratio: "words" } } } }]])("%s: the templates alone, and no rejection", async (_n, a) => {
    routes[STYLE] = a;
    const { loadStyle } = await store();
    await expect(loadStyle("mira")).resolves.toEqual({});
  });

  it("what this tab kept stands over the account's, part by part", async () => {
    routes[STYLE] = { body: { style: { image: card("4:5"), video: card("9:16") } } };
    const { keepStyle, loadStyle } = await store();
    await loadStyle("mira");
    keepStyle({ image: card("1:1") });
    expect(await loadStyle("mira")).toEqual({ image: card("1:1"), video: card("9:16") });
  });

  it("a part only the account has joins what this tab kept", async () => {
    routes[STYLE] = { body: { style: null } };
    const { keepStyle, loadStyle } = await store();
    await loadStyle("mira");
    keepStyle({ image: card("1:1") });
    routes[STYLE] = { body: { style: { video: card("9:16") } } };
    expect(await loadStyle("mira")).toEqual({ image: card("1:1"), video: card("9:16") });
  });

  it("this tab's style survives a read that fails", async () => {
    routes[STYLE] = { body: { style: null } };
    const { keepStyle, loadStyle } = await store();
    await loadStyle("mira");
    keepStyle({ image: card("1:1") });
    routes[STYLE] = "offline";
    expect(await loadStyle("mira")).toEqual({ image: card("1:1") });
  });

  it("another account in this tab starts empty", async () => {
    routes[STYLE] = { body: { style: null } };
    const { keepStyle, loadStyle, firstMiss } = await store();
    await loadStyle("mira");
    keepStyle({ image: card("1:1") });
    expect(firstMiss()).toBe(true);
    expect(firstMiss()).toBe(false);
    expect(await loadStyle("other")).toEqual({});
    expect(firstMiss()).toBe(true);
  });

  it("a picture at the address it has now; a deleted one has none", async () => {
    routes[STYLE] = { body: { style: { image: card("4:5", [title, up]) } } };
    routes[REFS] = { body: { references: [{ id: REF, url: "https://signed.test/now" }] } };
    const { loadStyle } = await store();
    expect((await loadStyle("mira")).image!.els[1].src).toBe("https://signed.test/now");
    routes[REFS] = { body: { references: [] } };
    expect((await loadStyle("mira")).image!.els[1].src).toBeUndefined();
  });

  it("the references cannot be read: templates only, this time, and the style is still held", async () => {
    routes[STYLE] = { body: { style: { image: card("4:5", [title, up]) } } };
    routes[REFS] = { status: 503 };
    const { loadStyle, yourStyle } = await store();
    expect(await loadStyle("mira")).toEqual({});
    expect(yourStyle().image!.els).toHaveLength(2);
  });
});

describe("saveStyle", () => {
  const part = (): ShareStyle => ({ image: card("4:5", [title, { ...up, src: "https://signed.test/now" }]) });

  it("PUTs the part with its reference, not its address", async () => {
    routes[`PUT ${STYLE}`] = { body: { ok: true } };
    const { saveStyle } = await store();
    expect(await saveStyle(part())).toBe(true);
    const sent = calls[0];
    expect(sent.init?.method).toBe("PUT");
    expect(JSON.parse(String(sent.init?.body)).image.els[1]).toEqual(up);
    expect(sent.init?.keepalive).toBe(true);
    expect(new Headers(sent.init?.headers).get("Content-Type")).toBe("application/json");
  });

  it.each<[string, Answer]>([["before SQL 71", { status: 503, body: { run: "71-share-style.sql" } }], ["refused", { status: 400 }], ["offline", "offline"]])("%s: not saved, and it says so by false", async (_n, a) => {
    routes[`PUT ${STYLE}`] = a;
    const { saveStyle } = await store();
    await expect(saveStyle(part())).resolves.toBe(false);
  });
});

describe("offerStyleEditor", () => {
  it("offers the editor alone", async () => {
    const { dismissShare, offerStyleEditor, shareOffer } = await store();
    offerStyleEditor();
    expect(shareOffer()).toEqual({ promptId: "", values: [], styleOnly: true });
    dismissShare();
    expect(shareOffer()).toBeNull();
  });

  it("a release's offer is not style only", async () => {
    const { offerShare, shareOffer } = await store();
    offerShare("p1", []);
    expect(shareOffer()?.styleOnly).toBeUndefined();
  });
});

describe("sampleContent", () => {
  const T = { paper: "#ffffff", alt: "#f6f5f4", ink: "#111111", ink2: "#3d3c3a", ga: "#7d1d33", gb: "#c58f9c", on: "#ffffff" };

  it("says it is one, and is shaped as a premium image prompt: no words, a set can be laid out", () => {
    const c = sampleContent("mira", "https://enki.test");
    expect(c.sample).toBe(true);
    expect(c.words).toBeNull();
    expect(c.media).toBe("image");
    expect(c.images).toHaveLength(4);
    expect(c.setups).toHaveLength(4);
    expect(c.setups[0]).toEqual(c.variables);
    expect(c.variables.every((v) => v.example)).toBe(true);
  });

  it("the creator's handle, none when there is none, and an address on this site", () => {
    expect(sampleContent("mira", "https://enki.test").handle).toBe("mira");
    expect(sampleContent(null, "https://enki.test").handle).toBeNull();
    expect(sampleContent("mira", "https://enki.test").link).toBe("https://enki.test/generator/your-prompt");
  });

  it("its images are pictures on the page, no request to anywhere", () => {
    for (const im of sampleContent("mira", "https://enki.test").images) {
      expect(im.src).toMatch(/^data:image\/svg\+xml,/);
      expect(im.full).toBe(im.src);
    }
  });

  it("every template holds it: all four cards, each element that has content", () => {
    const cards = cardsFor(T, sampleContent("mira", "https://enki.test"));
    expect(cards).toHaveLength(4);
    expect(cards[3].els.map((e) => e.k).sort()).toEqual(["desc", "handle", "results", "title"]);
  });
});
