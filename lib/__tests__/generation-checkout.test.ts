import { afterEach, describe, it, expect, vi } from "vitest";

/**
 * The buyer's checkout is a straight line — intent → authorize → sign →
 * submit — and every failure must stop the line COLD. A submit that fires
 * without a signature, or a sign prompt for an intent the server refused,
 * is the kind of bug that ends with a wallet popup nobody can explain.
 * The signer is passed in, so it is a plain mock; everything else runs the
 * real code against a scripted fetch.
 */

const signMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-headers", () => ({
  sessionAuthHeaders: () => ({ "X-Session-Token": "test-session" }),
}));

import {
  authorizePaidGeneration,
  resumePaidGeneration,
  fetchFreeGenerationQuota,
  fetchGenerationQuote,
  fetchGenerationQuotes,
  PromptUnavailable,
  toModelFamily,
  microToUsd,
  CheckoutError,
  CONFIRM_WAITS_MS,
  checkPaidGenerationStatus,
  storePendingEscrowPayments,
  readPendingEscrowPayments,
  type EscrowCheckout,
  onceMoreAfterLimit,
} from "@/lib/generation-checkout";

const REQ = { promptId: "p-1", modelId: "db00c518-ee31-4d12-b40a-f8130f8e605b", resolution: "2K" as const };

type Script = Record<string, { status: number; body: unknown }>;
let calls: string[] = [];

function scriptFetch(script: Script) {
  calls = [];
  // Reset lives HERE, not in beforeEach: with the shared beforeEach/afterEach
  // hooks in place, this vitest version fails the sign-cancellation test with
  // the mock's own error even though the code under test provably catches it
  // (bisected 2026-08-12 — hook-free, the identical test passes). Each test
  // calls scriptFetch first, so isolation is preserved.
  signMock.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url);
      calls.push(path);
      const hit = script[path];
      if (!hit) throw new Error(`unscripted fetch: ${path}`);
      return {
        ok: hit.status < 400,
        status: hit.status,
        json: async () => hit.body,
      } as Response;
    }),
  );
}


describe("the happy line", () => {
  it("runs intent → authorize → sign → submit, in that order, once each", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: { intentId: "i-1", transaction: "dHg=", units: 1, paymentScheme: "escrow" } },
      "/api/payments/generation/submit": { status: 200, body: { intentId: "i-1", paymentScheme: "escrow", state: "funded", funded: true } },
    });
    signMock.mockResolvedValue(["c2lnbmVk"]);

    const out = await authorizePaidGeneration(REQ, signMock);
    expect(out).toEqual({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "funded", signedTransaction: "c2lnbmVk" });
    expect(calls).toEqual([
      "/api/payments/generation/intent",
      "/api/payments/generation/authorize",
      "/api/payments/generation/submit",
    ]);
    expect(signMock).toHaveBeenCalledTimes(1);
    expect(signMock).toHaveBeenCalledWith(["dHg="]);
  });
});

describe("every failure stops the line cold", () => {
  it("a refused intent never reaches authorize or the wallet", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 422, body: { error: "no artist wallet" } },
    });
    await expect(authorizePaidGeneration(REQ, signMock)).rejects.toMatchObject({
      step: "intent",
      message: "no artist wallet",
    });
    expect(calls).toEqual(["/api/payments/generation/intent"]);
    expect(signMock).not.toHaveBeenCalled();
  });

  it("a failed authorize never opens the wallet", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 500, body: { error: "nope" } },
    });
    await expect(authorizePaidGeneration(REQ, signMock)).rejects.toMatchObject({ step: "authorize" });
    expect(signMock).not.toHaveBeenCalled();
  });

  it("a cancelled signature never reaches submit, and says nothing was charged", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: { intentId: "i-1", transaction: "dHg=", units: 1, paymentScheme: "escrow" } },
    });
    // A SYNCHRONOUS throw, deliberately: this vitest's spy tracking reports a
    // rejected promise returned from a mock as a test failure even when the
    // code under test awaits and catches it (verified — the caught error was
    // the correct CheckoutError and the test still went red). To an `await`
    // caller a sync throw and a rejection are indistinguishable, so the
    // semantics under test are identical.
    signMock.mockImplementation(() => {
      throw new Error("User rejected the request");
    });

    const err = await authorizePaidGeneration(REQ, signMock).catch((e) => e as CheckoutError);
    expect(err).toBeInstanceOf(CheckoutError);
    expect((err as CheckoutError).step).toBe("sign");
    // Literally true at every step of this flow — and the one sentence the
    // buyer needs when they change their mind in the wallet.
    expect((err as CheckoutError).message).toMatch(/nothing was charged/i);
    expect(calls).not.toContain("/api/payments/generation/submit");
    // An escrow deposit nobody signed holds nothing: no cancel is sent (review 2026-10-18).
    expect(calls).not.toContain("/api/payments/generation/cancel");
  });

  it("a signer that answers without a signature submits nothing", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: { intentId: "i-1", transaction: "dHg=", units: 1, paymentScheme: "escrow" } },
    });
    signMock.mockResolvedValue([]);
    await expect(authorizePaidGeneration(REQ, signMock)).rejects.toMatchObject({ step: "sign", message: "The wallet could not sign. Nothing was charged." });
    expect(calls).not.toContain("/api/payments/generation/submit");
  });

  it("a refusal from the signer itself reaches the buyer word for word", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: { intentId: "i-1", transaction: "dHg=", units: 1, paymentScheme: "escrow" } },
    });
    signMock.mockImplementation(() => {
      throw new CheckoutError("sign", "Connect the wallet you signed in with");
    });
    await expect(authorizePaidGeneration(REQ, signMock)).rejects.toMatchObject({
      step: "sign",
      message: "Connect the wallet you signed in with",
    });
    expect(calls).not.toContain("/api/payments/generation/submit");
  });

  describe("an order taken back (Kev, 2026-10-13) stops the line at the next step, and a signature already given goes nowhere", () => {
    const line = () => scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: { intentId: "i-1", transaction: "dHg=", units: 1, paymentScheme: "escrow" } },
      "/api/payments/generation/submit": { status: 200, body: { intentId: "i-1", paymentScheme: "escrow", state: "funded", funded: true } },
    });

    it.each([
      ["intent", 0, []],
      ["authorize", 1, ["/api/payments/generation/intent"]],
      ["sign", 2, ["/api/payments/generation/intent", "/api/payments/generation/authorize"]],
    ] as const)("before %s: no further request, the wallet unasked", async (step, after, sent) => {
      line();
      let asked = 0;
      signMock.mockResolvedValue(["c2lnbmVk"]);
      const err = await authorizePaidGeneration(REQ, signMock, 1, undefined, () => asked++ >= after).catch((e) => e as CheckoutError);
      expect(err).toBeInstanceOf(CheckoutError);
      expect((err as CheckoutError).step).toBe(step);
      expect((err as CheckoutError).message).toBe("Cancelled before anything was charged.");
      expect((err as CheckoutError).payment).toBeUndefined();
      expect(calls).toEqual(sent);
      expect(signMock).not.toHaveBeenCalled();
    });

    it("after signing: the signed deposit is never submitted", async () => {
      line();
      let gone = false;
      signMock.mockImplementation(async () => { gone = true; return ["c2lnbmVk"]; });
      const err = await authorizePaidGeneration(REQ, signMock, 1, undefined, () => gone).catch((e) => e as CheckoutError);
      expect(signMock).toHaveBeenCalledTimes(1);
      expect((err as CheckoutError).step).toBe("sign");
      expect((err as CheckoutError).message).toBe("Cancelled before anything was charged.");
      expect(calls).not.toContain("/api/payments/generation/submit");
    });

    it("never taken back: the line runs as without the hook", async () => {
      line();
      signMock.mockResolvedValue(["c2lnbmVk"]);
      expect(await authorizePaidGeneration(REQ, signMock, 1, undefined, () => false)).toMatchObject({ state: "funded" });
      expect(calls).toContain("/api/payments/generation/submit");
    });
  });

  it("an intent with no id is a refusal, not an undefined ride-along", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: {} } },
    });
    await expect(authorizePaidGeneration(REQ, signMock)).rejects.toMatchObject({ step: "intent" });
    expect(calls).toHaveLength(1);
  });
});

describe("the quote never invents a price", () => {
  it("maps the server breakdown into display dollars", async () => {
    scriptFetch({
      "/api/payments/generation/quote": {
        status: 200,
        body: {
          quote: {
            expiresAt: "2026-08-12T12:00:00Z",
            breakdown: { totalAmount: "1182000", networkFee: "5000", artistAmount: "1000000" },
            appliedRule: null,
          },
        },
      },
    });
    const q = await fetchGenerationQuote(REQ);
    expect(q).toMatchObject({ totalUsd: "1.182", networkFeeUsd: "0.005", artistUsd: "1.00" });
  });

  it("returns null on refusal or network failure — the button greys, no fake number", async () => {
    scriptFetch({ "/api/payments/generation/quote": { status: 401, body: { error: "auth" } } });
    expect(await fetchGenerationQuote(REQ)).toBeNull();

    signMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchGenerationQuote(REQ)).toBeNull();
  });
});

describe("the quote of a prompt that is not for sale", () => {
  it("says so, instead of the null that keeps a button waiting", async () => {
    scriptFetch({ "/api/payments/generation/quote": { status: 404, body: { error: "Prompt not found" } } });
    await expect(fetchGenerationQuote(REQ)).rejects.toBeInstanceOf(PromptUnavailable);
    await expect(fetchGenerationQuote(REQ)).rejects.toThrow("This prompt is no longer available.");
  });

  it("is only that answer: every other refusal still reads as no quote yet", async () => {
    for (const status of [400, 401, 422, 429, 500]) {
      scriptFetch({ "/api/payments/generation/quote": { status, body: { error: "no" } } });
      expect(await fetchGenerationQuote(REQ)).toBeNull();
    }
  });
});

describe("many quotes in one request", () => {
  const Q = (total: string) => ({
    expiresAt: "2026-10-02T12:00:00Z",
    breakdown: { totalAmount: total, networkFee: "0", artistAmount: "0" },
    appliedRule: null,
  });

  it("answers each option in order, with null where the server gave none", async () => {
    let sent: unknown = null;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return { ok: true, status: 200, json: async () => ({ quotes: [Q("147400"), { error: "free" }, Q("13200")] }) } as Response;
    }));
    const out = await fetchGenerationQuotes([REQ, REQ, REQ]);
    expect(sent).toEqual({ items: [REQ, REQ, REQ] });
    expect(out.map((q) => q?.totalUsd ?? null)).toEqual(["0.147", null, "0.013"]);
    expect(out[0]?.totalMicro).toBe(147400);
  });

  it("invents nothing on a failed request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response));
    expect(await fetchGenerationQuotes([REQ, REQ])).toEqual([null, null]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchGenerationQuotes([REQ])).toEqual([null]);
  });
});

describe("display helpers", () => {
  it("slugs display names onto pricing keys", () => {
    expect(toModelFamily("Nano Banana Pro")).toBe("nano-banana-pro");
    expect(toModelFamily("GPT-Image-2 (coming soon)")).toBe("gpt-image-2");
    expect(toModelFamily("Seedream 5.0 lite (coming soon)")).toBe("seedream-5-0-lite");
  });

  it("shows whole cents as two decimals and the half-cent fee as three", () => {
    expect(microToUsd("1180000")).toBe("1.18");
    expect(microToUsd("5000")).toBe("0.005");
    expect(microToUsd("garbage")).toBe("0.00");
  });
});

it("the current buyer shows an unavailable prompt before pricing it and does not retry its quote", async () => {
  const { readSource } = await import("@/lib/__tests__/_read-source"); const { join } = await import("node:path");
  const model = readSource(join(__dirname, "..", "..", "components", "image-view", "useImageViewModel.ts"));
  expect(model).toContain('if (quote.unavailable) return { label: "No longer available", why: "This prompt is no longer available" };');
  // The price never gates (the catalogue's estimate stands in, lib/ui/kit/price); the prompt's absence still does, before any field is asked for.
  expect(model).not.toContain('!setup.model.free && !quote.quote');
  expect(model.indexOf('if (quote.unavailable)')).toBeLessThan(model.indexOf('const field = missingRequired(fields, values);'));
  expect(readSource(join(__dirname, "..", "..", "hooks", "useComposerQuote.ts"))).toContain('retry: false,');
});

describe("one funded escrow per click", () => {
  const funded = { intentId: "i-1", paymentScheme: "escrow", state: "funded", funded: true };
  const prepared = (units: number) => ({ intentId: "i-1", transaction: "dHg=", units, paymentScheme: "escrow" });
  it("signs once for every paid unit and waits for a funded bank receipt", async () => {
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      bodies.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} });
      const body = path.endsWith("/intent") ? { intent: { id: "i-1" } } : path.endsWith("/authorize") ? prepared(4) :
        path.endsWith("/submit") ? { ...funded, state: "submitted", funded: false } : funded;
      return { ok: true, json: async () => body } as Response;
    }));
    const sign = vi.fn(async () => ["signed-original"]);
    expect(await authorizePaidGeneration(REQ, sign, 4)).toMatchObject({ units: 4, state: "funded" });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(bodies.find(call => call.path.endsWith("/authorize"))?.body).toEqual({ intentId: "i-1", units: 4 });
    expect(bodies.at(-1)?.path).toBe("/api/payments/generation/status?intentId=i-1");
  });
  it("an uncertain submit retains its original intent and exact signed wire", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: prepared(1) },
    });
    signMock.mockResolvedValue(["signed-original"]);
    const error = await authorizePaidGeneration(REQ, signMock).catch(error => error as CheckoutError);
    expect(error).toMatchObject({ step: "submit", payment: { intentId: "i-1", units: 1, state: "uncertain", signedTransaction: "signed-original" } });
    if (!(error instanceof CheckoutError)) throw new Error("Expected a pending CheckoutError");
    expect(error.message).not.toMatch(/nothing was charged|not charged/i);
    expect(calls.filter(path => path.endsWith("/intent"))).toHaveLength(1);
  });
  it("a prepared retry resubmits only the original wire without another wallet prompt or intent", async () => {
    const recorded: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      recorded.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { ok: true, json: async () => path.includes("/status?") ? { ...funded, state: "prepared", funded: false } : funded } as Response;
    }));
    const original = { intentId: "i-1", units: 4, paymentScheme: "escrow" as const, state: "uncertain" as const, signedTransaction: "original-wire" };
    expect(await resumePaidGeneration(original)).toMatchObject({ intentId: "i-1", units: 4, state: "funded" });
    expect(recorded).toEqual([
      { path: "/api/payments/generation/status?intentId=i-1", body: undefined },
      { path: "/api/payments/generation/submit", body: { intentId: "i-1", signedTransaction: "original-wire" } },
    ]);
  });
  describe("a deposit on its way to the chain (Kev's first browser payment, 2026-10-13)", () => {
    const submitted = { ...funded, state: "submitted", funded: false };
    const STATUS = "/api/payments/generation/status?intentId=i-1";
    const total = CONFIRM_WAITS_MS.reduce((a, b) => a + b, 0);
    /** Status answers, in order; the last one repeats. */
    const answers = (...states: Array<Record<string, unknown>>) => {
      let asked = 0;
      calls = [];
      vi.stubGlobal("fetch", vi.fn(async (path: string) => {
        calls.push(String(path));
        const body = path.endsWith("/intent") ? { intent: { id: "i-1" } } : path.endsWith("/authorize") ? prepared(1)
          : path.endsWith("/submit") ? submitted : states[Math.min(asked++, states.length - 1)];
        return { ok: true, status: 200, json: async () => body } as Response;
      }));
    };
    const asked = () => calls.filter((path) => path === STATUS).length;
    afterEach(() => vi.useRealTimers());

    it("is asked about again until its receipt is there, and then the order goes on", async () => {
      vi.useFakeTimers();
      answers(submitted, submitted, funded);
      const done = authorizePaidGeneration(REQ, vi.fn(async () => ["signed-original"]));
      // Asked once at once (unconfirmed), again after the first wait (unconfirmed), and after the second: funded.
      await vi.advanceTimersByTimeAsync(CONFIRM_WAITS_MS[0] + CONFIRM_WAITS_MS[1] - 1);
      expect(asked()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await done).toMatchObject({ intentId: "i-1", state: "funded", signedTransaction: "signed-original" });
      expect(asked()).toBe(3);
      expect(calls.filter((path) => path.endsWith("/intent") || path.endsWith("/submit"))).toHaveLength(2);
    });

    it("stays pending, never paid, when no receipt comes within the waits", async () => {
      vi.useFakeTimers();
      answers(submitted);
      const failed = resumePaidGeneration({ intentId: "i-1", units: 4, paymentScheme: "escrow", state: "submitted" }).catch((e) => e as CheckoutError);
      await vi.advanceTimersByTimeAsync(total);
      const error = await failed;
      expect(error).toMatchObject({ step: "status", payment: { state: "submitted", intentId: "i-1" } });
      expect((error as CheckoutError).message).toBe("Your payment is still being checked. Check its status before making another payment.");
      expect(asked()).toBe(1 + CONFIRM_WAITS_MS.length);
      expect(total).toBe(30_000);
    });

    it("stops asking the moment the deposit has an answer", async () => {
      vi.useFakeTimers();
      answers(submitted, { ...funded, state: "expired", funded: false });
      const failed = resumePaidGeneration({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "submitted" }).catch((e) => e as CheckoutError);
      await vi.advanceTimersByTimeAsync(total);
      expect(await failed).toMatchObject({ payment: { state: "expired" } });
      expect(asked()).toBe(2);
    });

    it("a prepared, unsigned deposit is an answer too: nothing is waited for", async () => {
      answers({ ...funded, state: "prepared", funded: false });
      await expect(resumePaidGeneration({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "prepared" })).rejects.toMatchObject({ payment: { state: "prepared" } });
      expect(asked()).toBe(1);
    });

    it("a status read that fails while waiting leaves the payment pending with its identity", async () => {
      vi.useFakeTimers();
      let n = 0;
      vi.stubGlobal("fetch", vi.fn(async () => (++n === 1
        ? { ok: true, status: 200, json: async () => submitted }
        : { ok: false, status: 503, json: async () => ({}) }) as Response));
      const failed = resumePaidGeneration({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "submitted", signedTransaction: "wire" }).catch((e) => e as CheckoutError);
      await vi.advanceTimersByTimeAsync(total);
      expect(await failed).toMatchObject({ step: "status", payment: { intentId: "i-1", state: "submitted", signedTransaction: "wire" } });
      expect(n).toBe(2);
    });
  });
  it.each([
    { ...funded, intentId: "another-intent" },
    { ...funded, state: "submitted" },
    { ...funded, paymentScheme: "nonce" },
  ])("rejects a mismatched or incoherent funded receipt", async body => {
    scriptFetch({ "/api/payments/generation/status?intentId=i-1": { status: 200, body } });
    await expect(resumePaidGeneration({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "submitted" })).rejects.toBeInstanceOf(CheckoutError);
  });
  it("retains expired payment identity and does not silently start a replacement", async () => {
    scriptFetch({ "/api/payments/generation/status?intentId=i-1": { status: 200, body: { ...funded, state: "expired", funded: false } } });
    await expect(resumePaidGeneration({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "submitted" })).rejects.toMatchObject({ payment: { intentId: "i-1", state: "expired" } });
    expect(calls).toHaveLength(1);
  });
  it.each([0, 25, 1.5])("refuses invalid batch size %s without creating a payment", async units => {
    scriptFetch({});
    await expect(authorizePaidGeneration(REQ, signMock, units)).rejects.toMatchObject({ step: "intent" });
    expect(calls).toEqual([]);
  });
  it("a mismatched prepared unit count never reaches the wallet", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: prepared(1) },
    });
    await expect(authorizePaidGeneration(REQ, signMock, 4)).rejects.toMatchObject({ step: "authorize" });
    expect(signMock).not.toHaveBeenCalled();
  });
});

describe("the one baseline free image per day", () => {
  it("reads the server allowance and never assigns it to a premium model", async () => {
    const freeQuota = { used: 0, limit: 2, remaining: 2, exhausted: false, resetsAt: null };
    scriptFetch({ "/api/generate-free/quota": { status: 200, body: { freeQuota } } });
    expect(await fetchFreeGenerationQuota()).toEqual(freeQuota);
  });
  it.each([
    { used: 0, limit: 1, remaining: 1, exhausted: false, resetsAt: null },
    { used: 0, limit: 2, remaining: 2, exhausted: false, resetsAt: "tomorrow" },
    { used: 1, limit: 2, remaining: 2, exhausted: false, resetsAt: null },
    { used: 2, limit: 2, remaining: 0, exhausted: false, resetsAt: null },
  ])("an invalid allowance stays unknown", async freeQuota => {
    scriptFetch({ "/api/generate-free/quota": { status: 200, body: { freeQuota } } });
    expect(await fetchFreeGenerationQuota()).toBeNull();
  });
});

it("rejects duplicate or out-of-range status units before any generation can be resumed", async () => {
  const pending = { unit_index: 0, state: "pending", generation_id: null };
  for (const units of [[pending, pending], [{ ...pending, unit_index: 4 }]]) {
    scriptFetch({ "/api/payments/generation/status?intentId=i-1": { status: 200, body: {
      intentId: "i-1", paymentScheme: "escrow", state: "funded", funded: true, units,
    } } });
    await expect(resumePaidGeneration({ intentId: "i-1", units: 4, paymentScheme: "escrow", state: "submitted" })).rejects.toBeInstanceOf(CheckoutError);
    expect(calls).toHaveLength(1);
  }
});

it("preserves public pending payment identity across reloads without retaining prompt content", async () => {
  const { storePendingEscrowPayments, readPendingEscrowPayments } = await import("@/lib/generation-checkout");
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const payment = { intentId: "i-1", units: 4, paymentScheme: "escrow" as const, state: "uncertain" as const,
    unitIndex: 0, signedTransaction: "original-wire", generationSubmitted: false, unitStatuses: [{ unit_index: 0, state: "pending" as const, generation_id: null }] };
  expect(storePendingEscrowPayments(storage, "user-a", [payment])).toBe(true);
  const restored = readPendingEscrowPayments(storage, "user-a");
  expect(restored).toEqual([{ intentId: "i-1", units: 4, paymentScheme: "escrow", state: "uncertain", unitIndex: 0, signedTransaction: "original-wire", generationSubmitted: false }]);
  expect(readPendingEscrowPayments(storage, "user-b")).toEqual([]);
  expect([...values.values()][0]).not.toContain("unitStatuses");
  storePendingEscrowPayments(storage, "user-b", null);
  expect(readPendingEscrowPayments(storage, "user-a")).toHaveLength(1);
  storePendingEscrowPayments(storage, "user-a", null);
  expect(readPendingEscrowPayments(storage, "user-a")).toEqual([]);
});

it("awaits the durable signed-payment checkpoint before the first submit fetch", async () => {
  const { storePendingEscrowPayments, readPendingEscrowPayments } = await import("@/lib/generation-checkout");
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const paths: string[] = [];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const checkpointEntered = new Promise<void>(resolve => { entered = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    paths.push(path);
    const body = path.endsWith("/intent") ? { intent: { id: "i-1" } } : path.endsWith("/authorize")
      ? { intentId: "i-1", transaction: "unsigned", units: 4, paymentScheme: "escrow" }
      : { intentId: "i-1", paymentScheme: "escrow", state: "funded", funded: true };
    return { ok: true, json: async () => body } as Response;
  }));
  const checkout = authorizePaidGeneration(REQ, vi.fn(async () => ["original-signed-wire"]), 4, async payment => {
    storePendingEscrowPayments(storage, "fixture-user", [{ ...payment, unitIndex: 0, generationSubmitted: false }]);
    entered();
    await gate;
  });
  await checkpointEntered;
  expect(paths).not.toContain("/api/payments/generation/submit");
  // This is what a new page can read even though submit has not finished or started.
  const reloaded = readPendingEscrowPayments(storage, "fixture-user");
  expect(reloaded[0]).toMatchObject({ intentId: "i-1", units: 4, signedTransaction: "original-signed-wire", state: "uncertain" });
  release();
  expect(await checkout).toMatchObject({ intentId: "i-1", state: "funded" });
  expect(paths.filter(path => path.endsWith("/submit"))).toHaveLength(1);
});

it("a failed checkpoint prevents submit and preserves the original signed payment for recovery", async () => {
  scriptFetch({
    "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
    "/api/payments/generation/authorize": { status: 200, body: { intentId: "i-1", transaction: "unsigned", units: 1, paymentScheme: "escrow" } },
  });
  await expect(authorizePaidGeneration(REQ, vi.fn(async () => ["original-wire"]), 1, async () => {
    throw new Error("storage unavailable");
  })).rejects.toMatchObject({ payment: { intentId: "i-1", signedTransaction: "original-wire" } });
  expect(calls).not.toContain("/api/payments/generation/submit");
});

it("read-only restored status inspection never submits even a prepared signed deposit", async () => {
  const { checkPaidGenerationStatus } = await import("@/lib/generation-checkout");
  scriptFetch({ "/api/payments/generation/status?intentId=i-1": { status: 200, body: { intentId: "i-1", paymentScheme: "escrow", state: "prepared", funded: false } } });
  expect(await checkPaidGenerationStatus({ intentId: "i-1", units: 4, paymentScheme: "escrow", state: "uncertain", signedTransaction: "original-wire" })).toMatchObject({ state: "prepared" });
  expect(calls).toEqual(["/api/payments/generation/status?intentId=i-1"]);
});

describe("an intent order: one payment per image, charged only after its image (2026-10-18)", () => {
  /** Records each request's path and body; a path without a script entry is a test failure. */
  function intentFetch(script: Record<string, { status: number; body: unknown }>) {
    const sent: { path: string; body: unknown }[] = [];
    signMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).split("?")[0];
      sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const hit = script[path];
      if (!hit) throw new Error(`unscripted fetch: ${path}`);
      return { ok: hit.status < 400, status: hit.status, json: async () => hit.body } as Response;
    }));
    return sent;
  }
  const unitsOf = (n: number) => Array.from({ length: n }, (_, unit_index) => ({ unit_index, state: "pending", generation_id: null }));
  const funded = (n: number) => ({ intentId: "i-1", paymentScheme: "intent", state: "funded", funded: true, units: unitsOf(n), batch: null });
  const opened = (transactions: unknown, units = 2) => ({ intentId: "i-1", paymentScheme: "intent", units, transactions });

  it("sends the same signed order once more after the shared address limit, and only after it (round 17, 2026-10-20)", async () => {
    signMock.mockResolvedValue(["c2lnMQ==", "c2lnMg=="]);
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body }) as Response;
    for (const [first, submits, state] of [
      [answer(429, { error: "Too many requests" }, { "Retry-After": "0" }), 2, "funded"],
      [answer(429, { error: "Please wait before checking this payment again." }), 1, null],
    ] as const) {
      const bodies: unknown[] = [];
      let submitted = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url).split("?")[0];
        if (path.endsWith("/intent")) return answer(200, { intent: { id: "i-1" } });
        if (path.endsWith("/authorize")) return answer(200, opened(["dHgx", "dHgy"]));
        if (path.endsWith("/submit")) { bodies.push(JSON.parse(String(init?.body))); return submitted++ === 0 ? first : answer(200, funded(2)); }
        return answer(200, {});
      }));
      const out = await authorizePaidGeneration(REQ, signMock, 2).catch((e) => e);
      expect(submitted).toBe(submits);
      // The buyer kept the job: nothing is let go, at the refusal or when the wait ends (round 21, 2026-10-20).
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes("/cancel"))).toHaveLength(0);
      if (state) {
        expect(out).toMatchObject({ state });
        expect(bodies).toEqual([bodies[0], bodies[0]]);
      } else expect(out).toBeInstanceOf(CheckoutError);
    }
  });

  it("submits nothing after the limit's wait when the job was taken back during it, and lets the order go (rounds 18, 19, 2026-10-20)", async () => {
    signMock.mockResolvedValue(["c2lnMQ==", "c2lnMg=="]);
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body }) as Response;
    const calls: Array<{ path: string; body: unknown }> = [];
    let taken = false;
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url).split("?")[0];
        calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (path.endsWith("/intent")) return answer(200, { intent: { id: "i-1" } });
        if (path.endsWith("/authorize")) return answer(200, opened(["dHgx", "dHgy"]));
        // Refused by the shared limit, with a wait the server can send (rateLimitResponse sends at least 1 s).
        if (path.endsWith("/submit")) return answer(429, { error: "Too many requests" }, { "Retry-After": "2" });
        return answer(200, {});
      }));
      const out = authorizePaidGeneration(REQ, signMock, 2, undefined, () => taken).catch((e) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.filter((c) => c.path.endsWith("/submit"))).toHaveLength(1);
      // Not let go before the take-back: the refusal alone voids nothing (round 20).
      expect(calls.filter((c) => c.path.endsWith("/cancel"))).toHaveLength(0);
      // The buyer takes the job back halfway through the wait.
      taken = true;
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await out;
      expect(result).toBeInstanceOf(CheckoutError);
      expect((result as CheckoutError).message).toBe("Cancelled before anything was charged.");
      expect(calls.filter((c) => c.path.endsWith("/submit"))).toHaveLength(1);
      expect(calls.filter((c) => c.path.endsWith("/cancel")).map((c) => c.body)).toEqual([{ intentId: "i-1" }]);
    } finally { vi.useRealTimers(); }
  });

  it("submits nothing when the job was taken back while the payment checkpoint saved, and lets the order go (round 19, 2026-10-20)", async () => {
    signMock.mockResolvedValue(["c2lnMQ==", "c2lnMg=="]);
    const answer = (status: number, body: unknown) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body }) as Response;
    const calls: Array<{ path: string; body: unknown }> = [];
    let taken = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).split("?")[0];
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.endsWith("/intent")) return answer(200, { intent: { id: "i-1" } });
      if (path.endsWith("/authorize")) return answer(200, opened(["dHgx", "dHgy"]));
      if (path.endsWith("/submit")) return answer(200, funded(2));
      return answer(200, {});
    }));
    // The checkpoint saves in a later task (an IndexedDB put); the buyer presses X meanwhile.
    const checkpoint = () => new Promise<void>((done) => setTimeout(() => { taken = true; done(); }, 5));
    const out = await authorizePaidGeneration(REQ, signMock, 2, checkpoint, () => taken).catch((e) => e);
    expect(out).toBeInstanceOf(CheckoutError);
    expect((out as CheckoutError).message).toBe("Cancelled before anything was charged.");
    expect(calls.filter((c) => c.path.endsWith("/submit"))).toHaveLength(0);
    expect(calls.filter((c) => c.path.endsWith("/cancel")).map((c) => c.body)).toEqual([{ intentId: "i-1" }]);
  });

  it("signs every unit's payment in one call and submits them together, keeping none on the device", async () => {
    const sent = intentFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: opened(["dHgx", "dHgy"]) },
      "/api/payments/generation/submit": { status: 200, body: funded(2) },
    });
    signMock.mockResolvedValue(["c2lnMQ==", "c2lnMg=="]);
    const checkpoints: EscrowCheckout[] = [];
    const out = await authorizePaidGeneration(REQ, signMock, 2, (p) => { checkpoints.push(p); });
    expect(signMock).toHaveBeenCalledTimes(1);
    expect(signMock).toHaveBeenCalledWith(["dHgx", "dHgy"]);
    expect(sent.find((r) => r.path.endsWith("/submit"))?.body).toEqual({ intentId: "i-1", signedTransactions: ["c2lnMQ==", "c2lnMg=="] });
    expect(out).toMatchObject({ intentId: "i-1", units: 2, paymentScheme: "intent", state: "funded" });
    expect(out.signedTransaction).toBeUndefined();
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(JSON.stringify(checkpoints)).not.toMatch(/c2ln/);
  });

  it("refuses an order whose payments do not match its images before any wallet is asked", async () => {
    for (const transactions of [["dHgx"], ["dHgx", ""], "dHgx", undefined]) {
      intentFetch({
        "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
        "/api/payments/generation/authorize": { status: 200, body: opened(transactions) },
      });
      await expect(authorizePaidGeneration(REQ, signMock, 2)).rejects.toMatchObject({ step: "authorize" });
      expect(signMock).not.toHaveBeenCalled();
    }
  });

  it("cancels an intent order the buyer did not sign, so its units free at once (review 2026-10-18)", async () => {
    const sent = intentFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: opened(["dHgx", "dHgy"]) },
      "/api/payments/generation/cancel": { status: 200, body: { cancelled: true } },
    });
    signMock.mockImplementation(() => { throw new Error("User rejected the request"); });
    await expect(authorizePaidGeneration(REQ, signMock, 2)).rejects.toMatchObject({ step: "sign", message: "Signing was cancelled. Nothing was charged." });
    await vi.waitFor(() => expect(sent.find((r) => r.path.endsWith("/cancel"))?.body).toEqual({ intentId: "i-1" }));
    expect(sent.some((r) => r.path.endsWith("/submit"))).toBe(false);
  });

  it("cancels an intent order taken back while its wallet window was open", async () => {
    const sent = intentFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: opened(["dHgx", "dHgy"]) },
      "/api/payments/generation/cancel": { status: 200, body: { cancelled: true } },
    });
    let gone = false;
    signMock.mockImplementation(async () => { gone = true; return ["c2lnMQ==", "c2lnMg=="]; });
    await expect(authorizePaidGeneration(REQ, signMock, 2, undefined, () => gone)).rejects.toMatchObject({ step: "sign" });
    await vi.waitFor(() => expect(sent.some((r) => r.path.endsWith("/cancel"))).toBe(true));
    expect(sent.some((r) => r.path.endsWith("/submit"))).toBe(false);
  });

  it("submits nothing when the wallet signs fewer payments than images", async () => {
    const sent = intentFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: opened(["dHgx", "dHgy"]) },
    });
    signMock.mockResolvedValue(["c2lnMQ=="]);
    await expect(authorizePaidGeneration(REQ, signMock, 2)).rejects.toMatchObject({ step: "sign", message: "The wallet could not sign. Nothing was charged." });
    expect(sent.some((r) => r.path.endsWith("/submit"))).toBe(false);
  });

  it("a refused submit held nothing: the buyer reads the server's sentence and no payment stays pending", async () => {
    intentFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: opened(["dHgx", "dHgy"]) },
      "/api/payments/generation/submit": { status: 402, body: { error: "Your wallet holds less than the $0.0076 this image costs. Add USDC and pay again — nothing was charged." } },
    });
    signMock.mockResolvedValue(["c2lnMQ==", "c2lnMg=="]);
    const err = await authorizePaidGeneration(REQ, signMock, 2).catch((e) => e as CheckoutError);
    expect(err).toMatchObject({ step: "submit", message: "Your wallet holds less than the $0.0076 this image costs. Add USDC and pay again — nothing was charged." });
    expect((err as CheckoutError).payment).toBeUndefined();
  });

  it("ends the order on a /submit 409 with the server's sentence, asking no status (round 31, 2026-10-21)", async () => {
    for (const error of ["Payments are paused for a moment on our side. Nothing was charged — try again shortly.", "This order's payment was already sent from your wallet. Nothing more will be charged; if it went through without an image, it is refunded."]) {
      const sent = intentFetch({
        "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
        "/api/payments/generation/authorize": { status: 200, body: opened(["dHgx", "dHgy"]) },
        "/api/payments/generation/submit": { status: 409, body: { error } },
      });
      signMock.mockResolvedValue(["c2lnMQ==", "c2lnMg=="]);
      const err = await authorizePaidGeneration(REQ, signMock, 2).catch((e) => e as CheckoutError);
      expect(err).toMatchObject({ step: "submit", message: error });
      expect((err as CheckoutError).payment).toBeUndefined();
      expect(sent.some((r) => r.path.includes("/status"))).toBe(false);
    }
  });

  it("asks the status when the submit's answer never came, and renders an order the server stored (round 4, 2026-10-19)", async () => {
    for (const lost of [{ status: 504, body: null }, "network"] as const) {
      const sent = intentFetch({
        "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
        "/api/payments/generation/authorize": { status: 200, body: opened(["dHgx", "dHgy"]) },
        ...(lost === "network" ? {} : { "/api/payments/generation/submit": lost }),
        "/api/payments/generation/status": { status: 200, body: funded(2) },
      });
      signMock.mockResolvedValue(["c2lnMQ==", "c2lnMg=="]);
      expect(await authorizePaidGeneration(REQ, signMock, 2)).toMatchObject({ intentId: "i-1", state: "funded" });
      expect(sent.filter((r) => r.path.endsWith("/submit"))).toHaveLength(1);
      expect(sent.some((r) => r.path.endsWith("/status"))).toBe(true);
    }
  });

  it("asks again while a submit whose answer was lost has not stored the order yet (round 5, 2026-10-20)", async () => {
    vi.useFakeTimers();
    try {
      const prepared = { intentId: "i-1", paymentScheme: "intent", state: "prepared", funded: false, units: unitsOf(2), batch: null };
      const answers = [prepared, prepared, funded(2)];
      const statusCalls: string[] = [];
      signMock.mockReset();
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        const path = String(url).split("?")[0];
        if (path.endsWith("/submit")) throw new Error("network");
        if (path.endsWith("/status")) { statusCalls.push(path); return { ok: true, status: 200, json: async () => answers[Math.min(statusCalls.length - 1, 2)] } as Response; }
        const body = path.endsWith("/intent") ? { intent: { id: "i-1" } } : opened(["dHgx", "dHgy"]);
        return { ok: true, status: 200, json: async () => body } as Response;
      }));
      signMock.mockResolvedValue(["c2lnMQ==", "c2lnMg=="]);
      const done = authorizePaidGeneration(REQ, signMock, 2);
      await vi.advanceTimersByTimeAsync(CONFIRM_WAITS_MS[0] + CONFIRM_WAITS_MS[1]);
      expect(await done).toMatchObject({ intentId: "i-1", state: "funded" });
      expect(statusCalls).toHaveLength(3);
    } finally { vi.useRealTimers(); }
  });

  it("an answer that never came leaves the order pending, to be checked", async () => {
    intentFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: opened(["dHgx", "dHgy"]) },
      "/api/payments/generation/submit": { status: 504, body: null },
    });
    signMock.mockResolvedValue(["c2lnMQ==", "c2lnMg=="]);
    const err = await authorizePaidGeneration(REQ, signMock, 2).catch((e) => e as CheckoutError);
    expect(err).toMatchObject({ message: "Your payment is still being checked. Check its status before making another payment." });
    expect((err as CheckoutError).payment).toMatchObject({ intentId: "i-1", paymentScheme: "intent" });
    expect((err as CheckoutError).payment?.signedTransaction).toBeUndefined();
  });

  it("reads its status as an intent's: a paid image with a lost record is delivered without a generation, an escrow one is not", async () => {
    const lost = { unit_index: 0, state: "delivered", generation_id: null };
    intentFetch({ "/api/payments/generation/status": { status: 200, body: { ...funded(1), units: [lost] } } });
    const intent: EscrowCheckout = { intentId: "i-1", units: 1, paymentScheme: "intent", state: "uncertain" };
    expect((await checkPaidGenerationStatus(intent)).unitStatuses).toEqual([lost]);
    intentFetch({ "/api/payments/generation/status": { status: 200, body: { ...funded(1), paymentScheme: "escrow", units: [lost] } } });
    await expect(checkPaidGenerationStatus({ ...intent, paymentScheme: "escrow" })).rejects.toMatchObject({ step: "status" });
    // An answer for the other rail is not this order's.
    intentFetch({ "/api/payments/generation/status": { status: 200, body: funded(1) } });
    await expect(checkPaidGenerationStatus({ ...intent, paymentScheme: "escrow" })).rejects.toMatchObject({ step: "status" });
  });

  it("keeps an intent order across a reload without any signed payment", () => {
    const store = new Map<string, string>();
    const storage = { setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), getItem: (k: string) => store.get(k) ?? null };
    const pending = { intentId: "i-1", units: 2, paymentScheme: "intent" as const, state: "funded" as const, unitIndex: 1, generationSubmitted: false };
    expect(storePendingEscrowPayments(storage, "user-a", [{ ...pending, signedTransaction: "c2lnMQ==" }])).toBe(true);
    expect([...store.values()].join()).not.toMatch(/c2ln/);
    expect(readPendingEscrowPayments(storage, "user-a")).toEqual([pending]);
    // A stored intent that carries one anyway is not trusted.
    store.set([...store.keys()][0], JSON.stringify([{ ...pending, signedTransaction: "c2lnMQ==" }]));
    expect(readPendingEscrowPayments(storage, "user-a")).toEqual([]);
  });
});

describe("the wallet connects before anything is opened (verification 2026-10-18)", () => {
  it("asks the signer to connect first, and opens nothing when it says tap again", async () => {
    scriptFetch({ "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } } });
    const tapAgain = new CheckoutError("sign", "Your wallet is connected. Tap again to sign — nothing was charged.");
    const sign = Object.assign(vi.fn(), { prepare: vi.fn(async () => { throw tapAgain; }) });
    await expect(authorizePaidGeneration(REQ, sign)).rejects.toBe(tapAgain);
    expect(calls).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
  });

  it("connects before the order is requested, then goes on", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: { intentId: "i-1", transaction: "dHg=", units: 1, paymentScheme: "escrow" } },
      "/api/payments/generation/submit": { status: 200, body: { intentId: "i-1", paymentScheme: "escrow", state: "funded", funded: true } },
    });
    const order: string[] = [];
    const sign = Object.assign(vi.fn(async () => { order.push("sign"); return ["c2lnbmVk"]; }), { prepare: vi.fn(async () => { order.push(`prepare:${calls.length}`); }) });
    await authorizePaidGeneration(REQ, sign);
    expect(order).toEqual(["prepare:0", "sign"]);
  });

  it("reads a refused connect as a cancel, and requests nothing (verification 2026-10-18)", async () => {
    scriptFetch({});
    const sign = Object.assign(vi.fn(), { prepare: vi.fn(async () => { throw new Error("User rejected the request."); }) });
    await expect(authorizePaidGeneration(REQ, sign)).rejects.toMatchObject({ step: "sign", message: "Connecting was cancelled. Nothing was charged." });
    expect(calls).toEqual([]);
  });

  it("requests no order for a job taken back while its connect waited", async () => {
    scriptFetch({});
    let gone = false;
    const sign = Object.assign(vi.fn(), { prepare: vi.fn(async () => { gone = true; }) });
    await expect(authorizePaidGeneration(REQ, sign, 1, undefined, () => gone)).rejects.toMatchObject({ step: "intent" });
    expect(calls).toEqual([]);
  });

  it("says the wallet could not connect when the connect fails another way", async () => {
    scriptFetch({});
    const sign = Object.assign(vi.fn(), { prepare: vi.fn(async () => { throw new Error("socket closed"); }) });
    await expect(authorizePaidGeneration(REQ, sign)).rejects.toMatchObject({ step: "sign", message: "The wallet could not connect. Nothing was charged." });
    expect(calls).toEqual([]);
  });
});

describe("a request the shared address limit refused (round 18, 2026-10-20)", () => {
  const answer = (status: number, headers: Record<string, string> = {}) => ({ status, ok: status < 400, headers: new Headers(headers) }) as Response;

  it("is sent once more after its Retry-After, never sooner and never twice", async () => {
    vi.useFakeTimers();
    try {
      const limited = answer(429, { "Retry-After": "2" });
      const send = vi.fn(async () => limited);
      const out = onceMoreAfterLimit(limited, send);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      // A second refusal stands.
      expect(send).toHaveBeenCalledTimes(1);
      expect(await out).toBe(limited);
    } finally { vi.useRealTimers(); }
  });

  it("is not sent again for a wait past 60 s, a 429 without Retry-After, or another status that carries one", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => answer(200));
      const kept = [answer(429, { "Retry-After": "61" }), answer(429), answer(503, { "Retry-After": "30" })];
      const outs = kept.map((res) => onceMoreAfterLimit(res, send));
      await vi.advanceTimersByTimeAsync(70_000);
      expect(send).not.toHaveBeenCalled();
      expect(await Promise.all(outs)).toEqual(kept);
      // Exactly 60 s is still waited out.
      const sixty = onceMoreAfterLimit(answer(429, { "Retry-After": "60" }), send);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(send).toHaveBeenCalledTimes(1);
      expect((await sixty)?.status).toBe(200);
    } finally { vi.useRealTimers(); }
  });
});
