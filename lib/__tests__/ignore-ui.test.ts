import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * Ignore (Kev, 2026-10-29: "an 'ignore' function so that i dont see the prompts and images of the person anymore ...
 * show in the filters that also ignored ppl shall be visible ... the profile settings where i see the list of people i
 * ignored"): the Ignore / Ignored toggle on someone else's profile, the feed's Show ignored pill while I ignore
 * someone, and People you ignore in Settings with Un-ignore. GET /api/ignores is the one list; every change reads it
 * and the feed again. The components are called with their state set, as React would render them.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], s: 0, query: { data: undefined as unknown, error: null as unknown }, options: null as null | { queryKey: unknown; queryFn: () => Promise<unknown>; enabled: boolean } }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
}));
const spies = vi.hoisted(() => ({ invalidate: vi.fn(async (_o: unknown) => {}), login: vi.fn(), notify: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: NonNullable<typeof ui.options>) => { ui.options = o; return ui.query; },
  useQueryClient: () => ({ invalidateQueries: spies.invalidate }),
}));
vi.mock("@/lib/openLogin", () => ({ openLogin: spies.login }));
vi.mock("@/components/kit/notify", () => ({ notify: spies.notify }));
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "t" }), viewerHeaders: () => ({}) }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("@/components/generation/GeneratorLogo", () => ({ default: () => null }));

import { IgnoreButton } from "@/components/profile/IgnoreButton";
import IgnoredPeople from "@/components/settings/IgnoredPeople";
import EnkiFilters from "@/components/enki/EnkiFilters";
import { useIgnores } from "@/hooks/useIgnores";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("") : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);
const buttons = (tree: ReactNode) => [...walk(tree)].filter((el) => el.type === "button");
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const draw = <P,>(C: (p: P) => ReactNode, props: P) => { ui.s = 0; return C(props); };

const ANN = { id: "u-2", handle: "ann", displayName: "Ann", avatarUrl: null };
const BOB = { id: "u-3", handle: "", displayName: "Bob", avatarUrl: null };
const NAMELESS = { id: "u-4", handle: "", displayName: "", avatarUrl: null };
const STYLE = { height: 40 };
// The list, the feed (search too: one key) and the strip of images made with a prompt.
const RELOADS = [[{ queryKey: ["/api/ignores"] }], [{ queryKey: ["/api/marketplace/prompts"] }], [{ queryKey: ["prompt-public-images"] }]];

let calls: unknown[];
let answer: { ok: boolean; body: unknown } | "offline";
beforeEach(() => {
  ui.state = []; ui.query = { data: undefined, error: null }; ui.options = null;
  spies.invalidate.mockClear(); spies.login.mockClear(); spies.notify.mockClear();
  calls = []; answer = { ok: true, body: {} };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body: string }) => {
    if (answer === "offline") throw new TypeError("network");
    if (init?.body) calls.push([url, init.method, JSON.parse(init.body)]);
    return { ok: answer.ok, json: async () => (answer as { body: unknown }).body };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Ignore on someone's profile", () => {
  const button = (signedIn = true) => buttons(draw(IgnoreButton, { user: "u-2", name: "Ann", signedIn, style: STYLE }))[0];

  it("ignores someone not ignored yet, says where they went, and reads the list and the feed again", async () => {
    ui.query.data = [BOB];
    const b = button();
    expect([text(b.props.children as ReactNode).trim(), b.props["aria-pressed"], ui.options?.enabled]).toEqual(["Ignore", false, true]);
    expect(b.props.title).toBe("Hide Ann's prompts and images from your feed");
    (b.props.onClick as () => void)();
    await settle();
    expect(calls).toEqual([["/api/ignores", "POST", { user: "u-2", ignore: true }]]);
    expect(spies.notify).toHaveBeenCalledWith("Ann's prompts and images are out of your feed. Show ignored brings them back.");
    expect(spies.invalidate.mock.calls).toEqual(RELOADS);
  });

  it("shows Ignored for someone ignored, and un-ignores them without a word", async () => {
    ui.query.data = [ANN];
    const b = button();
    expect([text(b.props.children as ReactNode).trim(), b.props["aria-pressed"], b.props.title]).toEqual(["Ignored", true, "Show Ann's prompts and images again"]);
    (b.props.onClick as () => void)();
    await settle();
    expect(calls).toEqual([["/api/ignores", "POST", { user: "u-2", ignore: false }]]);
    expect(spies.notify).not.toHaveBeenCalled();
    expect(spies.invalidate.mock.calls).toEqual(RELOADS);
  });

  it("says the server's sentence, or the network's, and reads the state again either way", async () => {
    answer = { ok: false, body: { error: "Ignoring is not available yet." } };
    (button().props.onClick as () => void)();
    await settle();
    expect(spies.notify).toHaveBeenCalledWith("Ignoring is not available yet.");
    answer = { ok: false, body: {} };
    (button().props.onClick as () => void)();
    await settle();
    expect(spies.notify).toHaveBeenLastCalledWith("That did not work. Try again.");
    answer = "offline";
    (button().props.onClick as () => void)();
    await settle();
    expect(spies.notify).toHaveBeenLastCalledWith("Network hiccup. Try again.");
    expect(spies.invalidate).toHaveBeenCalledTimes(9);
  });

  it("is busy while it asks", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((r) => { release = () => r({ ok: true, json: async () => ({}) }); })));
    (button().props.onClick as () => void)();
    expect(button().props.disabled).toBe(true);
    release();
    await settle();
    expect(button().props.disabled).toBe(false);
  });

  // Second review of DEC-2026-11-03-07: the button stayed disabled until every loaded page of the shelf behind it was read again.
  it("waits for its own list only, never for the feed's or a shelf's pages", async () => {
    let listIn!: () => void;
    spies.invalidate.mockImplementation(((o: { queryKey: string[] }) => (o.queryKey[0] === "/api/ignores" ? new Promise<void>((r) => { listIn = r; }) : new Promise<void>(() => {}))) as never);
    (button().props.onClick as () => void)();
    await settle();
    expect(button().props.disabled).toBe(true);
    listIn();
    await settle();
    expect(button().props.disabled).toBe(false);
    expect(spies.invalidate.mock.calls).toEqual(RELOADS);
    spies.invalidate.mockImplementation(async () => {});
  });

  it("asks a guest to log in, and reads nothing for one", () => {
    (button(false).props.onClick as () => void)();
    expect([spies.login.mock.calls.length, calls.length, ui.options?.enabled]).toEqual([1, 0, false]);
  });

  it("stands after Report on someone else's profile, never on your own, apart from Message and Follow", () => {
    const profile = readSource(join(__dirname, "..", "..", "components", "profile", "ProfileView.tsx"));
    expect(profile).toMatch(/<\/ReportButton>\n\s+\{creatorId !== seedOwner && \(\n\s+<IgnoreButton user=\{creatorId\} name=\{displayName\} signedIn=\{isAuthed\} style=\{[^\n]*\/>\n\s+\)\}\n\s+<\/div>/);
  });
});

describe("the list of people I ignore", () => {
  it("is GET /api/ignores, and a failed read is its sentence, never an empty list", async () => {
    useIgnores(true);
    const { queryKey, queryFn, enabled } = ui.options!;
    expect([queryKey, enabled]).toEqual([["/api/ignores"], true]);
    answer = { ok: true, body: { people: [ANN] } };
    expect(await queryFn()).toEqual([ANN]);
    expect(vi.mocked(fetch).mock.calls[0]).toEqual(["/api/ignores", { headers: { "X-Session-Token": "t" } }]);
    answer = { ok: true, body: {} };
    expect(await queryFn()).toEqual([]);
    answer = { ok: false, body: { error: "Ignoring is not available yet." } };
    await expect(queryFn()).rejects.toThrow("Ignoring is not available yet.");
    answer = { ok: false, body: {} };
    await expect(queryFn()).rejects.toThrow("The people you ignore could not be loaded.");
    useIgnores(false);
    expect(ui.options!.enabled).toBe(false);
  });
});

describe("Settings → Profile → People you ignore", () => {
  const section = () => draw(IgnoredPeople, { num: "05" });

  it("says it is loading, that it failed, or that you ignore nobody", () => {
    const head = section() as El;
    expect([head.props.num, head.props.title, ui.options?.enabled]).toEqual(["05", "People you ignore", true]);
    expect(text(section())).toContain("Loading…");
    ui.query.error = new Error("Ignoring is not available yet.");
    expect(text(section())).toContain("Ignoring is not available yet.");
    expect(text(section())).not.toContain("Loading…");
    ui.query = { data: [], error: null };
    expect(text(section())).toContain("You ignore nobody. Ignore someone from their profile.");
    expect(buttons(section())).toEqual([]);
  });

  it("lists each one by name and handle, one with neither as Unnamed, with Un-ignore", async () => {
    ui.query.data = [ANN, BOB, NAMELESS];
    const rows = [...walk(section())].filter((el) => el.props.className === "set-list-item");
    expect(rows.map((r) => text(r.props.children as ReactNode))).toEqual(["Ann@annUn-ignore", "BobUn-ignore", "UnnamedUn-ignore"]);
    (buttons(rows[1])[0].props.onClick as () => void)();
    await settle();
    expect(calls).toEqual([["/api/ignores", "POST", { user: "u-3", ignore: false }]]);
    expect(spies.invalidate.mock.calls).toEqual(RELOADS);
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("says why an un-ignore failed, and holds that row's button while it asks", async () => {
    ui.query.data = [ANN, BOB];
    answer = { ok: false, body: { error: "Too many requests" } };
    (buttons(section())[0].props.onClick as () => void)();
    expect(buttons(section()).map((b) => b.props.disabled)).toEqual([true, false]);
    await settle();
    expect(spies.notify).toHaveBeenCalledWith("Too many requests");
    expect(buttons(section()).map((b) => b.props.disabled)).toEqual([false, false]);
    answer = { ok: false, body: {} };
    (buttons(section())[0].props.onClick as () => void)();
    await settle();
    expect(spies.notify).toHaveBeenLastCalledWith("Couldn't un-ignore. Try again.");
    answer = "offline";
    (buttons(section())[0].props.onClick as () => void)();
    await settle();
    expect(spies.notify).toHaveBeenLastCalledWith("Network hiccup. Try again.");
  });
});

describe("the feed's Show ignored pill", () => {
  const pill = (props: object) =>
    buttons(draw(EnkiFilters as (p: object) => ReactNode, { active: [], onPick: () => {}, ...props })).filter((b) => text(b.props.children as ReactNode) === "Show ignored");

  it("is there only when the feed gives it, pressed as the feed says, and flips it", () => {
    expect(pill({})).toEqual([]);
    const flips: boolean[] = [];
    const [off] = pill({ showIgnored: false, onShowIgnored: (on: boolean) => flips.push(on) });
    expect([off.props["aria-pressed"], off.props.className, off.props.title]).toEqual([false, "feed-pill kit-hit", "Show the people you ignore"]);
    (off.props.onClick as () => void)();
    const [on] = pill({ showIgnored: true, onShowIgnored: (on: boolean) => flips.push(on) });
    expect([on.props["aria-pressed"], on.props.className, on.props.title]).toEqual([true, "feed-pill kit-hit on", "Hide the people you ignore"]);
    (on.props.onClick as () => void)();
    expect(flips).toEqual([true, false]);
  });

  it("shows while I ignore someone, starts off, and asks the feed and search for them only while on", () => {
    const feed = readSource(join(__dirname, "..", "..", "components", "enki", "EnkiFeedPage.tsx"));
    expect(feed).toContain("const ignoring = (useIgnores(authed).data?.length ?? 0) > 0;");
    expect(feed).toContain("const [ignoredPill, setIgnoredPill] = useState(false);");
    expect(feed).toContain("const showIgnored = ignoring && ignoredPill;");
    expect(feed).toContain("showIgnored={showIgnored} onShowIgnored={ignoring ? setIgnoredPill : undefined} />");
    expect(feed).toContain('queryKey: ["/api/marketplace/prompts", "home", showIgnored ? "ignored" : "", genFilter.join(",")');
    expect(feed).toMatch(/if \(showIgnored\) params\.set\("ignored", "1"\);\n\s+const res = await fetch\(`\/api\/search\?/);
    expect(feed).toMatch(/if \(showIgnored\) params\.set\("ignored", "1"\);\n\s+const res = await fetch\(`\/api\/marketplace\/prompts\?/);
  });
});
