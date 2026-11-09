import { vi } from "vitest";

// Excluding *.live.test.ts / __live-* / __bench-* is only a naming convention:
// a suite that calls a paid provider from an ordinary filename still bills Kev
// on every CI run, silently. This makes that impossible instead of unlikely —
// any real socket a test opens throws here rather than reaching a metered host.
// Suites that need fetch mock it (vi.stubGlobal), which replaces this stub for
// the duration of the test and restores it afterwards.
globalThis.fetch = (input: RequestInfo | URL) => {
  const url = typeof input === "object" && "url" in input ? input.url : String(input);
  throw new Error(
    `Test attempted a real network call to ${url}. Mock it (vi.stubGlobal("fetch", ...)); ` +
      `live provider calls belong in *.live.test.ts / __live-*, run by name, never in the suite.`,
  );
};

// Every route that spends Enki's money reserves first (SQL 72), and a stubbed database cannot answer that: allowed here,
// so a route's own test reads its own subject. lib/__tests__/spend-cap.test.ts unmocks it and runs the real SQL;
// lib/__tests__/spend-cap-routes.test.ts replaces it to refuse.
vi.mock("@/lib/generation/spend-cap", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/spend-cap")>()),
  reserveSpend: async (_db: unknown, micro: number) => ({ ok: true, day: "2026-01-01", micro }),
  spendFits: async (_db: unknown, micro: number) => ({ ok: true, day: "2026-01-01", micro }),
  releaseSpend: async () => undefined,
}));
