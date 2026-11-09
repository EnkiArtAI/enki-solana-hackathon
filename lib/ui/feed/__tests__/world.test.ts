import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * Explore's row and Create's switch (Kev, 2026-10-30, on an icon rail with Explore, Create, Studio and Inbox: "ok build
 * ... explore und create links ist super"). Explore shows All | Images | Videos above the categories; Create switches
 * Image | Video | Remix in the same row's place. Before that day's rail the row was Image | Video | Remix over the feed
 * (Kev, 2026-10-30: "at the very top menü bar über den categories bitte Image | Video | Remix wahl ... Video = wie image
 * mit den categories, aber dort werden wir dann videos ausrollen demnächst, behalte das bitte leer"). The views are
 * called with their hooks answered, as React would render them.
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, params: new URLSearchParams(), push: vi.fn(), query: null as null | { enabled?: boolean },
  access: { access: "ok", role: "user" as string | null }, data: undefined as unknown, pending: true, catalogue: [] as unknown[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T | (() => T)) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = typeof start === "function" ? (start as () => T)() : start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
  useEffect: () => {},
  useRef: <T>(current: T) => ({ current }),
  useMemo: <T>(make: () => T) => make(),
  useCallback: <T>(fn: T) => fn,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: ui.push, replace: vi.fn() }),
  useSearchParams: () => ui.params,
  usePathname: () => "/home",
}));
vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: (o: { enabled?: boolean }) => {
    ui.query = o;
    return { data: ui.data, fetchNextPage: () => {}, hasNextPage: false, isFetchingNextPage: false, isPending: ui.pending, error: null, refetch: () => {} };
  },
  useQueryClient: () => ({ getQueryState: () => undefined }),
  // A Studio project's context in Create (useCreateScope): none read.
  useQuery: () => ({ data: undefined, error: null }),
}));
vi.mock("@/components/enki/EnkiFilters", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/enki/FeedCard", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/enki/MasonryGrid", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/GenerateLauncher", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/enki/EnkiDetailPanel", () => ({ default: vi.fn(() => null), ImageView: vi.fn(() => null) }));
vi.mock("@/components/remix/RemixView", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/create/video/VideoView", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/create/image/CreateImage", () => ({ default: vi.fn(() => null) }));
// A client-only mount keeps what it loads, for the test to follow.
vi.mock("next/dynamic", () => ({ default: (load: () => Promise<unknown>) => Object.assign(() => null, { load }) }));
vi.mock("@/hooks/useModelLimits", () => ({ useModelCatalogue: () => ui.catalogue }));
vi.mock("@/hooks/useBookmarkIndex", () => ({ useBookmarkIndex: () => undefined }));
vi.mock("@/hooks/useIgnores", () => ({ useIgnores: () => ({ data: [] }) }));
vi.mock("@/components/BetaGate", () => ({
  useBetaAccess: () => ({ ...ui.access, adultConfirmed: false, adultPill: false, setAdultPill: () => {} }),
}));
vi.mock("@/lib/session-headers", () => ({ sessionHeadersWith: () => ({}) }));
vi.mock("@/lib/openCreator", () => ({ openCreator: () => {} }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

import EnkiFeedPage from "@/components/enki/EnkiFeedPage";
import CreateView from "@/components/enki/CreateView";
import EnkiFilters from "@/components/enki/EnkiFilters";
import MasonryGrid from "@/components/enki/MasonryGrid";
import GenerateLauncher from "@/components/GenerateLauncher";
import EnkiDetailPanel, { ImageView } from "@/components/enki/EnkiDetailPanel";
import RemixView from "@/components/remix/RemixView";
import VideoView from "@/components/create/video/VideoView";
import CreateImage from "@/components/create/image/CreateImage";
import Segmented from "@/components/kit/Segmented";
import { MEDIA, TOOLS, mediaLink, mediaOf, toolLink, toolOf, type Tool } from "@/lib/ui/feed/world";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const of = (tree: ReactNode, type: unknown) => [...walk(tree)].filter((el) => el.type === type);
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("") : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);
const feed = (search = "") => {
  ui.params = new URLSearchParams(search);
  ui.state = [];
  ui.s = 0;
  return EnkiFeedPage() as ReactNode;
};
const create = (tool: Tool) => {
  ui.state = [];
  ui.s = 0;
  return CreateView({ tool }) as ReactNode;
};
const note = (tree: ReactNode) => [...walk(tree)].filter((el) => el.props.className === "feed-note").map((el) => text(el));
const counts = (tree: ReactNode) => [EnkiFilters, MasonryGrid, GenerateLauncher, RemixView, ImageView].map((t) => of(tree, t).length);

let scrollTo: ReturnType<typeof vi.fn>;
beforeEach(() => {
  ui.push.mockClear(); ui.query = null; ui.access = { access: "ok", role: "user" }; ui.data = undefined; ui.pending = true; ui.catalogue = [];
  scrollTo = vi.fn();
  vi.stubGlobal("window", { scrollTo });
});
afterEach(() => vi.unstubAllGlobals());

describe("the address", () => {
  it("names what Explore shows as ?media=: All for none and for anything unknown", () => {
    expect(MEDIA.map((m) => [m.key, m.label])).toEqual([["all", "All"], ["images", "Images"], ["videos", "Videos"]]);
    expect(mediaOf(new URLSearchParams(""))).toBe("all");
    expect(mediaOf(new URLSearchParams("media=nope"))).toBe("all");
    // The old ?world= is not read: nothing with it was deployed.
    expect(mediaOf(new URLSearchParams("world=video"))).toBe("all");
    expect(mediaOf(new URLSearchParams("media=videos"))).toBe("videos");
    expect(mediaOf(new URLSearchParams("media=images&q=cats"))).toBe("images");
  });

  it("writes Explore's pick with every other part of the query kept, and All leaves it out", () => {
    expect(mediaLink("/home", new URLSearchParams("q=cats"), "videos")).toBe("/home?q=cats&media=videos");
    expect(mediaLink("/home", new URLSearchParams("media=videos&q=cats"), "images")).toBe("/home?media=images&q=cats");
    expect(mediaLink("/home", new URLSearchParams("media=videos&q=cats"), "all")).toBe("/home?q=cats");
    expect(mediaLink("/home", new URLSearchParams("media=images"), "all")).toBe("/home");
  });

  it("opens Create on the tool ?create= names, Image for an unknown one, none without it", () => {
    expect(TOOLS.map((t) => [t.key, t.label])).toEqual([["image", "Image"], ["video", "Video"], ["remix", "Remix"]]);
    expect(toolOf(new URLSearchParams(""))).toBeNull();
    expect(toolOf(new URLSearchParams("media=videos"))).toBeNull();
    expect(toolOf(new URLSearchParams("create=remix"))).toBe("remix");
    expect(toolOf(new URLSearchParams("create=video"))).toBe("video");
    expect(toolOf(new URLSearchParams("create=nope"))).toBe("image");
    expect(toolOf(new URLSearchParams("create="))).toBe("image");
    expect(TOOLS.map((t) => toolLink(t.key))).toEqual(["/home?create=image", "/home?create=video", "/home?create=remix"]);
  });
});

describe("Explore's row", () => {
  it("sits first in the feed, above the categories: All | Images | Videos, All picked by default", () => {
    const tree = feed();
    const root = [...walk(tree)].find((el) => el.props.className === "feed kit-focus")!;
    const [first, second] = [root.props.children].flat() as El[];
    expect(first.props.className).toBe("feed-world");
    expect(second.type).toBe(EnkiFilters);
    const seg = of(tree, Segmented)[0];
    expect(seg.props).toMatchObject({ role: "tablist", slide: true, ariaLabel: "All, images or videos", value: "all" });
    expect((seg.props.options as Array<{ key: string; label: string }>).map((o) => [o.key, o.label]))
      .toEqual([["all", "All"], ["images", "Images"], ["videos", "Videos"]]);
    expect(of(feed("media=images"), Segmented)[0].props.value).toBe("images");
  });

  it("All and Images are the feed: the categories, the wall, Quick Create, the prompts asked for", () => {
    for (const search of ["", "media=images", "media=nope"]) {
      const tree = feed(search);
      expect(counts(tree)).toEqual([1, 1, 1, 0, 0]);
      expect(note(tree)).toEqual([]);
      expect(ui.query?.enabled).toBeUndefined();
    }
  });

  it("Videos is a wall of its own with the same categories, search and community filter: only Quick Create stays out, it makes pictures", () => {
    const tree = feed("media=videos");
    expect(of(tree, Segmented)[0].props.value).toBe("videos");
    expect(counts(tree)).toEqual([1, 1, 0, 0, 0]);
    expect(note(tree)).toEqual([]);
    expect(ui.query?.enabled).toBeUndefined();
    const bar = of(tree, EnkiFilters)[0].props;
    expect(bar.onCommunity).toBeTypeOf("function");
  });

  it("an empty Videos says so, and nothing about filters; an empty wall elsewhere says what it said", () => {
    ui.data = { pages: [{ prompts: [], hasMore: false }] };
    const empty = (search: string) => {
      ui.pending = false;
      const said = note(feed(search));
      ui.pending = true;
      return said;
    };
    expect(empty("media=videos")).toEqual(["No video prompts yet."]);
    expect(empty("")).toEqual(["No prompts here yet.Adjust your filters to widen the results."]);
    expect(empty("media=images")).toEqual(["No prompts here yet.Adjust your filters to widen the results."]);
  });

  it("asks the server for its world, in a cache entry of its own; All names none", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { asked.push(url); return new Response(JSON.stringify({ prompts: [], hasMore: false }), { status: 200 }); });
    const read = async (search: string) => {
      feed(search);
      const query = ui.query as unknown as { queryKey: unknown[]; queryFn: (c: { pageParam: number }) => Promise<unknown> };
      await query.queryFn({ pageParam: 0 });
      return [new URL(asked.at(-1)!, "http://x").pathname, new URL(asked.at(-1)!, "http://x").searchParams.get("media"), query.queryKey.at(-1)];
    };
    expect(await read("")).toEqual(["/api/marketplace/prompts", null, "all"]);
    expect(await read("media=images")).toEqual(["/api/marketplace/prompts", "images", "images"]);
    expect(await read("media=videos")).toEqual(["/api/marketplace/prompts", "videos", "videos"]);
  });

  it("shows only the world's generator branch, and a pick of the other branch stops filtering there", () => {
    ui.catalogue = [{ id: "m-flux", name: "Flux (free)", mediaType: "image" }, { id: "m-seed", name: "Seedance 2.5", mediaType: "video" }];
    const groups = (search: string) => (of(feed(search), EnkiFilters)[0].props.generators as { label: string }[]).map((g) => g.label);
    expect(groups("")).toEqual(["Image", "Video"]);
    expect(groups("media=images")).toEqual(["Image"]);
    expect(groups("media=videos")).toEqual(["Video"]);
    // A pick made in Images, and the state kept while the world changes.
    const picked = (search: string) => {
      ui.params = new URLSearchParams(search);
      ui.s = 0;
      const tree = EnkiFeedPage() as ReactNode;
      return { shown: of(tree, EnkiFilters)[0].props.generatorFilter, key: (ui.query as unknown as { queryKey: unknown[] }).queryKey[3] };
    };
    feed("media=images");
    ui.s = 0;
    (of(EnkiFeedPage() as ReactNode, EnkiFilters)[0].props.onGeneratorFilter as (ids: string[]) => void)(["m-flux"]);
    expect(picked("media=images")).toEqual({ shown: ["m-flux"], key: "m-flux" });
    expect(picked("media=videos")).toEqual({ shown: [], key: "" });
    expect(picked("")).toEqual({ shown: ["m-flux"], key: "m-flux" });
  });

  it("holds no Remix any more: that is Create's", () => {
    expect(of(feed("create=remix"), RemixView)).toHaveLength(0);
    expect(of(feed("world=remix"), MasonryGrid)).toHaveLength(1);
  });

  it("shows a search's creators in every world", () => {
    ui.data = { pages: [{ prompts: [], creators: [{ id: "u-2", handle: "ann", displayName: "Ann" }] }] };
    const creators = (tree: ReactNode) => [...walk(tree)].filter((el) => el.props.className === "feed-creators").length;
    expect(creators(feed("q=cats"))).toBe(1);
    expect(creators(feed("media=images&q=cats"))).toBe(1);
    expect(creators(feed("media=videos&q=cats"))).toBe(1);
  });

  it("the bar leaves the search out when told to, and has it otherwise", async () => {
    const { default: Filters } = await vi.importActual<typeof import("@/components/enki/EnkiFilters")>("@/components/enki/EnkiFilters");
    const searches = (props: object) => {
      ui.state = []; ui.s = 0;
      return [...walk(Filters({ active: [], onPick: () => {}, ...props }) as ReactNode)].filter((el) => (el.type as { name?: string }).name === "SearchChip").length;
    };
    expect([searches({}), searches({ search: true }), searches({ search: false })]).toEqual([1, 1, 0]);
  });

  it("a pick goes into the address as its own history entry, the rest of the query kept, back at the top; the one shown adds none", () => {
    const pick = (search: string, media: string) => {
      ui.push.mockClear();
      (of(feed(search), Segmented)[0].props.onChange as (m: string) => void)(media);
      return ui.push.mock.calls.at(-1);
    };
    expect(pick("q=cats", "videos")).toEqual(["/home?q=cats&media=videos", { scroll: false }]);
    expect(pick("media=videos&q=cats", "all")).toEqual(["/home?q=cats", { scroll: false }]);
    expect(pick("", "images")).toEqual(["/home?media=images", { scroll: false }]);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 });
    expect(pick("media=videos", "videos")).toBeUndefined();
  });
});

describe("Create's switch", () => {
  it("stands in the place and look of Explore's row: Image | Video | Remix, the tool the address opens picked", () => {
    const tree = create("video");
    const root = [...walk(tree)].find((el) => el.props.className === "feed feed--create kit-focus")!;
    expect(root.props["data-menu-autohide"]).toBe(true);
    const [first] = [root.props.children].flat() as El[];
    expect(first.props.className).toBe("feed-world");
    const seg = of(tree, Segmented)[0];
    expect(seg.props).toMatchObject({ role: "tablist", slide: true, ariaLabel: "Image, video or remix", value: "video" });
    expect((seg.props.options as Array<{ key: string; label: string }>).map((o) => [o.key, o.label]))
      .toEqual([["image", "Image"], ["video", "Video"], ["remix", "Remix"]]);
  });

  it("Image is Sume's image page (CreateImage, client-only) in the page, not over it", async () => {
    const tree = create("image");
    expect(counts(tree)).toEqual([0, 0, 0, 0, 0]);
    const box = [...walk(tree)].find((el) => el.props.className === "feed-create-image")!;
    // Inside the Studio scope's provider, which holds none outside a project (StudioScope).
    const scope = box.props.children as El;
    expect(scope.props.value).toBeNull();
    const mount = scope.props.children as El;
    expect(mount.props).toEqual({});
    expect(await (mount.type as unknown as { load: () => Promise<{ default: unknown }> }).load()).toMatchObject({ default: CreateImage });
    expect(of(tree, EnkiDetailPanel)).toHaveLength(0);
    expect(note(tree)).toEqual([]);
  });

  it("Video is the video view, a guest's for a visitor without an account, and no note", () => {
    const tree = create("video");
    expect(counts(tree)).toEqual([0, 0, 0, 0, 0]);
    expect(note(tree)).toEqual([]);
    expect(of(tree, VideoView).map((el) => el.props)).toEqual([{ guest: false, studio: null }]);
    ui.access = { access: "ok", role: "team" };
    expect(of(create("video"), VideoView)[0].props.guest).toBe(true);
  });

  it("Remix is the Remix view as built, a guest's for a visitor without an account", () => {
    expect(of(create("remix"), RemixView).map((el) => el.props)).toEqual([{ guest: false }]);
    expect(counts(create("remix"))).toEqual([0, 0, 0, 1, 0]);
    ui.access = { access: "checking", role: null };
    expect(of(create("remix"), RemixView)[0].props.guest).toBe(true);
    ui.access = { access: "ok", role: "team" };
    expect(of(create("remix"), RemixView)[0].props.guest).toBe(true);
  });

  it("a pick is its own history entry, so Back returns to the tool before; back at the top; the one shown adds none", () => {
    const pick = (tool: Tool, next: string) => {
      ui.push.mockClear();
      (of(create(tool), Segmented)[0].props.onChange as (t: string) => void)(next);
      return ui.push.mock.calls.at(-1);
    };
    expect(pick("image", "video")).toEqual(["/home?create=video", { scroll: false }]);
    expect(pick("video", "remix")).toEqual(["/home?create=remix", { scroll: false }]);
    expect(pick("remix", "image")).toEqual(["/home?create=image", { scroll: false }]);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 });
    expect(pick("remix", "remix")).toBeUndefined();
  });
});

describe("the row's place", () => {
  const css = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "enki", "feed.css"), "utf8").split("\r\n").join("\n");
  const phone = css.slice(css.indexOf("@media (max-width: 767.98px)"));

  it("is fixed where the category bar was, in the bar's look, and the bar moves down under it", () => {
    expect(css).toContain(".feed { --feed-world-h: 44px; padding: calc(48px + var(--feed-world-h) + var(--ek-banner-h, 0px)) 0 96px; }");
    // One rule for both rows' look, so the two stacked rows cannot drift apart.
    expect(css).toContain(".feed-world, .feed-bar {\n  position: fixed; left: var(--ek-sw, 0px); right: 0; z-index: 45;\n  display: flex; align-items: center; height: 44px; padding: 0 24px;\n  background: var(--header-bg);");
    expect(css).toContain(".feed-world { top: var(--ek-banner-h, 0px); height: var(--feed-world-h); }");
    expect(css).toContain(".feed-bar { top: calc(var(--ek-banner-h, 0px) + var(--feed-world-h)); }");
    expect(css).toContain("  .feed-bar, .feed-world { padding: 0 12px; }");
    expect(css).toContain(".feed-bar, .feed-world, .feed-chips, .feed-search input { transition: none; }");
  });

  it("on a phone sits under the header, the categories under it, and both go up with the header", () => {
    expect(phone).toContain(".feed { padding: calc(48px + var(--feed-world-h)) 0 76px; }");
    expect(phone).toContain(".feed-world { top: calc(var(--ek-head, 46px) + var(--ek-banner-h, 0px)); transition: top 0.2s ease, transform 0.2s ease; }");
    expect(phone).toContain(".ek-tucked .feed-world { transform: translateY(calc(-100% - var(--ek-banner-h, 0px))); }");
    expect(phone).toContain(".ek-tucked .feed-bar { transform: translateY(calc(-100% - var(--ek-banner-h, 0px) - var(--feed-world-h))); }");
  });

  // Measured in a real browser at 1440x900 (row 256/0/1184x44; Create > Image's bar 283/754/1116x128, 18 px over the foot)
  // and 390x844 (row 0/46/390x44; the bar docked, 0/663/390x181).
  it("in Create puts the tool right under it, Create > Image at least the window below it", () => {
    expect(css).toContain(".feed--create { padding: calc(var(--feed-world-h) + var(--ek-banner-h, 0px)) 0 0; }");
    expect(css).toContain("  min-height: calc(100dvh - var(--feed-world-h) - var(--ek-banner-h, 0px));\n  padding: 24px 24px 0;\n}");
    expect(phone).toContain("  .feed--create { padding: var(--feed-world-h) 0 0; }\n  /* The bar docked to the screen's foot, edge to edge (Kev, 2026-10-30). */\n  .feed-create-image { min-height: calc(100dvh - var(--ek-head-h, 46px) - var(--ek-banner-h, 0px) - var(--feed-world-h)); padding: 12px 12px 0; }");
  });
});
