import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "./_read-source";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";

/**
 * Saved references in the image UI's picker (Kev, 2026-10-29: "the images uploaded via ref image uploading must remain
 * in that image upload UI until i delete them, this must be the database of uploaded referenced images"): an upload is
 * saved to the account in the background, the Images tab lists the saved ones after this visit's unsaved uploads, each
 * with its ×, then the earlier renders' references that are no saved or deleted picture. A guest saves nothing. The
 * components and the hook are called with their state set, as React would render them.
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, refs: [] as { current: unknown }[], r: 0,
  query: { data: undefined as unknown },
  options: null as null | { queryKey: unknown; queryFn: () => Promise<unknown>; enabled: boolean; staleTime: number; refetchInterval: number },
  cache: undefined as unknown,
}));
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
  useEffect: () => {},
}));
const spies = vi.hoisted(() => ({ invalidate: vi.fn(async (_o: unknown) => {}), notify: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: NonNullable<typeof ui.options>) => { ui.options = o; return ui.query; },
  useQueryClient: () => ({
    invalidateQueries: spies.invalidate,
    setQueryData: (_key: unknown, next: (old: unknown) => unknown) => { ui.cache = next(ui.cache); },
  }),
}));
vi.mock("@/components/kit/notify", () => ({ notify: spies.notify }));
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "t" }) }));
vi.mock("react-dom", async (original) => ({ ...(await original<typeof import("react-dom")>()), createPortal: (node: ReactNode) => node }));
vi.mock("@/components/enki/NftGrid", () => ({ default: () => null }));
vi.mock("@/components/kit/BottomSheet", () => ({ default: () => null }));
vi.mock("@/components/kit/Segmented", () => ({ default: () => null }));

import { REFERENCES_FRESH, REFERENCES_KEY, storedHash, useReferenceLibrary, type SavedReference } from "@/hooks/useReferenceLibrary";
import { REFERENCE_SIGN_TTL } from "@/lib/reference-library";
import RefPicker from "@/components/image-view/RefPicker";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => String(el.props.className ?? "").split(" ").includes(name));
const press = (el: El) => (el.props.onClick as () => void)();
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const ROOT = join(__dirname, "..", "..");

let calls: [string, { method?: string; headers?: Record<string, string>; body?: string } | undefined][];
let answer: { status: number; body: unknown } | "offline" | "not json";
beforeEach(() => {
  ui.state = []; ui.refs = []; ui.query = { data: undefined }; ui.options = null; ui.cache = undefined;
  spies.invalidate.mockClear(); spies.notify.mockClear();
  calls = []; answer = { status: 200, body: {} };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push([url, init]);
    if (answer === "offline") throw new TypeError("network");
    const a = answer;
    // "not json": a 200 whose body is no JSON (a page in its place).
    return { ok: a === "not json" || a.status < 300, status: a === "not json" ? 200 : a.status, json: async () => { if (a === "not json") throw new SyntaxError("html"); return a.body; } };
  }));
});
afterEach(() => vi.unstubAllGlobals());

const H = (c: string) => c.repeat(64);
const A: SavedReference = { id: "a1", url: "https://db/sign/a.webp?token=1", src: "https://db/sign/a.tile.webp?token=1", hash: H("a") };
const B: SavedReference = { id: "b1", url: "https://db/sign/b.webp?token=1", src: "https://db/sign/b.webp?token=1", hash: H("b") };
const RELOAD = [[{ queryKey: ["references"] }]];
// A render's stored copy of a picture (lib/generation/reference-images).
const RENDERED = (hash: string) => `https://store.public.blob.vercel-storage.com/references/0b5f2c1e-1111-4222-8333-444455556666/${hash}.webp`;

describe("the account's saved references", () => {
  it("are read from GET /api/references with the session, anew before their addresses lapse; a guest reads none and saves none", async () => {
    let lib = useReferenceLibrary(false);
    expect([ui.options!.queryKey, ui.options!.enabled, lib.saved, lib.deleted]).toEqual([["references"], false, [], []]);
    expect(await lib.save("data:image/webp;base64,AA")).toBeNull();
    expect(calls).toEqual([]);
    lib = useReferenceLibrary(true);
    expect([ui.options!.queryKey, ui.options!.enabled]).toEqual([REFERENCES_KEY, true]);
    // The app's queries never go stale (providers/index.tsx): this one does, at half the hour its addresses are signed for.
    expect([ui.options!.staleTime, ui.options!.refetchInterval]).toEqual([REFERENCES_FRESH, REFERENCES_FRESH]);
    expect(REFERENCES_FRESH * 2).toBe(REFERENCE_SIGN_TTL * 1000);
    answer = { status: 200, body: { references: [{ id: "a1", url: A.url, thumb: A.src, hash: A.hash }], deleted: [H("d")] } };
    expect(await ui.options!.queryFn()).toEqual({ saved: [A], deleted: [H("d")] });
    expect(calls).toEqual([["/api/references", { headers: { "X-Session-Token": "t" } }]]);
    // Before SQL 51, a failed read: an error, so the picker lists none.
    answer = { status: 503, body: { error: "Saving references is not available yet." } };
    await expect(ui.options!.queryFn()).rejects.toThrow("Saving references is not available yet.");
    answer = { status: 500, body: "Internal error" };
    await expect(ui.options!.queryFn()).rejects.toThrow("Your references could not be loaded.");
    answer = "not json";
    expect(await ui.options!.queryFn()).toEqual({ saved: [], deleted: [] });
    ui.query = { data: { saved: [A, B], deleted: [H("d")] } };
    lib = useReferenceLibrary(true);
    expect([lib.saved, lib.deleted]).toEqual([[A, B], [H("d")]]);
  });

  it("saves a picture as the picker read it, on top of the list at once and no longer deleted, then reads the list again", async () => {
    const lib = useReferenceLibrary(true);
    ui.cache = { saved: [B, A], deleted: [H("d"), A.hash] };
    answer = { status: 200, body: { id: "a1", url: A.url, thumb: A.src, hash: A.hash } };
    expect(await lib.save("data:image/webp;base64,AA")).toEqual(A);
    expect(calls).toEqual([["/api/references", { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": "t" }, body: JSON.stringify({ image: "data:image/webp;base64,AA" }) }]]);
    // Saved again: moved to the top, once.
    expect(ui.cache).toEqual({ saved: [A, B], deleted: [H("d")] });
    expect(spies.invalidate.mock.calls).toEqual(RELOAD);
    ui.cache = undefined;
    await lib.save("data:image/webp;base64,AA");
    expect(ui.cache).toEqual({ saved: [A], deleted: [] });
  });

  it("keeps nothing and says nothing when a save fails, except at the cap, where the account is told why", async () => {
    const lib = useReferenceLibrary(true);
    ui.cache = { saved: [B], deleted: [] };
    for (const a of [{ status: 503, body: { error: "Saving references is not available yet." } }, "offline", "not json", { status: 200, body: { id: "x" } }] as const) {
      answer = a;
      expect(await lib.save("data:image/webp;base64,AA"), JSON.stringify(a)).toBeNull();
    }
    expect([spies.notify.mock.calls, spies.invalidate.mock.calls, ui.cache]).toEqual([[], [], { saved: [B], deleted: [] }]);
    answer = { status: 409, body: { error: "You can keep up to 50 references. Delete some first." } };
    expect(await lib.save("data:image/webp;base64,AA")).toBeNull();
    expect(spies.notify.mock.calls).toEqual([["You can keep up to 50 references. Delete some first.", { tone: "error" }]]);
    answer = { status: 409, body: {} };
    await lib.save("data:image/webp;base64,AA");
    expect(spies.notify).toHaveBeenCalledOnce();
  });

  it("deletes at once, among the deleted, and reads the list again; a failed delete says so (one already gone is no failure)", async () => {
    const lib = useReferenceLibrary(true);
    ui.cache = { saved: [A, B], deleted: [H("d")] };
    lib.remove("a1");
    expect(ui.cache).toEqual({ saved: [B], deleted: [A.hash, H("d")] });
    expect(spies.invalidate).not.toHaveBeenCalled();
    await settle();
    expect(calls).toEqual([["/api/references/a1", { method: "DELETE", headers: { "X-Session-Token": "t" } }]]);
    expect([spies.notify.mock.calls, spies.invalidate.mock.calls]).toEqual([[], RELOAD]);
    answer = { status: 404, body: {} };
    lib.remove("b1");
    await settle();
    expect(spies.notify).not.toHaveBeenCalled();
    for (const a of [{ status: 500, body: {} }, "offline"] as const) {
      answer = a;
      lib.remove("a/1");
      await settle();
    }
    expect(calls.at(-1)![0]).toBe("/api/references/a%2F1");
    expect(spies.notify.mock.calls).toEqual([["Couldn't delete that reference", { tone: "error" }], ["Couldn't delete that reference", { tone: "error" }]]);
    expect(spies.invalidate).toHaveBeenCalledTimes(4);
    // Nothing listed yet: nothing to take out.
    ui.cache = undefined;
    lib.remove("a1");
    expect(ui.cache).toBeUndefined();
  });

  it("knows a render's stored copy of a picture by the hash it is named by, and nothing else", () => {
    expect(storedHash(RENDERED(H("c")))).toBe(H("c"));
    for (const url of [
      `https://store.public.blob.vercel-storage.com/renders/u/${H("c")}.webp`, // not a reference
      RENDERED("c".repeat(63)), RENDERED(H("C")), `${RENDERED(H("c"))}?x=1`, "https://s/old.png",
    ]) expect(storedHash(url), url).toBeUndefined();
  });
});

describe("the picker's Images tab", () => {
  let m: ImageViewModel;
  const onUpload = vi.fn(), onClose = vi.fn();
  const show = (at?: number) => { ui.s = 0; ui.r = 0; return RefPicker({ model: m, anchor: { left: 1, top: 2, bottom: 3 } as DOMRect, phone: false, at, onUpload, onClose }) as El; };
  beforeEach(() => {
    vi.stubGlobal("document", { body: {} });
    onClose.mockClear();
    m = {
      room: 3, refs: [], toggleRef: vi.fn(), deleteRef: vi.fn(), addNfts: vi.fn(),
      // u1 unsaved, u2 saved as A this visit (under A's id).
      uploads: [{ id: "u1", src: "data:u1" }, { id: "a1", src: "data:a" }],
      library: [A, B],
      deletedRefs: [H("d")],
      // Earlier renders' references: B's copy (saved), a deleted picture's copy, one never saved, an upload's preview.
      myImages: [{ url: RENDERED(B.hash), src: RENDERED(B.hash) }, { url: RENDERED(H("d")), src: RENDERED(H("d")) },
        { url: RENDERED(H("e")), src: RENDERED(H("e")) }, { url: "https://s/old.png", src: "https://s/old-t.png" }],
    } as unknown as ImageViewModel;
  });

  it("lists this visit's unsaved uploads, the saved ones newest first with their ×, then the earlier ones no saved or deleted picture", () => {
    const tree = show();
    expect(byClass(tree, "iv-rp-item").map((i) => [i.key, [...walk(i)].find((el) => el.type === "img")!.props.src])).toEqual([
      ["u1", "data:u1"], ["a1", A.src], ["b1", B.src], [RENDERED(H("e")), RENDERED(H("e"))], ["https://s/old.png", "https://s/old-t.png"]]);
    const saved = byClass(tree, "iv-rp-tile");
    expect(saved.map((t) => t.key)).toEqual(["a1", "b1"]);
    expect(saved.map((t) => byClass(t, "iv-rp-del").map((x) => [x.props.type, x.props["aria-label"], x.props.children]))).toEqual([
      [["button", "Delete this reference", "×"]], [["button", "Delete this reference", "×"]]]);
    expect(byClass(tree, "iv-rp-del")).toHaveLength(2);
    // Only the saved list: the note about earlier images stays away.
    m.uploads = []; m.myImages = [];
    expect(byClass(show(), "iv-rp-note")).toHaveLength(0);
  });

  it("a saved tile switches its picture in and out by its id; its × deletes it and the picker stays open", () => {
    m.refs = [{ id: "a1", src: "data:a" }];
    const tree = show(7);
    const [, a, b] = byClass(tree, "iv-rp-item");
    expect([a.props["data-on"], a.props["aria-pressed"], b.props["data-on"]]).toEqual([true, true, undefined]);
    press(b);
    expect(m.toggleRef).toHaveBeenCalledWith("b1", 7);
    press(byClass(tree, "iv-rp-del")[1]);
    expect(m.deleteRef).toHaveBeenCalledWith("b1");
    expect(onClose).not.toHaveBeenCalled();
    // Every place filled: a tile not in the prompt waits, its × still deletes.
    m.room = 0;
    const full = show();
    expect(byClass(full, "iv-rp-item").map((i) => i.props.disabled)).toEqual([true, false, true, true, true]);
    expect(byClass(full, "iv-rp-del").map((x) => x.props.disabled)).toEqual([undefined, undefined]);
  });

  it("stands in place again once the saved list arrives, as it does for a new upload", () => {
    expect(readSource(join(ROOT, "components", "image-view", "RefPicker.tsx"))).toContain("}, [phone, anchor, tab, m.uploads.length, m.library.length]);");
  });

  it("shows the × on hover where the pointer can hover, always on a touch screen, over a tile as wide as its place", () => {
    const CSS = readFileSync(join(ROOT, "components", "image-view", "image-view.css"), "utf8");
    expect(CSS).toContain(".iv-rp-tile { position: relative; }\n.iv-rp-tile .iv-rp-item { width: 100%; }\n.iv-rp-del {\n  position: absolute;");
    expect(CSS).toContain("@media (hover: hover) {\n  .iv-rp-del { opacity: 0; transition: opacity 0.15s ease; }\n  .iv-rp-tile:hover .iv-rp-del,\n  .iv-rp-tile:focus-within .iv-rp-del { opacity: 1; }\n}");
    // Nowhere else is it hidden.
    expect(CSS.match(/\.iv-rp-del[^{]*\{[^}]*opacity: 0/g)).toHaveLength(1);
  });
});

describe("the view model", () => {
  // As the compiler sees it, without the lines a comment stood on.
  const MODEL = readSource(join(ROOT, "components", "image-view", "useImageViewModel.ts")).replace(/^[ \t]*\n/gm, "");

  // Kev, 2026-10-30: "i only want these ref images for videos pls not for images"; "hier [Create > Video] werden aber
  // ref content gespeichert". The saved references live in VideoComposer now (lib/video/__tests__/video-ui.test.ts).
  it("saves no upload and lists no saved reference in the image view: Create > Video has them", () => {
    expect(MODEL).not.toContain("useReferenceLibrary(");
    expect(MODEL).not.toContain("keep(");
    expect(MODEL).not.toContain("library.save");
    expect(MODEL).toContain("    library: [],\n    deletedRefs: [],\n    deleteRef: (id: string) => setUploads((u) => u.filter((x) => x.id !== id)),\n");
  });
});
