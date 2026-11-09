"use client";

/**
 * The browser's half of the bot guard on free renders (lib/turnstile.ts is the server's): Cloudflare's script is loaded
 * only when a free render is asked for, its widget shows itself only if Cloudflare wants a click, and each render gets a
 * new token, because a token is good once. There is no CSP to extend (DEC-2026-11-02-22).
 */
const API = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const WAIT_MS = 60_000;

export const HUMAN_CHECK_FAILED = "The human check could not finish. Nothing was generated. Try again.";

interface Turnstile {
  render(box: HTMLElement, options: {
    sitekey: string;
    appearance: "interaction-only";
    retry: "never";
    callback: (token: string) => void;
    "error-callback": () => void;
    "expired-callback": () => void;
    "timeout-callback": () => void;
  }): string;
  remove(widgetId: string): void;
}

let loading: Promise<Turnstile> | null = null;

function loadTurnstile(): Promise<Turnstile> {
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    // A network that silently drops the script fires neither onload nor onerror, so its load has a clock of its own.
    // What failed is taken away, and the next render loads it anew.
    const fail = (why: string) => {
      clearTimeout(stalled);
      script.remove();
      reject(new Error(why));
    };
    const stalled = setTimeout(() => fail("turnstile stalled"), WAIT_MS);
    script.src = API;
    script.async = true;
    script.onload = () => {
      const turnstile = (window as unknown as { turnstile?: Turnstile }).turnstile;
      if (!turnstile) return fail("no turnstile");
      clearTimeout(stalled);
      resolve(turnstile);
    };
    script.onerror = () => fail("turnstile blocked");
    document.head.appendChild(script);
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** A new token, or null when this deployment has no site key (the server decides). Throws when the check cannot finish. */
export async function freeRenderToken(): Promise<string | null> {
  const sitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  if (!sitekey) return null;
  const box = document.createElement("div");
  // Above any open dialog, and clickable although a modal dialog turns the body's pointer events off.
  box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:auto";
  document.body.appendChild(box);
  let done = () => {};
  try {
    const turnstile = await loadTurnstile();
    return await new Promise<string>((resolve, reject) => {
      const fail = () => reject(new Error("human check failed"));
      const timer = setTimeout(fail, WAIT_MS);
      const widget = turnstile.render(box, {
        sitekey,
        appearance: "interaction-only",
        retry: "never",
        callback: resolve,
        "error-callback": fail,
        "expired-callback": fail,
        "timeout-callback": fail,
      });
      done = () => { clearTimeout(timer); turnstile.remove(widget); };
    });
  } finally {
    done();
    box.remove();
  }
}
