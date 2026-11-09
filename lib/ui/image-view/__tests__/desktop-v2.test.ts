import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";

/**
 * The desktop page from 1024 px up (image UI v2, handoff §3 and §5.2): its
 * own header, the composer beside the picture column, the right column as
 * wide as the visible variables allow (layout.ts).
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], index: 0, login: vi.fn(), funds: vi.fn(), openRender: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T | (() => T)) => {
    const i = ui.index++;
    // A lazy start is called, as React does (the History's open state reads it).
    if (!(i in ui.state)) ui.state[i] = typeof start === "function" ? (start as () => T)() : start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
  useRef: <T>(start: T) => ({ current: start }),
}));
vi.mock("@/lib/openLogin", () => ({ openLogin: ui.login }));
vi.mock("@/components/image-view/ReviewsPanel", () => ({ default: () => null }));
vi.mock("@/lib/ui/kit/controls", () => ({ openAddFunds: ui.funds }));
vi.mock("@/components/enki/NftPickerModal", () => ({ default: () => null }));
vi.mock("@/components/kit/AddFundsPopover", () => ({ default: () => null }));
vi.mock("@/components/kit/CostLine", () => ({ default: () => null }));
vi.mock("@/components/kit/FullscreenViewer", () => ({ default: () => null }));
vi.mock("@/components/kit/GenerateButton", () => ({ default: () => null }));
vi.mock("@/components/kit/GeneratorPill", () => ({ default: () => null }));
vi.mock("@/components/kit/ReferenceTiles", () => ({ default: () => null }));
vi.mock("@/components/kit/SettingsPills", () => ({ RatioPill: () => null, ResolutionPill: () => null, QualityPill: () => null }));
vi.mock("@/components/image-view/AgentRow", () => ({ default: () => null }));
vi.mock("@/components/image-view/HistoryStrip", async (original) => ({ ...(await original<typeof import("@/components/image-view/HistoryStrip")>()), default: () => null, renderWhen: () => "2h ago" }));
vi.mock("@/components/image-view/MainImage", () => ({ default: () => null }));
vi.mock("@/components/image-view/PreviewStrip", () => ({ default: () => null }));
vi.mock("@/components/image-view/PromptActions", () => ({ default: () => null }));
vi.mock("@/components/image-view/PromptPanel", () => ({ default: () => null }));
vi.mock("@/components/image-view/ViewerPanel", () => ({ default: () => null }));
vi.mock("@/components/image-view/useOpenRender", () => ({ useOpenRender: ui.openRender }));

import ImageViewDesktop from "@/components/image-view/ImageViewDesktop";
import IvHeader from "@/components/image-view/IvHeader";
import AgentRow from "@/components/image-view/AgentRow";
import ComposeFoot from "@/components/image-view/ComposeFoot";
import HistoryRail from "@/components/image-view/HistoryStrip";
import PreviewStrip from "@/components/image-view/PreviewStrip";
import PromptActions from "@/components/image-view/PromptActions";
import FullscreenViewer from "@/components/kit/FullscreenViewer";

function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => el.props.className === name);
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("")
    : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children)
      : typeof node === "string" || typeof node === "number" ? String(node) : "";
const press = (el: ReactElement<Record<string, unknown>>) => (el.props.onClick as () => void)();

let model: ImageViewModel;
const draw = () => { ui.index = 0; return ImageViewDesktop({ model, onClose: vi.fn() }); };
beforeEach(() => {
  ui.state = [];
  ui.login.mockClear();
  ui.funds.mockClear();
  model = {
    status: "ready", blank: false, guest: false, premium: false, promptId: "prompt", title: "Portrait", now: 0,
    artist: { handle: "amara", name: null },
    finished: [], fields: [], refs: [], cap: 0, discussion: { data: undefined }, queue: [], history: [], examples: [], community: [], jobs: [],
    core: { entry: null, supportsQuality: false }, models: [], button: { label: "Generate", dimmed: false },
    chip: "$0.60", perImage: "$0.20", count: 3, quotePending: false, short: null, funds: null,
    historyState: { loading: false, failed: false, retry: vi.fn(), more: false, loadingOlder: false, loadOlder: vi.fn() },
  } as unknown as ImageViewModel;
});

describe("the desktop header", () => {
  const head = (onBack = vi.fn()) => IvHeader({ model, onBack });

  it("goes back with Back", () => {
    const onBack = vi.fn();
    press(byClass(head(onBack), "iv-back kit-hit")[0]);
    expect(onBack).toHaveBeenCalledOnce();
  });

  // Kev, 2026-10-29: "remove bitte doch the profile image and the dollar on the top right corner wo auch immer das so
  // auftaucht wie zb bei image ui".
  it("shows a signed-in viewer nothing at the top right: no balance, no seal, on desktop and phone", () => {
    for (const phone of [false, true]) {
      const tree = IvHeader({ model, onBack: vi.fn(), phone });
      const right = byClass(tree, "iv-top-right")[0];
      expect([...walk(right.props.children as ReactNode)], String(phone)).toHaveLength(0);
      expect(byClass(tree, "iv-wallet")).toHaveLength(0);
      expect(byClass(tree, "iv-me")).toHaveLength(0);
    }
    expect(ui.funds).not.toHaveBeenCalled();
  });

  it("names the image's category beside Back, and nothing where there is none", () => {
    (model as { category: string | null }).category = "Portrait";
    expect(text(byClass(head(), "iv-top-cat")[0])).toBe("Portrait");
    (model as { category: string | null }).category = null;
    expect(byClass(head(), "iv-top-cat")).toHaveLength(0);
  });

  it("gives a guest Log in instead of a balance and an avatar", () => {
    model.guest = true;
    const tree = head();
    expect(byClass(tree, "iv-wallet")).toHaveLength(0);
    expect(byClass(tree, "iv-me")).toHaveLength(0);
    press(byClass(tree, "iv-login")[0]);
    expect(ui.login).toHaveBeenCalledOnce();
  });
});

describe("the desktop page", () => {
  // Kev (2026-10-26): a finished render's notice leads straight to the image; Esc or close leaves it in the Image UI.
  it("opens a finished render's notice in the viewer, and leaves it on the stage when the viewer closes", () => {
    const done = { key: "job:1", kind: "job", src: "/r/1.png", ratio: "1:1" } as ImageViewModel["finished"][number];
    model.finished = [{ key: "example:0", kind: "example", src: "/e.png", ratio: "1:1" } as ImageViewModel["finished"][number], done];
    model.seen = vi.fn();
    model.select = vi.fn();
    // The page's notices (RenderNotices) reach this view through useOpenRender, with its own open.
    const page = draw();
    const [taken, open, root] = ui.openRender.mock.calls.at(-1)!;
    // Its root is the page's own: a hidden page (another tab of the shell) takes no render.
    expect([taken, typeof open, byClass(page, "iv-root iv-v2 kit-focus")[0].props.ref === root]).toEqual([model, "function", true]);
    (open as (s: unknown) => void)(done);
    expect(model.seen).toHaveBeenCalledWith(done);
    const viewer = [...walk(draw())].find((el) => el.type === FullscreenViewer)!;
    expect(viewer.props.index).toBe(1);
    (viewer.props.onClose as (last: number) => void)(1);
    expect(model.select).toHaveBeenCalledWith(done);
    expect([...walk(draw())].filter((el) => el.type === FullscreenViewer)).toHaveLength(0);
  });

  // Kev (2026-10-21): the History column is there before the first render; a guest has none. Kev (2026-10-29: "'history'
  // sieht clickable aus. just write the text above"; DEC-504): open at 78 px, a plain name above it, never a button.
  it("gives a signed-in viewer the open History column with its name above it before the first render, a guest none", () => {
    const tree = draw();
    expect((byClass(tree, "iv-grid")[0].props.style as Record<string, string>)["--iv-strip"]).toBe("78px");
    expect([...walk(tree)].find((el) => el.type === HistoryRail)!.props.open).toBe(true);
    expect(byClass(tree, "iv-meta-hist-btn")).toHaveLength(0);
    expect(byClass(tree, "iv-meta-hist-label").map((s) => [s.type, s.props.children])).toEqual([["span", "History"]]);
    // The meta row keeps the column's place: its Premium badge ends where the hero does.
    expect(byClass(tree, "iv-meta-hist").map((s) => s.props["data-open"])).toEqual([true]);
    expect(byClass(tree, "iv-examples")[0].props["data-history"]).toBe("open");
    model.guest = true;
    expect((byClass(draw(), "iv-grid")[0].props.style as Record<string, string>)["--iv-strip"]).toBe("0px");
    expect(byClass(draw(), "iv-meta-hist")).toHaveLength(0);
  });

  // Review 2026-10-29: while the first read runs, a column its viewer folded stays folded (it never opens, then snaps shut).
  it("keeps a folded History folded while its first read runs, and opens it once it is known to be empty", () => {
    const strip = () => ((byClass(draw(), "iv-grid")[0].props.style as Record<string, string>)["--iv-strip"]);
    ui.state[0] = false; // folded, as the viewer left it
    (model.historyState as { loading: boolean }).loading = true;
    expect(strip()).toBe("40px");
    (model.historyState as { loading: boolean }).loading = false;
    expect(strip()).toBe("78px");
  });

  // Kev (2026-10-21): "let your ai use this prompt" above the generator module, never scrolled inside the prompt.
  it("stands the agent row right above the foot, outside the scroller, for a signed-in viewer only", () => {
    const col = () => [byClass(draw(), "iv-lcol")[0].props.children].flat() as ReactElement[];
    const kids = col();
    expect(kids.findIndex((k) => isValidElement(k) && k.type === AgentRow)).toBe(kids.findIndex((k) => isValidElement(k) && k.type === ComposeFoot) - 1);
    expect([...walk(byClass(draw(), "iv-left-scroll")[0])].filter((el) => el.type === AgentRow)).toHaveLength(0);
    model.guest = true;
    expect(col().filter((k) => isValidElement(k) && k.type === AgentRow)).toHaveLength(0);
  });

  it("heads the composer with the template's own name, not a slogan", () => {
    const tree = draw();
    expect(byClass(tree, "iv-make").map((h) => h.props.children)).toEqual(["Portrait"]);
    expect(byClass(tree, "iv-eyebrow")).toHaveLength(0);
  });

  it("puts Premium and its price per image beside who made it, and no price for a guest", () => {
    model.premium = true;
    expect(text(byClass(draw(), "iv-premium")[0])).toBe("Premium$0.20");
    model.guest = true;
    expect(text(byClass(draw(), "iv-premium")[0])).toBe("Premium");
    model.premium = false;
    expect(byClass(draw(), "iv-premium")).toHaveLength(0);
  });

  it("keeps this tab's renders in the History strip for a signed-in viewer, open from the start, else in the examples row", () => {
    const strip = () => [...walk(draw())].filter((el) => el.type === HistoryRail);
    const queue = () => [...walk(draw())].find((el) => el.type === PreviewStrip)!.props.queue;
    expect(strip().map((s) => s.props.open)).toEqual([true]);
    expect(queue()).toBe(false);
    model.history = [{ key: "history:1", kind: "history" }] as ImageViewModel["history"];
    expect(strip().map((s) => s.props.open)).toEqual([true]);
    expect(queue()).toBe(false);
    model.guest = true;
    expect(strip()).toHaveLength(0);
    expect(queue()).toBe(true);
  });

  it("gives the strip its share of the picture column, 78 px open and 40 px folded, and a toggle that keeps its state", () => {
    model.history = [{ key: "history:1", kind: "history" }] as ImageViewModel["history"];
    model.fields = [{ key: "a" }] as ImageViewModel["fields"];
    const strip = () => ((byClass(draw(), "iv-grid")[0].props.style as Record<string, string>)["--iv-strip"]);
    expect(strip()).toBe("78px");
    const toggle = byClass(draw(), "iv-meta-hist-btn")[0];
    expect(toggle.props.children).toBe("History ›");
    (toggle.props.onClick as () => void)();
    expect(strip()).toBe("40px");
    expect(byClass(draw(), "iv-meta-hist-btn")[0].props.children).toBe("‹");
    expect(byClass(draw(), "iv-examples")[0].props["data-history"]).toBe("folded");
  });

  it("says Yours with its time instead of who made it while one of the viewer's renders is on the hero", () => {
    model.main = { key: "history:1", kind: "history", createdAt: "2026-10-21T10:00:00Z" } as ImageViewModel["main"];
    const tree = draw();
    expect(text(byClass(tree, "iv-yours")[0])).toBe("Yours · 2h ago");
    expect(byClass(tree, "iv-meta-by")).toHaveLength(0);
  });

  it("gives the blank composer no meta row, no prompt actions and no rail", () => {
    model.blank = true;
    const tree = draw();
    expect(byClass(tree, "iv-metarow")).toHaveLength(0);
    expect([...walk(tree)].filter((el) => el.type === PromptActions)).toHaveLength(0);
    expect([...walk(tree)].filter((el) => el.type === HistoryRail)).toHaveLength(0);
  });

  it("says No reviews yet until a rating exists, then the average and the count", () => {
    model.discussion = { data: { avgRating: null, reviews: [], capped: false } } as unknown as ImageViewModel["discussion"];
    expect(byClass(draw(), "iv-meta-none")).toHaveLength(1);
    model.discussion = { data: { avgRating: 4.25, reviews: [{}, {}], capped: false } } as unknown as ImageViewModel["discussion"];
    const tree = draw();
    expect(byClass(tree, "iv-meta-none")).toHaveLength(0);
    expect(text(byClass(tree, "iv-rating")[0])).toBe("★4.3 (2)");
  });
});

describe("the header's data", () => {
  const MODEL = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"), "utf8");

  it("takes the category the prompt route sends, none in the blank composer", () => {
    expect(MODEL).toContain("category: blank ? null : (prompt?.category ?? null),");
  });
});

describe("the desktop styles", () => {
  const CSS = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
  const FRAME = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view-frame.css"), "utf8");

  it("lay the grid out as the handoff does: 360 px minimum composer, 72 px gap, the right column's width", () => {
    expect(CSS).toMatch(/\.iv-grid \{[^}]*grid-template-columns: minmax\(360px, 1fr\) minmax\(0, var\(--iv-col\)\);[^}]*gap: 72px;[^}]*padding: 8px 40px 40px 72px;/);
    expect(CSS).toMatch(/\.iv-rcol \{[^}]*max-width: var\(--iv-col\);/);
  });

  // Kev (2026-10-29): the user name keeps its spot at the top; a wide picture moves up under it, the examples below.
  it("start the picture column at the top, never centred", () => {
    expect(CSS).toMatch(/\.iv-rcol \{[^}]*align-self: start;/);
    expect(CSS).not.toMatch(/\.iv-rcol \{[^}]*align-self: center;/);
  });

  it("fit the picture column to the square the window's height leaves, so it never overflows a short window", () => {
    expect(CSS).toMatch(/\.iv-grid \{[^}]*--iv-col: calc\(max\(100dvh - var\(--ek-banner-h, 0px\), 620px\) - 288px \+ var\(--iv-strip, 0px\)\);/);
  });

  // Kev (2026-10-26): "by ARTIST" and the reviews were a bit small (13 px; the link 12.5).
  it("set who made it and the reviews at 15 px, the artist's link with them", () => {
    expect(CSS).toContain(".iv-metarow { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 10px; min-height: 32px; font-size: 15px;");
    expect(CSS).toContain(".iv-meta-by .iv-by-link { font-size: inherit; font-weight: 600; color: var(--enki-ink); }");
    // A narrow column (bench 1280x620, @studio_kevin_portraits): the name gives way, the review + stays clear of Premium.
    expect(CSS).toContain(".iv-meta-by > :not(:first-child) { flex-shrink: 0; }");
    expect(CSS).toContain(".iv-meta-by .iv-by-link { min-width: 0; overflow: hidden; text-overflow: ellipsis; }");
  });

  // Kev (2026-10-26): in a very short window nothing worked. Bench 1280x420: the prompt scroller 48 -> 209 px, the hero
  // 134 -> 334, and the page scrolls to Generate instead of squeezing it.
  it("lay the page out at least 620 px tall and scroll it below that", () => {
    expect(CSS).toContain(".iv-root.iv-v2 { display: flex; overflow-y: auto; }");
    expect(CSS).toContain(".iv-v2 .iv-main { min-height: 620px; }");
  });

  it("wrap the settings row only where the composer cannot hold it, so no pill is clipped", () => {
    expect(CSS).toContain(".iv-foot .iv-bar { --kit-pill-h: 38px; flex-wrap: wrap; min-width: 0; }");
  });

  it("give the hero a wide picture's shape, so no empty band sits above and below it; a portrait keeps the square", () => {
    const hero = () => [...walk(draw())].find((e) => e.props.className === "iv-hero")!;
    const ar = () => (hero().props.style as Record<string, number>)["--hero-ar"];
    expect(ar()).toBe(1);
    const main = [...walk(draw())].find((e) => typeof e.props.onRatio === "function")!;
    (main.props.onRatio as (r: number) => void)(2.4);
    expect(ar()).toBe(2.4);
    (main.props.onRatio as (r: number) => void)(0.66);
    expect(ar()).toBe(1);
  });

  it("make the hero a square, or a wide picture's own shape, with a 34 px radius, and the header 72 px high", () => {
    expect(CSS).toMatch(/\.iv-hero \{[^}]*aspect-ratio: var\(--hero-ar, 1\);[^}]*border-radius: 34px;/);
    expect(CSS).toMatch(/\.iv-top \{[^}]*height: 72px;/);
  });

  // DEC-502 (Kev, 2026-10-29: "diese komischen grauen felder links und rechts am bild ... get rid of these").
  it("paint nothing around the picture: the square has no fill or shadow, the picture its corners and none of its own", () => {
    expect(CSS).not.toMatch(/\.iv-hero \{[^}]*(background|box-shadow)/);
    expect(CSS).toContain(".iv-hero .iv-box { border-radius: 34px; box-shadow: none; }");
  });

  // DEC-503 (Kev, 2026-10-29: "the schatten unter dem generate button ... wird unten am rand kantig").
  it("keep Generate's glow inside the foot that clips it: 8 px under the button, none at its sides", () => {
    expect(CSS).toContain(".iv-foot .kit-gen--hero:not([data-short]) { box-shadow: 0 8px 12px -12px color-mix(in oklab, var(--enki-ember) 32%, transparent); }");
    expect(CSS).toMatch(/\.iv-foot \{[^}]*overflow-x: hidden;/);
  });

  // Kev (2026-10-21): "let your agent use this prompt" must be slightly larger.
  it("set the agent row at 13.5 px, 36 px high, its x402 badge at 10.5 px", () => {
    expect(CSS).toMatch(/\.iv-agent-toggle \{[^}]*height: 36px;[^}]*font-size: 13\.5px;/);
    expect(CSS).toMatch(/\.iv-agent-badge \{[^}]*font: 400 10\.5px\/1\.3 var\(--font-mono\)/);
  });

  // Bench 1440x900: the actions beside a two-line title, the row 78 px (89 with them under it).
  it("keep the actions beside the title, which wraps in its own room", () => {
    expect(CSS).toContain(".iv-titles { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }");
  });

  // The tiles' z-indexes (up to 80) stayed in the scroller's context and painted over the sticky head (3).
  it("paint the photos as one layer, under the sticky head", () => {
    expect(CSS).toContain(".iv-deck-box { position: relative; isolation: isolate; transition: height 0.25s ease; }");
  });

  // Line height 1.08 put the clamp's clip 0.88 em above the baseline: Ä lost its dots, É its accent. Bench: the clip
  // now starts 4 px higher at 36 px, the heading where it was.
  it("clip the title's two lines at the font's ascent, not the line box", () => {
    expect(CSS).toMatch(/\.iv-make \{\n  display: -webkit-box;\n  margin: -0\.11em 0 0;\n  padding-top: 0\.11em;\n  overflow: hidden;/);
  });

  // Kev (2026-10-21): the hover over a photo place stayed far too long (0.3 s back, the shadow snapping).
  it("lift a hovered photo and let it go in 0.12 s, its shadow with it; places still move in 0.3 s", () => {
    expect(CSS).toContain("transition: left 0.3s ease, top 0.3s ease, width 0.3s ease, height 0.3s ease, transform 0.12s ease-out, box-shadow 0.12s ease-out, filter 0.12s ease-out;");
  });

  // Bench 1440x675, a 340 px agent request open: before, Generate's foot shrank (128 of 140 px even closed); now the foot
  // keeps 141, the fold stops at 169 and scrolls, the prompt keeps 135.
  it("never squeeze Generate's foot; the open x402 fold scrolls within itself", () => {
    expect(CSS).toContain(".iv-v2 .iv-foot { flex-shrink: 0; gap: 12px; padding: 14px 0 0; border-top: 1px solid var(--enki-rule-2); }");
    expect(CSS).toContain(".iv-v2 .iv-lcol > .iv-agent .iv-agent-fold-in { max-height: min(25dvh, 300px); overflow-y: auto; }");
  });

  // Handoff README: "Preis-Badge oben rechts im Hero". Bench 2048x1103: the badge ended mid-row (1536-1651) beside the
  // History spacer; now it ends at the hero's edge (1930 = 1930 open, 1968 = 1968 empty), the spacer over the strip.
  it("end the Premium badge at the hero's top right, the History spacer over the strip", () => {
    expect(CSS).toContain(".iv-metarow > .iv-premium { margin-left: auto; }");
    expect(CSS).toContain(".iv-meta-hist { display: flex; flex-shrink: 0; justify-content: center; width: 64px; margin-left: 4px; }");
  });

  // Bench 2048x1103: folded, the strip's vertical label made the hero 817 x 1103; out of the flow it stays 817 x 817.
  it("keep the folded History's label out of the flow, so the hero stays square", () => {
    expect(CSS).toContain(".iv-hstrip-fold { position: absolute; inset: 0; padding: 0;");
    // It fills the strip, which clips: the keyboard's ring goes inside it.
    expect(CSS).toContain(".iv-hstrip-fold:focus-visible { outline-offset: -2px; }");
    // Folded, a visible rail (Kev, 2026-10-26: "history is barely visible").
    expect(CSS).toContain('.iv-hstrip[data-open="false"] { width: 26px; border-radius: 13px; background: var(--enki-fill); }');
    // Both History labels in ink-2: ink-3 at 12 px read 3.77:1 on the dark rail, 3.58:1 on purple, 4.24:1 on purple paper (AA: 4.5).
    expect(CSS).toMatch(/\.iv-hstrip-fold \{[^}]*color: var\(--enki-ink-2\)/);
    expect(CSS).toMatch(/\.iv-meta-hist-btn \{[^}]*color: var\(--enki-ink-2\)/);
  });

  it("drop the menu's toggles to the header's middle only while the v2 header shows", () => {
    expect(FRAME).toContain(".ek-app:has(.iv-frame:not(.is-hidden) .iv-top) .ek-toggles { top: 24px; }");
  });
});
