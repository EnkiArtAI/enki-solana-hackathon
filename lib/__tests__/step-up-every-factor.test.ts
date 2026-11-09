import { describe, it, expect, vi, beforeEach } from "vitest";

/** useStepUp's everyFactorToken, for the one request that cannot go through guarded: a passkey's registration. */

const ask = vi.hoisted(() => vi.fn(async (_s: string, f: string[]) => `t-${f[0]}`));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useContext: () => ask, useCallback: (f: unknown) => f }));

import { useStepUp } from "../../components/StepUpProvider";

const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

beforeEach(() => { ask.mockClear(); });

describe("everyFactorToken", () => {
  it("asks every factor the server names, one dialog each", async () => {
    answer(200, { factors: ["passkey", "totp"] });
    await expect(useStepUp().everyFactorToken("add-factor")).resolves.toBe("t-passkey,t-totp");
    expect(ask.mock.calls).toEqual([["add-factor", ["passkey"]], ["add-factor", ["totp"]]]);
  });

  it("asks nothing and gives nothing when the factors cannot be read", async () => {
    answer(503, {});
    await expect(useStepUp().everyFactorToken("add-factor")).resolves.toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});
