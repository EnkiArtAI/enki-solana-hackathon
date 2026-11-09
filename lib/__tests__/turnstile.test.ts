import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The server's half of the human check. Cloudflare is a stub and is never called (vitest.setup.ts throws on any real
 * socket). Blind spot: the siteverify shape here is written from Cloudflare's documentation as remembered, not read off
 * a real answer; the first real one comes with Kev's widget.
 */
const load = async () => {
  vi.resetModules();
  return (await import("@/lib/turnstile")).verifyTurnstile;
};

let fetched: { url: string; init: RequestInit }[] = [];
const cloudflare = (answer: () => Response | Promise<Response>) => vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
  fetched.push({ url: String(url), init });
  return answer();
}));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  fetched = [];
  process.env.TURNSTILE_SECRET_KEY = "the-secret";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.TURNSTILE_SECRET_KEY;
});

describe("verifyTurnstile", () => {
  it("asks siteverify with the secret and the token, by POST", async () => {
    const verify = await load();
    cloudflare(() => json({ success: true }));
    expect(await verify("a-token")).toBe("pass");
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(fetched[0].init.method).toBe("POST");
    expect(JSON.parse(String(fetched[0].init.body))).toEqual({ secret: "the-secret", response: "a-token" });
    expect(fetched[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses what cannot be a token without asking", async () => {
    const verify = await load();
    cloudflare(() => json({ success: true }));
    for (const token of [undefined, null, "", 7, {}, "x".repeat(2049)]) expect(await verify(token)).toBe("refused");
    expect(fetched).toEqual([]);
    expect(await verify("x".repeat(2048))).toBe("pass");
  });

  it("refuses a token Cloudflare refuses, in any environment", async () => {
    const verify = await load();
    for (const env of ["development", "production"]) {
      vi.stubEnv("NODE_ENV", env);
      for (const codes of [["timeout-or-duplicate"], ["invalid-input-response"], []]) {
        cloudflare(() => json({ success: false, "error-codes": codes }));
        expect(await verify("t")).toBe("refused");
      }
      // A 400 with the same answer is still a refused token, not an outage.
      cloudflare(() => json({ success: false, "error-codes": ["invalid-input-response"] }, 400));
      expect(await verify("t")).toBe("refused");
    }
  });

  it("only success: true passes", async () => {
    const verify = await load();
    vi.stubEnv("NODE_ENV", "production");
    for (const body of [{ success: "true" }, { success: 1 }, {}, null, []]) {
      cloudflare(() => json(body));
      expect(await verify("t")).toBe("paused");
    }
  });

  describe("no check possible", () => {
    const FAILURES: [string, () => Response | Promise<Response>][] = [
      ["no answer", () => Promise.reject(new TypeError("fetch failed"))],
      ["a 500", () => json({ success: true }, 500)],
      ["a 503 page", () => new Response("<html>", { status: 503 })],
      ["not JSON", () => new Response("<html>")],
      ["Cloudflare's own error", () => json({ success: false, "error-codes": ["internal-error"] })],
      ["a wrong secret", () => json({ success: false, "error-codes": ["invalid-input-secret"] })],
      ["no secret reached it", () => json({ success: false, "error-codes": ["missing-input-secret"] })],
    ];

    // A Vercel preview is a production build too, and VERCEL_ENV may not reach the runtime at all (review of DEC-22).
    it.each(FAILURES)("on a production build, closed, whatever VERCEL_ENV says: %s", async (_, answer) => {
      const verify = await load();
      vi.stubEnv("NODE_ENV", "production");
      for (const where of ["production", "preview", undefined]) {
        vi.stubEnv("VERCEL_ENV", where as string);
        cloudflare(answer);
        expect(await verify("t")).toBe("paused");
      }
    });

    it.each(FAILURES)("in next dev, skipped: %s", async (_, answer) => {
      const verify = await load();
      vi.stubEnv("NODE_ENV", "development");
      cloudflare(answer);
      expect(await verify("t")).toBe("pass");
    });

    it("a missing secret: closed on a preview's production build, without asking", async () => {
      const verify = await load();
      delete process.env.TURNSTILE_SECRET_KEY;
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VERCEL_ENV", "preview");
      cloudflare(() => json({ success: true }));
      expect(await verify("t")).toBe("paused");
      expect(fetched).toEqual([]);
    });

    it("a missing secret in next dev: skipped, with one warning that names no secret", async () => {
      const verify = await load();
      delete process.env.TURNSTILE_SECRET_KEY;
      vi.stubEnv("NODE_ENV", "development");
      expect(await verify(undefined)).toBe("pass");
      expect(await verify("t")).toBe("pass");
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(console.warn).mock.calls[0][0]).toContain("TURNSTILE_SECRET_KEY is not set");
    });

    it("logs never carry the secret or the token", async () => {
      const verify = await load();
      vi.stubEnv("NODE_ENV", "production");
      cloudflare(() => json({ success: false, "error-codes": ["invalid-input-secret"] }));
      await verify("the-token");
      const said = JSON.stringify([...vi.mocked(console.error).mock.calls, ...vi.mocked(console.warn).mock.calls]);
      expect(said).toContain("invalid-input-secret");
      expect(said).not.toContain("the-secret");
      expect(said).not.toContain("the-token");
    });
  });
});
