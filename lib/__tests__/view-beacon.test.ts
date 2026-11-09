import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * lib/ui/view-beacon.ts (Kev, 2026-10-29: views by day for posts): an image opened large counts once per browser and
 * UTC day, the ids leave batched in one call that survives a closing tab, and a browser without storage still counts
 * each image once while the page lives.
 */
let store: Record<string, string> | null = {};
const storage = {
  getItem: (k: string) => { if (!store) throw new Error("no storage"); return store[k] ?? null; },
  setItem: (k: string, v: string) => { if (!store) throw new Error("no storage"); store[k] = v; },
};
const sent: { url: string; init: RequestInit }[] = [];

describe("the image view beacon", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
    store = {}; sent.length = 0;
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(null, { status: 204 }); });
    vi.resetModules();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("counts each image once a day, batched into one call that keeps alive", async () => {
    const { countImageOpen } = await import("@/lib/ui/view-beacon");
    countImageOpen("img-1"); countImageOpen("img-2"); countImageOpen("img-1"); countImageOpen(null); countImageOpen("");
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/images/views");
    expect(sent[0].init.keepalive).toBe(true);
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ ids: ["img-1", "img-2"] });
    countImageOpen("img-1");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(1);
    // The next UTC day counts it again.
    vi.setSystemTime(new Date("2026-10-30T00:00:01Z"));
    countImageOpen("img-1");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(String(sent[1].init.body))).toEqual({ ids: ["img-1"] });
  });

  it("remembers the day's images across page loads, in the browser", async () => {
    const first = await import("@/lib/ui/view-beacon");
    first.countImageOpen("img-1");
    first.flushImageOpens();
    vi.resetModules();
    const again = await import("@/lib/ui/view-beacon");
    again.countImageOpen("img-1"); again.countImageOpen("img-3");
    again.flushImageOpens();
    expect(sent.map((s) => JSON.parse(String(s.init.body)).ids)).toEqual([["img-1"], ["img-3"]]);
  });

  it("is called by the image UI for a public image on the stage or in the viewer", () => {
    const model = readSource(join(__dirname, "..", "..", "components", "image-view", "useImageViewModel.ts"));
    expect(model).toMatch(/const seen = \(x: Shot\) => \{\n[^}]*markSeen\(x\.job\.id\);\n\s+if \(x\.publicId\) countImageOpen\(x\.publicId\);\n\s+\};/);
  });

  it("counts a prompt open in the prompt view itself, however it was opened, and no more from the feed card", () => {
    const panel = readSource(join(__dirname, "..", "..", "components", "enki", "EnkiDetailPanel.tsx"));
    // Comments are stripped, so only blank space sits between the guard and the count.
    expect(panel).toMatch(/if \(id === "blank"\) return;\s+fetch\(`\/api\/prompts\/\$\{encodeURIComponent\(id\)\}\/view`, \{ method: "POST" \}\)/);
    const feed = readSource(join(__dirname, "..", "..", "components", "enki", "EnkiFeedPage.tsx"));
    expect(feed).not.toContain("/view`");
  });

  it("is called by the gallery viewer for a public image", () => {
    const wall = readSource(join(__dirname, "..", "..", "components", "gallery", "GalleryWall.tsx"));
    expect(wall).toContain('if (selected?.visibility === "public") countImageOpen(selected.id);');
  });

  it("works without storage, once per image for the page's life", async () => {
    store = null;
    const { countImageOpen, flushImageOpens } = await import("@/lib/ui/view-beacon");
    countImageOpen("img-1"); countImageOpen("img-1"); countImageOpen("img-2");
    flushImageOpens();
    expect(sent.map((s) => JSON.parse(String(s.init.body)).ids)).toEqual([["img-1", "img-2"]]);
    countImageOpen("img-1");
    flushImageOpens();
    expect(sent).toHaveLength(1);
  });
});
