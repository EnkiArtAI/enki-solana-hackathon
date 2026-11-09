import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";
import type { GenerationRow } from "@/lib/ui/image-view/history";
import { pastImages } from "@/lib/ui/image-view/history";

/**
 * Where a reference photo comes from (Kev, 2026-10-21): a dropdown at the
 * button that asked, with the tabs Images (an upload, an image used or
 * uploaded before), Characters (no store for them yet) and NFTs.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], s: 0, refs: [] as { current: unknown }[], r: 0, effects: [] as (() => (() => void) | void)[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
  useRef: <T>(start: T) => {
    const i = ui.r++;
    ui.refs[i] ??= { current: start };
    return ui.refs[i];
  },
  useLayoutEffect: () => {},
  useEffect: (run: () => (() => void) | void) => { ui.effects.push(run); },
}));
vi.mock("react-dom", async (original) => ({ ...(await original<typeof import("react-dom")>()), createPortal: (node: ReactNode) => node }));
vi.mock("@/components/enki/NftGrid", () => ({ default: () => null }));
vi.mock("@/components/kit/BottomSheet", () => ({ default: () => null }));
vi.mock("@/components/kit/Segmented", () => ({ default: () => null }));

import RefPicker from "@/components/image-view/RefPicker";
import NftGrid from "@/components/enki/NftGrid";
import BottomSheet from "@/components/kit/BottomSheet";
import Segmented from "@/components/kit/Segmented";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const of = (tree: ReactNode, type: unknown) => [...walk(tree)].filter((el) => el.type === type);
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => el.props.className === name);
const press = (el: El) => (el.props.onClick as () => void)();

let m: ImageViewModel;
const onUpload = vi.fn(), onClose = vi.fn();
const anchor = { left: 10, top: 20, bottom: 54 } as DOMRect;
const show = (o: { phone?: boolean; at?: number; uploads?: boolean } = {}) => {
  ui.s = 0; ui.r = 0;
  return RefPicker({ model: m, anchor, phone: !!o.phone, at: o.at, onUpload, onClose, uploads: o.uploads }) as El;
};

beforeEach(() => {
  ui.state = []; ui.refs = []; ui.effects = []; onUpload.mockClear(); onClose.mockClear();
  // The popover portals to document.body.
  vi.stubGlobal("document", { body: {} });
  m = { room: 3, myImages: [{ url: "https://s/a.png", src: "https://s/a.png" }, { url: "https://s/b.webp", src: "https://s/b-thumb.webp" }], addUrls: vi.fn(), addNfts: vi.fn(),
    uploads: [], library: [], deletedRefs: [], refs: [], toggleRef: vi.fn() } as unknown as ImageViewModel;
});
afterEach(() => vi.unstubAllGlobals());

describe("the reference picker", () => {
  // Kev, 2026-10-30: "bei videos, instead of images, mach da Uploads, and also show videos there".
  it("is Uploads | Characters | NFTs for Create > Video, its clips playing as clips, its Upload open while pictures are full", () => {
    m = { ...m, room: 0, myImages: [], uploads: [{ id: "c1", src: "blob:1", kind: "clip" }, { id: "p1", src: "data:p", kind: "image" }] } as unknown as ImageViewModel;
    const tree = show({ uploads: true });
    expect((of(tree, Segmented)[0].props.options as { label: string }[]).map((o) => o.label)).toEqual(["Uploads", "Characters", "NFTs"]);
    const [clip, pic] = byClass(tree, "iv-rp-item");
    expect(of(clip, "video")[0].props).toMatchObject({ src: "blob:1", muted: true, loop: true, playsInline: true, autoPlay: true });
    expect([of(clip, "img").length, of(pic, "img")[0].props.src, of(pic, "video").length]).toEqual([0, "data:p", 0]);
    // Pictures are full; clips count apart, so a clip and Upload stay open, a picture does not.
    expect([clip.props.disabled, pic.props.disabled, byClass(tree, "iv-rp-upload")[0].props.disabled]).toEqual([false, true, false]);
    expect(clip.props.title).toBe("Use this clip");
    press(clip);
    expect(m.toggleRef).toHaveBeenCalledWith("c1", undefined);
    m = { ...m, uploads: [] } as unknown as ImageViewModel;
    expect(byClass(show({ uploads: true }), "iv-rp-note").map((el) => el.props.children)).toContain("The pictures and clips you upload show up here.");
    // The image view keeps Images, and its Upload closes when full.
    const own = show();
    expect((of(own, Segmented)[0].props.options as { label: string }[])[0].label).toBe("Images");
    expect(byClass(own, "iv-rp-upload")[0].props.disabled).toBe(true);
  });

  it("offers Images, Characters and NFTs, Images first", () => {
    const tabs = of(show(), Segmented)[0];
    expect(tabs.props.role).toBe("tablist");
    expect((tabs.props.options as { label: string }[]).map((o) => o.label)).toEqual(["Images", "Characters", "NFTs"]);
    expect(tabs.props.value).toBe("images");
  });

  // DEC-506 (Kev, 2026-10-29: "uploaded images must first be shown there ... and I can select them ... coloured border,
  // and only then do they appear in the prompt window. But auto-select the ones I upload").
  it("uploads from the device and stays open, and switches an earlier image in and out at Expert's cursor", () => {
    const tree = show({ at: 7 });
    press(byClass(tree, "iv-rp-upload")[0]);
    expect([onUpload.mock.calls.length, onClose.mock.calls.length]).toEqual([1, 0]);
    const items = byClass(tree, "iv-rp-item");
    // Each shows its thumbnail and switches the image itself.
    expect(items.map((i) => [...walk(i)].find((el) => el.type === "img")!.props.src)).toEqual(["https://s/a.png", "https://s/b-thumb.webp"]);
    press(items[1]);
    expect(m.toggleRef).toHaveBeenCalledWith("https://s/b.webp", 7);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows this visit's uploads first, selected with the photo ring while they are in the prompt, and a selected tile stays a switch when full", () => {
    m.uploads = [{ id: "u1", src: "data:u1" }, { id: "u2", src: "data:u2" }];
    m.refs = [{ id: "u2", src: "data:u2" }, { id: "https://s/a.png", src: "data:a" }];
    m.room = 0;
    const items = byClass(show(), "iv-rp-item");
    expect(items.map((i) => [i.key, i.props["data-on"], i.props["aria-pressed"], i.props.disabled])).toEqual([
      ["u1", undefined, false, true], ["u2", true, true, false], ["https://s/a.png", true, true, false], ["https://s/b.webp", undefined, false, true]]);
    press(items[1]);
    expect(m.toggleRef).toHaveBeenCalledWith("u2", undefined);
    const CSS = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
    expect(CSS).toContain(".iv-rp-item[data-on],\n.iv-rp-item[data-on]:hover:not(:disabled) { box-shadow: 0 0 0 2px var(--enki-photo-ring); }");
  });

  it("offers + Add character where there is no character yet, which uploads a picture on the Images tab", () => {
    ui.state[0] = "characters";
    const add = byClass(show(), "iv-rp-upload");
    expect(add.map((b) => [...walk(b)].map((el) => el.props.children).flat().filter((c) => typeof c === "string"))).toEqual([["Add character", "+"]]);
    press(add[0]);
    expect([ui.state[0], onUpload.mock.calls.length, onClose.mock.calls.length]).toEqual(["images", 1, 0]);
  });

  it("says where the earlier images come from while there are none", () => {
    m.myImages = [];
    expect(byClass(show(), "iv-rp-note")).toHaveLength(1);
    m.myImages = [{ url: "https://s/a.png", src: "https://s/a.png" }];
    expect(byClass(show(), "iv-rp-note")).toHaveLength(0);
  });

  it("shows the characters' place, and the wallets' NFTs with the room left", () => {
    ui.state[0] = "characters";
    expect(byClass(show(), "iv-rp-note").length).toBe(1);
    expect(of(show(), NftGrid)).toHaveLength(0);
    ui.state[0] = "nfts";
    const grid = of(show({ at: 7 }), NftGrid)[0];
    expect([grid.props.max, grid.props.onDone]).toEqual([3, onClose]);
    // At Expert's cursor, as an upload or an earlier image goes.
    const picks = [{ image: "i", thumb: "t" }];
    (grid.props.onPick as (p: unknown) => void)(picks);
    expect(m.addNfts).toHaveBeenCalledWith(picks, 7);
  });

  it("takes nothing more once every place is filled, and says so", () => {
    m.room = 0;
    const tree = show();
    expect([...byClass(tree, "iv-rp-upload"), ...byClass(tree, "iv-rp-item")].every((b) => b.props.disabled)).toBe(true);
    expect(byClass(tree, "iv-rp-note").map((n) => n.props.children)).toContain("Every photo place this generator takes is filled.");
  });

  it("is a bottom sheet on a phone, a dialog popover beside the button on desktop", () => {
    const sheet = of(show({ phone: true }), BottomSheet)[0];
    expect([sheet.props.title, sheet.props.onClose]).toEqual(["Add a reference", onClose]);
    const pop = show();
    expect(pop.props.className).toBe("iv-rp kit-focus");
    expect(pop.props.role).toBe("dialog");
  });

  it("takes the focus once it stands in place, and gives it back to what asked when it closes on it", () => {
    const trigger = { focus: vi.fn() }, first = { focus: vi.fn() };
    const doc: { body: object; activeElement: unknown } = { body: {}, activeElement: trigger };
    vi.stubGlobal("document", doc);
    ui.refs[0] = { current: { contains: () => false, querySelector: (q: string) => (q === "button:not(:disabled)" ? first : null) } };
    show();
    ui.effects[0]();
    // Still hidden while it is placed: nothing to focus yet.
    expect(first.focus).not.toHaveBeenCalled();
    ui.state[1] = { left: 1, top: 2, maxHeight: 300 };
    ui.effects = [];
    show();
    ui.effects[0]();
    expect(first.focus).toHaveBeenCalledWith({ preventScroll: true });
    const closed = ui.effects[1]() as () => void;
    // Closed by a click into another field: the focus stays there.
    doc.activeElement = { focus: vi.fn() };
    closed();
    expect(trigger.focus).not.toHaveBeenCalled();
    // A pick unmounted what had the focus.
    doc.activeElement = doc.body;
    closed();
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("closes on a click outside it, Esc, a scroll outside it or a resize", () => {
    const on: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal("window", { addEventListener: (t: string, l: (e: unknown) => void) => { on[t] = l; }, removeEventListener: vi.fn() });
    let frame: (() => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => { frame = f; return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const inside = {};
    // The popover's panel: a click on what it holds keeps it open.
    ui.refs[0] = { current: { contains: (t: unknown) => t === inside } };
    show();
    ui.effects.at(-1)!();
    // The scroll its opening caused comes before the next frame: nothing listens to it yet.
    expect(on.scroll).toBeUndefined();
    frame!();
    on.pointerdown({ target: inside });
    expect(onClose).not.toHaveBeenCalled();
    on.pointerdown({ target: {} });
    expect(onClose).toHaveBeenCalledOnce();
    const stop = vi.fn();
    on.keydown({ key: "Escape", stopPropagation: stop });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalled();
    on.keydown({ key: "ArrowLeft", stopPropagation: stop });
    expect(onClose).toHaveBeenCalledTimes(2);
    // Its own list scrolling is reading it; the column under it moving is not.
    on.scroll({ target: inside });
    expect(onClose).toHaveBeenCalledTimes(2);
    on.scroll({ target: {} });
    expect(onClose).toHaveBeenCalledTimes(3);
    on.resize({});
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});

describe("the picker's styles", () => {
  // A wallet of 60 NFTs scrolls the whole popover: the count and "Use N" stay at its foot, as in the modal.
  it("keep the NFTs' foot at the bottom of the popover or the sheet", () => {
    const CSS = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
    expect(CSS).toContain(".iv-rp-body .enki-nftp-foot { position: sticky; bottom: 0; background: var(--enki-paper); }");
    expect(CSS).toContain(".iv-rp .enki-nftp-foot { bottom: -12px; }");
  });
});

describe("the images used before", () => {
  const row = (over: Partial<GenerationRow>) => ({ id: "r", image_url: null, image_urls: [], thumbnail_url: null, isUploaded: false, visibility: "private", prompt_id: "p", created_at: "", ...over }) as GenerationRow;

  it("are every row's references and uploads, newest first, each once, at most the cap", () => {
    const rows = [
      row({ settings: { modelId: null, aspectRatio: null, resolution: null, boost: false, references: ["a", "b"] } }),
      row({ isUploaded: true, image_url: "up" }),
      row({ settings: { modelId: null, aspectRatio: null, resolution: null, boost: false, references: ["b", "c"] } }),
      row({ isUploaded: false, image_url: "render" }),
    ];
    const urls = (list: { url: string }[]) => list.map((p) => p.url);
    expect(urls(pastImages(rows))).toEqual(["a", "b", "up", "c"]);
    expect(urls(pastImages(rows, 2))).toEqual(["a", "b"]);
  });

  it("show an upload by its thumbnail and read it from its preview, never the stored original", () => {
    const up = row({ isUploaded: true, image_url: "original.png", image_urls: ["preview.webp"], thumbnail_url: "thumb.webp" });
    expect(pastImages([up])).toEqual([{ url: "preview.webp", src: "thumb.webp" }]);
    // Without derivatives: the original, both ways.
    expect(pastImages([row({ isUploaded: true, image_url: "original.png" })])).toEqual([{ url: "original.png", src: "original.png" }]);
    expect(pastImages([row({ settings: { modelId: null, aspectRatio: null, resolution: null, boost: false, references: ["r"] } })])).toEqual([{ url: "r", src: "r" }]);
    // The upload, later sent as a reference by its preview: the newest row's thumbnail stays.
    const sent = row({ settings: { modelId: null, aspectRatio: null, resolution: null, boost: false, references: ["preview.webp"] } });
    expect(pastImages([up, sent])).toEqual([{ url: "preview.webp", src: "thumb.webp" }]);
  });

  it("travel as every reference does, read into data and pending from the pick on, a new place's reference at the cursor", () => {
    const MODEL = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"), "utf8");
    const add = MODEL.slice(MODEL.indexOf("    addUrls: (urls: string[], at?: number) => {"), MODEL.indexOf("    myImages: pastImages(own.rows),"));
    expect(add).toContain("growText(refs.length + reads.pending.length + take.length, at);");
    // The read takes the address: nothing is fetched before it counts as pending (Generate waits).
    expect(add).toContain("const src = await reads.read(url);");
    expect(add).not.toContain("fetch(");
    expect(MODEL).toContain("    addNfts: (picks: NftPick[], at?: number) => {\n      growText(refs.length + reads.pending.length + picks.length, at);");
  });

  // DEC-506: an upload is one reference in two lists (the picker's and the prompt's), an earlier image goes by its address.
  it("land an upload in the picker selected, and switch a tile in or out by its key", () => {
    const MODEL = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"), "utf8");
    expect(MODEL).toContain("        const ref = { id: crypto.randomUUID(), src };\n        setUploads((u) => [...u, ref]);\n        setRefs((r) => [...r, ref]);");
    expect(MODEL).toContain("        if (src) setRefs((r) => [...r, { id: url, src }]);");
    expect(MODEL).toContain(`    toggleRef: (key: string, at?: number) => {
      const i = refs.findIndex((r) => r.id === key);
      if (i >= 0) return model.removeSlot(i);
      if (slots.room <= 0) return;
      const up = uploads.find((u) => u.id === key);
      // A second press while its download still runs adds nothing (it would land twice).
      if (!up) return reads.pending.some((p) => p.startsWith(\`\${key}#read-\`)) ? undefined : model.addUrls([key], at);
      growText(refs.length + reads.pending.length + 1, at);
      setRefs((r) => [...r, up]);
    },`);
  });

  // Review 2026-10-29 (wf_b25acc74-abe): ids that changed under the tiles, a double press, Replace, a stale caret.
  it("keep a picture's id through Regenerate and a recorded render's load, take Replace as an upload, and drop Expert's caret when the words move", () => {
    const MODEL = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"), "utf8");
    expect(MODEL).toContain("setRefs(job.refs.map((src) => ({ id: [...refs, ...uploads].find((r) => r.src === src)?.id ?? crypto.randomUUID(), src })));");
    expect(MODEL).toContain("if (refLoad.current === n) setRefs(data.flatMap((src, i) => (src ? [{ id: urls[i], src }] : [])));");
    expect(MODEL).toContain("        const ref = { id: crypto.randomUUID(), src };\n        setUploads((u) => [...u, ref]);\n        setRefs((r) => r.map((x, j) => (j === i ? ref : x)));");
    // The pending read's preview is the address plus "#read-n" (useReferenceReads).
    expect(readFileSync(join(__dirname, "..", "..", "..", "..", "hooks", "useReferenceReads.ts"), "utf8")).toContain("#read-${++remoteReads}");
    const COMPOSER = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "Composer.tsx"), "utf8");
    expect(COMPOSER).toContain("  useEffect(() => setCaret(null), [m.text]);");
  });
});
