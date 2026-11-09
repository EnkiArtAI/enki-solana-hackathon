import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLicenceCredits, type LicenceCredit } from "../licence-credits";

/**
 * The licence fees Enki owes for an x402 render it sold (Kev, 2026-10-17:
 * "verkäufer-modell für künstlerprompts"): one row per payment and role, a
 * repeat is a no-op, a failure is asked again three times, then logged.
 */

const CREDITS: LicenceCredit[] = [
  { role: "artist", owner: "ArtistWa11et", userId: "u-artist", micro: 1_000_000 },
  { role: "referrer", owner: "Referrer", micro: 55_000 },
  // An artist without a payout wallet is owed by account (Kev, 2026-10-18).
  { role: "author", owner: null, userId: "u-author", micro: 27_500 },
];
const P = { source: "x402:5sig", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", promptId: "p-1", credits: CREDITS };

/** A client whose licence_credits upsert answers each of `answers` in turn ("throw" throws). */
function client(answers: Array<{ error: { code: string } | null } | "throw">) {
  const calls: Array<{ table: string; rows: unknown; options: unknown }> = [];
  const supabase = {
    from: (table: string) => ({
      upsert: async (rows: unknown, options: unknown) => {
        calls.push({ table, rows, options });
        const next = answers[calls.length - 1] ?? { error: null };
        if (next === "throw") throw new Error("fetch failed");
        return next;
      },
    }),
  } as unknown as SupabaseClient;
  return { supabase, calls };
}

afterEach(() => vi.restoreAllMocks());

describe("recordLicenceCredits", () => {
  it("writes one row per credit, keyed by the payment and the role, and ignores a repeat", async () => {
    const { supabase, calls } = client([{ error: null }]);
    expect(await recordLicenceCredits(supabase, P, { gapMs: 0 })).toBe(true);
    expect(calls).toEqual([{
      table: "licence_credits",
      rows: [
        { source: "x402:5sig", role: "artist", owner: "ArtistWa11et", user_id: "u-artist", mint: P.mint, micro: 1_000_000, prompt_id: "p-1" },
        { source: "x402:5sig", role: "referrer", owner: "Referrer", user_id: null, mint: P.mint, micro: 55_000, prompt_id: "p-1" },
        { source: "x402:5sig", role: "author", owner: null, user_id: "u-author", mint: P.mint, micro: 27_500, prompt_id: "p-1" },
      ],
      options: { onConflict: "source,role", ignoreDuplicates: true },
    }]);
  });

  it("asks again after a failed or thrown write and stops at the first that lands", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { supabase, calls } = client([{ error: { code: "PGRST205" } }, "throw", { error: null }]);
    expect(await recordLicenceCredits(supabase, P, { gapMs: 0 })).toBe(true);
    expect(calls).toHaveLength(3);
    expect(error).not.toHaveBeenCalled();
  });

  it("gives up after three tries and says so with the payment and the last error code", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { supabase, calls } = client([{ error: { code: "08006" } }, { error: { code: "08006" } }, { error: { code: "PGRST205" } }, { error: null }]);
    expect(await recordLicenceCredits(supabase, P, { gapMs: 0 })).toBe(false);
    expect(calls).toHaveLength(3);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe("[licence-credits] 3 licence credit(s) for x402:5sig NOT recorded after 3 tries (PGRST205): Enki owes them, add them by hand");
  });

  it("waits between tries", async () => {
    vi.useFakeTimers();
    try {
      const { supabase, calls } = client([{ error: { code: "08006" } }, { error: null }]);
      const done = recordLicenceCredits(supabase, P);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await done).toBe(true);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
