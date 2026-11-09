import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ImageViewModel, Shot } from "@/components/image-view/useImageViewModel";

/**
 * The viewer's renders beside the hero (image UI v2, handoff §5.10, plan B10):
 * 60 px squares newest first, this tab's renders leading, older ones loading
 * near the end; folded, "History · N" opens it.
 */
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: <T>(start: T) => ({ current: start }),
  useEffect: () => {},
}));
vi.mock("@/components/kit/JobTile", () => ({ default: () => null }));

import HistoryStrip, { renderWhen } from "@/components/image-view/HistoryStrip";
import JobTile from "@/components/kit/JobTile";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => el.props.className === name);
const shot = (key: string, extra: Partial<Shot> = {}) => ({ key, kind: "history", thumb: `/${key}.png`, ratio: "4:5", ...extra }) as Shot;
const model = (over: Partial<ImageViewModel> = {}) => ({
  queue: [], history: [shot("h1", { createdAt: "2026-10-21T10:00:00Z" }), shot("h2")], jobs: [], main: null, now: Date.parse("2026-10-21T12:00:00Z"),
  select: vi.fn(), cancel: vi.fn(),
  historyState: { loading: false, failed: false, retry: vi.fn(), more: true, loadingOlder: false, loadOlder: vi.fn() },
  ...over,
}) as unknown as ImageViewModel;

describe("a render's frame in the Image View", () => {
  // Kev (2026-10-26): "mit ladeanimation innen drin und orangener umrandung und dann grün umrandet ... wenn es fertig ist".
  it("is orange while it renders, its spinner too once sent, and green once finished until seen", () => {
    const CSS = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
    expect(CSS).toContain('.iv-root .kit-tile[data-status="rendering"]:not([data-frame="ember"]) { border-color: var(--enki-amber);');
    expect(CSS).toContain(".iv-root .kit-tile[data-sent] .kit-spinner { border-color: color-mix(in oklab, var(--enki-amber) 30%, transparent); border-top-color: var(--enki-amber);");
    expect(CSS).toContain('.iv-root .kit-tile[data-frame="turq"] { border-color: var(--enki-green);');
  });
});

describe("the History strip", () => {
  // DEC-504 (Kev, 2026-10-29: "figure something else how we can display to the user that he really just has no history yet").
  it("shows, open and empty, a dashed square where the first render lands and says so; a failed read shows Retry instead", () => {
    const st = { loading: false, failed: false, retry: vi.fn(), more: false, loadingOlder: false, loadOlder: vi.fn() };
    const empty = HistoryStrip({ model: model({ history: [], historyState: st }), open: true, onToggle: vi.fn() });
    expect(byClass(empty, "iv-hstrip-ghost").map((g) => g.props["aria-hidden"])).toEqual([true]);
    expect(byClass(empty, "iv-hstrip-note iv-hstrip-hint").map((h) => h.props.children)).toEqual(["Your renders land here"]);
    const failed = HistoryStrip({ model: model({ history: [], historyState: { ...st, failed: true } }), open: true, onToggle: vi.fn() });
    expect(byClass(failed, "iv-hstrip-ghost")).toHaveLength(0);
    expect(byClass(failed, "iv-link iv-hstrip-note").map((b) => b.props.children)).toEqual(["Retry"]);
    expect(byClass(HistoryStrip({ model: model(), open: true, onToggle: vi.fn() }), "iv-hstrip-ghost")).toHaveLength(0);
    // Not before it is known (review 2026-10-29): while the first read runs, nor while older rows are unread.
    for (const unknown of [{ loading: true }, { more: true }]) {
      const strip = HistoryStrip({ model: model({ history: [], historyState: { ...st, ...unknown } }), open: true, onToggle: vi.fn() });
      expect(byClass(strip, "iv-hstrip-ghost")).toHaveLength(0);
    }
    // Folded while it loads: the name without a count, never "History · 0".
    const folded = byClass(HistoryStrip({ model: model({ history: [], historyState: { ...st, loading: true } }), open: false, onToggle: vi.fn() }), "iv-hstrip-fold");
    expect(folded.map((f) => [f.props.children].flat().join(""))).toEqual(["History"]);
    const CSS = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
    expect(CSS).toContain(".iv-meta-hist-label { color: var(--enki-ink-2); font-size: 12px; font-weight: 600; white-space: nowrap; cursor: default; }");
    expect(CSS).toContain(".iv-hstrip-hint { color: var(--enki-ink-2); text-align: center; line-height: 1.35; }");
    expect(CSS).toContain(".iv-hstrip-ghost { flex: 0 0 60px; width: 60px; height: 60px; border: 1.5px dashed var(--enki-rule); border-radius: 15px; }");
  });

  // Folded only once it holds renders (DEC-504): the count, and a click opens it.
  it("folds to its count, which opens it again", () => {
    const toggle = vi.fn();
    const folded = byClass(HistoryStrip({ model: model(), open: false, onToggle: toggle }), "iv-hstrip-fold");
    expect(folded.map((f) => [f.type, [f.props.children].flat().join("")])).toEqual([["button", "History · 2"]]);
    (folded[0].props.onClick as () => void)();
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("lists the renders as squares, picks one onto the hero, and says when it was made", () => {
    const m = model();
    const picks = byClass(HistoryStrip({ model: m, open: true, onToggle: vi.fn() }), "iv-hstrip-pick");
    expect(picks).toHaveLength(2);
    expect(picks[0].props.title).toBe("Your render · 2h ago");
    (picks[1].props.onClick as () => void)();
    expect(m.select).toHaveBeenCalledWith(m.history[1]);
  });

  it("leads with this tab's renders, square, while they paint", () => {
    const job = shot("job:1", { kind: "job", job: { id: "1", status: "rendering", seen: false } as Shot["job"] });
    const tiles = [...walk(HistoryStrip({ model: model({ queue: [job] }), open: true, onToggle: vi.fn() }))].filter((el) => el.type === JobTile);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].props).toMatchObject({ ratio: "1:1", height: 60 });
  });

  it("asks for older renders within 160 px of its end, once at a time", () => {
    const m = model();
    const list = byClass(HistoryStrip({ model: m, open: true, onToggle: vi.fn() }), "iv-hstrip-list kit-noscroll")[0];
    const scroll = (top: number) => (list.props.onScroll as (e: unknown) => void)({ currentTarget: { scrollTop: top, clientHeight: 400, scrollHeight: 1000 } });
    scroll(400);
    expect(m.historyState.loadOlder).not.toHaveBeenCalled();
    scroll(441);
    expect(m.historyState.loadOlder).toHaveBeenCalledOnce();
    const busy = model({ historyState: { ...m.historyState, loadingOlder: true, loadOlder: vi.fn() } });
    const list2 = byClass(HistoryStrip({ model: busy, open: true, onToggle: vi.fn() }), "iv-hstrip-list kit-noscroll")[0];
    (list2.props.onScroll as (e: unknown) => void)({ currentTarget: { scrollTop: 900, clientHeight: 400, scrollHeight: 1000 } });
    expect(busy.historyState.loadOlder).not.toHaveBeenCalled();
  });

  it("folds to History · N, which opens it again", () => {
    const onToggle = vi.fn();
    const fold = byClass(HistoryStrip({ model: model(), open: false, onToggle }), "iv-hstrip-fold")[0];
    expect([fold.props.children].flat().join("")).toBe("History · 2");
    (fold.props.onClick as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("tells the time of a recorded render, else where this tab's stands", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(renderWhen(shot("a", { createdAt: "2026-10-21T10:00:00Z" }), now)).toBe("2h ago");
    expect(renderWhen(shot("b", { job: { status: "rendering" } as Shot["job"] }), now)).toBe("Rendering…");
    expect(renderWhen(shot("c", { job: { status: "failed" } as Shot["job"] }), now)).toBe("Failed");
    expect(renderWhen(shot("d"), now)).toBe("Just now");
  });
});

describe("picking one of the viewer's recorded renders", () => {
  it("loads the values it was made with, with its settings and photos (README §5.4), holding the fields from shrinking", () => {
    const MODEL = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"), "utf8");
    const branch = MODEL.slice(MODEL.indexOf("else if (recorded) {"), MODEL.indexOf('} else if (x.kind === "example") {'));
    expect(branch).toContain("loadRecordedRefs(recorded.references ?? []);");
    expect(branch).toMatch(/const made = x\.record\?\.variable_values;\n\s+if \(made\) \{\n\s+setOverrides\(made\);\n\s+grow\.hold\(Object\.keys\(made\)\);/);
    const HISTORY = readFileSync(join(__dirname, "..", "..", "..", "..", "lib", "ui", "image-view", "history.ts"), "utf8");
    expect(HISTORY).toContain("variable_values?: Record<string, string> | null;");
  });
});

describe("the desktop page's history", () => {
  const DESKTOP = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "ImageViewDesktop.tsx"), "utf8");
  it("keeps the strip's open state across visits", () => {
    expect(DESKTOP).toContain('const HISTORY_KEY = "enki:iv-history";');
    expect(DESKTOP).toContain('try { return localStorage.getItem(HISTORY_KEY) !== "0"; } catch { return true; }');
    expect(DESKTOP).toContain('try { localStorage.setItem(HISTORY_KEY, next ? "1" : "0"); } catch { /* private mode */ }');
  });
});
