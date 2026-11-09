import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BAD_LINK, BAD_PALETTE, CONTENT_NAME_TAKEN, MAX_FILE_AT_ONCE, MAX_PROJECTS, MAX_SUBMENU_PROJECTS, NAME_NEEDED, PROJECT_NAME_TAKEN,
  STUDIO_TEXT, TOO_LONG,
} from "@/lib/studio/types";
import { submenuRows } from "../submenu";
import { OPEN_KEY, RECENT_KEY, byRecent, readOpen, readRecent, rememberRecent, writeOpen } from "../recent";
import { appendBlock, contextText, styleBlock } from "../compose";
import { fileKey, noteJobs, toFile } from "../filing";
import { createAt, createLink, sheetLink, withoutSheet } from "../links";
import { counter, detailsInput, detailsProblem, fieldOf, hostOf, paletteProblem, withScheme } from "../fields";
import { contentGoes, countsLine, plural, projectGoes } from "../copy";
import type { GenerationRow } from "@/lib/ui/image-view/history";

/**
 * Studio's rules for the UI (Kev, 2026-10-30: "help me build that as the super responsive and genius UX designer that
 * you are, in the style of enki"): the menu's submenu, this browser's picks, the brand words in Create's bar, renders
 * filed into the content piece they were started in, Create's address in a project, the dialogs' field rules.
 */
const P = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333";
const projects = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` }));
const kinds = (rows: ReturnType<typeof submenuRows>) => rows.map((r) => (r.kind === "project" ? r.id : r.kind === "all" ? `all·${r.count}` : "create"));

describe("the Studio submenu's rows (\"FALLS ich welche hab\")", () => {
  it("is Create project alone without projects, however little room", () => {
    expect(kinds(submenuRows([], 5, false))).toEqual(["create"]);
    expect(kinds(submenuRows([], 0, false))).toEqual(["create"]);
  });

  it("lists every project and Create project while they all fit, under the cap", () => {
    expect(MAX_SUBMENU_PROJECTS).toBe(4);
    expect(kinds(submenuRows(projects(2), 5, false))).toEqual(["p0", "p1", "create"]);
    expect(kinds(submenuRows(projects(4), 5, false))).toEqual(["p0", "p1", "p2", "p3", "create"]);
    // At the cap no Create project, so the projects need no last row.
    expect(kinds(submenuRows(projects(4), 4, true))).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("shows at most four, then All projects with how many there are", () => {
    expect(kinds(submenuRows(projects(5), 9, false))).toEqual(["p0", "p1", "p2", "p3", "all·5"]);
    expect(kinds(submenuRows(projects(MAX_PROJECTS), 9, true))).toEqual(["p0", "p1", "p2", "p3", `all·${MAX_PROJECTS}`]);
  });

  it("fits the room it has, a last row always: a short column ends on All projects, at least that one row", () => {
    expect(kinds(submenuRows(projects(3), 3, false))).toEqual(["p0", "p1", "all·3"]);
    expect(kinds(submenuRows(projects(2), 2, false))).toEqual(["p0", "all·2"]);
    expect(kinds(submenuRows(projects(2), 1, false))).toEqual(["all·2"]);
    expect(kinds(submenuRows(projects(2), 0, false))).toEqual(["all·2"]);
    expect(kinds(submenuRows(projects(5), 3, true))).toEqual(["p0", "p1", "all·5"]);
  });

  it("keeps each project's name for its row", () => {
    expect(submenuRows([{ id: "a", name: "Moonlight" }], 5, false)[0]).toEqual({ kind: "project", id: "a", name: "Moonlight" });
  });
});

describe("this browser's picks (open or closed, the projects opened last)", () => {
  const store = (init: Record<string, string> = {}) => {
    const data = { ...init };
    vi.stubGlobal("localStorage", { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } });
    return data;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the submenu open or closed, closed when nothing or nothing readable is kept", () => {
    const data = store();
    expect(readOpen()).toBe(false);
    writeOpen(true);
    expect([data[OPEN_KEY], readOpen()]).toEqual(["1", true]);
    writeOpen(false);
    expect([data[OPEN_KEY], readOpen()]).toEqual(["0", false]);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readOpen()).toBe(false);
    expect(() => writeOpen(true)).not.toThrow();
    expect(() => rememberRecent("x")).not.toThrow();
    expect(readRecent()).toEqual([]);
  });

  it("remembers the projects opened last first, each once, no more than an account can have", () => {
    const data = store();
    rememberRecent("a");
    rememberRecent("b");
    rememberRecent("a");
    expect(readRecent()).toEqual(["a", "b"]);
    for (let i = 0; i < MAX_PROJECTS + 3; i++) rememberRecent(`x${i}`);
    expect(readRecent()).toHaveLength(MAX_PROJECTS);
    expect(readRecent()[0]).toBe(`x${MAX_PROJECTS + 2}`);
    data[RECENT_KEY] = "{oops";
    expect(readRecent()).toEqual([]);
    data[RECENT_KEY] = JSON.stringify(["ok", 3, null]);
    expect(readRecent()).toEqual(["ok"]);
  });

  it("orders the projects opened last first, then the server's order (newest first)", () => {
    const list = [{ id: "n1" }, { id: "n2" }, { id: "n3" }, { id: "n4" }];
    expect(byRecent(list, ["n3", "gone", "n1"]).map((p) => p.id)).toEqual(["n3", "n1", "n2", "n4"]);
    expect(byRecent(list, []).map((p) => p.id)).toEqual(["n1", "n2", "n3", "n4"]);
  });
});

describe("a content piece's brand words in Create's bar (what is sent is what the bar shows)", () => {
  const style = { words: " warm film grain, soft daylight ", palette: ["#7d1d33", "#cba24a"] };
  const master = { prompt: "Moonlight's launch, editorial and calm. " };

  it("says a style as its words, then its colours", () => {
    expect(styleBlock(style)).toBe("warm film grain, soft daylight\nColour palette: #7d1d33, #cba24a");
    expect(styleBlock({ words: "", palette: ["#000000"] })).toBe("Colour palette: #000000");
    expect(styleBlock({ words: "matte", palette: [] })).toBe("matte");
  });

  it("opens an empty bar with the master prompt, a blank line, the style", () => {
    expect(contextText(master, style)).toBe("Moonlight's launch, editorial and calm.\n\nwarm film grain, soft daylight\nColour palette: #7d1d33, #cba24a");
    expect(contextText(null, style)).toBe(styleBlock(style));
    expect(contextText(master, null)).toBe("Moonlight's launch, editorial and calm.");
    expect(contextText(null, null)).toBe("");
  });

  it("adds a chip's block after the words with a blank line, the words kept as they are", () => {
    expect(appendBlock("a fox in snow", "matte")).toBe("a fox in snow\n\nmatte");
    expect(appendBlock("a fox in snow  \n", "matte")).toBe("a fox in snow\n\nmatte");
    expect(appendBlock("", "matte")).toBe("matte");
    expect(appendBlock("  ", "matte")).toBe("matte");
    expect(appendBlock("a fox", "  ")).toBe("a fox");
  });
});

describe("renders filed into the piece they were started in", () => {
  const row = (id: string, url: string, over: Partial<GenerationRow> = {}): GenerationRow =>
    ({ id, image_url: url, image_urls: [url], thumbnail_url: null, isUploaded: false, visibility: "private", prompt_id: null, created_at: "", ...over });
  const job = (id: string, status: "rendering" | "ready" | "failed" = "ready", imageUrl?: string) => ({ id, status, imageUrl: imageUrl ?? (status === "ready" ? `https://x/${id}.png` : undefined) });

  it("notes the jobs there at mount as none, each later one as the piece Create worked in when it first showed", () => {
    const at = noteJobs(null, [job("old1"), job("old2")], C);
    expect([...at]).toEqual([["old1", null], ["old2", null]]);
    noteJobs(at, [job("new1"), job("old1")], C);
    noteJobs(at, [job("new2"), job("new1")], null);
    noteJobs(at, [job("new1")], "other");
    expect(Object.fromEntries(at)).toEqual({ old1: null, old2: null, new1: C, new2: null });
  });

  it("files a finished job of a piece once its row is in, not one at mount, not one rendering or failed, not twice", () => {
    const at = noteJobs(null, [job("old")], C);
    noteJobs(at, [job("a"), job("b", "rendering"), job("c", "failed"), job("d"), job("e")], C);
    const rows = [row("r-old", "https://x/old.png"), row("r-a", "https://x/a.png"), row("r-e", "https://x/e.png", { isUploaded: true })];
    const jobs = [job("old"), job("a"), job("b", "rendering"), job("c", "failed"), job("d"), job("e")];
    expect(toFile(jobs, rows, at, new Set())).toEqual([{ content: C, imageIds: ["r-a"] }]);
    expect(toFile(jobs, rows, at, new Set([fileKey(C, "r-a")]))).toEqual([]);
    expect(fileKey(C, "r-a")).toBe(`${C}:r-a`);
  });

  it("files per piece, at most MAX_FILE_AT_ONCE ids a request", () => {
    expect(MAX_FILE_AT_ONCE).toBe(8);
    const ids = Array.from({ length: 10 }, (_, i) => `j${i}`);
    const at = noteJobs(null, [], null);
    noteJobs(at, ids.map((id) => job(id)), C);
    noteJobs(at, [job("k")], S);
    const rows = [...ids, "k"].map((id) => row(`r-${id}`, `https://x/${id}.png`));
    const out = toFile([...ids, "k"].map((id) => job(id)), rows, at, new Set());
    expect(out.map((b) => [b.content, b.imageIds.length])).toEqual([[C, 8], [C, 2], [S, 1]]);
  });
});

describe("Create's address in a project", () => {
  const at = (q: string) => createAt(new URLSearchParams(q));
  it("names the project, piece and sheet Create works in, each only as an id", () => {
    expect(at(`create=image&project=${P}&content=${C}&sheet=${S}`)).toEqual({ project: P, content: C, sheet: S });
    expect(at(`create=video&project=${P}`)).toEqual({ project: P, content: null, sheet: null });
    expect(at(`create=image&project=${P}&content=nope&sheet=x`)).toEqual({ project: P, content: null, sheet: null });
    expect([at(`create=image&project=nope&content=${C}`), at("create=image")]).toEqual([null, null]);
  });

  it("is none under a panel, whose address names its own place", () => {
    expect(at(`create=image&panel=studio&project=${P}&content=${C}`)).toBeNull();
    expect(at(`create=image&project=${P}&panel=inbox`)).toBeNull();
  });

  it("keeps the project and piece through Image | Video | Remix; the sheet's link names its image view too", () => {
    expect(createLink("video", { project: P, content: C })).toBe(`/home?create=video&project=${P}&content=${C}`);
    expect(createLink("remix", { project: P, content: null })).toBe(`/home?create=remix&project=${P}`);
    expect(createLink("image", null)).toBe("/home?create=image");
    expect(sheetLink(P, S)).toBe(`/home?create=image&project=${P}&sheet=${S}&prompt=${S}`);
    expect(withoutSheet(`http://enki.test${sheetLink(P, S)}#x`)).toBe(`/home?create=image&project=${P}#x`);
  });
});

describe("the dialogs' fields, as the server holds them", () => {
  const v = (name: string, description = "", link = "") => ({ name, description, link });
  it("give a bare domain https:// and leave the rest as typed", () => {
    expect(withScheme(" enki.art ")).toBe("https://enki.art");
    expect(withScheme("shop.enki.art/drop?x=1")).toBe("https://shop.enki.art/drop?x=1");
    expect(withScheme("http://enki.art")).toBe("http://enki.art");
    expect(withScheme("ftp://enki.art")).toBe("ftp://enki.art");
    expect(withScheme("not a link")).toBe("not a link");
    expect(withScheme("")).toBe("");
  });

  it("refuse what the server would, with its sentence, under the field it concerns", () => {
    expect(detailsProblem(v("  "))).toEqual({ field: "name", message: NAME_NEEDED });
    expect(detailsProblem(v("x".repeat(STUDIO_TEXT.name + 1)))).toEqual({ field: "name", message: TOO_LONG.name });
    expect(detailsProblem(v(` ${"x".repeat(STUDIO_TEXT.name)} `))).toBeNull();
    expect(detailsProblem(v("Moonlight", "d".repeat(STUDIO_TEXT.description + 1)))).toEqual({ field: "description", message: TOO_LONG.description });
    expect(detailsProblem(v("Moonlight", "", "ftp://enki.art"))).toEqual({ field: "link", message: BAD_LINK });
    expect(detailsProblem(v("Moonlight", "", "not a link"))).toEqual({ field: "link", message: BAD_LINK });
    expect(detailsProblem(v("Moonlight", "", `https://${"a".repeat(STUDIO_TEXT.link)}.art`))).toEqual({ field: "link", message: TOO_LONG.link });
    expect(detailsProblem(v("Moonlight", "", "enki.art"))).toBeNull();
  });

  it("send them trimmed, an empty optional one as null", () => {
    expect(detailsInput(v(" Moonlight ", "  ", " enki.art "))).toEqual({ name: "Moonlight", description: null, link: "https://enki.art" });
    expect(detailsInput(v("M", " calm ", ""))).toEqual({ name: "M", description: "calm", link: null });
  });

  it("show a server's sentence under its field, else nowhere (a toast says it)", () => {
    expect([PROJECT_NAME_TAKEN, CONTENT_NAME_TAKEN, NAME_NEEDED, TOO_LONG.name].map(fieldOf)).toEqual(["name", "name", "name", "name"]);
    expect([TOO_LONG.description, BAD_LINK, TOO_LONG.link, "Studio is not available yet."].map(fieldOf)).toEqual(["description", "link", "link", null]);
  });

  it("count near the end only, check a palette as the server keeps it, and show a link by its host", () => {
    expect([counter("x".repeat(49), 60, 50), counter("x".repeat(50), 60, 50)]).toEqual([null, "50 / 60"]);
    expect(paletteProblem(["#7d1d33", "#CBA24A"])).toBeNull();
    expect(paletteProblem(["#7d1d3"])).toBe(BAD_PALETTE);
    expect(paletteProblem(Array(7).fill("#000000"))).toBe(BAD_PALETTE);
    expect(paletteProblem(Array(6).fill("#000000"))).toBeNull();
    expect([hostOf("https://www.enki.art/x"), hostOf("http://shop.enki.art"), hostOf("nope")]).toEqual(["enki.art", "shop.enki.art", "nope"]);
  });
});

describe("Studio's sentences", () => {
  it("count a folder's contents, assets and characters", () => {
    expect(countsLine({ counts: { contents: 3, assets: 12, characters: 1 } })).toBe("3 contents · 12 assets · 1 character");
    expect([plural(0, "image"), plural(1, "image"), plural(2, "image")]).toEqual(["0 images", "1 image", "2 images"]);
  });

  it("say what a project's delete takes, and that the renders stay", () => {
    const d = (a: number, c: number, s: number, m: number, k: number) => ({
      assets: Array(a), characters: Array(c), styles: Array(s), masterPrompts: Array(m), contents: Array(k),
    }) as unknown as Parameters<typeof projectGoes>[0];
    expect(projectGoes(d(12, 3, 2, 1, 5))).toBe("Its 12 assets, 3 characters, 2 styles, 1 master prompt and 5 content pieces go with it. Your renders stay in your gallery.");
    expect(projectGoes(d(1, 0, 0, 0, 0))).toBe("Its 1 asset goes with it. Your renders stay in your gallery.");
    expect(projectGoes(d(0, 0, 0, 0, 0))).toBe("Your renders stay in your gallery.");
    expect([contentGoes(8), contentGoes(1), contentGoes(0)]).toEqual(["Its 8 images stay in your gallery.", "Its image stays in your gallery.", "Your renders stay in your gallery."]);
  });
});
