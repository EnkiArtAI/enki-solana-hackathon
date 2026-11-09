import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Kev, 2026-11-03: Filter by NFT. The list is a metered read: these are the query's terms, which the browser run in
 * the decision log drives against a stubbed route. The real NftFilter and ProfileView, called with a small state store
 * in place of React's, so a press changes what the next call asks.
 */
type Query = { queryKey: unknown[]; enabled: (q: { state: { status: string } }) => boolean; staleTime: number; retry: boolean; refetchOnWindowFocus: boolean; refetchOnReconnect: boolean; queryFn: () => Promise<unknown> };
const s = vi.hoisted(() => ({ i: 0, values: [] as unknown[], query: null as Query | null, answer: {} as Record<string, unknown> }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T,>(start: T | (() => T)) => {
    const i = s.i++;
    if (!(i in s.values)) s.values[i] = typeof start === "function" ? (start as () => T)() : start;
    return [s.values[i], (next: unknown) => { s.values[i] = typeof next === "function" ? (next as (v: unknown) => unknown)(s.values[i]) : next; }];
  },
  useEffect: () => {}, useLayoutEffect: () => {},
  useMemo: <T,>(f: () => T) => f(), useRef: <T,>(v: T) => ({ current: v }), useCallback: <T,>(f: T) => f,
}));
vi.mock("react-dom", async (original) => ({ ...(await original<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (q: Query) => {
    if (q.queryKey[0] === "wallet-nfts") s.query = q;
    return q.queryKey[0] === "wallet-nfts" ? s.answer : { data: undefined };
  },
  useInfiniteQuery: () => ({ data: { pages: [{ prompts: [{ id: "a", title: "a" }] }] }, hasNextPage: false, fetchNextPage: vi.fn(), refetch: vi.fn() }),
}));
vi.mock("@/components/StepUpProvider", () => ({ useStepUp: () => ({ guarded: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("thirdweb/react", () => ({ useActiveAccount: () => null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ publicKey: null }) }));
vi.mock("@/hooks/useCdpAddress", () => ({ useCdpAddress: () => ({ address: null }) }));
vi.mock("@/hooks/useSolanaAuth", () => ({ useSolanaAuth: () => ({ isAuthenticated: false, walletAddress: null }) }));
vi.mock("@/hooks/useModelLimits", () => ({ useModelCatalogue: () => [] }));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({ access: "ok", role: "beta", userId: "me", profile: { handle: "qa" } }) }));
vi.mock("@/components/enki/PromptWall", () => ({ default: () => null }));
vi.mock("@/components/enki/EnkiFilters", () => ({ default: () => null }));
vi.mock("@/components/enki/EnkiDetailPanel", () => ({ default: () => null }));
vi.mock("@/components/ReportButton", () => ({ ReportButton: () => null }));

import NftFilter, { NftWall } from "@/components/profile/NftFilter";
import NftTile from "@/components/enki/NftTile";
import ProfileView from "@/components/profile/ProfileView";
import PromptWall from "@/components/enki/PromptWall";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}

const NFT = { id: "n1", name: "Madlad", image: "https://host.test/a.png", thumb: "https://cdn.test/a.jpg", collection: null, proof: null };
const filter = (checked: unknown[] = [], onChecked = vi.fn(), viewer = "me") => {
  s.i = 0;
  return [...walk(NftFilter({ viewer, checked: checked as never, onChecked }))];
};
const trigger = (els: El[]) => els.find((el) => el.props["aria-haspopup"] === "dialog")!;
const asks = (status = "pending") => s.query!.enabled({ state: { status } });
/** A press on the real button, which the popover measures. */
const pressIt = (els: El[]) => {
  const button = trigger(els);
  (button.props.ref as { current: unknown }).current = { getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0, width: 0 }) };
  (button.props.onClick as () => void)();
};
const storage = new Map<string, string>();

beforeEach(() => {
  s.values = [];
  s.query = null;
  s.answer = { data: undefined, error: null, isFetching: false, refetch: vi.fn() };
  storage.clear();
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });
});
afterEach(() => vi.unstubAllGlobals());

describe("the X beside the button", () => {
  it("under a finger its 44 px press stops where the button ends", () => {
    const css = readFileSync(join(__dirname, "../../../../components/profile/nft-filter.css"), "utf8");
    const circle = Number(/\.pf-nft-x \{[^}]*?[^-]width: (\d+)px/.exec(css)?.[1]);
    const margin = Number(/@media \(pointer: coarse\) \{ \.pf-nft-x \{ margin-left: (\d+)px/.exec(css)?.[1]);
    expect(margin).toBeGreaterThanOrEqual((44 - circle) / 2);
  });
});

describe("the list is read only when asked for", () => {
  it("asks nothing until the button is pressed, then asks", () => {
    const els = filter();
    expect(asks()).toBe(false);
    pressIt(els);
    filter();
    expect(asks()).toBe(true);
  });
  it("a closed menu asks nothing again, so a reset of every query in the app cannot reach it", () => {
    pressIt(filter());
    pressIt(filter());
    filter();
    expect(asks("success")).toBe(false);
    expect(asks()).toBe(false);
  });
  it("a press on a phone asks too, and closing the sheet ends it", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    (trigger(filter()).props.onClick as () => void)();
    const open = filter();
    expect(asks()).toBe(true);
    (open.find((el) => el.props.title === "Filter by NFT" && "onClose" in el.props)!.props.onClose as () => void)();
    filter();
    expect(asks()).toBe(false);
  });
  it("a failure waits for Try again: an open menu does not ask by itself", () => {
    pressIt(filter());
    filter();
    expect(asks("error")).toBe(false);
  });
  it("never asks again by itself: no retry, no refetch on focus or reconnect, and a reopen inside staleTime is free", () => {
    filter();
    expect(s.query).toMatchObject({ retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, networkMode: "always" });
    expect(s.query?.staleTime).toBeGreaterThanOrEqual(60_000);
  });
  it("keeps each viewer's list apart", () => {
    filter();
    expect(s.query?.queryKey).toEqual(["wallet-nfts", "me"]);
    filter([], vi.fn(), "you");
    expect(s.query?.queryKey).toEqual(["wallet-nfts", "you"]);
  });
});

describe("what it asks", () => {
  const run = async (res = Response.json({ nfts: [], wallets: 0 })) => {
    const fetcher = vi.fn(async (_u: string, _i: RequestInit) => res);
    vi.stubGlobal("fetch", fetcher);
    filter();
    const body = s.query!.queryFn();
    return { fetcher, body };
  };
  it("the session's own list: the route with no parameter", async () => {
    const { fetcher, body } = await run();
    await body;
    expect(fetcher.mock.calls[0][0]).toBe("/api/wallet/nfts");
    expect(fetcher.mock.calls[0][1].cache).toBe("default");
  });
  it("a wallet linked a moment ago goes past the browser's copy", async () => {
    storage.set("enki-wallets-changed", String(Date.now()));
    const own = await run();
    await own.body;
    expect(own.fetcher.mock.calls[0][1].cache).toBe("reload");
  });
  it("sends the session", async () => {
    storage.set("enki_session_token", "tok");
    const { fetcher, body } = await run();
    await body;
    expect(fetcher.mock.calls[0][1].headers).toEqual({ "X-Session-Token": "tok" });
  });
  it("says the route's sentence when it refuses", async () => {
    const { body } = await run(Response.json({ error: "NFT index unavailable" }, { status: 503 }));
    await expect(body).rejects.toThrow("NFT index unavailable");
  });
  it("says something plain when nothing answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    filter();
    await expect(s.query!.queryFn()).rejects.toThrow("NFTs unavailable");
  });
});

describe("the tiles", () => {
  it("a green one ticks by the whole tile, which is one checkbox with the NFT's name", () => {
    s.answer = { ...s.answer, data: { nfts: [NFT], wallets: 1 } };
    const onChecked = vi.fn();
    // The body is what the portal and the sheet draw: BottomSheet's children hold it.
    const props = filter([], onChecked).find((el) => el.type === NftTile)!.props as Parameters<typeof NftTile>[0];
    const checks = { ...props.checks, checks: { [NFT.id]: { verdict: "allowed" as const, why: null, left: 0, opensAt: null, picture: true } } };
    const tile = [...walk(NftTile({ ...props, checks }))].find((el) => el.props.role === "checkbox")!;
    expect(tile.props["aria-checked"]).toBe(false);
    expect(tile.props.title).toBe("Madlad");
    (tile.props.onClick as () => void)();
    const step = onChecked.mock.calls[0][0] as (now: unknown[]) => unknown[];
    expect(step([])).toEqual([NFT]);
    expect(step([NFT])).toEqual([]);
    const other = { ...NFT, id: "n2" };
    expect(step([other])).toEqual([other, NFT]);
    expect(step([other, NFT])).toEqual([other]);
  });
});

describe("the focus, when what was pressed goes away", () => {
  // Review 2026-11-03: it fell to the body, or to the button under a menu that stayed open.
  const inMenu = vi.fn();
  const pressed = { currentTarget: { closest: (q: string) => (q === '[role="dialog"]' ? { focus: inMenu } : null) } };
  const named = (els: El[], text: string) => els.find((el) => el.type === "button" && el.props.children === text)!;
  beforeEach(() => inMenu.mockClear());
  it("Try again keeps it in the menu and asks", () => {
    const refetch = vi.fn();
    s.answer = { ...s.answer, error: new Error("busy"), refetch };
    (named(filter(), "Try again").props.onClick as (e: unknown) => void)(pressed);
    expect(inMenu).toHaveBeenCalledOnce();
    expect(refetch).toHaveBeenCalledOnce();
  });
  it("Clear keeps it in the menu and clears", () => {
    s.answer = { ...s.answer, data: { nfts: [NFT], wallets: 1 } };
    const onChecked = vi.fn();
    (named(filter([NFT], onChecked), "Clear").props.onClick as (e: unknown) => void)(pressed);
    expect(inMenu).toHaveBeenCalledOnce();
    expect(onChecked).toHaveBeenCalledWith([]);
  });
  it("the X hands it to the button and clears", () => {
    const onChecked = vi.fn();
    const els = filter([NFT], onChecked);
    const focus = vi.fn();
    (trigger(els).props.ref as { current: unknown }).current = { focus };
    (els.find((el) => el.props["aria-label"] === "Clear the NFT filter")!.props.onClick as () => void)();
    expect(focus).toHaveBeenCalledOnce();
    expect(onChecked).toHaveBeenCalledWith([]);
  });
});

describe("the pictures", () => {
  // Review 2026-11-03: the NFT's own host would see every viewer's IP, and a mint names that host. Only the harness outside the repo held this.
  const srcOf = (els: El[]) => {
    const picture = (els.find((el) => el.type === NftTile)?.props.picture ?? els.find((el) => (el.props as { nft?: unknown }).nft === NFT)) as El;
    s.i = 100;
    return (picture.type as (p: unknown) => El)(picture.props).props.src;
  };
  it("a tile in the menu shows the Helius tile, never the NFT's own host", () => {
    s.answer = { ...s.answer, data: { nfts: [NFT], wallets: 1 } };
    expect(srcOf(filter())).toBe(NFT.thumb);
  });
  it("a card on the wall too", () => {
    expect(srcOf([...walk(NftWall({ nfts: [NFT] }))])).toBe(NFT.thumb);
  });
});

describe("the profile", () => {
  const draw = (handle: string | null = null) => { s.i = 0; return [...walk(ProfileView({ handle: handle ?? undefined, isOwnProfile: !handle }))]; };
  const menu = (els = draw()) => els.find((el) => el.type === NftFilter)!;
  it("draws the menu on the own profile, reading the session's wallets, and none on someone else's", () => {
    expect(menu()).toBeDefined();
    s.values = [];
    expect(menu(draw("mira"))).toBeUndefined();
  });
  it("shows the checked NFTs in place of the tab, and the tab again after the last", () => {
    expect(draw().some((el) => el.type === PromptWall)).toBe(true);
    (menu().props.onChecked as (v: unknown[]) => void)([NFT]);
    const shown = draw();
    expect(shown.find((el) => el.type === NftWall)?.props.nfts).toEqual([NFT]);
    expect(shown.some((el) => el.type === PromptWall || el.props.className === "pf-controls kit-focus")).toBe(false);
    (menu().props.onChecked as (v: unknown[]) => void)([]);
    const back = draw();
    expect(back.some((el) => el.type === NftWall)).toBe(false);
    expect(back.some((el) => el.type === PromptWall)).toBe(true);
  });
  it("the tab row slides on a phone and wraps from 768 px, where a mouse could not reach what lies past its end", () => {
    const row = draw().find((el) => el.type === "div" && String(el.props.className).includes("pf-tab-row"))!;
    const style = row.props.style as Record<string, unknown>;
    expect(style.flexWrap).toBeUndefined();
    // No gap between the lines: the tabs' own padding spaces them.
    expect(style.gap).toBeUndefined();
    expect(style.columnGap).toBeDefined();
    const css = readFileSync(join(__dirname, "../../../../components/profile/nft-filter.css"), "utf8");
    expect(css).toContain("@media (min-width: 768px) { .pf-tab-row { flex-wrap: wrap; } }");
  });
  it("leaving the own profile takes the checks and the menu with it, and coming back starts anew", () => {
    const before = menu();
    (before.props.onChecked as (v: unknown[]) => void)([NFT]);
    expect(draw().some((el) => el.type === NftWall)).toBe(true);
    draw("zed"); // The render that notices; React would run it again at once.
    const after = draw("zed");
    expect(after.some((el) => el.type === NftWall)).toBe(false);
    expect(menu(after)).toBeUndefined();
    draw(); // As above, going back.
    const back = draw();
    expect(back.some((el) => el.type === NftWall)).toBe(false);
    expect(menu(back).key).toBe(before.key);
  });
});
