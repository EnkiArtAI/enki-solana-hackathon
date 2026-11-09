import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * What a person sees of the "Confirm your email" window (Kev, 2026-11-07: "enter code oder request code"). The component is
 * called as React would render it, with state kept between calls and effects run when asked; its real handlers are driven
 * and the routes are what lib/__tests__/confirm-email.test.ts pins. The dialog's parts stand in for Radix (focus, Escape and
 * the backdrop are Radix's: components/ui/dialog.tsx). Blind spot: no browser, so layout, focus and the look are not seen
 * here; the agents' browser pane stops at the access gate (docs/change_management.md).
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, effects: [] as Array<() => unknown>, cleanups: [] as unknown[],
  path: "/home", account: "owner@example.test" as string | null,
  dialog: null as null | { open: boolean; onOpenChange: (open: boolean) => void },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T | (() => T)) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = typeof start === "function" ? (start as () => T)() : start;
    return [ui.state[i], (next: unknown) => { ui.state[i] = typeof next === "function" ? (next as (p: unknown) => unknown)(ui.state[i]) : next; }];
  },
  useEffect: (fn: () => unknown) => { ui.effects.push(fn); },
  useRef: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = { current: start };
    return ui.state[i];
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => ui.path, useRouter: () => ({ replace: () => {} }) }));
vi.mock("@/hooks/useEmailAuth", () => ({ useEmailAuth: () => ({ account: ui.account }) }));
vi.mock("@/lib/session-headers", async (real) => ({ ...(await real<typeof import("@/lib/session-headers")>()), sessionAuthHeaders: () => ({ "X-Session-Token": "s" }) }));
vi.mock("@/components/ui/dialog", async () => {
  const { createElement: h } = await import("react");
  return {
    Dialog: (p: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) => { ui.dialog = p; return p.open ? p.children : null; },
    DialogContent: (p: { children: ReactNode }) => p.children,
    DialogTitle: (p: { children: ReactNode }) => h("h2", null, p.children),
    DialogDescription: (p: { children: ReactNode }) => h("p", null, p.children),
  };
});

import ConfirmEmailWindow from "@/components/ConfirmEmailWindow";
import { CONFIRM_EMAIL_CLOSED_KEY as CLOSED_KEY, CONFIRM_EMAIL_EVENT, ensureCdpWallet, fetchWalletJwt, registerCdpEnsure } from "@/lib/cdp-bridge";

type El = ReactElement<Record<string, unknown>>;
type Portal = { containerInfo: unknown; children: ReactNode };
function flat(node: unknown, out: (El | string)[] = []): (El | string)[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => flat(n, out)); return out; }
  if ((node as Portal).containerInfo) return flat((node as Portal).children, out);
  if (!isValidElement(node)) return out;
  const el = node as El;
  if (typeof el.type === "function") return flat((el.type as (p: unknown) => unknown)(el.props), out);
  if ((el.type as unknown) !== Fragment) out.push(el);
  return flat(el.props.children, out);
}
const render = () => { ui.s = 0; ui.effects.length = 0; return flat(ConfirmEmailWindow()); };
const words = (tree: (El | string)[]) => tree.filter((n) => typeof n === "string").join(" ");
const hosts = (tree: (El | string)[]) => tree.filter((n): n is El => typeof n !== "string");
const textOf = (el: El) => words(flat(el.props.children));
const buttons = (tree: (El | string)[]) => hosts(tree).filter((e) => e.type === "button").map(textOf);
const button = (tree: (El | string)[], name: string) => {
  const found = hosts(tree).find((e) => e.type === "button" && (textOf(e) === name || e.props["aria-label"] === name));
  if (!found) throw new Error(`no button "${name}" in: ${words(tree)}`);
  return found.props as { onClick: () => unknown; disabled?: boolean; type?: string };
};
const input = (tree: (El | string)[]) => hosts(tree).find((e) => e.props["aria-label"] === "Code from the email");
const type = (value: string) => (input(render())!.props as { onChange: (e: unknown) => void }).onChange({ target: { value } });
const submit = async () => {
  const form = hosts(render()).find((e) => e.type === "form")!;
  (form.props as { onSubmit: (e: unknown) => void }).onSubmit({ preventDefault: () => {} });
  await settle();
};
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
/** One page load: render, run its effects, let the reads answer, render again. */
const load = async () => {
  render();
  for (const done of ui.cleanups) if (typeof done === "function") done();
  ui.cleanups = ui.effects.map((fn) => fn());
  await settle();
  return render();
};

const ADDRESS = "ow…@example.test";
let calls: { url: string; method: string; body?: unknown }[];
let answers: Array<{ status: number; body: unknown; headers?: Record<string, string> } | "offline">;
let page: { listeners: Map<string, Set<() => void>>; top: unknown; self: unknown; store: Map<string, string>; storeFails: boolean };

beforeEach(() => {
  ui.state.length = 0;
  ui.cleanups = [];
  ui.path = "/home";
  ui.account = "owner@example.test";
  ui.dialog = null;
  calls = [];
  answers = [];
  page = { listeners: new Map(), top: null, self: null, store: new Map(), storeFails: false };
  const win = {
    addEventListener: (t: string, f: () => void) => { if (!page.listeners.has(t)) page.listeners.set(t, new Set()); page.listeners.get(t)!.add(f); },
    removeEventListener: (t: string, f: () => void) => { page.listeners.get(t)?.delete(f); },
    dispatchEvent: (e: Event) => { page.listeners.get(e.type)?.forEach((f) => f()); return true; },
  } as Record<string, unknown>;
  win.top = win;
  win.self = win;
  vi.stubGlobal("window", win);
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => { if (page.storeFails) throw new Error("blocked"); return page.store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (page.storeFails) throw new Error("blocked"); page.store.set(k, v); },
    removeItem: (k: string) => { if (page.storeFails) throw new Error("blocked"); page.store.delete(k); },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    const a = answers.shift() ?? { status: 200, body: { needed: true, email: ADDRESS } };
    if (a === "offline") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(a.body), { status: a.status, headers: a.headers });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("when it shows", () => {
  it("on load, when the status read says the login email waits: the title, one line with the address and both reasons, two buttons", async () => {
    const tree = await load();
    expect(calls).toEqual([{ url: "/api/auth/password/confirm-email", method: "GET" }]);
    expect(ui.dialog!.open).toBe(true);
    expect(words(tree)).toContain("Confirm your email");
    expect(words(tree)).toContain(`Confirm ${ADDRESS} to open your wallet and to make sure security alerts reach you.`);
    expect(buttons(tree)).toEqual(["Enter code", "Request code"]);
    expect(words(tree)).not.toMatch(/forgot/i);
  });

  it("not when the read says no, fails, or cannot be made", async () => {
    answers = [{ status: 200, body: { needed: false, email: null } }];
    await load();
    expect(ui.dialog!.open).toBe(false);
    ui.state.length = 0;
    answers = [{ status: 503, body: { error: "down" } }];
    await load();
    expect(ui.dialog!.open).toBe(false);
    ui.state.length = 0;
    answers = ["offline"];
    await load();
    expect(ui.dialog!.open).toBe(false);
  });

  it("reads nothing without a session, on a public page, on /banned or in a frame", async () => {
    ui.account = null;
    await load();
    for (const path of ["/", "/landing", "/reset-password", "/banned", "/banned/appeal"]) {
      ui.account = "owner@example.test";
      ui.path = path;
      ui.state.length = 0;
      await load();
    }
    ui.path = "/home";
    ui.state.length = 0;
    (window as unknown as { top: unknown }).top = {};
    await load();
    expect(calls).toEqual([]);
  });

  it("reads once per account and page load, not on every render or page; again for another account", async () => {
    await load();
    await load();
    ui.path = "/settings";
    await load();
    expect(calls).toHaveLength(1);
    ui.account = "second@example.test";
    await load();
    expect(calls).toHaveLength(2);
  });

  it("a page that started on the landing reads once it reaches a signed-in page", async () => {
    ui.path = "/";
    await load();
    expect(calls).toEqual([]);
    ui.path = "/home";
    await load();
    expect(calls).toHaveLength(1);
  });

  it("closed (×, Escape or the backdrop all end in onOpenChange(false)), it stays closed on the next load of this browser session", async () => {
    await load();
    ui.dialog!.onOpenChange(false);
    expect(ui.dialog!.open).toBe(true); // the state changes; the next render draws it
    render();
    expect(ui.dialog!.open).toBe(false);
    expect(page.store.get(CLOSED_KEY)).toBe("owner@example.test");
    ui.state.length = 0; // a new page load in the same browser session
    await load();
    expect(calls).toHaveLength(1);
    expect(ui.dialog!.open).toBe(false);
  });

  it("a close by another account in this browser session does not keep it closed for this one", async () => {
    page.store.set(CLOSED_KEY, "someone-else@example.test");
    await load();
    expect(ui.dialog!.open).toBe(true);
  });

  it("opens again when the wallet asks, closed before or not", async () => {
    page.store.set(CLOSED_KEY, "owner@example.test");
    await load();
    expect(calls).toEqual([]);
    window.dispatchEvent(new Event(CONFIRM_EMAIL_EVENT));
    await settle();
    expect(words(render())).toContain("Confirm your email");
    expect(ui.dialog!.open).toBe(true);
  });

  it("with browser storage blocked it still opens, and a close does not throw", async () => {
    page.storeFails = true;
    await load();
    expect(ui.dialog!.open).toBe(true);
    expect(() => ui.dialog!.onOpenChange(false)).not.toThrow();
    render();
    expect(ui.dialog!.open).toBe(false);
  });

  it("does not close while a request runs", async () => {
    await load();
    let release: (v: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { release = r; })));
    const running = button(render(), "Request code").onClick() as Promise<void>;
    render(); // the handler the dialog holds now: the one of the render after the click
    ui.dialog!.onOpenChange(false);
    render();
    expect(ui.dialog!.open).toBe(true);
    release(new Response(JSON.stringify({ sent: true }), { status: 200 }));
    await running;
  });
});

describe("the two ways in", () => {
  it("Request code sends, then shows the code view saying where it went", async () => {
    await load();
    answers = [{ status: 200, body: { sent: true } }];
    await button(render(), "Request code").onClick();
    expect(calls.at(-1)).toEqual({ url: "/api/auth/password/confirm-email", method: "POST" });
    const tree = render();
    expect(words(tree)).toContain(`We sent a code to ${ADDRESS}. It works for 15 minutes.`);
    expect(input(tree)).toBeTruthy();
    expect(button(tree, "Back")).toBeTruthy();
    expect(button(tree, "Confirm").type).toBe("submit");
    expect(button(tree, "Request a new code")).toBeTruthy();
    expect(words(tree)).not.toMatch(/forgot/i);
  });

  it("Enter code shows the code view at once, and sends nothing", async () => {
    await load();
    button(render(), "Enter code").onClick();
    const tree = render();
    expect(calls).toHaveLength(1);
    expect(words(tree)).toContain(`Enter the code we emailed to ${ADDRESS}.`);
    expect(input(tree)!.props).toMatchObject({ inputMode: "numeric", autoComplete: "one-time-code", maxLength: 7 });
  });

  it("the back chevron goes back to the two buttons", async () => {
    await load();
    button(render(), "Enter code").onClick();
    button(render(), "Back").onClick();
    expect(buttons(render())).toEqual(["Enter code", "Request code"]);
  });

  it("a request that is refused stays on the two buttons and says why in the server's words", async () => {
    await load();
    answers = [{ status: 429, body: { error: "Too many codes asked for. Try again in a few minutes." } }];
    await button(render(), "Request code").onClick();
    const tree = render();
    expect(buttons(tree)).toEqual(["Enter code", "Request code"]);
    const alert = hosts(tree).find((e) => e.props.role === "alert")!;
    expect(textOf(alert)).toBe("Too many codes asked for. Try again in a few minutes.");
    answers = ["offline"];
    await button(render(), "Request code").onClick();
    expect(textOf(hosts(render()).find((e) => e.props.role === "alert")!)).toBe("The code could not be sent. Try again in a minute.");
  });

  it("already confirmed elsewhere: the request ends in the confirmed state", async () => {
    await load();
    answers = [{ status: 200, body: { confirmed: true } }];
    await button(render(), "Request code").onClick();
    expect(words(render())).toContain("Email confirmed");
  });
});

describe("the code", () => {
  async function codeView() {
    await load();
    button(render(), "Enter code").onClick();
    render();
  }

  it("takes digits only, and Confirm waits for all seven", async () => {
    await codeView();
    type("12a3-45");
    expect(input(render())!.props.value).toBe("12345");
    expect(button(render(), "Confirm").disabled).toBe(true);
    type("1234567");
    expect(button(render(), "Confirm").disabled).toBe(false);
  });

  it("a right code: a short confirmed state, then it closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await codeView();
    type("1234567");
    answers = [{ status: 200, body: { confirmed: true } }];
    await submit();
    expect(calls.at(-1)).toEqual({ url: "/api/auth/password/confirm-email/verify", method: "POST", body: { code: "1234567" } });
    const done = render();
    expect(words(done)).toContain("Email confirmed");
    // The verify route signs out every other session of the account (DEC-2026-11-07-21): the window says so (DEC-2026-11-07-33).
    expect(words(done)).toContain("Your wallet can open now. Any other device signed in to this account was signed out.");
    expect(input(done)).toBeUndefined();
    expect(ui.dialog!.open).toBe(true);
    vi.advanceTimersByTime(1500); // short, but long enough to be read
    expect(words(render())).toContain("Email confirmed");
    expect(ui.dialog!.open).toBe(true);
    vi.advanceTimersByTime(100);
    render();
    expect(ui.dialog!.open).toBe(false);
  });

  it("a wrong, expired or too often tried code says so in the server's words, and the code view stays", async () => {
    await codeView();
    for (const error of ["Wrong code. Check the email and try again.", "This code has expired. Request a new code.", "Too many tries. Wait 15 minutes, then try again."]) {
      type("1234567");
      answers = [{ status: error.startsWith("Too") ? 429 : 400, body: { error } }];
      await submit();
      const tree = render();
      expect(textOf(hosts(tree).find((e) => e.props.role === "alert")!)).toBe(error);
      expect(input(tree)).toBeTruthy();
    }
  });

  it("after Too many tries, no code is sent or tried and the words stay, until the server's wait is over", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const TOO_MANY = "Too many tries. Wait 15 minutes, then try again.";
    const alert = (tree: (El | string)[]) => hosts(tree).find((e) => e.props.role === "alert");
    await codeView();
    type("1234567");
    answers = [{ status: 429, body: { error: TOO_MANY }, headers: { "Retry-After": "60" } }];
    await submit();
    let tree = render();
    expect(textOf(alert(tree)!)).toBe(TOO_MANY);
    expect(button(tree, "Confirm").disabled).toBe(true);
    expect(button(tree, "Request a new code").disabled).toBe(true);
    button(tree, "Back").onClick();
    tree = render();
    expect(button(tree, "Request code").disabled).toBe(true);
    expect(textOf(alert(tree)!)).toBe(TOO_MANY);
    vi.advanceTimersByTime(59_000);
    expect(button(render(), "Request code").disabled).toBe(true);
    vi.advanceTimersByTime(1_000);
    tree = render();
    expect(button(tree, "Request code").disabled).toBe(false);
    expect(alert(tree)).toBeUndefined();
    button(tree, "Enter code").onClick();
    type("1234567");
    expect(button(render(), "Confirm").disabled).toBe(false);
    expect(button(render(), "Request a new code").disabled).toBe(false);
  });

  it("a Too many tries without the server's wait keeps them off for the 15 minutes its words say", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await codeView();
    type("1234567");
    answers = [{ status: 429, body: { error: "Too many tries. Wait 15 minutes, then try again." } }];
    await submit();
    vi.advanceTimersByTime(15 * 60_000 - 1_000);
    expect(button(render(), "Request a new code").disabled).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(button(render(), "Request a new code").disabled).toBe(false);
  });

  it("Request a new code sends one and says a new one went where, and that only the newest works", async () => {
    await codeView();
    answers = [{ status: 200, body: { sent: true } }];
    await button(render(), "Request a new code").onClick();
    expect(calls.at(-1)).toEqual({ url: "/api/auth/password/confirm-email", method: "POST" });
    expect(words(render())).toContain(`We sent a new code to ${ADDRESS}. Only the newest code works.`);
  });

  it("after Request code, a Request a new code that went out changes what the window says", async () => {
    await load();
    answers = [{ status: 200, body: { sent: true } }];
    await button(render(), "Request code").onClick();
    const first = words(render());
    expect(first).toContain(`We sent a code to ${ADDRESS}. It works for 15 minutes.`);
    answers = [{ status: 200, body: { sent: true } }];
    await button(render(), "Request a new code").onClick();
    const second = words(render());
    expect(second).toContain(`We sent a new code to ${ADDRESS}. Only the newest code works.`);
    expect(second).not.toContain("It works for 15 minutes.");
  });

  it("a Request a new code that did not go out leaves the line as it was", async () => {
    await load();
    answers = [{ status: 200, body: { sent: true } }];
    await button(render(), "Request code").onClick();
    answers = [{ status: 502, body: { error: "The code could not be sent. Try again in a minute." } }];
    await button(render(), "Request a new code").onClick();
    expect(words(render())).toContain(`We sent a code to ${ADDRESS}. It works for 15 minutes.`);
    expect(words(render())).not.toContain("new code to");
  });

  it("a read that answers while a code is being typed leaves the window as it is", async () => {
    await codeView();
    type("123");
    window.dispatchEvent(new Event(CONFIRM_EMAIL_EVENT));
    await settle();
    expect(calls).toHaveLength(2);
    expect(input(render())!.props.value).toBe("123");
  });

  it("an error from before is gone once the window opens again", async () => {
    await codeView();
    type("1234567");
    answers = [{ status: 400, body: { error: "Wrong code. Check the email and try again." } }];
    await submit();
    ui.dialog!.onOpenChange(false);
    render();
    window.dispatchEvent(new Event(CONFIRM_EMAIL_EVENT));
    await settle();
    const tree = render();
    expect(buttons(tree)).toEqual(["Enter code", "Request code"]);
    expect(hosts(tree).some((e) => e.props.role === "alert")).toBe(false);
  });
});

describe("the wallet asks for it", () => {
  const jwtAnswer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  const heard = () => { let n = 0; window.addEventListener(CONFIRM_EMAIL_EVENT, () => { n += 1; }); return () => n; };
  afterEach(() => registerCdpEnsure(null));

  it("a wallet action refused for the unconfirmed email opens the window", async () => {
    const count = heard();
    jwtAnswer(403, { error: "Confirm your email to open your wallet.", confirmEmail: true });
    registerCdpEnsure(async () => { if (!(await fetchWalletJwt())) throw new Error("closed"); });
    await expect(ensureCdpWallet()).rejects.toThrow("closed");
    expect(count()).toBe(1);
  });

  it("not for a lock, an own-wallet account or a wallet that opens, and not for CDP's own token reads", async () => {
    const count = heard();
    registerCdpEnsure(async () => { if (!(await fetchWalletJwt())) throw new Error("closed"); });
    for (const [status, body] of [[403, { locked: true }], [403, { walletAccount: true, error: "x" }], [200, { jwt: "j" }]] as const) {
      jwtAnswer(status, body);
      await ensureCdpWallet().catch(() => {});
    }
    jwtAnswer(403, { confirmEmail: true });
    await fetchWalletJwt(); // CDP asks before every request, the silent sign-in on load included: no window from it
    expect(count()).toBe(0);
  });

  it("not for a wallet action whose read got no answer, even right after a refusal for the email", async () => {
    const count = heard();
    registerCdpEnsure(async () => { if (!(await fetchWalletJwt())) throw new Error("closed"); });
    jwtAnswer(403, { error: "Confirm your email to open your wallet.", confirmEmail: true });
    await fetchWalletJwt(); // CDP's own read: the refusal is recorded, no window
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(ensureCdpWallet()).rejects.toThrow("Failed to fetch");
    expect(count()).toBe(0);
  });
});

describe("pinned in the source", () => {
  const source = readSource(join(__dirname, "..", "..", "components", "ConfirmEmailWindow.tsx"));

  it("the exact labels, in this order, and no Forgot password anywhere", () => {
    const enter = source.indexOf(">Enter code</button>");
    const request = source.indexOf(">Request code</button>");
    expect(enter).toBeGreaterThan(0);
    expect(request).toBeGreaterThan(enter);
    expect(source).toContain('"Confirm your email"');
    expect(source).toMatch(/>Confirm<\/button>/);
    expect(source).toContain(">Request a new code</button>");
    expect(readSource(join(__dirname, "..", "..", "components", "ConfirmEmailWindow.tsx"))).not.toMatch(/forgot/i);
  });

  it("the app's dialog, its existing logo, the shell's dimmed and blurred backdrop, and only the theme's tokens", () => {
    expect(source).toContain('from "@/components/ui/dialog"');
    expect(source).toContain('src="/favicon.svg"');
    expect(source).toContain('overlayClassName="z-[10028] bg-black/50 backdrop-blur-[6px]"');
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it("its look is the shared one in components/enki-window.ts, which holds only the theme's tokens", () => {
    expect(source).toContain('import { CARD, CODE, CORNER, CTA, FIELD, PILL, ROUND, TEXT, TITLE } from "@/components/enki-window";');
    expect(source).not.toMatch(/const (CARD|PILL|CTA|CORNER|TEXT|TITLE)\b/);
    const look = readSource(join(__dirname, "..", "..", "components", "enki-window.ts"));
    expect(look).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(look).toContain('background: "var(--enki-paper)", color: "var(--enki-ink)", borderColor: "var(--enki-rule)", borderRadius: 18,');
    expect(look).toContain('export const CTA: CSSProperties = { ...PILL, border: "none", background: "var(--cta-bg)", color: "var(--cta-ink)" };');
  });

  it("the shell mounts it inside the access gate, the wallet's runtime outside it", () => {
    const providers = readSource(join(__dirname, "..", "..", "providers", "index.tsx"));
    const gate = /<BetaGate>([\s\S]*?)<\/BetaGate>/.exec(providers)![1];
    expect(gate).toContain("<ConfirmEmailWindow />");
  });
});

describe("logging out (DEC-2026-11-07-23)", () => {
  const signedIn = () => {
    const local = new Map<string, string>([["enki_session_token", "t"], ["enki_session_email", "owner@example.test"]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => { local.set(k, v); },
      removeItem: (k: string) => { local.delete(k); },
    });
    return local;
  };
  const realForget = async () => (await vi.importActual<typeof import("@/hooks/useEmailAuth")>("@/hooks/useEmailAuth")).forgetSession;

  it("clears the close flag, so the next login of the same account in this tab shows the window again", async () => {
    await load();
    ui.dialog!.onOpenChange(false);
    render();
    expect(page.store.get(CLOSED_KEY)).toBe("owner@example.test");
    page.store.set("another-key", "kept");
    const local = signedIn();
    (await realForget())();
    expect(page.store.has(CLOSED_KEY)).toBe(false);
    expect(page.store.get("another-key")).toBe("kept");
    expect(local.has("enki_session_token")).toBe(false);
    ui.state.length = 0; // the next login: the same account, the same tab
    await load();
    expect(calls).toHaveLength(2);
    expect(ui.dialog!.open).toBe(true);
  });

  it("a storage that throws does not stop the logout", async () => {
    const local = signedIn();
    page.storeFails = true;
    const forget = await realForget();
    expect(() => forget()).not.toThrow();
    expect(local.has("enki_session_token")).toBe(false);
  });

  it("the hook takes the key from lib, and the window declares none of its own", () => {
    const hook = readSource(join(__dirname, "..", "..", "hooks", "useEmailAuth.ts"));
    expect(hook).toContain('import { CONFIRM_EMAIL_CLOSED_KEY, forgetCdpAddresses } from "@/lib/cdp-bridge";');
    expect(hook).not.toMatch(/from "@\/components\//);
    expect(readSource(join(__dirname, "..", "cdp-bridge.ts"))).toContain('export const CONFIRM_EMAIL_CLOSED_KEY = "enki:confirm-email-closed";');
    expect(readSource(join(__dirname, "..", "..", "components", "ConfirmEmailWindow.tsx"))).not.toMatch(/const CLOSED_KEY|"enki:confirm-email-closed"/);
  });
});
