import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The browser's half of the human check, on a stand-in for the DOM and for Cloudflare's script. Blind spot: the real
 * widget never ran here (no site key exists yet, and no test may call Cloudflare): its look, its click and the option
 * names as Cloudflare reads them are from its documentation as remembered, unproven until Kev's widget exists.
 */
type Options = Record<string, unknown> & {
  sitekey: string; callback: (t: string) => void;
  "error-callback": () => void; "expired-callback": () => void; "timeout-callback": () => void;
};

let scripts: { src: string; async?: boolean; removed: boolean; onload?: () => void; onerror?: () => void }[];
let boxes: { style: { cssText: string }; removed: boolean; remove(): void }[];
let rendered: Options[];
let removed: string[];
let script: "loads" | "blocked" | "empty" | "never answers";
let answer: ((o: Options) => void) | null;

const fake = { render: (_box: unknown, o: Options) => { rendered.push(o); answer?.(o); return `w${rendered.length}`; }, remove: (id: string) => { removed.push(id); } };

const load = async () => {
  vi.resetModules();
  return await import("@/lib/ui/kit/human-check");
};

beforeEach(() => {
  scripts = []; boxes = []; rendered = []; removed = []; script = "loads";
  answer = (o) => o.callback("a-token");
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";
  const win: { turnstile?: typeof fake } = {};
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag === "script") {
        const made = { removed: false, remove() { made.removed = true; } };
        return made;
      }
      const box ={ style: { cssText: "" }, removed: false, remove() { box.removed = true; } };
      boxes.push(box);
      return box;
    },
    head: { appendChild: (s: (typeof scripts)[number]) => {
      scripts.push(s);
      if (script === "never answers") return;
      if (script === "blocked") { queueMicrotask(() => s.onerror?.()); return; }
      if (script === "loads") win.turnstile = fake;
      queueMicrotask(() => s.onload?.());
    } },
    body: { appendChild: () => {} },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
});

describe("freeRenderToken", () => {
  it("without a site key touches nothing and leaves the decision to the server", async () => {
    const { freeRenderToken } = await load();
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    expect(await freeRenderToken()).toBeNull();
    expect(scripts).toEqual([]);
    expect(boxes).toEqual([]);
  });

  it("loads Cloudflare's script only now, renders with the site key, and clears up after the token", async () => {
    const { freeRenderToken } = await load();
    expect(scripts).toEqual([]);
    expect(await freeRenderToken()).toBe("a-token");
    expect(scripts.map((s) => s.src)).toEqual(["https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"]);
    expect(rendered[0]).toMatchObject({ sitekey: "site-key", appearance: "interaction-only", retry: "never" });
    expect(removed).toEqual(["w1"]);
    expect(boxes.map((b) => b.removed)).toEqual([true]);
    expect(boxes[0].style.cssText).toContain("pointer-events:auto");
  });

  it("each render gets a new widget and token, from the one script", async () => {
    const { freeRenderToken } = await load();
    await freeRenderToken();
    answer = (o) => o.callback("another");
    expect(await freeRenderToken()).toBe("another");
    expect(scripts).toHaveLength(1);
    expect(rendered).toHaveLength(2);
  });

  it.each(["error-callback", "expired-callback", "timeout-callback"] as const)("%s fails it, and clears up", async (name) => {
    const { freeRenderToken } = await load();
    answer = (o) => o[name]();
    await expect(freeRenderToken()).rejects.toThrow("human check failed");
    expect(removed).toEqual(["w1"]);
    expect(boxes[0].removed).toBe(true);
  });

  it("no answer in a minute fails it", async () => {
    const { freeRenderToken } = await load();
    vi.useFakeTimers();
    answer = null;
    const out = freeRenderToken().catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(rendered).toHaveLength(1);
    expect(boxes[0].removed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await out).toBe("human check failed");
    expect(boxes[0].removed).toBe(true);
  });

  it("a token in time stops the clock", async () => {
    const { freeRenderToken } = await load();
    vi.useFakeTimers();
    await freeRenderToken();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a blocked script fails it, and the next render tries again", async () => {
    const { freeRenderToken } = await load();
    script = "blocked";
    await expect(freeRenderToken()).rejects.toThrow("turnstile blocked");
    expect(boxes[0].removed).toBe(true);
    expect(scripts[0].removed).toBe(true);
    script = "loads";
    expect(await freeRenderToken()).toBe("a-token");
    expect(scripts).toHaveLength(2);
    expect(scripts[1].removed).toBe(false);
  });

  it("a script that brings no turnstile fails it, and the next render loads it anew", async () => {
    const { freeRenderToken } = await load();
    vi.useFakeTimers();
    script = "empty";
    await expect(freeRenderToken()).rejects.toThrow("no turnstile");
    expect(scripts[0].removed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a script that never answers fails it in a minute, with no clock left, and the next render loads it anew", async () => {
    const { freeRenderToken } = await load();
    vi.useFakeTimers();
    script = "never answers";
    const out = freeRenderToken().catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(boxes[0].removed).toBe(false);
    expect(scripts[0].removed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await out).toBe("turnstile stalled");
    expect(boxes[0].removed).toBe(true);
    expect(scripts[0].removed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    script = "loads";
    expect(await freeRenderToken()).toBe("a-token");
    expect(scripts).toHaveLength(2);
  });

  it("a second render that joined the stalled load ends with it", async () => {
    const { freeRenderToken } = await load();
    vi.useFakeTimers();
    script = "never answers";
    const first = freeRenderToken().catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(30_000);
    const second = freeRenderToken().catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toBe("turnstile stalled");
    expect(await second).toBe("turnstile stalled");
    expect(scripts).toHaveLength(1);
    expect(boxes.map((b) => b.removed)).toEqual([true, true]);
  });
});
