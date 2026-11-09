import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "./_read-source";
import type { FeedCard as Card } from "@/lib/ui/feed/card";

/**
 * DEC-456 (Kev, 2026-10-27, phone screenshots: "the images on profile ... sehen ja sehr kaputt aus ... the behavior
 * should be also exactly the same as on the main page"): a profile's Released is Home's wall, its cards from the
 * profile's own read (no second one), and on the own profile each card keeps the pencil into the editor.
 */
const q = vi.hoisted(() => ({ calls: [] as { queryKey: unknown[]; enabled?: boolean }[], marks: [] as boolean[] }));
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useState: <T,>(start: T) => [start, () => {}],
  useRef: <T,>(start: T) => ({ current: start }),
  useEffect: () => {},
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey: unknown[]; enabled?: boolean }) => { q.calls.push(o); return { data: undefined, isPending: true, error: null }; },
  useQueryClient: () => ({ prefetchQuery: () => Promise.resolve() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({ access: "ok", role: "beta", adultConfirmed: false, adultPill: false }) }));
vi.mock("@/hooks/useBookmarkIndex", () => ({ useBookmarkIndex: (on: boolean) => { q.marks.push(on); return null; } }));
vi.mock("@/components/enki/EnkiDetailPanel", () => ({ default: () => null, preloadImageUI: () => {} }));
vi.mock("@/components/enki/BookmarkPicker", () => ({ default: () => null }));

import PromptWall from "@/components/enki/PromptWall";
import FeedCard from "@/components/enki/FeedCard";
import MasonryGrid from "@/components/enki/MasonryGrid";

function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const card: Card = { openVideo: null, id: "p1", title: "Crystal logo", priceCents: 0, category: "logo", images: [{ url: "/a.png" }] as Card["images"], ratio: 1, creator: null, publicText: false, stats: null, video: null };
const edit = (tree: ReactNode) => [...walk(tree)].filter((el) => el.props.className === "feed-card-edit kit-hit");

beforeEach(() => { q.calls = []; q.marks = []; });

describe("the wall with the cards in hand", () => {
  it("reads nothing again, shows them in Home's grid, and hands each card the pencil", () => {
    const onEdit = vi.fn();
    const tree = PromptWall({ cards: [card], onEdit });
    expect(q.calls.find((c) => c.queryKey[0] === "prompt-cards")?.enabled).toBe(false);
    const grid = [...walk(tree)].find((el) => el.type === MasonryGrid)!;
    expect(grid.props.items).toEqual([card]);
    expect(grid.props.skeletons).toBe(0);
    const item = (grid.props.renderItem as (c: Card) => ReactElement<Record<string, unknown>>)(card);
    expect(item.type).toBe(FeedCard);
    expect(item.props.onEdit).toBe(onEdit);
  });

  // Review wf_cb05c8c6-2aa: the bookmark index for cards in hand was untested.
  it("reads the bookmarks for cards in hand at once, for cards by id only once they came", () => {
    PromptWall({ cards: [card] });
    PromptWall({ ids: ["p1"] });
    expect(q.marks).toEqual([true, false]);
  });

  it("still reads by id for Likes and the bookmarks, without a pencil", () => {
    const tree = PromptWall({ ids: ["p1"] });
    expect(q.calls.find((c) => c.queryKey[0] === "prompt-cards")?.enabled).toBe(true);
    const grid = [...walk(tree)].find((el) => el.type === MasonryGrid)!;
    expect(grid.props.skeletons).toBe(6);
    expect((grid.props.renderItem as (c: Card) => ReactElement<Record<string, unknown>>)(card).props.onEdit).toBeUndefined();
  });
});

describe("a card's numbers", () => {
  const nums = (c: Card, on?: boolean, onOpen = vi.fn()) => [...walk(FeedCard({ card: c, onOpen, canBookmark: true, saved: undefined, numbers: on }))].filter((el) => el.props.className === "feed-card-nums");
  const shown = (el: ReactElement<Record<string, unknown>>) => [...walk(el)].filter((x) => x.type === "span").map((x) => (x.props.children as ReactNode[])[1]);
  const icons = (el: ReactElement<Record<string, unknown>>) => [...walk(el)].filter((x) => x.props.name).map((x) => x.props.name);

  it("are not on any card unless the wall asks, also with the numbers in hand", () => {
    expect(nums({ ...card, stats: { uses: 1, likes: 2, views: 3 } })).toHaveLength(0);
    expect(nums({ ...card, stats: { uses: 1, likes: 2, views: 3 } }, false)).toHaveLength(0);
  });

  it("show uses, likes and views in that order with their icons, and a zero as 0", () => {
    const [el] = nums({ ...card, stats: { uses: 1234, likes: 0, views: 27 } }, true);
    expect(shown(el)).toEqual(["1,234", "0", "27"]);
    expect(icons(el)).toEqual(["sparkles", "heart", "eye"]);
    expect(el.props["aria-label"]).toBe("1234 uses, 0 likes, 27 views");
    expect(el.props.title).toBe(el.props["aria-label"]);
  });

  it("say one use, one like and one view", () => {
    expect(nums({ ...card, stats: { uses: 1, likes: 1, views: 1 } }, true)[0].props["aria-label"]).toBe("1 use, 1 like, 1 view");
  });

  it("are dashes when the count failed, never a 0", () => {
    const [el] = nums({ ...card, stats: null }, true);
    expect(shown(el)).toEqual(["—", "—", "—"]);
    expect(el.props["aria-label"]).toBe("Numbers not available");
  });

  it("open the card when tapped, as the rest of the card does", () => {
    const onOpen = vi.fn();
    const [el] = nums({ ...card, stats: null }, true, onOpen);
    (el.props.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledWith({ ...card, stats: null });
  });

  it("come through the wall only when it is told to", () => {
    const item = (tree: ReactNode) => ([...walk(tree)].find((el) => el.type === MasonryGrid)!.props.renderItem as (c: Card) => ReactElement<Record<string, unknown>>)(card);
    expect(item(PromptWall({ cards: [card], numbers: true })).props.numbers).toBe(true);
    expect(item(PromptWall({ cards: [card] })).props.numbers).toBe(false);
    expect(item(PromptWall({ ids: ["p1"] })).props.numbers).toBe(false);
  });

  it("are on the card without a hover, above the rising title and clear of the pencil", () => {
    const css = readSource(join(__dirname, "..", "..", "components", "enki", "feed.css"));
    const rule = css.slice(css.indexOf(".feed-card-nums {"), css.indexOf(".feed-card-nums span"));
    expect(rule).toContain("position: absolute; left: 8px; bottom: 12px; z-index: 3;");
    expect(rule).not.toMatch(/opacity: 0|visibility: hidden|display: none/);
    expect(css).toContain(".feed-card:has(.feed-card-edit) .feed-card-nums { max-width: calc(100% - 54px); }");
    expect(css).toContain(".feed-card:has(.feed-card-nums) .feed-card-foot { padding-bottom: 40px; }");
  });

  // Second review of DEC-2026-11-03-07: beside the pencil on a phone the strip was cut, and the views went without a word.
  it("take a second row rather than lose a number, and the rising title clears it", () => {
    const css = readSource(join(__dirname, "..", "..", "components", "enki", "feed.css"));
    const rule = css.slice(css.indexOf(".feed-card-nums {"), css.indexOf(".feed-card-nums span"));
    expect(rule).toContain("flex-wrap: wrap;");
    expect(rule).toContain("min-height: 22px;");
    expect(rule).not.toMatch(/overflow|[ ;]height:/);
    expect(css).toContain(".feed-card:has(.feed-card-edit):has(.feed-card-nums) .feed-card-foot { padding-bottom: 56px; }");
  });
});

describe("the wall's next page", () => {
  it("is asked for 600 px ahead also inside a panel, whose body scrolls", () => {
    expect(readSource(join(__dirname, "..", "..", "components", "enki", "PromptWall.tsx"))).toContain('{ rootMargin: "600px 0px", scrollMargin: "600px 0px" }');
  });
});

describe("the card's pencil", () => {
  it("is there only with onEdit, opens the editor for that card and not the image view", () => {
    expect(edit(FeedCard({ card, onOpen: vi.fn(), canBookmark: true, saved: undefined }))).toHaveLength(0);
    const onEdit = vi.fn();
    const onOpen = vi.fn();
    const [pen] = edit(FeedCard({ card, onOpen, canBookmark: true, saved: undefined, onEdit }));
    expect(pen.props["aria-label"]).toBe("Edit Crystal logo");
    const stop = vi.fn();
    (pen.props.onClick as (e: { stopPropagation: () => void }) => void)({ stopPropagation: stop });
    expect(onEdit).toHaveBeenCalledWith(card);
    expect(stop).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("sits bottom right, always shown, and the rising title keeps clear of it", () => {
    const css = readSource(join(__dirname, "..", "..", "components", "enki", "feed.css"));
    expect(css).toMatch(/\.feed-card-edit \{\n  position: absolute; right: 8px; bottom: 8px; z-index: 3; width: 30px; height: 30px;/);
    expect(css).not.toMatch(/\.feed-card-edit \{[^}]*opacity: 0/);
    expect(css).toContain(".feed-card:has(.feed-card-edit) .feed-card-foot { padding-right: 46px; }");
  });
});

// DEC-457 (Kev, 2026-10-27: "rechts und links und dazwischen ist außerdem zu viel rand").
describe("on a phone a profile's walls", () => {
  const css = readSource(join(__dirname, "..", "..", "components", "enki", "enki.css"));
  const profile = readSource(join(__dirname, "..", "..", "components", "profile", "ProfileView.tsx"));

  it("run edge to edge, giving back exactly the content box's padding, and only while they hold pictures", () => {
    expect(css).toMatch(/@media \(max-width: 767\.98px\) \{\n  \.pf-wrap > :is\(\.feed-wall:has\(\.feed-grid\), \.gw:has\(\.gw-rows\)\) \{ width: auto; margin-inline: calc\(-1 \* clamp\(16px, 4vw, 40px\)\); \}\n\}/);
    expect(profile).toContain('<div ref={contentRef} className="pf-wrap" style={{ padding: "clamp(16px, 4vw, 40px)" }}>');
  });
});

describe("the profile", () => {
  const profile = readSource(join(__dirname, "..", "..", "components", "profile", "ProfileView.tsx"));

  it("maps its own read through the feed's mapping and shows Home's wall, the pencil on the own profile only", () => {
    expect(profile).toContain("const card = toFeedCard(raw);");
    expect(profile).toContain("<PromptWall cards={cards} numbers more={hasNextPage && !isError} onMore={moreShelf}");
    expect(profile).toContain("onEdit={own ? (c) => router.push(`/editor?id=${encodeURIComponent(c.id)}`) : undefined}");
    expect(profile).toContain(') : activeTab === "Released" ? (');
    expect(profile).not.toContain("<EnkiCard");
  });
});
