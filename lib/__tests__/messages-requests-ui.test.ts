import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * DEC-513 (Kev, 2026-10-29: "requests shall have a zähler as indizes, oben rechts. switchable both between a pille ...
 * at the bottom click on 'accept message' and then it gets moved to normal chat and i can chat with him with the chat
 * eingabefeld being freigeschaltet").
 */
// Effects are kept, not run: a test runs the one it means.
const ui = vi.hoisted(() => ({ state: [] as unknown[], s: 0, effects: [] as (() => unknown)[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T | ((p: T) => T)) => { ui.state[i] = typeof next === "function" ? (next as (p: T) => T)(ui.state[i] as T) : next; }];
  },
  useEffect: (fn: () => unknown) => { ui.effects.push(fn); },
  useRef: <T>(start: T) => ({ current: start }),
}));
const store = vi.hoisted(() => ({
  threads: [] as unknown[],
  accept: vi.fn(async (_id: string) => null as string | null),
  del: vi.fn(async (_id: string, _upTo?: string) => null as string | null),
}));
vi.mock("@/hooks/useMessages", async (original) => ({
  ...(await original<typeof import("@/hooks/useMessages")>()),
  useMessages: () => ({ threads: store.threads, unreadTotal: 0, loaded: true }),
  acceptThread: store.accept,
  deleteThread: store.del,
  markThreadRead: vi.fn(),
  refreshMessages: vi.fn(),
}));
vi.mock("@/components/kit/Seal", () => ({ default: () => null }));
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "t" }) }));

import MessagesPanel from "@/components/enki-shell/MessagesPanel";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const text = (el: El): string => [...walk(el.props.children as ReactNode)].map((c) => (typeof c.props.children === "string" ? c.props.children : "")).join("")
  + [el.props.children].flat().filter((c) => typeof c === "string").join("");
const toast = vi.fn();
const draw = () => { ui.s = 0; ui.effects = []; return [...walk(MessagesPanel({ toast }) as El)]; };
const byClass = (tree: El[], c: string) => tree.filter((el) => typeof el.props.className === "string" && (el.props.className as string).split(" ").includes(c));
const peer = (h: string) => ({ id: `u-${h}`, handle: h, name: null, avatarUrl: null });
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
  ui.state = []; toast.mockClear(); store.accept.mockReset(); store.accept.mockResolvedValue(null);
  store.del.mockReset(); store.del.mockResolvedValue(null);
  store.threads = [
    { id: "t-req", peer: peer("ann"), last: { body: "hi", hasImage: false, mine: false, at: "2026-10-29T10:00:00Z" }, unread: 1, accepted: false },
    // No accepted at all: a conversation just opened from search is no request.
    { id: "t-chat", peer: peer("ben"), last: { body: "yo", hasImage: false, mine: true, at: "2026-10-29T09:00:00Z" }, unread: 0 },
  ];
});
afterEach(() => vi.unstubAllGlobals());

describe("Messages and requests", () => {
  it("switches between messages and requests in one pill, the requests' count on its top right", () => {
    let tree = draw();
    const tabs = tree.filter((el) => el.props.role === "tab");
    expect(tabs.map((t) => [t.props["aria-selected"], [t.props.children].flat().filter((c) => typeof c === "string").join("").trim()])).toEqual([[true, "Messages"], [false, "Requests"]]);
    expect(byClass(tree, "ek-msg-box-count").map((c) => c.props.children)).toEqual([1]);
    expect(byClass(tree, "ek-msg-row-name").map((n) => n.props.children)).toEqual(["ben"]);
    (tabs[1].props.onClick as () => void)();
    tree = draw();
    expect(byClass(tree, "ek-msg-row-name").map((n) => n.props.children)).toEqual(["ann"]);
    store.threads = store.threads.slice(1);
    expect(byClass(draw(), "ek-msg-box-count")).toHaveLength(0);
  });

  it("closes the open conversation when the box changes, and never offers to start one with someone who wrote", () => {
    (byClass(draw(), "ek-msg-row")[0].props.onClick as () => void)();
    expect(byClass(draw(), "ek-msg-thead")).toHaveLength(1);
    (draw().filter((el) => el.props.role === "tab")[1].props.onClick as () => void)();
    expect(byClass(draw(), "ek-msg-thead")).toHaveLength(0);
    (draw().filter((el) => el.props.role === "tab")[0].props.onClick as () => void)();
    // The people search's answer (state 5: activeId, box, busy, extraThread, query, people).
    ui.state[5] = [peer("ann"), peer("cat")];
    const starts = byClass(draw(), "ek-msg-row").filter((r) => r.key?.toString().startsWith("u-"));
    expect(starts.map((r) => r.key)).toEqual(["u-cat"]);
  });

  it("opens a request with Accept message in place of the field, and Accept moves it to the messages", async () => {
    (draw().filter((el) => el.props.role === "tab")[1].props.onClick as () => void)();
    (byClass(draw(), "ek-msg-row")[0].props.onClick as () => void)();
    let tree = draw();
    expect(tree.filter((el) => el.type === "input").map((i) => i.props.placeholder)).toEqual(["Search people…"]);
    const acceptBtn = byClass(tree, "ek-msg-accept-btn")[0];
    expect(text(acceptBtn)).toBe("Accept message");
    expect(text((byClass(tree, "ek-msg-accept")[0].props.children as El[])[0])).toBe("@ann wants to message you. Accept to reply.");
    (acceptBtn.props.onClick as () => void)();
    await settle();
    expect(store.accept).toHaveBeenCalledWith("t-req");
    tree = draw();
    expect(tree.filter((el) => el.props.role === "tab").map((t) => t.props["aria-selected"])).toEqual([true, false]);
  });

  it("an accepted conversation has the field", () => {
    (byClass(draw(), "ek-msg-row")[0].props.onClick as () => void)();
    const tree = draw();
    expect(byClass(tree, "ek-msg-accept")).toHaveLength(0);
    expect(tree.some((el) => el.type === "input" && el.props.placeholder === "Write a message…")).toBe(true);
  });

  it("says what went wrong and stays on the request", async () => {
    store.accept.mockResolvedValue("Message requests are not available yet");
    (draw().filter((el) => el.props.role === "tab")[1].props.onClick as () => void)();
    (byClass(draw(), "ek-msg-row")[0].props.onClick as () => void)();
    (byClass(draw(), "ek-msg-accept-btn")[0].props.onClick as () => void)();
    await settle();
    expect(toast).toHaveBeenCalledWith("Message requests are not available yet");
    expect(draw().filter((el) => el.props.role === "tab").map((t) => t.props["aria-selected"])).toEqual([false, true]);
  });
});

// Kev, 2026-10-29: "the decline button for message requests, just add a delete button, no decline button".
describe("Delete on a request", () => {
  const openRequest = () => {
    (draw().filter((el) => el.props.role === "tab")[1].props.onClick as () => void)();
    (byClass(draw(), "ek-msg-row")[0].props.onClick as () => void)();
  };
  const buttons = () => { const tree = draw(); return [...byClass(tree, "ek-msg-delete-btn"), ...byClass(tree, "ek-msg-accept-btn")].map((b) => [text(b), b.props.disabled]); };
  const clickDelete = () => (byClass(draw(), "ek-msg-delete-btn")[0].props.onClick as () => void)();
  // The open thread's messages (state 6, after people).
  const shown = (ats: string[]) => { ui.state[6] = ats.map((at, i) => ({ id: `m${i}`, mine: false, body: "hi", imageUrl: null, at })); };

  it("sits beside Accept message, deletes on one click up to the newest message shown, and closes the request", async () => {
    openRequest();
    const actions = byClass(draw(), "ek-msg-accept-actions")[0];
    expect((actions.props.children as El[]).map((b) => [b.props.className, text(b), b.props.disabled])).toEqual([["ek-msg-delete-btn", "Delete", false], ["ek-msg-accept-btn", "Accept message", false]]);
    shown(["2026-10-29T10:00:00Z", "2026-10-29T10:05:00Z"]);
    clickDelete();
    await settle();
    expect(store.del).toHaveBeenCalledWith("t-req", "2026-10-29T10:05:00Z");
    const tree = draw();
    expect(byClass(tree, "ek-msg-thead")).toHaveLength(0);
    expect(tree.filter((el) => el.props.role === "tab").map((t) => t.props["aria-selected"])).toEqual([false, true]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("opens no other request after a delete, and the box's newest again once the box changes", async () => {
    store.threads.splice(1, 0, { id: "t-req2", peer: peer("cat"), last: { body: "hey", hasImage: false, mine: false, at: "2026-10-29T09:30:00Z" }, unread: 1, accepted: false });
    // As the real store does: what was deleted leaves the list.
    store.del.mockImplementation(async (id: string) => { store.threads = store.threads.filter((t) => (t as { id: string }).id !== id); return null; });
    // Draw, run the panel's first effect (open the box's newest when none is open), draw again.
    const settled = () => { draw(); (ui.effects[0] as () => void)(); return draw(); };
    openRequest();
    clickDelete();
    await settle();
    let tree = settled();
    expect([byClass(tree, "ek-msg-thead").length, byClass(tree, "ek-msg-row").map((r) => [r.key, r.props.className])]).toEqual([0, [["t-req2", "ek-msg-row unread"]]]);
    const tab = (i: number) => (draw().filter((el) => el.props.role === "tab")[i].props.onClick as () => void)();
    tab(0);
    tab(1);
    tree = settled();
    expect(byClass(tree, "ek-msg-row").map((r) => [r.key, r.props.className])).toEqual([["t-req2", "ek-msg-row on unread"]]);
  });

  it("with no messages loaded yet, or none, deletes up to the list's newest", async () => {
    openRequest();
    clickDelete();
    await settle();
    shown([]);
    openRequest();
    clickDelete();
    await settle();
    expect(store.del.mock.calls).toEqual([["t-req", "2026-10-29T10:00:00Z"], ["t-req", "2026-10-29T10:00:00Z"]]);
  });

  it("keeps both buttons off while one waits, and says which", async () => {
    const wait = () => { let done!: (v: string | null) => void; return [new Promise<string | null>((r) => { done = r; }), (v: string | null) => done(v)] as const; };
    const [deleting, deleted] = wait();
    store.del.mockReturnValue(deleting);
    openRequest();
    clickDelete();
    expect(buttons()).toEqual([["Deleting…", true], ["Accept message", true]]);
    deleted("Deleting requests is not available yet");
    await settle();
    const [accepting, accepted] = wait();
    store.accept.mockReturnValue(accepting);
    (byClass(draw(), "ek-msg-accept-btn")[0].props.onClick as () => void)();
    expect(buttons()).toEqual([["Delete", true], ["Accepting…", true]]);
    accepted("Message requests are not available yet");
    await settle();
    expect(buttons()).toEqual([["Delete", false], ["Accept message", false]]);
  });

  it("is Accept's quieter twin: in a row with it, the same height, outlined, dimmed while waiting", () => {
    const css = readSource(join(__dirname, "..", "..", "components", "enki-shell", "enki-shell.css"));
    expect(css).toContain(".ek-msg-accept-actions { display: flex; gap: 8px; }");
    expect(css).toMatch(/\.ek-msg-delete-btn \{ height: 36px; [^}]*border: 1px solid var\(--enki-rule\); [^}]*background: transparent; color: var\(--enki-ink\);/);
    expect(css).toContain(".ek-msg-delete-btn:disabled { opacity: 0.5; cursor: default; }");
  });

  it("says what went wrong and keeps the request open", async () => {
    store.del.mockResolvedValue("Deleting requests is not available yet");
    openRequest();
    clickDelete();
    await settle();
    expect(toast).toHaveBeenCalledWith("Deleting requests is not available yet");
    expect(byClass(draw(), "ek-msg-thead")).toHaveLength(1);
    expect(buttons()[0]).toEqual(["Delete", false]);
  });
});

describe("the store's Accept", () => {
  it("posts it and, only once the server says yes, moves the thread to the messages", async () => {
    const real = await vi.importActual<typeof import("@/hooks/useMessages")>("@/hooks/useMessages");
    const sent: unknown[] = [];
    let ok = false;
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => { sent.push(JSON.parse(init.body)); return { ok, json: async () => ({ error: "nope" }) }; }));
    expect(await real.acceptThread("t-req")).toBe("nope");
    ok = true;
    expect(await real.acceptThread("t-req")).toBeNull();
    expect(sent).toEqual([{ threadId: "t-req", accept: true }, { threadId: "t-req", accept: true }]);
    expect((window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe("the store's Delete", () => {
  it("posts it and, only once the server says yes, drops the thread and its unread", async () => {
    const real = await vi.importActual<typeof import("@/hooks/useMessages")>("@/hooks/useMessages");
    const sent: unknown[] = [];
    let answer: { ok: boolean; json: () => Promise<unknown> } | null = null;
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body?: string }) => {
      // The overview poll first: a request with 2 unread, a conversation with 1.
      if (!init.body) return { ok: true, json: async () => ({ threads: [{ ...(store.threads[0] as object), unread: 2 }, store.threads[1]], unreadTotal: 3 }) };
      sent.push(JSON.parse(init.body));
      if (!answer) throw new Error("offline");
      return answer;
    }));
    real.refreshMessages();
    await settle();
    // useMessages hands out the store as it stands (useState is the test's).
    const seen = () => { ui.s = 0; ui.state = []; const s = real.useMessages(); return [s.threads.map((t) => t.id), s.unreadTotal]; };
    expect(seen()).toEqual([["t-req", "t-chat"], 3]);
    const at = "2026-10-29T10:00:00Z";
    expect(await real.deleteThread("t-req", at)).toBe("Could not delete the request. Check your connection.");
    answer = { ok: false, json: async () => ({}) };
    expect(await real.deleteThread("t-req", at)).toBe("Could not delete the request.");
    answer = { ok: false, json: async () => ({ error: "nope" }) };
    expect(await real.deleteThread("t-req", at)).toBe("nope");
    expect(seen()).toEqual([["t-req", "t-chat"], 3]);
    answer = { ok: true, json: async () => ({ ok: true }) };
    expect(await real.deleteThread("t-gone", at)).toBeNull();
    expect(seen()).toEqual([["t-req", "t-chat"], 3]);
    expect(await real.deleteThread("t-req", at)).toBeNull();
    expect(seen()).toEqual([["t-chat"], 1]);
    const body = (threadId: string) => ({ threadId, delete: true, upTo: at });
    expect(sent).toEqual([body("t-req"), body("t-req"), body("t-req"), body("t-gone"), body("t-req")]);
    // One for the poll, one for each delete the server took.
    expect((window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it("a poll that read before the delete does not bring the request back; the next one counts", async () => {
    const real = await vi.importActual<typeof import("@/hooks/useMessages")>("@/hooks/useMessages");
    const both = { threads: [store.threads[0], store.threads[1]], unreadTotal: 1 };
    let answers: Promise<unknown>[] = [Promise.resolve(both)];
    let late!: (v: unknown) => void;
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body?: string }) =>
      init.body ? { ok: true, json: async () => ({ ok: true }) } : { ok: true, json: () => answers.shift() }));
    const seen = () => { ui.s = 0; ui.state = []; const s = real.useMessages(); return [s.threads.map((t) => t.id), s.unreadTotal]; };
    real.refreshMessages();
    await settle();
    expect(seen()).toEqual([["t-req", "t-chat"], 1]);
    answers = [new Promise((r) => { late = r; })];
    real.refreshMessages();
    await settle();
    expect(await real.deleteThread("t-req", "2026-10-29T10:00:00Z")).toBeNull();
    late(both);
    await settle();
    expect(seen()).toEqual([["t-chat"], 0]);
    answers = [Promise.resolve({ threads: [store.threads[1]], unreadTotal: 4 })];
    real.refreshMessages();
    await settle();
    expect(seen()).toEqual([["t-chat"], 4]);
  });

  it("a poll that read before an accept does not make it a request again", async () => {
    const real = await vi.importActual<typeof import("@/hooks/useMessages")>("@/hooks/useMessages");
    const before = { threads: [store.threads[0], store.threads[1]], unreadTotal: 1 };
    let answers: Promise<unknown>[] = [Promise.resolve(before)];
    let late!: (v: unknown) => void;
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body?: string }) =>
      init.body ? { ok: true, json: async () => ({ ok: true }) } : { ok: true, json: () => answers.shift() }));
    const accepted = () => { ui.s = 0; ui.state = []; return real.useMessages().threads.find((t) => t.id === "t-req")?.accepted; };
    real.refreshMessages();
    await settle();
    expect(accepted()).toBe(false);
    answers = [new Promise((r) => { late = r; })];
    real.refreshMessages();
    await settle();
    expect(await real.acceptThread("t-req")).toBeNull();
    late(before);
    await settle();
    expect(accepted()).toBe(true);
  });
});
