import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "@/lib/__tests__/_read-source";
import type { ImageViewModel, Shot } from "@/components/image-view/useImageViewModel";

/**
 * Reviews and comments in one panel (image UI v2, handoff §5.16, README §5.9,
 * plan B13): it lies over the hero (desktop) or the frame (phone); writing is
 * stars and words, then one of the viewer's renders of this prompt or None,
 * and opens only once they have made one.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], s: 0, login: vi.fn(), creator: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
  useEffect: () => {},
  useEffectEvent: <F>(f: F) => f,
}));
vi.mock("react-dom", async (original) => ({ ...(await original<typeof import("react-dom")>()), createPortal: (node: ReactNode) => node }));
vi.mock("@/lib/openLogin", () => ({ openLogin: ui.login }));
vi.mock("@/lib/openCreator", () => ({ openCreator: ui.creator }));

import ReviewsPanel from "@/components/image-view/ReviewsPanel";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => el.props.className === name);
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("")
    : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children)
      : typeof node === "string" || typeof node === "number" ? String(node) : "";
const button = (tree: ReactNode, label: string) => [...walk(tree)].find((el) => el.type === "button" && text(el) === label);
const press = (el: El | undefined) => (el!.props.onClick as (e?: unknown) => void)({ stopPropagation: vi.fn() });

const STATE = { leaving: 0, step: 1, stars: 2, text: 3, pick: 4, busy: 5, open: 6 };
const render = (id: string) => ({ key: `history:${id}`, kind: "history", thumb: `/${id}.png`, record: { id } }) as unknown as Shot;
const row = (id: string, at: string, extra = {}) => ({ id, handle: "amara", rating: null, body: `says ${id}`, imageUrl: null, createdAt: at, ...extra });
let model: ImageViewModel;
let onClose: () => void;
const draw = (over: { phone?: boolean; compose?: boolean; hero?: { left: number; top: number; width: number; height: number } | null } = {}) => {
  ui.s = 0;
  return ReviewsPanel({ model, from: { left: 900, top: 90, width: 60, height: 20 }, hero: over.hero === undefined ? { left: 852, top: 122, width: 470, height: 470 } : over.hero,
    phone: over.phone ?? false, compose: over.compose, onClose }) as El;
};
beforeEach(() => {
  ui.state = []; ui.login.mockClear(); ui.creator.mockClear(); onClose = vi.fn();
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { body: {} });
  model = {
    guest: false, canPost: true, now: Date.parse("2026-10-21T12:00:00Z"), reviewable: [render("r1"), render("r2")],
    discussion: { data: { reviews: [row("a", "2026-10-21T09:00:00Z", { rating: 5, imageUrl: "/a.png" })], comments: [row("b", "2026-10-21T11:00:00Z")], avgRating: 5, capped: false }, error: null, retry: vi.fn() },
    post: vi.fn(async () => true),
  } as unknown as ImageViewModel;
});

describe("where the panel lies", () => {
  it("over the hero on desktop, down to 24 px above the bottom, morphing out of what opened it", () => {
    const style = byClass(draw(), "iv-rv-panel")[0].props.style as Record<string, unknown>;
    expect(style).toMatchObject({ left: 852, top: 122, width: 470, height: 754, transformOrigin: "78px -22px" });
  });
  it("inset 12 and 56 from the top on a phone", () => {
    expect(byClass(draw({ phone: true, hero: null }), "iv-rv-panel")[0].props.style).toMatchObject({ left: 12, top: 56, width: 1416, height: 832 });
  });
});

describe("the head", () => {
  it("gives the average and both counts, Write a review while allowed, and closes", () => {
    const tree = draw();
    expect(text(byClass(tree, "iv-rv-counts")[0])).toBe("1 review · 1 comment");
    expect(button(tree, "Write a review")).toBeDefined();
    press(byClass(tree, "iv-rv-close kit-hit")[0]);
    expect(ui.state[STATE.leaving]).toBe(true);
  });
  it("says Reviews without a rating, and offers no writing to someone who has not made an image", () => {
    model.discussion = { ...model.discussion, data: { ...model.discussion.data!, avgRating: null } };
    model.canPost = false;
    const tree = draw({ compose: true });
    expect(text(byClass(tree, "iv-rv-avg")[0])).toBe("Reviews");
    expect(button(tree, "Write a review")).toBeUndefined();
    expect(byClass(tree, "iv-rv-card")).toHaveLength(0);
  });
});

describe("the entries", () => {
  it("are the reviews and comments together, newest first; a tap opens the text, a name opens the profile", () => {
    const entries = [...walk(draw())].filter((el) => el.props.row);
    expect(entries.map((e) => e.key)).toEqual(["b", "a"]);
    const article = (entries[0].type as (p: unknown) => El)(entries[0].props);
    press(article);
    expect(ui.state[STATE.open]).toBe("b");
    const stop = vi.fn();
    (byClass(article, "iv-rv-who")[0].props.onClick as (e: unknown) => void)({ stopPropagation: stop });
    expect(ui.creator).toHaveBeenCalledWith("amara");
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("writing", () => {
  it("opens straight into the composer from the +, and Send waits for words or stars", () => {
    let tree = draw({ compose: true });
    expect(button(tree, "Send")!.props.disabled).toBe(true);
    const third = [...walk(tree)].filter((el) => el.props.className === "iv-star")[2];
    press(third);
    expect(ui.state[STATE.stars]).toBe(3);
    tree = draw();
    press([...walk(tree)].filter((el) => el.props.className === "iv-star")[2]);
    expect(ui.state[STATE.stars]).toBe(0);
    ui.state[STATE.text] = "nice";
    expect(button(draw(), "Send")!.props.disabled).toBe(false);
  });

  it("then picks the newest render by default, and posts a review with it", async () => {
    ui.state[STATE.step] = "pick"; ui.state[STATE.stars] = 4; ui.state[STATE.text] = " great ";
    const tree = draw();
    expect([...walk(tree)].find((el) => el.props.role === "radio" && el.props["aria-checked"] === true)!.key).toBe("history:r1");
    press(button(tree, "Post review"));
    await Promise.resolve();
    expect(model.post).toHaveBeenCalledWith({ imageId: "r1", rating: 4, body: "great" });
  });

  it("with None posts a comment, which needs words", () => {
    ui.state[STATE.step] = "pick"; ui.state[STATE.pick] = null; ui.state[STATE.stars] = 4;
    expect(button(draw(), "Post comment")!.props.disabled).toBe(true);
    ui.state[STATE.text] = "hi";
    press(button(draw(), "Post comment"));
    expect(model.post).toHaveBeenCalledWith({ body: "hi" });
  });
});

describe("with nothing written yet", () => {
  beforeEach(() => { model.discussion = { ...model.discussion, data: { reviews: [], comments: [], written: [], avgRating: null, capped: false } }; });
  it("asks the viewer who has made an image to write the first review", () => {
    press(button(draw(), "Write the first review"));
    expect(ui.state[STATE.step]).toBe("write");
  });
  it("sends a guest to sign in, and tells everyone else to make an image first", () => {
    model.guest = true; model.canPost = false;
    press(button(draw(), "Sign in to review"));
    expect(ui.login).toHaveBeenCalledOnce();
    model.guest = false;
    expect(text(byClass(draw(), "iv-rv-hint")[0])).toBe("Make an image with this prompt first. Then you can leave a review.");
  });
});

describe("the layouts", () => {
  const view = (f: string) => readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", f));
  it("open it from the rating and, once allowed, the + on desktop, from the hero's chip on the phone; the old Discussion is gone", () => {
    const desktop = view("ImageViewDesktop.tsx");
    expect(desktop).toContain("onClick={(e) => openReviews(e, false)}>");
    expect(desktop).toContain("{talk && m.canPost && (");
    expect(desktop).toContain("title=\"Write a review · you've made images with this prompt\" onClick={(e) => openReviews(e, true)}>");
    const phone = view("ImageViewMobile.tsx");
    expect(phone).toContain('<button type="button" className="iv-mchip" title="Read the reviews" onClick={(e) => setReviews(e.currentTarget.getBoundingClientRect())}>');
    for (const v of [desktop, phone]) expect(v).not.toContain("<Discussion");
  });
});
