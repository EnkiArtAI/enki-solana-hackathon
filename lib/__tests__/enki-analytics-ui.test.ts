import { describe, expect, it, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The Analytics panel's Enki view (Kev, 2026-10-29: "Enki-global analytics, wie users, posted images, generated
 * images, generated revenue for artists, views, halt genauso wie hier: https://hup.social/leaderboard"): Mine | Enki,
 * every figure with its last 24 hours, and the creators ranked by the column clicked. The components are called with
 * their state set, as React would render them; effects are collected and run by hand.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], s: 0, effects: [] as (() => unknown)[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
  useEffect: (fn: () => unknown) => { ui.effects.push(fn); },
}));
const opened = vi.hoisted(() => [] as string[]);
const pushed = vi.hoisted(() => [] as string[]);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (u: string) => { pushed.push(u); } }) }));
vi.mock("@/lib/openCreator", () => ({ openCreator: (h: string) => { opened.push(h); } }));
vi.mock("@/components/kit/Seal", () => ({ default: () => null }));
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({}) }));

import AnalyticsPanel from "@/components/enki-shell/AnalyticsPanel";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("") : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);
const named = (tree: ReactNode, name: string) => [...walk(tree)].filter((e) => typeof e.type === "function" && e.type.name === name);
const render = (Component: (p: never) => ReactNode, props: object, state: unknown[]) => {
  ui.s = 0; ui.state = state; ui.effects = [];
  return (Component as (p: object) => ReactNode)(props);
};

const PAYLOAD = {
  totals: {
    users: { value: 39, day: 2 }, posts: { value: 2, day: 0 }, images: { value: 55, day: 4 }, revenue: { value: 386, day: 150 },
    views: { value: null, day: null }, prompts: { value: 6, day: 0 }, likes: { value: 3, day: 0 }, comments: { value: 1, day: 1 },
  },
  board: [
    { rank: 1, handle: "ann", prompts: 2, posts: 1, revenueCents: 360, views: null, likes: 2, comments: 0, followers: 1 },
    { rank: 2, handle: "bob", prompts: 0, posts: 1, revenueCents: 0, views: null, likes: 0, comments: 1, followers: 2 },
    { rank: 3, handle: null, prompts: 0, posts: 1, revenueCents: 0, views: null, likes: 0, comments: 0, followers: 0 },
  ],
  sort: "revenue",
  period: "week",
};
const ALL = { ...PAYLOAD, period: "all" };
const enkiView = () => {
  const panel = render(AnalyticsPanel as never, {}, [null, false, "week", "earnings", "enki"]);
  const [el] = named(panel, "EnkiView");
  return { panel, el, View: el.type as (p: never) => ReactNode };
};

const SERIES = { labels: ["W1"], earningsCents: [0], prints: [0] };
const PERIOD = { earningsCents: 255, earningsTrend: null, prints: 4, printsTrend: 10, unlocks: 3, unlocksTrend: null, created: 7, createdTrend: -5 };
const MINE = { charts: { week: SERIES, month: SERIES, all: SERIES }, stats: { week: PERIOD, month: PERIOD, all: PERIOD }, conversionPct: null, topPrompts: [], activity: [] as { type: string; prompt: string; amountCents: number | null; rating: number | null; at: string }[] };

describe("Analytics: Mine | Enki", () => {
  beforeEach(() => { opened.length = 0; pushed.length = 0; });

  it("Mine shows what I earned per paid render and what I created, private renders included", () => {
    const mine = render(AnalyticsPanel as never, {}, [MINE, false, "month", "earnings", "mine"]);
    expect(named(mine, "StatCard").map((c) => [c.props.label, c.props.value, c.props.trendPct])).toEqual([
      ["Earnings", "$2.55", null], ["Prints", "4", 10], ["Paid renders", "3", null], ["Created", "7", -5], ["Conversion", "—", null],
    ]);
    expect(text(mine)).toContain("Quiet so far — earnings, renders and ratings land here.");
    const sold = render(AnalyticsPanel as never, {}, [{ ...MINE, activity: [{ type: "sale", prompt: "Lighthouse", amountCents: 150, rating: null, at: new Date().toISOString() }] }, false, "month", "earnings", "mine"]);
    expect(text(sold)).toContain("Paid render");
    expect(text(sold)).not.toContain("unlocked");
    // The Payment tab counts the same thing by the same name.
    expect(readSource(join(__dirname, "..", "..", "components", "settings", "PaymentPanel.tsx"))).toContain('<div className="set-earn-label">Paid renders</div>');
  });

  it("opens on Mine; the Enki tab shows Enki's numbers for the same period", () => {
    const mine = render(AnalyticsPanel as never, {}, []);
    expect(named(mine, "EnkiView")).toEqual([]);
    const tabs = [...walk(mine)].filter((e) => e.props.role === "tab");
    expect(tabs.map((t) => [text(t.props.children as ReactNode), t.props["aria-selected"]])).toEqual([["Mine", true], ["Enki", false]]);
    (tabs[1].props.onClick as () => void)();
    expect(ui.state[4]).toBe("enki");
    const { panel, el } = enkiView();
    expect(el.props.period).toBe("week");
    expect(named(panel, "StatCard")).toEqual([]);
    const head = named(panel, "PanelHead")[0];
    expect(head.props.sub).toBe("Everything happening on Enki.");
  });

  it("asks for the period and the column, and keeps the answer; a failed load says so", async () => {
    const { View } = enkiView();
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { fetched.push(url); return { ok: true, json: async () => PAYLOAD }; });
    render(View, { period: "week" }, ["likes", null, false]);
    await ui.effects[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetched).toEqual(["/api/analytics/enki?period=week&sort=likes"]);
    expect(ui.state[1]).toEqual(PAYLOAD);
    render(View, { period: "week" }, ["likes", null, true]);
    await ui.effects[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(ui.state[2]).toBe(false);
    vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => ({}) }));
    render(View, { period: "all" }, ["revenue", ALL, false]);
    await ui.effects[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(ui.state[2]).toBe(true);
    expect(text(render(View, { period: "all" }, ["revenue", ALL, true]))).toContain("Could not load Enki's numbers");
    // Another period's answer is not this period's: it waits for its own.
    expect(text(render(View, { period: "all" }, ["revenue", PAYLOAD, false]))).toBe("Loading…");
    vi.unstubAllGlobals();
  });

  it("shows each figure with its last 24 hours, Kev's list first; a week counts new users", () => {
    const { View } = enkiView();
    const cards = named(render(View, { period: "week" }, ["revenue", PAYLOAD, false]), "StatCard").map((c) => [c.props.label, c.props.value, c.props.day]);
    expect(cards).toEqual([
      ["New users", "39", "+2"], ["Posted images", "2", "0"], ["Generated images", "55", "+4"], ["Artist revenue", "$3.86", "+$1.50"],
      ["Views", "—", null], ["Prompts", "6", "0"], ["Likes", "3", "0"], ["Comments", "1", "+1"],
    ]);
    expect(named(render(View, { period: "all" }, ["revenue", ALL, false]), "StatCard")[0].props.label).toBe("Users");
    const card = named(render(View, { period: "week" }, ["revenue", PAYLOAD, false]), "StatCard");
    const Card = card[0].type as (p: object) => ReactNode;
    expect(text(Card(card[0].props))).toBe("New users39↗ +2 in 24h");
    expect(text(Card(card[1].props))).toBe("Posted images20 in 24h");
    expect(text(Card(card[4].props))).toBe("Views——");
  });

  it("ranks the creators by the server's column, opens a creator, and asks for a column clicked", () => {
    const { View } = enkiView();
    const tree = render(View, { period: "week" }, ["followers", PAYLOAD, false]);
    const heads = [...walk(tree)].filter((e) => "aria-pressed" in e.props);
    expect(heads.map((h) => [text(h.props.children as ReactNode), h.props["aria-pressed"], h.props.disabled ?? false])).toEqual([
      ["Prompts", false, false], ["Posts", false, false], ["Revenue ↓", true, false], ["Views", false, false],
      ["Likes", false, false], ["Comments", false, false], ["Followers", false, false],
    ]);
    const rows = [...walk(tree)].filter((e) => typeof e.props.title === "string" && String(e.props.title).startsWith("Open @"));
    expect(rows.map((r) => text(r.props.children as ReactNode))).toEqual(["@ann", "@bob"]);
    (rows[1].props.onClick as () => void)();
    expect(opened).toEqual(["bob"]);
    // No handle, no profile: the row says unnamed and opens nothing.
    expect(text(tree)).toContain("unnamed");
    expect(text(tree)).toContain("$3.60");
    (heads[6].props.onClick as () => void)();
    expect(ui.state[0]).toBe("followers");
    (heads[1].props.onClick as () => void)();
    expect(ui.state[0]).toBe("posts");
    const allTime = render(View, { period: "all" }, ["revenue", { ...ALL, board: [] }, false]);
    expect([...walk(allTime)].filter((e) => "aria-pressed" in e.props)[3].props.disabled).toBeFalsy();
    expect(text(allTime)).toContain("No creators in this period yet.");
  });

  it("shows what was watched most, and opens a prompt or an image from it", () => {
    const { View } = enkiView();
    const payload = { ...PAYLOAD, watched: { prompts: [{ id: "p1", title: "Lighthouse", handle: "ann", views: 9 }], images: [{ id: "i1", thumb: "https://x/t.webp", handle: null, views: 7 }] } };
    const tree = render(View, { period: "week" }, ["revenue", payload, false]);
    const blocks = [...walk(tree)].filter((e) => "data-watched" in e.props);
    expect(blocks.map((b) => b.props["data-watched"])).toEqual(["prompts", "images"]);
    expect(text(blocks[0])).toContain("Lighthouse");
    expect(text(blocks[0])).toContain("9 opens");
    expect(text(blocks[1])).toContain("unnamed");
    expect(text(blocks[1])).toContain("7 opens");
    const rows = [...walk(tree)].filter((e) => typeof e.props.title === "string" && (String(e.props.title).startsWith("Open “") || e.props.title === "Open this image"));
    (rows[0].props.onClick as () => void)();
    (rows[1].props.onClick as () => void)();
    expect(pushed).toEqual(["/home?prompt=p1", "/i/i1"]);
    expect([...walk(render(View, { period: "week" }, ["revenue", PAYLOAD, false]))].filter((e) => "data-watched" in e.props)).toEqual([]);
  });
});
