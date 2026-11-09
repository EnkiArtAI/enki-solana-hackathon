import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * DEC-511 (Kev, 2026-10-29: "where is the follow button for people that arent me? i also want also then to the left
 * of it once followed the bell button to turn on notifications upon new post"): Follow, and once followed a bell left
 * of it that starts off. Every change reads the state again from GET /api/follows.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], s: 0, data: undefined as unknown, enabled: undefined as unknown }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
}));
const spies = vi.hoisted(() => ({ invalidate: vi.fn(async () => {}), login: vi.fn(), notify: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { enabled: boolean }) => { ui.enabled = o.enabled; return { data: ui.data }; },
  useQueryClient: () => ({ invalidateQueries: spies.invalidate }),
}));
vi.mock("@/lib/openLogin", () => ({ openLogin: spies.login }));
vi.mock("@/components/kit/notify", () => ({ notify: spies.notify }));
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "t" }) }));

import { FollowButtons } from "@/components/profile/FollowButtons";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const STYLE = { height: 40, padding: "0 16px" };
const buttons = (signedIn = true) => {
  ui.s = 0;
  return [...walk(FollowButtons({ user: "u-2", name: "mira", signedIn, style: STYLE }) as El)].filter((el) => el.type === "button");
};
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

let calls: unknown[];
let answer: { ok: boolean; body: unknown };
beforeEach(() => {
  ui.state = []; ui.data = undefined; spies.invalidate.mockClear(); spies.login.mockClear(); spies.notify.mockClear();
  calls = []; answer = { ok: true, body: {} };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body: string }) => {
    if (init?.body) calls.push(JSON.parse(init.body));
    return { ok: answer.ok, json: async () => answer.body };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Follow on someone's profile", () => {
  it("follows, with no bell until followed", async () => {
    const [follow] = buttons();
    expect(buttons().map((b) => [b.props.children].flat().join(""))).toEqual(["Follow"]);
    (follow.props.onClick as () => void)();
    await settle();
    expect(calls).toEqual([{ user: "u-2", follow: true }]);
    expect(spies.invalidate).toHaveBeenCalledWith({ queryKey: ["follow", "u-2"] });
  });

  it("once followed, shows the bell left of Following, off, and the bell turns it on", async () => {
    ui.data = { following: true, notify: false };
    const [bell, following] = buttons();
    expect([bell.props["aria-pressed"], [following.props.children].flat().join(""), following.props["aria-pressed"]]).toEqual([false, "Following", true]);
    (bell.props.onClick as () => void)();
    await settle();
    expect(calls).toEqual([{ user: "u-2", notify: true }]);
    ui.data = { following: true, notify: true };
    expect(buttons()[0].props["aria-pressed"]).toBe(true);
  });

  it("unfollows from Following", async () => {
    ui.data = { following: true, notify: true };
    (buttons()[1].props.onClick as () => void)();
    await settle();
    expect(calls).toEqual([{ user: "u-2", follow: false }]);
  });

  it("says what went wrong and reads the state again", async () => {
    answer = { ok: false, body: { error: "Too many requests" } };
    (buttons()[0].props.onClick as () => void)();
    await settle();
    expect(spies.notify).toHaveBeenCalledWith("Too many requests");
    expect(spies.invalidate).toHaveBeenCalledTimes(2);
  });

  it("asks a guest to log in, and reads nothing for one", () => {
    (buttons(false)[0].props.onClick as () => void)();
    expect([spies.login.mock.calls.length, calls.length, ui.enabled]).toEqual([1, 0, false]);
  });
});
