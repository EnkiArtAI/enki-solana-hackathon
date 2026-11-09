import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * Kev, 2026-11-03: "fix the released wand, das soll auch son endless scroller sein ofc mit den performances sichtbar
 * and below the bar a sort by performance und date und auch nen filter nach categories, generatoren."
 * The real ProfileView, called with a small state store in place of React's, so a click changes what the next call draws.
 */
const s = vi.hoisted(() => ({
  i: 0, values: [] as unknown[], effects: [] as Array<() => void>,
  queries: [] as Array<Record<string, unknown> & { queryKey: unknown[]; queryFn: (c: { pageParam: number }) => Promise<unknown>; getNextPageParam: (p: { nextCursor?: string }) => number | undefined }>,
  result: {} as Record<string, unknown>, stats: undefined as unknown,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T,>(start: T | (() => T)) => {
    const i = s.i++;
    if (!(i in s.values)) s.values[i] = typeof start === "function" ? (start as () => T)() : start;
    return [s.values[i], (next: unknown) => { s.values[i] = typeof next === "function" ? (next as (v: unknown) => unknown)(s.values[i]) : next; }];
  },
  useEffect: (f: () => void) => { s.effects.push(f); },
  useMemo: <T,>(f: () => T) => f(), useRef: <T,>(v: T) => ({ current: v }), useCallback: <T,>(f: T) => f,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: s.stats === undefined ? undefined : { stats: s.stats } }),
  useInfiniteQuery: (q: typeof s.queries[number]) => { s.queries.push(q); return s.result; },
}));
vi.mock("@/components/StepUpProvider", () => ({ useStepUp: () => ({ guarded: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("thirdweb/react", () => ({ useActiveAccount: () => null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ publicKey: null }) }));
vi.mock("@/hooks/useCdpAddress", () => ({ useCdpAddress: () => ({ address: null }) }));
vi.mock("@/hooks/useSolanaAuth", () => ({ useSolanaAuth: () => ({ isAuthenticated: false, walletAddress: null }) }));
vi.mock("@/hooks/useModelLimits", () => ({ useModelCatalogue: () => [{ id: "m1", name: "Flux (free)", mediaType: "image" }] }));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({ access: "ok", role: "beta", userId: "me", profile: { handle: "qa" } }) }));
vi.mock("@/components/enki/PromptWall", () => ({ default: () => null }));
vi.mock("@/components/enki/EnkiFilters", () => ({ default: () => null }));
vi.mock("@/components/enki/EnkiDetailPanel", () => ({ default: () => null }));
vi.mock("@/components/ReportButton", () => ({ ReportButton: () => null }));

import ProfileView from "@/components/profile/ProfileView";
import PromptWall from "@/components/enki/PromptWall";
import EnkiFilters from "@/components/enki/EnkiFilters";
import Segmented from "@/components/kit/Segmented";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const draw = () => { s.i = 0; s.effects = []; return [...walk(ProfileView({ handle: "mira", isOwnProfile: false }))]; };
const wall = (els = draw()) => els.find((el) => el.type === PromptWall)!;
const filters = (els = draw()) => els.find((el) => el.type === EnkiFilters)!;
const sort = (els = draw()) => els.find((el) => el.type === Segmented)!;
const lastQuery = () => s.queries.at(-1)!;
const text = (el: El): string => [...walk(el)].flatMap((x) => (x.props.children === undefined ? [] : [x.props.children].flat())).filter((c) => typeof c === "string" || typeof c === "number").join("");
const tabButton = (name: string, els = draw()) => els.find((el) => el.type === "button" && [el.props.children].flat().includes(name))!;
const tabNumber = () => { const span = [tabButton("Released").props.children].flat().find((c) => isValidElement(c)) as El | undefined; return span ? span.props.children : null; };
const page = (...ids: string[]) => ({ prompts: ids.map((id) => ({ id, title: id })) });
const answer = (over: Record<string, unknown> = {}) => {
  s.result = { data: { pages: [page("a", "b")] }, error: null, isError: false, isFetching: false, isFetchingNextPage: false, isFetchNextPageError: false, isPending: false, isPlaceholderData: false, hasNextPage: false, fetchNextPage: vi.fn(async () => {}), refetch: vi.fn(async () => {}), ...over };
};
// The magnifier's term: open it, type, and let its debounce run.
const typeTerm = (term: string) => {
  (draw().find((el) => el.props["aria-label"] === "Search this profile")!.props.onClick as () => void)();
  (draw().find((el) => el.type === "input" && el.props["aria-label"] === "Search this profile")!.props.onChange as (e: unknown) => void)({ target: { value: term } });
  draw();
  vi.useFakeTimers();
  s.effects.find((f) => String(f).includes("setTerm"))!();
  vi.runAllTimers();
  vi.useRealTimers();
};
const urlOf = async () => {
  const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ prompts: [] })));
  vi.stubGlobal("fetch", fetcher);
  draw();
  await lastQuery().queryFn({ pageParam: 48 });
  return new URL(fetcher.mock.calls[0][0], "https://local.example");
};

beforeEach(() => { s.values = []; s.queries = []; s.stats = undefined; answer(); });
afterEach(() => vi.unstubAllGlobals());

describe("the shelf's read", () => {
  it("asks 24 at a time from the cursor, by performance, with the numbers, for this creator", async () => {
    const url = await urlOf();
    expect(url.pathname).toBe("/api/marketplace/prompts");
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "24", sortBy: "performance", creator: "mira", stats: "1", cursor: "48" });
    expect(lastQuery().initialPageParam).toBe(0);
  });
  it("asks Date as newest", async () => {
    (sort().props.onChange as (k: string) => void)("newest");
    expect((await urlOf()).searchParams.get("sortBy")).toBe("newest");
  });
  it("sends the category chip's key and every alias of a generator, with the term, all at once", async () => {
    (filters().props.onPick as (k: string) => void)("marketing");
    (filters().props.onGeneratorFilter as (k: string[]) => void)(["m1"]);
    typeTerm("gold");
    const { searchParams } = await urlOf();
    expect(searchParams.get("category")).toBe("marketing");
    expect(searchParams.getAll("models")).toEqual(["m1", "Flux (free)", "flux"]);
    expect(searchParams.get("query")).toBe("gold");
  });
  it("sends no filter it does not have", async () => {
    const { searchParams } = await urlOf();
    for (const absent of ["category", "models", "query"]) expect(searchParams.has(absent)).toBe(false);
  });
  it("runs dry with the server: the next cursor as a number, none without one or with nonsense", () => {
    draw();
    const next = lastQuery().getNextPageParam;
    expect(next({ nextCursor: "24" })).toBe(24);
    expect(next({})).toBeUndefined();
    expect(next({ nextCursor: "soon" })).toBeUndefined();
  });
  it("says the server's sentence when it fails, or its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "database unreachable" }), { status: 500 })));
    draw();
    await expect(lastQuery().queryFn({ pageParam: 0 })).rejects.toThrow("database unreachable");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(lastQuery().queryFn({ pageParam: 0 })).rejects.toThrow("(HTTP 503)");
  });
});

describe("the query's key", () => {
  const key = () => { draw(); return lastQuery().queryKey; };
  it("keeps the prefix an ignore invalidates, and the creator last", () => {
    expect(key()[0]).toBe("/api/marketplace/prompts");
    expect(key().at(-1)).toBe("mira");
  });
  it("changes with the sort, the category, the generators and the term, so each reads its own pages", () => {
    const seen = [JSON.stringify(key())];
    (sort().props.onChange as (k: string) => void)("newest");
    seen.push(JSON.stringify(key()));
    (filters().props.onPick as (k: string) => void)("marketing");
    seen.push(JSON.stringify(key()));
    (filters().props.onGeneratorFilter as (k: string[]) => void)(["m1"]);
    seen.push(JSON.stringify(key()));
    typeTerm("gold");
    seen.push(JSON.stringify(key()));
    expect(new Set(seen).size).toBe(5);
  });
  it("keeps the old wall while a control's answer is on its way", () => {
    draw();
    const keep = lastQuery().placeholderData as (p: unknown) => unknown;
    const previous = { pages: [] };
    expect(keep(previous)).toBe(previous);
  });
});

describe("the wall", () => {
  const cardIds = (el: El) => (el.props.cards as { id: string }[]).map((c) => c.id);
  it("shows each prompt once across pages, with its numbers", () => {
    answer({ data: { pages: [page("a", "b"), page("b", "c"), { prompts: "nonsense" }, page("", "d")] } });
    const el = wall();
    expect(cardIds(el)).toEqual(["a", "b", "c", "d"]);
    expect(el.props.numbers).toBe(true);
  });
  it("asks for more while the server has more, and never twice at once", () => {
    answer({ hasNextPage: true });
    const el = wall();
    expect(el.props.more).toBe(true);
    (el.props.onMore as () => void)();
    expect(s.result.fetchNextPage).toHaveBeenCalledTimes(1);
    answer({ hasNextPage: true, isFetchingNextPage: true });
    (wall().props.onMore as () => void)();
    expect(s.result.fetchNextPage).not.toHaveBeenCalled();
    answer({ hasNextPage: false });
    expect(wall().props.more).toBe(false);
  });
  it("does not ask again by itself after a failed page", () => {
    answer({ hasNextPage: true, isError: true, isFetchNextPageError: true, error: new Error("x") });
    expect(wall().props.more).toBe(false);
  });
  it("has skeletons while the first page or a next one is on its way, not while a filter's answer is awaited over old cards", () => {
    answer({ data: undefined, isPending: true, isFetching: true });
    expect(wall().props.loading).toBe(true);
    answer({ data: undefined, isError: true, error: new Error("x"), isFetching: true });
    expect(wall().props.loading).toBe(true);
    answer({ isFetchingNextPage: true, isFetching: true });
    expect(wall().props.loading).toBe(true);
    answer({ isFetching: true, isPlaceholderData: true });
    expect(wall().props.loading).toBe(false);
    answer({ data: { pages: [page()] } });
    expect(wall().props.loading).toBe(false);
  });
  it("marks the row while old cards wait for a control's answer", () => {
    const row = (els = draw()) => els.find((el) => el.props.className === "pf-controls kit-focus")!;
    answer({ isPlaceholderData: true });
    expect(row().props["data-busy"]).toBe(true);
    answer();
    expect(row().props["data-busy"]).toBeUndefined();
  });
});

describe("the controls", () => {
  it("offer Performance first, chosen by default, then Date", () => {
    const el = sort();
    expect((el.props.options as { label: string }[]).map((o) => o.label)).toEqual(["Performance", "Date"]);
    expect(el.props.value).toBe("performance");
    expect(el.props.role).toBe("radiogroup");
  });
  it("reuse the filter bar with the categories and the Generator only", () => {
    const el = filters();
    expect(el.props.search).toBe(false);
    expect(el.props.generators).toEqual([{ label: "Image", entries: [{ id: "m1", name: "Flux (free)" }] }]);
    for (const absent of ["onShowAdult", "onCommunity", "onShowIgnored"]) expect(el.props[absent]).toBeUndefined();
  });
  it("show the chip it picked, and All when none", () => {
    expect(filters().props.active).toEqual([]);
    (filters().props.onPick as (k: string | null) => void)("marketing");
    expect(filters().props.active).toEqual(["marketing"]);
    (filters().props.onPick as (k: string | null) => void)(null);
    expect(filters().props.active).toEqual([]);
  });
  it("stand before the wall, on Released only", () => {
    const els = draw();
    expect(els.indexOf(els.find((el) => el.type === Segmented)!)).toBeLessThan(els.indexOf(wall(els)));
    expect(els.indexOf(filters(els))).toBeLessThan(els.indexOf(wall(els)));
    (tabButton("Reviews", els).props.onClick as () => void)();
    const reviews = draw();
    expect(reviews.some((el) => el.type === Segmented || el.type === EnkiFilters || el.type === PromptWall)).toBe(false);
    expect(reviews.map(text).join("")).toContain("Nothing to show in Reviews yet.");
  });
  it("leave Filter by NFT in the tab bar", () => {
    const view = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "profile", "ProfileView.tsx"), "utf8");
    expect(view).toContain("<NftFilter key={nftScope}");
  });
});

describe("the tab's number", () => {
  it("is the profile's total with no term or filter, also while the wall holds fewer", () => {
    s.stats = { totalPrompts: 119 };
    answer({ hasNextPage: true });
    expect(tabNumber()).toBe(119);
  });
  it("is the loaded count with a filter once the last page is in, nothing before", () => {
    s.stats = { totalPrompts: 119 };
    (filters().props.onPick as (k: string) => void)("marketing");
    answer({ hasNextPage: true });
    expect(tabNumber()).toBeNull();
    answer({ isPlaceholderData: true });
    expect(tabNumber()).toBeNull();
    answer({ data: undefined, isPending: true });
    expect(tabNumber()).toBeNull();
    answer();
    expect(tabNumber()).toBe(2);
  });
  it("follows the same rule with a term and with a generator", () => {
    s.stats = { totalPrompts: 119 };
    (filters().props.onGeneratorFilter as (k: string[]) => void)(["m1"]);
    expect(tabNumber()).toBe(2);
    (filters().props.onGeneratorFilter as (k: string[]) => void)([]);
    expect(tabNumber()).toBe(119);
    typeTerm("gold");
    expect(tabNumber()).toBe(2);
  });
  it("says 0 for a filter with no match", () => {
    s.stats = { totalPrompts: 119 };
    (filters().props.onPick as (k: string) => void)("marketing");
    answer({ data: { pages: [page()] } });
    expect(tabNumber()).toBe(0);
  });
  it("without a total waits for the last page, never counting the pages as they come", () => {
    s.stats = { totalPrompts: null };
    answer({ hasNextPage: true });
    expect(tabNumber()).toBeNull();
    answer();
    expect(tabNumber()).toBe(2);
  });
});

describe("what an empty or failed wall says", () => {
  const note = () => text(wall().props.note as El);
  const alert = (els = draw()) => els.find((el) => el.props.role === "alert");
  beforeEach(() => answer({ data: { pages: [page()] } }));

  it("an empty shelf says nothing is there", () => { expect(note()).toBe("Nothing to show in Released yet."); });
  it("a filter with no match says so", () => {
    (filters().props.onPick as (k: string) => void)("marketing");
    expect(note()).toBe("No prompt here matches these filters.");
    (filters().props.onPick as (k: string | null) => void)(null);
    (filters().props.onGeneratorFilter as (k: string[]) => void)(["m1"]);
    expect(note()).toBe("No prompt here matches these filters.");
  });
  it("a term with no match names it, and says when filters narrow it too", () => {
    typeTerm("gold");
    expect(note()).toBe('No prompt here matches "gold".');
    (filters().props.onPick as (k: string) => void)("marketing");
    expect(note()).toBe('No prompt here matches "gold" with these filters.');
    (filters().props.onPick as (k: string | null) => void)(null);
    (filters().props.onGeneratorFilter as (k: string[]) => void)(["m1"]);
    expect(note()).toBe('No prompt here matches "gold" with these filters.');
  });
  it("a failed read says so with Try again, and never draws a wall", () => {
    answer({ data: undefined, isError: true, error: new Error("database unreachable") });
    const els = draw();
    expect(wall(els)).toBeUndefined();
    const el = alert(els)!;
    expect(text(el)).toContain("Couldn't load these prompts.");
    expect(text(el)).toContain("database unreachable");
    ([...walk(el)].find((x) => x.type === "button")!.props.onClick as () => void)();
    expect(s.result.refetch).toHaveBeenCalledTimes(1);
  });
  it("while Try again reads, the wall's skeletons stand there, not the sentence", () => {
    answer({ data: undefined, isError: true, error: new Error("x"), isFetching: true });
    const els = draw();
    expect(alert(els)).toBeUndefined();
    expect(wall(els)).toBeDefined();
  });
  it("a failed later page keeps the wall and asks that page again", () => {
    answer({ hasNextPage: true, isError: true, isFetchNextPageError: true, error: new Error("database unreachable") });
    const els = draw();
    expect((wall(els).props.cards as unknown[]).length).toBe(2);
    const el = alert(els)!;
    expect(text(el)).toContain("database unreachable");
    ([...walk(el)].find((x) => x.type === "button")!.props.onClick as () => void)();
    expect(s.result.fetchNextPage).toHaveBeenCalledTimes(1);
    expect(s.result.refetch).not.toHaveBeenCalled();
  });
  it("a failed refresh of a full wall keeps it and reads it again", () => {
    answer({ isError: true, error: new Error("x") });
    const el = alert()!;
    ([...walk(el)].find((x) => x.type === "button")!.props.onClick as () => void)();
    expect(s.result.refetch).toHaveBeenCalledTimes(1);
    expect(s.result.fetchNextPage).not.toHaveBeenCalled();
  });
  it("says nothing failed while the answer is being read again", () => {
    answer({ isError: true, error: new Error("x"), isFetching: true });
    expect(alert()).toBeUndefined();
  });
});

describe("the row's place", () => {
  const css = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "enki", "feed.css"), "utf8").replace(/\r\n/g, "\n");
  const rule = (selector: string) => css.slice(css.indexOf(`\n${selector} {`), css.indexOf("}", css.indexOf(`\n${selector} {`)));

  it("takes the filter bar out of its fixed place, its tuck and its glass, after the rules it overrides", () => {
    const bar = rule(".pf-controls .feed-bar");
    expect(bar).toContain("position: static;");
    expect(bar).toContain("transform: none;");
    expect(bar).toContain("background: none;");
    expect(bar).toContain("backdrop-filter: none; -webkit-backdrop-filter: none;");
    expect(bar).toContain("border-bottom: 0;");
    expect(css.indexOf("\n.pf-controls .feed-bar {")).toBeGreaterThan(css.lastIndexOf(".ek-tucked .feed-bar {"));
    expect(css.indexOf("\n.pf-controls .feed-bar {")).toBeGreaterThan(css.lastIndexOf(".feed-bar { top:"));
  });
  it("lies in the flow under the tabs, wraps, and lays its popover over the wall but under the tabs", () => {
    const row = rule(".pf-controls");
    expect(row).toContain("position: relative; z-index: 2;");
    expect(row).toContain("flex-wrap: wrap;");
    expect(row).toContain("margin: calc(8px - clamp(16px, 4vw, 40px)) 0 4px;");
    expect(row).not.toMatch(/sticky|fixed/);
  });
  it("dims the wall only while a control's answer is awaited", () => {
    expect(css).toContain(".pf-controls[data-busy] ~ .feed-wall { opacity: 0.55; }");
  });
  it("does not let a rounded cell slide the phone's page sideways, nor clip a hover's shadow on a desktop", () => {
    expect(css).toContain("@media (max-width: 767.98px) { .pf-controls ~ .feed-wall { overflow-x: clip; } }");
  });
  it("keeps the room for the row to hold still when its choice leaves few cards", () => {
    expect(css).toContain(".pf-tabs + .pf-wrap:has(> .pf-controls) { min-height: calc(100dvh - 80px); }");
  });
});

// Second review of DEC-2026-11-03-07: after a failed later page this button is the only way on, and it was 32 px on a phone.
describe("Try again is a finger's size", () => {
  const tryAgain = () => draw().find((el) => el.type === "button" && el.props.children === "Try again")!;
  it.each([
    ["after a failed first read", { data: undefined, isError: true, error: new Error("no") }],
    ["after a failed later page", { isError: true, isFetchNextPageError: true, error: new Error("no") }],
  ])("%s", (_, state) => {
    answer(state);
    expect(tryAgain().props.className).toBe("ek-btn kit-hit");
  });
});

// Second review of DEC-2026-11-03-07: a term typed deep left the first matches above the screen, with no sign of them.
describe("a term goes to the wall's start", () => {
  const run = (past: number, panel: { scrollBy: ReturnType<typeof vi.fn> } | null, tabs = true) => {
    const page = { scrollBy: vi.fn() };
    const content = draw().find((el) => el.props.className === "pf-wrap" && el.props.ref)!;
    (content.props.ref as { current: unknown }).current = {
      getBoundingClientRect: () => ({ top: 100 - past }),
      previousElementSibling: tabs ? { getBoundingClientRect: () => ({ bottom: 100 }) } : null,
      closest: (selector: string) => (selector === ".ek-panel-body" ? panel : null),
    };
    vi.stubGlobal("window", page);
    s.effects.find((f) => String(f).includes("scrollBy"))!();
    return page;
  };
  it("from deep in a panel: up by what lies past the tabs, in the panel's own scroller", () => {
    const panel = { scrollBy: vi.fn() };
    const page = run(2000, panel);
    expect(panel.scrollBy.mock.calls).toEqual([[0, -2000]]);
    expect(page.scrollBy).not.toHaveBeenCalled();
  });
  it("from deep on a page without a panel: the window scrolls", () => {
    expect(run(2000, null).scrollBy.mock.calls).toEqual([[0, -2000]]);
  });
  it.each([["the tabs not stuck yet", -300], ["the wall's start exactly under the tabs", 0]])("%s: the page holds still", (_, past) => {
    const panel = { scrollBy: vi.fn() };
    expect(run(past, panel).scrollBy).not.toHaveBeenCalled();
    expect(panel.scrollBy).not.toHaveBeenCalled();
  });
  it("runs on the term and the NFT wall alone: a sort or a filter holds the page", () => {
    const source = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "profile", "ProfileView.tsx"), "utf8");
    expect(source).toMatch(/\.scrollBy\(0, -past\);\s+\}, \[term, showNfts\]\);/);
  });
});

describe("the Generator's popover", () => {
  it("comes on screen when it opens, from a chip at the window's foot", () => {
    const filtersSource = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "enki", "EnkiFilters.tsx"), "utf8");
    expect(filtersSource).toContain('popRef.current?.scrollIntoView({ block: "nearest" });');
    expect(filtersSource).toContain('<div ref={popRef} className="feed-gen-pop"');
  });
});
