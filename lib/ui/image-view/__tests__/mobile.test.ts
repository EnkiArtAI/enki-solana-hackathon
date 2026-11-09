import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ImageViewModel, Shot } from "@/components/image-view/useImageViewModel";

const ui = vi.hoisted(() => ({ state: [] as unknown[], index: 0, phone: true, query: "", model: null as unknown, openRender: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "mobile-test",
  useRef: <T>(start: T) => ({ current: start }),
  useState: <T>(start: T) => {
    const i = ui.index++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: (query: string) => { ui.query = query; return ui.phone; } }));
vi.mock("@/components/kit/notify", () => ({ notify: vi.fn(), useToastOffset: () => {} }));
vi.mock("@/components/image-view/useImageViewModel", () => ({ useImageViewModel: () => ui.model }));
vi.mock("@/components/image-view/ImageViewDesktop", () => ({ default: () => null }));
vi.mock("@/components/enki/NftPickerModal", () => ({ default: () => null }));
vi.mock("@/components/generation/BoostToggle", () => ({ default: () => null }));
vi.mock("@/components/kit/AddFundsPopover", () => ({ default: () => null }));
vi.mock("@/components/kit/CostLine", () => ({ default: () => null }));
vi.mock("@/components/kit/FullscreenViewer", () => ({ default: () => null }));
vi.mock("@/components/kit/GenerateButton", () => ({ default: () => null }));
vi.mock("@/components/kit/GeneratorPill", () => ({ default: () => null }));
vi.mock("@/components/kit/JobTile", () => ({ default: () => null }));
vi.mock("@/components/kit/ReferenceTiles", () => ({ default: () => null }));
vi.mock("@/components/kit/SettingsPills", () => ({ RatioPill: () => null, ResolutionPill: () => null, QualityPill: () => null }));
vi.mock("@/components/image-view/AgentRow", () => ({ default: () => null }));
vi.mock("@/components/image-view/useOpenRender", () => ({ useOpenRender: ui.openRender }));
vi.mock("@/components/image-view/ComposeFoot", () => ({ default: () => null, refHint: () => "" }));
vi.mock("@/components/image-view/IvHeader", () => ({ default: () => null }));
vi.mock("@/components/image-view/MainImage", () => ({ default: () => null }));
vi.mock("@/components/image-view/PromptPanel", () => ({ default: () => null }));
vi.mock("@/components/image-view/ViewerPanel", () => ({ default: () => null }));

import ImageView from "@/components/image-view/ImageView";
import { IV_MOBILE } from "@/lib/ui/kit/breakpoints";
import ImageViewDesktop from "@/components/image-view/ImageViewDesktop";
import ImageViewMobile from "@/components/image-view/ImageViewMobile";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import GenerateButton from "@/components/kit/GenerateButton";
import JobTile from "@/components/kit/JobTile";
import ViewerPanel from "@/components/image-view/ViewerPanel";
import MainImage from "@/components/image-view/MainImage";
import ComposeFoot from "@/components/image-view/ComposeFoot";
import IvHeader from "@/components/image-view/IvHeader";
import PreviewStrip from "@/components/image-view/PreviewStrip";

function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const ofType = (tree: ReactNode, type: unknown) => [...walk(tree)].filter((el) => el.type === type);
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("")
    : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children)
      : typeof node === "string" || typeof node === "number" ? String(node) : "";
let model: ImageViewModel;
const draw = () => { ui.index = 0; return ImageViewMobile({ model, onClose: vi.fn() }); };
const press = (element: ReactElement<Record<string, unknown>>) => (element.props.onClick as () => void)();
const shot = (id: string, status: "ready" | "failed" | "rendering"): Shot => ({
  key: `job:${id}`, kind: "job", ratio: "4:5", src: status === "ready" ? "/fixture.png" : undefined,
  job: { id, status, seen: false } as Shot["job"],
});
beforeEach(() => {
  ui.state = []; ui.index = 0; ui.phone = true;
  model = {
    status: "ready", blank: false, guest: false, premium: false, promptId: "prompt", title: "Portrait", now: 0,
    queue: [], jobs: [], finished: [], history: [], examples: [], community: [], main: null,
    discussion: { data: undefined }, core: { entry: null, supportsQuality: false, boostAvailable: false, boostAt: () => false },
    refs: [], cap: 0, over: 0, pending: 0, models: [], modelPrices: [], button: { label: "Generate", dimmed: false },
    chip: "$0.60", perImage: "$0.20", count: 3, quotePending: false, short: null, funds: null,
    historyState: { loading: false, failed: false, more: false, retry: vi.fn(), loadOlder: vi.fn() },
    select: vi.fn(), seen: vi.fn(), generate: vi.fn(), again: vi.fn(),
  } as unknown as ImageViewModel;
  ui.model = model;
});

describe("the phone Image View", () => {
  it("chooses the phone layout with the same model, and keeps desktop above the breakpoint", () => {
    expect(ImageView({ seed: "blank" }).type).toBe(ImageViewMobile);
    expect(ui.query).toBe(IV_MOBILE);
    ui.phone = false;
    expect(ImageView({ seed: "blank" }).type).toBe(ImageViewDesktop);
  });
  it("puts the stage in the hero and the public images in the Examples row under it, not beside it (Kev, 2026-10-26)", () => {
    model.examples = Array.from({ length: 4 }, (_, i) => ({ key: "example:" + i, kind: "example", src: "/example" + i + ".png", ratio: "4:5" } as Shot));
    model.finished = model.examples;
    const tree = draw();
    const hero = [...walk(tree)].find((el) => el.props.className === "iv-mhero")!;
    expect(ofType(hero, MainImage)).toHaveLength(1);
    const scroll = [...walk(tree)].find((el) => el.props.className === "iv-mscroll")!;
    const kids = (scroll.props.children as ReactNode[]).filter(isValidElement) as ReactElement<Record<string, unknown>>[];
    const row = kids.findIndex((el) => el.props.className === "iv-mhero-row");
    expect(kids[row + 1].props.className).toBe("iv-examples");
    expect(text(kids[row + 1])).toBe("Examples");
    expect(ofType(kids[row + 1], PreviewStrip).map((el) => el.props)).toEqual([{ model, queue: false }]);
    // The column at the hero's right holds no example any more.
    expect([...walk(tree)].filter((el) => el.props.className === "iv-mthumb")).toHaveLength(0);
  });
  it("keeps the History at the hero's right for a signed-in viewer, a narrow rail with nothing on it while it is empty", () => {
    // In the hero's row, after the hero: the row's own children are exactly [hero, History].
    const row = [...walk(draw())].find((el) => el.props.className === "iv-mhero-row")!;
    const inRow = ([row.props.children].flat(2) as ReactNode[]).filter(isValidElement) as ReactElement<Record<string, unknown>>[];
    expect(inRow.map((el) => el.props.className)).toEqual(["iv-mhero", "iv-mthumbs kit-noscroll"]);
    const column = () => [...walk(draw())].find((el) => el.props.className === "iv-mthumbs kit-noscroll");
    expect(column()!.props).toMatchObject({ "aria-label": "History", "data-empty": "" });
    // Nothing written on the empty rail (Kev, 2026-10-26: "strange ... 'history' when there is no history").
    expect(text(column()!)).toBe("");
    expect([...walk(draw())].some((el) => el.props.className === "iv-examples")).toBe(false);
    model.history = [{ key: "history:h", kind: "history", ratio: "4:5", thumb: "/h.png" } as Shot];
    expect(column()!.props["data-empty"]).toBeUndefined();
    expect(text(column()!)).toBe("History");
    model.history = []; model.historyState = { ...model.historyState, failed: true };
    expect(column()!.props["data-empty"]).toBeUndefined();
    model.historyState = { ...model.historyState, failed: false };
    model.guest = true;
    expect(column()).toBeUndefined();
  });
  it("shows the public images made with it under the image even without a creator example", () => {
    model.community = [{ key: "community:c", kind: "community", src: "/c.png", thumb: "/c.png", ratio: null, maker: { handle: "amara" } } as unknown as Shot];
    const ex = [...walk(draw())].find((el) => el.props.className === "iv-examples")!;
    expect(text(ex)).toBe("Examples");
    expect(ofType(ex, PreviewStrip).map((el) => el.props)).toEqual([{ model, queue: false }]);
  });
  it("leads the Examples row with this tab's renders where there is no History (the blank composer)", () => {
    model.blank = true; model.queue = [shot("q", "rendering")];
    const strip = ofType(draw(), PreviewStrip);
    expect(strip.map((el) => el.props.queue)).toEqual([true]);
    expect([...walk(draw())].some((el) => el.props.className === "iv-examples-label")).toBe(false);
  });
  it("heads the scroller with the prompt's title, above its image (Kev, 2026-10-26), a small Back before it (DEC-460)", () => {
    const onClose = vi.fn();
    ui.index = 0;
    const scroll = [...walk(ImageViewMobile({ model, onClose }))].find((el) => el.props.className === "iv-mscroll")!;
    const kids = (scroll.props.children as ReactNode[]).filter(isValidElement) as ReactElement<Record<string, unknown>>[];
    expect(kids[0].props.className).toBe("iv-mtitle-row");
    const [back, title] = ([kids[0].props.children].flat() as ReactNode[]).filter(isValidElement) as ReactElement<Record<string, unknown>>[];
    expect(back.props).toMatchObject({ type: "button", className: "iv-mback kit-hit", "aria-label": "Back" });
    expect(back.props.onClick).toBe(onClose);
    expect(title.type).toBe("h1");
    expect(text(title)).toBe("Portrait");
    expect(kids.findIndex((el) => el.props.className === "iv-mhero-row")).toBeGreaterThan(0);
  });
  it("draws that Back quiet, centred on the title's first line (DEC-460)", () => {
    const CSS = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view-mobile.css"), "utf8");
    expect(CSS).toContain(".iv-mtitle-row { display: flex; align-items: flex-start; gap: 2px; }");
    expect(CSS).toMatch(/\.iv-mback \{\n  flex-shrink: 0; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px;\n  margin: 10px 0 0 -6px; padding: 0; border: 0; border-radius: 50%; background: none; color: var\(--enki-ink-3\);/);
  });
  it("has the phone header, whose Back is the view's way out, and the shared foot", () => {
    const onClose = vi.fn();
    ui.index = 0;
    const tree = ImageViewMobile({ model, onClose });
    const head = ofType(tree, IvHeader)[0];
    expect(head.props).toMatchObject({ phone: true, onBack: onClose });
    expect(ofType(tree, ComposeFoot)).toHaveLength(1);
    expect(ofType(tree, GenerateButton)).toHaveLength(0);
  });
  it("opens failed jobs with their setup in the existing Retry panel", () => {
    const failed = shot("f", "failed"); model.queue = [failed];
    press(ofType(draw(), JobTile)[0]);
    const viewer = ofType(draw(), FullscreenViewer)[0];
    expect(viewer.props).toMatchObject({ layout: "stacked", nav: "dots", index: 0 });
    expect(viewer.props.items).toMatchObject([{ key: failed.key, failed: { message: expect.any(String) } }]);
    expect((viewer.props.panel as ReactElement).type).toBe(ViewerPanel);
    expect((viewer.props.panel as ReactElement<{ shot: Shot }>).props.shot).toBe(failed);
    expect(model.again).not.toHaveBeenCalled();
  });
  it("marks a ready job seen without moving it into History when its viewer closes", () => {
    const ready = shot("r", "ready"); model.queue = [ready]; model.finished = [ready];
    press(ofType(draw(), JobTile)[0]);
    const viewer = ofType(draw(), FullscreenViewer)[0];
    (viewer.props.onClose as (last: number) => void)(0);
    expect(model.seen).toHaveBeenCalledWith(ready);
    expect(model.select).toHaveBeenCalledWith(ready);
    expect(model.queue).toEqual([ready]); expect(model.history).toEqual([]);
    expect(ofType(draw(), FullscreenViewer)).toHaveLength(0);
  });
  it("opens a finished render's notice in its viewer, through its own root", () => {
    const ready = shot("r", "ready"); model.finished = [ready];
    const page = draw();
    const [taken, open, root] = ui.openRender.mock.calls.at(-1)!;
    expect([taken, [...walk(page)].find((el) => el.props.className === "iv-root iv-mobile kit-focus")!.props.ref === root]).toEqual([model, true]);
    (open as (s: Shot) => void)(ready);
    expect(ofType(draw(), FullscreenViewer)).toHaveLength(1);
  });
  it("shows a rendering job on the stage without opening a finished-image viewer", () => {
    const pending = shot("p", "rendering"); model.queue = [pending];
    press(ofType(draw(), JobTile)[0]);
    expect(model.select).toHaveBeenCalledWith(pending);
    expect(ofType(draw(), FullscreenViewer)).toHaveLength(0);
  });
  it("puts the viewer's renders in the History column, and loads one through the model", () => {
    const history = { key: "history:h", kind: "history", ratio: "4:5", thumb: "/h.png" } as Shot;
    model.history = [history];
    const tree = draw();
    expect([...walk(tree)].filter((el) => el.props.className === "iv-mthumbs-yours")).toHaveLength(1);
    const entry = [...walk(tree)].find((el) => el.props.className === "iv-mthumb" && String(el.props["aria-label"]).startsWith("Your render"))!;
    press(entry); expect(model.select).toHaveBeenCalledWith(history);
  });
  it("never offers another person's renders to guests or the blank composer", () => {
    model.history = [{ key: "history:h", kind: "history", ratio: "4:5", thumb: "/h.png" } as Shot];
    const yours = () => [...walk(draw())].filter((el) => el.props.className === "iv-mthumbs-yours");
    expect(yours()).toHaveLength(1);
    model.guest = true;
    expect(yours()).toHaveLength(0);
    model.guest = false; model.blank = true;
    expect(yours()).toHaveLength(0);
  });
  it("loads older renders as the column nears its end", () => {
    model.history = [{ key: "history:h", kind: "history", ratio: "4:5", thumb: "/h.png" } as Shot];
    model.historyState = { ...model.historyState, more: true, loadingOlder: false, loadOlder: vi.fn() };
    const column = [...walk(draw())].find((el) => el.props.className === "iv-mthumbs kit-noscroll")!;
    (column.props.onScroll as (e: unknown) => void)({ currentTarget: { scrollTop: 0, clientHeight: 300, scrollHeight: 1000 } });
    expect(model.historyState.loadOlder).not.toHaveBeenCalled();
    (column.props.onScroll as (e: unknown) => void)({ currentTarget: { scrollTop: 600, clientHeight: 300, scrollHeight: 1000 } });
    expect(model.historyState.loadOlder).toHaveBeenCalledOnce();
  });
  it("shows who made it and the rating at the top left above the image, and Premium with its price only to a signed-in viewer", () => {
    model.artist = { handle: "amara", name: null };
    model.discussion = { data: { avgRating: 4.8, reviews: [{}, {}], capped: false } } as unknown as ImageViewModel["discussion"];
    model.premium = true;
    const chip = [...walk(draw())].find((el) => el.props.className === "iv-mchip")!;
    expect(text(chip)).toBe("by @amara · ★ 4.8 (2)");
    // A row of its own between the title and the image, chip first, as the desktop's meta row (Kev, 2026-10-26).
    const scroll = [...walk(draw())].find((el) => el.props.className === "iv-mscroll")!;
    const kids = (scroll.props.children as ReactNode[]).filter(isValidElement) as ReactElement<Record<string, unknown>>[];
    const row = kids.findIndex((el) => el.props.className === "iv-mmeta");
    expect([kids[row - 1]?.props.className, kids[row + 1]?.props.className]).toEqual(["iv-mtitle-row", "iv-mhero-row"]);
    const inRow = [...walk(kids[row])].map((el) => el.props.className).filter(Boolean);
    expect(inRow.slice(0, 2)).toEqual(["iv-mmeta", "iv-mchip"]);
    expect(inRow).toContain("iv-premium iv-mpremium");
    const hero = [...walk(draw())].find((el) => el.props.className === "iv-mhero")!;
    expect([...walk(hero)].some((el) => el.props.className === "iv-mchip" || el.props.className === "iv-premium iv-mpremium")).toBe(false);
    expect(text([...walk(draw())].find((el) => el.props.className === "iv-premium iv-mpremium")!)).toBe("Premium$0.20");
    model.guest = true;
    expect(text([...walk(draw())].find((el) => el.props.className === "iv-premium iv-mpremium")!)).toBe("Premium");
  });
});

describe("the phone styles", () => {
  const CSS = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view-mobile.css"), "utf8");

  it("hold the header and the foot still and scroll only what is between them", () => {
    expect(CSS).toContain(".iv-root.iv-mobile { display: flex; flex-direction: column; overflow: hidden;");
    expect(CSS).toMatch(/\.iv-mscroll \{[^}]*flex: 1;[^}]*min-height: 0;[^}]*overflow-y: auto;/);
    // Never sideways: the words sliding in from the right gave a finger 26 px to pan (Kev, 2026-10-29).
    expect(CSS).toMatch(/\.iv-mscroll \{[^}]*overflow-x: hidden;/);
    expect(CSS).toContain(".iv-mobile .iv-foot { flex-shrink: 0;");
    expect(CSS).toContain(".iv-top.iv-top--phone { height: 52px; padding: 0 20px; }");
  });

  it("fit the hero's 28 px frame to the picture, no grey bars beside it, and the thumb column 52 px wide", () => {
    // Kev, 2026-10-26: "links und rechts so graue balken bei anderer größe als cube, get rid of that".
    const hero = CSS.match(/\.iv-mhero \{[^}]*\}/)![0];
    expect(hero).toContain("border-radius: 28px;");
    expect(hero).not.toMatch(/aspect-ratio|background/);
    expect(CSS).toContain(".iv-mhero .iv-heronav,\n.iv-mhero .iv-hero-slide { position: relative; inset: auto; }");
    expect(CSS).toContain(".iv-mhero .iv-stage { position: relative; height: auto; min-height: 0; container-type: normal; }");
    expect(CSS).toContain(".iv-mhero .iv-box { width: 100%; height: auto; border-radius: 0; box-shadow: none; }");
    // Without a picture there is nothing to hug: a tall asked ratio stops at half the screen (review 2026-10-26).
    expect(CSS).toContain(".iv-mhero .iv-box:not(:has(.iv-open)) { max-height: 50dvh; }");
    expect(CSS).toMatch(/\.iv-mthumbs \{[^}]*width: 52px;/);
  });

  it("hold the History column to the hero's height, a filled rail while empty, and give the phone the desktop's Examples strip", () => {
    expect(CSS).toMatch(/\.iv-mthumbs \{[^}]*align-self: stretch;[^}]*overflow-y: auto;[^}]*contain: size;/);
    expect(CSS).toContain(".iv-mthumbs[data-empty] { width: 26px; padding: 0; border-radius: 13px; background: var(--enki-fill); }");
    expect(CSS).not.toContain("writing-mode");
    const shared = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
    expect(shared).toContain(":is(.iv-v2, .iv-mobile) .iv-strip-arrow { display: none; }");
    expect(shared).toContain(":is(.iv-v2, .iv-mobile) .iv-thumb { width: 60px; height: 60px; border-radius: 15px; }");
    // The picture fills its square, so a portrait leaves no grey band (review 2026-10-26).
    expect(shared).toContain(":is(.iv-v2, .iv-mobile) .iv-thumb img { width: 100%; }");
    expect(shared).toMatch(/\.iv-thumb img \{[^}]*height: 100%; object-fit: cover;/);
  });

  it("leave room under the header before the title, and either side of Full prompt's text (Kev, 2026-10-26)", () => {
    expect(CSS).toMatch(/.iv-mtitle { margin: 12px 0 0;/);
    expect(CSS).toContain(".iv-mobile .iv-doc { font-size: 15.5px; padding: 0 12px; }");
  });

  it("set who made it as a plain line in its row, not a chip over the image", () => {
    expect(CSS).toContain(".iv-mmeta { display: flex; align-items: center; justify-content: space-between;");
    expect(CSS).toMatch(/\.iv-mchip \{[^}]*background: none;[^}]*text-overflow: ellipsis;/);
    expect(CSS).not.toMatch(/\.iv-mchip \{[^}]*position: absolute/);
    expect(CSS).not.toMatch(/\.iv-mpremium \{[^}]*position: absolute/);
  });

  it("stop the column at 560 px from 600 px up, full width below that", () => {
    expect(CSS).toMatch(/@media \(min-width: 600px\) \{\n\s+\.iv-root\.iv-mobile > \* \{ width: 100%; max-width: 560px; margin-inline: auto; \}/);
  });
});
