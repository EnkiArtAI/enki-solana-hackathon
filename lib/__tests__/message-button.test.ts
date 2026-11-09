import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "./_read-source";

/**
 * DEC-507 (Kev, 2026-10-29: "next to it to the left shall be the message button which is a DM. when clicking it, a lil
 * pop up comes up where i can type in a message, without any anhang"): words only, through the Messages panel's routes.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], s: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
}));
const spies = vi.hoisted(() => ({ refresh: vi.fn(), login: vi.fn() }));
vi.mock("@/hooks/useMessages", () => ({ refreshMessages: spies.refresh }));
vi.mock("@/lib/openLogin", () => ({ openLogin: spies.login }));
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "t" }) }));
vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => children;
  return { Dialog: pass, DialogContent: pass, DialogDescription: pass, DialogHeader: pass, DialogTitle: pass };
});

import { MessageButton } from "@/components/profile/MessageButton";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) {
    yield node;
    // Function components the mock passes through (the dialog's parts) render their children.
    yield* walk(node.props.children as ReactNode);
  }
}
const draw = (signedIn = true) => { ui.s = 0; return MessageButton({ to: "u-2", name: "mira", signedIn, children: "Message" }) as El; };
const find = (tree: ReactNode, type: string) => [...walk(tree)].filter((el) => el.type === type);
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

let calls: { url: string; body: unknown }[];
let answers: ({ ok: boolean; body: unknown })[];
beforeEach(() => {
  ui.state = []; spies.refresh.mockClear(); spies.login.mockClear();
  calls = []; answers = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const a = answers.shift() ?? { ok: true, body: {} };
    return { ok: a.ok, json: async () => a.body };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("the Message button on someone's profile", () => {
  it("opens a words-only pop-up and sends through the Messages routes: open the conversation, then the message", async () => {
    (find(draw(), "button")[0].props.onClick as () => void)();
    expect(ui.state[0]).toBe(true);
    const tree = draw();
    expect(find(tree, "input")).toHaveLength(0);
    const field = find(tree, "textarea")[0];
    expect(field.props.maxLength).toBe(2000);
    (field.props.onChange as (e: unknown) => void)({ target: { value: "  hi mira  " } });
    answers = [{ ok: true, body: { threadId: "t-1" } }, { ok: true, body: { message: {} } }];
    (find(draw(), "form")[0].props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
    await settle();
    expect(calls).toEqual([{ url: "/api/messages", body: { to: "u-2" } }, { url: "/api/messages", body: { threadId: "t-1", body: "hi mira" } }]);
    expect(spies.refresh).toHaveBeenCalledOnce();
    expect(ui.state[2]).toEqual({ sent: true });
  });

  it("says what went wrong and sends nothing more when the conversation cannot open", async () => {
    ui.state[0] = true; ui.state[1] = "hi";
    answers = [{ ok: false, body: { error: "That's you" } }];
    (find(draw(), "form")[0].props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
    await settle();
    expect(calls).toHaveLength(1);
    expect(ui.state[2]).toEqual({ error: "That's you" });
    expect(spies.refresh).not.toHaveBeenCalled();
  });

  it("never says nothing was sent once the message itself went out and its answer was lost", async () => {
    ui.state[0] = true; ui.state[1] = "hi";
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (n++ === 0) return { ok: true, json: async () => ({ threadId: "t-1" }) };
      throw new TypeError("network");
    }));
    (find(draw(), "form")[0].props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
    await settle();
    expect(ui.state[2]).toEqual({ error: "Network hiccup. It may have gone through: check your Messages before sending again." });
    expect(spies.refresh).toHaveBeenCalledOnce();
    // Lost before the conversation opened: nothing went out.
    ui.state = [true, "hi"]; spies.refresh.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    (find(draw(), "form")[0].props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
    await settle();
    expect(ui.state[2]).toEqual({ error: "Network hiccup. Nothing was sent." });
    expect(spies.refresh).not.toHaveBeenCalled();
  });

  it("asks a guest to log in instead of opening", () => {
    (find(draw(false), "button")[0].props.onClick as () => void)();
    expect([spies.login.mock.calls.length, ui.state[0]]).toEqual([1, false]);
  });

  // Message, then the bell and Follow (DEC-511: "next to it to the left shall be the message button"), then Report.
  it("stands left of the bell and Follow on someone else's profile, never on your own", () => {
    const profile = readSource(join(__dirname, "..", "..", "components", "profile", "ProfileView.tsx"));
    expect(profile).toMatch(/\{!own && creatorId && \(\n\s+<div className="pf-actions" style=\{\{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" \}\}>\n\s+\{creatorId !== seedOwner && \(\n\s+<>\n\s+<MessageButton to=\{creatorId\} name=\{displayName\} signedIn=\{isAuthed\}[^>]*>\n\s+<MessageCircle size=\{14\} \/> Message\n\s+<\/MessageButton>\n\s+<FollowButtons user=\{creatorId\} name=\{displayName\} signedIn=\{isAuthed\}[^>]*\/>\n\s+<\/>\n\s+\)\}\n\s+<ReportButton targetType="user" targetId=\{creatorId\}/);
  });
});
