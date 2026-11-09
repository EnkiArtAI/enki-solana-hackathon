import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import HistoryStrip, { railItems } from "@/components/image-view/HistoryStrip";
import type { ImageViewModel, Shot } from "@/components/image-view/useImageViewModel";

/**
 * A render of this tab is in the History from the moment it starts, not
 * under the stage (Kev, 2026-10-13: "das generierende Bild soll nicht UNTER
 * dem Hauptbild stehen sondern in der History ganz rechts"); in v2 that is the
 * strip beside the hero (desktop) and the thumb column (phone).
 */

const job = (id: string, status: "rendering" | "failed" | "ready", over: Partial<Shot> = {}, sent = status === "rendering"): Shot => ({
  key: `job:${id}`, kind: "job", ratio: "4:5", src: status === "ready" ? `/${id}.png` : undefined, thumb: status === "ready" ? `/${id}.png` : undefined,
  job: { id, status, sent, seen: false } as Shot["job"], ...over,
});
const row = (id: string): Shot => ({ key: `history:${id}`, kind: "history", ratio: null, src: `/${id}.webp`, thumb: `/${id}.webp`, createdAt: "2026-10-12T10:00:00Z" });

const model = (queue: Shot[], history: Shot[]): ImageViewModel => ({
  queue, history, jobs: queue.map((s) => s.job), examples: [], community: [], main: null, now: Date.parse("2026-10-13T10:00:00Z"),
  historyState: { loading: false, failed: false, more: false, loadingOlder: false, retry: vi.fn(), loadOlder: vi.fn() },
  select: vi.fn(), cancel: vi.fn(),
} as unknown as ImageViewModel);

const strip = (m: ImageViewModel, open = true) => renderToStaticMarkup(createElement(HistoryStrip, { model: m, open, onToggle: vi.fn() }));

describe("railItems", () => {
  it("puts this tab's renders first, then the history", () => {
    expect(railItems([job("b", "rendering"), job("a", "failed")], [row("x"), row("y")]).map((s) => s.key))
      .toEqual(["job:b", "job:a", "history:x", "history:y"]);
  });

  it("lists a recorded render once: where the history has it", () => {
    const recorded = job("a", "ready", { createdAt: "2026-10-13T09:59:00Z" });
    expect(railItems([job("b", "rendering"), recorded], [recorded, row("x")]).map((s) => s.key)).toEqual(["job:b", "job:a", "history:x"]);
  });
});

describe("the History strip", () => {
  it("shows a render from the moment it starts, above the older ones, and says where it stands", () => {
    const html = strip(model([job("b", "rendering"), job("a", "failed")], [row("x")]));
    const [rendering, failed, old] = [html.indexOf('aria-label="Your render, rendering"'), html.indexOf('aria-label="Your render, failed'), html.indexOf("/x.webp")];
    expect(rendering).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(rendering);
    expect(old).toBeGreaterThan(failed);
    expect(html).toContain('<span class="iv-sr" role="status">Rendering…</span>');
  });

  it("a recorded render tells its time; folded, the strip counts them all", () => {
    const recorded = job("a", "ready", { createdAt: "2026-10-13T09:00:00Z" });
    expect(strip(model([], [row("x")]))).toContain('title="Your render · yesterday"');
    expect(strip(model([recorded], [recorded, row("x")]), false)).toContain("History · 2");
  });

  it("a render still in line carries an X that cancels it through the model; a sent one is lit and has none (Kev, 2026-10-13)", () => {
    const inLine = job("q", "rendering", {}, false);
    const html = strip(model([job("s", "rendering"), inLine], []));
    const tiles = html.match(/<div class="kit-tile kit-focus"[^>]*>/g) ?? [];
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toContain('data-sent="true"');
    expect(tiles[1]).not.toContain("data-sent");
    expect(html.match(/aria-label="Cancel this render"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Your render, in line, cancel with its X"');
    const src = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "HistoryStrip.tsx"));
    expect(src).toContain("onClick={() => m.select(s)} onCancel={() => m.cancel(s)} />");
    for (const file of ["PreviewStrip.tsx", "ImageViewMobile.tsx"]) {
      const text = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", file));
      expect(text, file).toContain("sent={s.job.sent}");
      expect(text, file).toContain("onCancel={() => m.cancel(s)}");
    }
    const modelSrc = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"));
    expect(modelSrc).toContain("cancel: (shot) => { if (shot.job) queue.cancel(shot.job.id); },");
  });
});
