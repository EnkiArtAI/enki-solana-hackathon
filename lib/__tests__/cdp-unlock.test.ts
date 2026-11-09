import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The client half of the wallet unlock (Kev, 2026-10-07): a wallet action
 * waits for the unlock before its own timeout starts, so the user can answer
 * the dialog; a cancelled unlock sends nothing; without a CDP runtime (wallet
 * logins, guests) nothing waits. The last address per email stands in while
 * the wallet is locked, and logging out forgets it.
 */

const store = new Map<string, string>();
vi.stubGlobal("window", new EventTarget());
// A browser-like localStorage: Object.keys lists what is stored.
const api: Record<string, unknown> = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
vi.stubGlobal("localStorage", new Proxy({}, {
  get: (_, k: string) => api[k] ?? store.get(k),
  ownKeys: () => [...store.keys()],
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
}));

import {
  CDP_SIGN_REQUEST, CDP_SIGN_RESULT, ensureCdpWallet, expectCdpRuntime, registerCdpEnsure, requestCdpSign,
  rememberCdpAddress, rememberedCdpAddress, forgetCdpAddresses, fetchWalletJwt, isCdpLocked, cdpClosedReason, cdpOwnWalletAccount,
} from "../cdp-bridge";

const answerSigns = () => window.addEventListener(CDP_SIGN_REQUEST, (e) => {
  const { id } = (e as CustomEvent).detail as { id: string };
  window.dispatchEvent(new CustomEvent(CDP_SIGN_RESULT, { detail: { id, signedTransaction: "signed" } }));
});

beforeEach(() => {
  registerCdpEnsure(null);
  expectCdpRuntime(false);
  store.clear();
});

describe("a paid order right after an email, Google or X login (round 32, 2026-10-21)", () => {
  it("waits for the runtime the session is about to mount, then attaches through it", async () => {
    expectCdpRuntime(true);
    const ensure = vi.fn(async () => {});
    let done = false;
    const ready = ensureCdpWallet({ attached: true }).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    registerCdpEnsure(ensure);
    await ready;
    expect(ensure).toHaveBeenCalledWith({ attached: true });
  });

  it("refuses before anything opens when the runtime does not come in time", async () => {
    vi.useFakeTimers();
    try {
      expectCdpRuntime(true);
      let settled = false;
      const outcome = ensureCdpWallet({ attached: true }).catch((e) => e).finally(() => { settled = true; });
      // The whole 15 s, not less (round 33).
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ message: "Your wallet is still loading. Try again — nothing was charged." });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait once the expected runtime has registered (round 33)", async () => {
    vi.useFakeTimers();
    try {
      expectCdpRuntime(true);
      const ensure = vi.fn(async () => {});
      registerCdpEnsure(ensure);
      let done = false;
      void ensureCdpWallet({ attached: true }).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(ensure).toHaveBeenCalledWith({ attached: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is expected only where the runtime really mounts", () => {
    const src = readSource(join(__dirname, "..", "..", "providers", "index.tsx"));
    expect(src).toContain("const expected = Boolean(account && process.env.NEXT_PUBLIC_CDP_PROJECT_ID);");
    expect(src).toContain("useEffect(() => { expectCdpRuntime(expected); }, [expected]);");
  });
});

describe("a wallet action", () => {
  it("goes ahead at once without a CDP runtime", async () => {
    await expect(ensureCdpWallet()).resolves.toBeUndefined();
  });

  it("waits for the unlock before its timeout starts", async () => {
    answerSigns();
    let release!: () => void;
    registerCdpEnsure(() => new Promise<void>((r) => { release = r; }));
    const signing = requestCdpSign("tx", 50);
    await new Promise((r) => setTimeout(r, 120)); // longer than the timeout: the user is typing a code
    release();
    await expect(signing).resolves.toBe("signed");
  });

  it("sends nothing when the unlock is cancelled", async () => {
    const asked = vi.fn();
    window.addEventListener(CDP_SIGN_REQUEST, asked);
    registerCdpEnsure(async () => { throw new Error("Not confirmed, nothing was signed."); });
    await expect(requestCdpSign("tx")).rejects.toThrow(/Not confirmed/);
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("the lock", () => {
  const answer = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 300, status, json: async () => body })));

  it("is whatever the JWT route said last: 403 { locked } locks, a JWT unlocks", async () => {
    answer(403, { locked: true });
    expect(await fetchWalletJwt()).toBeUndefined();
    expect(isCdpLocked()).toBe(true);
    answer(200, { jwt: "jwt" });
    expect(await fetchWalletJwt()).toBe("jwt");
    expect(isCdpLocked()).toBe(false);
  });

  it("names a refusal the user must answer elsewhere (an email to confirm), and is no lock", async () => {
    answer(403, { confirmEmail: true, error: "Confirm your email to open your wallet." });
    expect(await fetchWalletJwt()).toBeUndefined();
    expect(isCdpLocked()).toBe(false);
    expect(cdpClosedReason()).toBe("Confirm your email to open your wallet.");
    answer(200, { jwt: "jwt" });
    await fetchWalletJwt();
    expect(cdpClosedReason()).toBeNull();
  });

  it("tells a wallet account, which has no embedded wallet, from an email still to confirm, an outage and an open wallet", async () => {
    const own = async (status: number, body: unknown) => { answer(status, body); await fetchWalletJwt(); return cdpOwnWalletAccount(); };
    expect(await own(403, { walletAccount: true, error: "This account pays with its own wallet." })).toBe(true);
    expect(await own(200, { jwt: "jwt" })).toBe(false);
    await own(403, { walletAccount: true });
    expect(await own(403, { confirmEmail: true, error: "Confirm your email." })).toBe(false);
    await own(403, { walletAccount: true });
    expect(await own(503, { error: "down" })).toBe(false);
    await own(403, { walletAccount: true });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(fetchWalletJwt()).rejects.toThrow("offline");
    expect(cdpOwnWalletAccount()).toBe(false);
  });

  it("is never an outage or another refusal: no dialog for those", async () => {
    for (const [status, body] of [[503, { error: "down" }], [403, { error: "other" }]] as const) {
      answer(403, { locked: true });
      await fetchWalletJwt();
      answer(status, body);
      expect(await fetchWalletJwt()).toBeUndefined();
      expect(isCdpLocked()).toBe(false);
    }
  });
});

describe("the remembered address", () => {
  it("is kept per email, and logging out forgets it", () => {
    rememberCdpAddress("a@example.com", "AddrA");
    expect(rememberedCdpAddress("a@example.com")).toBe("AddrA");
    expect(rememberedCdpAddress("b@example.com")).toBeNull();
    store.set("theme", "dark");
    forgetCdpAddresses();
    expect(rememberedCdpAddress("a@example.com")).toBeNull();
    expect(store.get("theme")).toBe("dark");
  });
});
