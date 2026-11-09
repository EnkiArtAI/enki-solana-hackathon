import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as gate } from "../../app/api/gate/route";
import { signTrial, TRIAL_COOKIE, TRIAL_PASS_COOKIE } from "@/lib/trial-cookie";

/**
 * SOC-8: GET /api/gate gains `whitelistActive`, the one piece of server
 * state BetaGate.tsx needs to know whether the role check still applies.
 * It mirrors lib/allowlist.ts's whitelistStageActive() exactly (same env
 * var, same truthiness), tested here against the real route handler.
 * `team` says whether the browser carries what the proxy opens the app for:
 * a member's signed cookie or a running trial's, never the bare team code
 * (DEC-434).
 */

afterEach(() => vi.unstubAllEnvs());

const PEPPER = "test-pepper";
const USER = "11111111-1111-4111-8111-111111111111";
const req = (cookie?: string) => new NextRequest("http://enki.test/api/gate", { headers: cookie ? { cookie } : {} });
const stage = () => { vi.stubEnv("TEAM_ACCESS_CODE", "beta-code"); vi.stubEnv("AUTH_PEPPER", PEPPER); };

describe("GET /api/gate — whitelistActive", () => {
  it("is false once the whitelist stage has ended (TEAM_ACCESS_CODE unset)", async () => {
    vi.stubEnv("TEAM_ACCESS_CODE", "");
    const res = await gate(req());
    expect(await res.json()).toEqual({ team: false, whitelistActive: false });
  });

  it("is true while the stage is active, even with no cookie", async () => {
    stage();
    const res = await gate(req());
    expect(await res.json()).toEqual({ team: false, whitelistActive: true });
  });

  it("says team for a member's signed cookie and for a running trial's", async () => {
    stage();
    const member = signTrial("member", USER, Date.now() + 60_000, PEPPER);
    expect(await (await gate(req(`enki_team=${member}`))).json()).toEqual({ team: true, whitelistActive: true });
    const trial = signTrial("trial", USER, Date.now() + 60_000, PEPPER);
    expect(await (await gate(req(`${TRIAL_COOKIE}=${trial}`))).json()).toEqual({ team: true, whitelistActive: true });
  });

  it("never for the bare team code, an ended or forged cookie, a pass, or one kind under another's name", async () => {
    stage();
    const ended = signTrial("member", USER, Date.now() - 1, PEPPER);
    const pass = signTrial("pass", USER, Date.now() + 60_000, PEPPER);
    const trial = signTrial("trial", USER, Date.now() + 60_000, PEPPER);
    const otherPepper = signTrial("member", USER, Date.now() + 60_000, "another-pepper");
    for (const cookie of ["enki_team=beta-code", `enki_team=${ended}`, `enki_team=${otherPepper}`, `enki_team=${pass}`, `enki_team=${trial}`, `${TRIAL_PASS_COOKIE}=${pass}`]) {
      expect(await (await gate(req(cookie))).json(), cookie).toEqual({ team: false, whitelistActive: true });
    }
  });
});
