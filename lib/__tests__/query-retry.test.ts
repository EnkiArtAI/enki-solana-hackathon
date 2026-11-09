import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { isTransientFailure, QUERY_RETRY } from "@/lib/queryClient";
import { DB_UNAVAILABLE_MESSAGE } from "@/lib/db-error";

/**
 * A read that the database or the network dropped is tried twice more, after
 * 1 s and 3 s, so a blip of a few seconds never reaches the screen (Kev,
 * 2026-10-16: "was passiert denn mit unseren angezeigten daten?"). A refusal
 * or a bug fails at once, and writes never retry on their own.
 */
describe("isTransientFailure", () => {
  it("is a 502, 503 or 504 from getQueryFn, the database's own sentence, or a dropped request", () => {
    for (const m of ["503: {\"success\":false}", "502: Bad Gateway", "504: Gateway Timeout", DB_UNAVAILABLE_MESSAGE,
      "Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed", "TypeError: fetch failed"]) {
      expect(isTransientFailure(new Error(m)), m).toBe(true);
    }
  });

  it("is never a refusal, a missing thing or a bug", () => {
    for (const m of ["401: Unauthorized", "403: Forbidden", "404: {\"error\":\"not found\"}", "409: Conflict", "500: Internal Server Error",
      "Couldn't load prompts (HTTP 500).", "Unexpected token < in JSON", "This prompt isn't available"]) {
      expect(isTransientFailure(new Error(m)), m).toBe(false);
    }
  });

  it("matches the sentence lib/db-error.ts really sends", () => {
    expect(DB_UNAVAILABLE_MESSAGE.startsWith("The database is unreachable right now")).toBe(true);
  });
});

describe("QUERY_RETRY", () => {
  const blip = new Error("503: {\"code\":\"DB_UNAVAILABLE\"}");
  it("tries twice more on a transient failure, then gives up", () => {
    expect([0, 1, 2].map((n) => QUERY_RETRY.retry(n, blip))).toEqual([true, true, false]);
  });
  it("never tries a refusal again", () => {
    expect(QUERY_RETRY.retry(0, new Error("404: gone"))).toBe(false);
  });
  it("waits 1 s, then 3 s", () => {
    expect([0, 1].map((n) => QUERY_RETRY.retryDelay(n))).toEqual([1_000, 3_000]);
  });
});

describe("the app's QueryClient", () => {
  it("retries reads by QUERY_RETRY and never retries a write", () => {
    const providers = readSource(join(__dirname, "..", "..", "providers", "index.tsx"));
    expect(providers).toContain("staleTime: Infinity,\n            ...QUERY_RETRY,\n          },");
    expect(providers).toContain("mutations: {\n            retry: false,\n          },");
  });

  it("asks the database every minute", () => {
    const vercel = JSON.parse(readSource(join(__dirname, "..", "..", "vercel.json"))) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons.find((c) => c.path === "/api/cron/db-health")?.schedule).toBe("* * * * *");
    expect(vercel.crons.find((c) => c.path === "/api/cron/sweep-payments")?.schedule).toBe("*/5 * * * *");
  });
});
