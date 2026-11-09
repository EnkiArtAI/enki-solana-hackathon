import { describe, expect, it } from "vitest";
import { batchSize, promptName, recreatePlan, shotId, tileState, wallItems, wallShot, withoutRow, type OwnRow, type WallItem } from "@/lib/ui/create/image";
import type { ImageSetup } from "@/lib/ui/image-view/setups";
import type { Job } from "@/lib/ui/kit/render-queue";

/**
 * Create > Image (Kev, 2026-10-30): the wall above the bar, newest first, a job in each of its states, and what
 * Recreate puts back into the bar.
 */
const setup = (prompt: string, aspectRatio = "1:1") => ({ prompt, aspectRatio } as unknown as ImageSetup);
const job = (id: string, over: Partial<Job<ImageSetup>> = {}): Job<ImageSetup> =>
  ({ id, createdAt: 1, status: "rendering", sent: false, setup: setup(id), seen: false, ...over });
const row = (id: string, over: Partial<OwnRow> = {}): OwnRow => ({
  id, image_url: `https://cdn/${id}.png`, image_urls: [`https://cdn/${id}.webp`], thumbnail_url: `https://cdn/${id}-t.webp`, isUploaded: false,
  visibility: "private", prompt_id: null, settings: { modelId: "gpt", aspectRatio: "3:4", resolution: "1K", boost: false, references: ["https://cdn/ref.png"] },
  prompt_text: `words of ${id}`, created_at: "2026-10-30", ...over,
});

describe("a job's look", () => {
  it("is grey while its request waits in line, the spinner once sent, red once failed", () => {
    expect(tileState({ status: "rendering", sent: false })).toBe("waiting");
    expect(tileState({ status: "rendering" })).toBe("waiting");
    expect(tileState({ status: "rendering", sent: true })).toBe("running");
    expect(tileState({ status: "failed", sent: true })).toBe("failed");
    expect(tileState({ status: "ready", sent: true })).toBe("ready");
  });
});

describe("the wall", () => {
  it("shows this visit's jobs first in the queue's order, then the recorded rows, newest first", () => {
    const items = wallItems([job("new"), job("old", { status: "failed" })], [row("r1"), row("r2")]);
    expect(items.map((i) => i.key)).toEqual(["job:new", "job:old", "row:r1", "row:r2"]);
  });

  it("shows a finished job as its recorded row once the row is in, in the job's place, with the job for Recreate", () => {
    const done = job("done", { status: "ready", sent: true, imageUrl: "https://cdn/r2.png" });
    const items = wallItems([job("new"), done], [row("r1"), row("r2")]);
    expect(items.map((i) => i.key)).toEqual(["job:new", "row:r2", "row:r1"]);
    expect(items[1].job).toBe(done);
    // Each image once.
    expect(items.filter((i) => i.key === "row:r2")).toHaveLength(1);
  });

  it("leaves out uploads and rows without a picture, and shows the small version first", () => {
    const items = wallItems([], [row("up", { isUploaded: true }), row("none", { image_url: null, image_urls: [], thumbnail_url: null }), row("r1"), row("r2", { thumbnail_url: null })]);
    expect(items.map((i) => i.key)).toEqual(["row:r1", "row:r2"]);
    expect(items.map((i) => (i as Extract<WallItem, { kind: "row" }>).src)).toEqual(["https://cdn/r1-t.webp", "https://cdn/r2.webp"]);
  });

  it("leaves out a render deleted here at once, its job with it, so it does not come back as the job it was", () => {
    const done = job("done", { status: "ready", sent: true, imageUrl: "https://cdn/r2.png" });
    expect(wallItems([job("new"), done], [row("r1"), row("r2")], new Set(["r2", "done"])).map((i) => i.key)).toEqual(["job:new", "row:r1"]);
    // The rows read again without it: the job stays gone.
    expect(wallItems([done], [row("r1")], new Set(["r2", "done"])).map((i) => i.key)).toEqual(["row:r1"]);
    expect(wallItems([done], [row("r1"), row("r2")]).map((i) => i.key)).toEqual(["row:r2", "row:r1"]);
  });

  it("gives a job its tile's ratio (the measured size once in), a row the ratio it asked for or none", () => {
    const [wait, sized] = wallItems([job("w", { setup: setup("w", "16:9") }), job("s", { status: "ready", imageUrl: "data:x", size: { w: 900, h: 1200 } })], []);
    expect(wait.ratio).toBeCloseTo(16 / 9);
    expect(sized.ratio).toBeCloseTo(0.75);
    // 21:9 is held at 16:9, as JobTile draws it.
    expect(wallItems([job("x", { setup: setup("x", "21:9") })], [])[0].ratio).toBeCloseTo(16 / 9);
    const [asked, unknown] = wallItems([], [row("a"), row("b", { settings: null })]);
    expect(asked.ratio).toBeCloseTo(0.75);
    expect(unknown.ratio).toBeNull();
  });
});

describe("Recreate", () => {
  it("loads a job of this visit whole, with the count of the batch it came in", () => {
    const one = setup("two foxes", "16:9");
    const a = job("a", { status: "ready", setup: one, imageUrl: "data:a" });
    const b = job("b", { status: "ready", setup: one, imageUrl: "data:b" });
    const other = job("c", { status: "ready", setup: setup("two foxes", "16:9"), imageUrl: "data:c" });
    const jobs = [a, b, other];
    const plan = recreatePlan(wallItems(jobs, [])[0], jobs);
    expect(plan).toEqual({ shot: { key: "job:a", kind: "job", job: a, ratio: "16:9" }, text: null, count: 2, reset: false, unrecorded: false });
    expect(batchSize(jobs, other)).toBe(1);
  });

  it("loads a failed job too, but nothing from one still rendering", () => {
    const failed = job("f", { status: "failed" });
    expect(recreatePlan(wallItems([failed], [])[0], [failed])).toMatchObject({ text: null, count: 1 });
    const busy = job("r", { sent: true });
    expect(recreatePlan(wallItems([busy], [])[0], [busy])).toBeNull();
  });

  it("loads a recorded render from its row after resetting the bar (a row keeps no quality): its words, one image", () => {
    const r = row("r1");
    const plan = recreatePlan(wallItems([], [r])[0], []);
    expect(plan).toEqual({ shot: { key: "history:r1", kind: "history", ratio: null, record: r }, text: "words of r1", count: 1, reset: true, unrecorded: false });
    expect(recreatePlan(wallItems([], [row("r2", { prompt_text: null })])[0], [])).toMatchObject({ text: "" });
  });

  it("loads only the words of a row without settings: no generator, ratio, size or references of its own", () => {
    const r = row("old", { settings: null });
    const plan = recreatePlan(wallItems([], [r])[0], []);
    expect(plan).toMatchObject({ text: "words of old", count: 1, reset: true, unrecorded: true });
    const shot = (plan as { shot: { record: OwnRow } }).shot;
    expect(shot.record).toEqual({ ...r, settings: { modelId: null, aspectRatio: null, resolution: null, boost: false, references: [] } });
    // The row itself is left as read.
    expect(r.settings).toBeNull();
  });

  it("opens someone's listed prompt on that render instead, as the profile's Recreate does", () => {
    const r = row("m", { prompt_kind: "market", prompt_id: "p1" });
    expect(recreatePlan(wallItems([], [r])[0], [])).toEqual({ open: { promptId: "p1", imageUrl: "https://cdn/m-t.webp", recreateImageId: "m" } });
    // The viewer's own prompt (written here) stays in the bar.
    expect(recreatePlan(wallItems([], [row("o", { prompt_kind: "own", prompt_id: "p2" })])[0], [])).toMatchObject({ text: "words of o" });
  });
});

describe("the rest", () => {
  it("names a prompt made from the bar by its first six words, as Quick Create does", () => {
    expect(promptName("  a  fox in the snow at dusk again ")).toBe("a fox in the snow at");
    expect(promptName("x".repeat(80))).toHaveLength(60);
  });

});

describe("the viewer", () => {
  it("shows a finished job's picture, nothing for one rendering or failed", () => {
    const ready = job("ok", { status: "ready", imageUrl: "data:ok", setup: setup("ok", "4:3") });
    const [shown, busy, failed] = wallItems([ready, job("busy", { sent: true }), job("f", { status: "failed" })], []);
    expect(wallShot(shown)).toEqual({ key: "job:ok", kind: "job", job: ready, src: "data:ok", ratio: "4:3" });
    expect(wallShot(busy)).toBeNull();
    expect(wallShot(failed)).toBeNull();
  });

  it("shows a row's full image (the small one on the wall), its original for Download, its row and its job", () => {
    const r = row("r1");
    expect(wallShot(wallItems([], [r])[0])).toEqual({
      key: "row:r1", kind: "history", job: undefined, record: r, src: "https://cdn/r1.webp", thumb: "https://cdn/r1-t.webp", original: "https://cdn/r1.png",
      ratio: "3:4", createdAt: "2026-10-30",
    });
    const done = job("done", { status: "ready", imageUrl: "https://cdn/r2.png" });
    const recorded = wallShot(wallItems([done], [row("r2", { image_urls: [], image_url: "https://cdn/r2.png", settings: null })])[0])!;
    expect(recorded).toMatchObject({ key: "row:r2", kind: "job", job: done, src: "https://cdn/r2.png", original: "https://cdn/r2.png", ratio: null });
    // The same picture before and after its row came in.
    expect(shotId(recorded)).toBe("job:done");
    expect(shotId(wallShot(wallItems([], [r])[0])!)).toBe("row:r1");
  });
});

describe("a render deleted here", () => {
  it("leaves the rows read, every page of them, the rest as they were; nothing read stays nothing", () => {
    const data = { pages: [{ generations: [{ id: "a" }, { id: "gone" }], total: 3 }, { generations: [{ id: "b" }], total: 3 }], pageParams: [0, 100] };
    expect(withoutRow(data, "gone")).toEqual({ pages: [{ generations: [{ id: "a" }], total: 3 }, { generations: [{ id: "b" }], total: 3 }], pageParams: [0, 100] });
    expect(data.pages[0].generations).toHaveLength(2);
    expect(withoutRow(undefined, "gone")).toBeUndefined();
  });
});
