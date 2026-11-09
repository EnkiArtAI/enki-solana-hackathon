import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { readSource } from "./_read-source";

// Absolute, so the in-memory mutant runner reaches what these pins read (__bench-mutant.setup.mjs matches on the path).
const src = (p: string) => readSource(join(__dirname, "..", "..", p));
import { trialLine } from "@/lib/ui/trial-line";

/**
 * Trial codes (Kev, 2026-10-26): a tester off the access list signs in with an
 * own account after a trial code; the login lets them in until the trial
 * ends, with its own cookie and a session that ends with it, never the team's.
 */
const USER = "11111111-1111-4111-8111-111111111111";
const ENDS = new Date(Date.now() + 20 * 60_000).toISOString();
const TRIAL = { redemptionId: "r1", endsAt: ENDS, budgetMicro: 2_000_000, spentMicro: 600_000 };

const ctl = vi.hoisted(() => ({ listed: false, ipBanned: false, banned: false, trial: null as unknown, admitted: [] as string[], minted: [] as unknown[] }));
vi.mock("@/lib/trial", async (orig) => ({
  ...(await orig<typeof import("@/lib/trial")>()),
  trialAdmission: vi.fn(async () => ctl.trial),
}));
vi.mock("@/lib/allowlist", async (orig) => ({
  ...(await orig<typeof import("@/lib/allowlist")>()),
  whitelistStageActive: () => true,
  isEmailAllowed: async () => ctl.listed,
  admitAllowlisted: async (_: unknown, id: string) => { ctl.admitted.push(id); },
}));
vi.mock("@/lib/ip-hash", () => ({ getClientIp: () => "203.0.113.9", hashIp: () => "iphash", isIpBanned: async () => ctl.ipBanned }));
vi.mock("@/lib/session-user", () => ({ activeBanFor: async () => (ctl.banned ? { id: "ban" } : null) }));
vi.mock("@/lib/user-session", () => ({ mintUserSession: async (...args: unknown[]) => { ctl.minted.push(args); return { token: "tok", expiresAt: ENDS }; } }));

import { loginRefusal, openLoginSession } from "@/lib/password-login";
import { trialAdmission } from "@/lib/trial";

const req = () => new NextRequest("http://enki.test/api/auth/password/login", { method: "POST" });
const supabase = {} as never;
const cookies = (res: Response) => res.headers.getSetCookie().join("\n");

beforeEach(() => {
  Object.assign(ctl, { listed: false, ipBanned: false, banned: false, trial: null, admitted: [], minted: [] });
  vi.mocked(trialAdmission).mockClear();
  vi.stubEnv("TEAM_ACCESS_CODE", "team-code");
  vi.stubEnv("AUTH_PEPPER", "pepper");
});
afterEach(() => vi.unstubAllEnvs());

describe("a password login off the access list", () => {
  it("is let in on a trial this browser redeemed, after the password and the network were checked", async () => {
    ctl.trial = TRIAL;
    const gate = await loginRefusal(req(), supabase, "tester@example.com", USER);
    expect([gate.refusal, gate.trial]).toEqual([null, TRIAL]);
    expect(trialAdmission).toHaveBeenCalledWith(supabase, expect.anything(), USER);
  });

  it("is refused without one, as any wrong login, and a blocked network spends no code", async () => {
    expect((await loginRefusal(req(), supabase, "tester@example.com", USER)).refusal?.status).toBe(401);
    expect((await loginRefusal(req(), supabase, "tester@example.com")).refusal?.status).toBe(401);
    ctl.trial = TRIAL;
    ctl.ipBanned = true;
    vi.mocked(trialAdmission).mockClear();
    expect((await loginRefusal(req(), supabase, "tester@example.com", USER)).refusal?.status).toBe(403);
    expect(trialAdmission).not.toHaveBeenCalled();
  });

  // Review 2026-10-26: a suspended account spent a use; an ended code read as a wrong password.
  it("spends no code on a suspended account, and says so when the code is what failed", async () => {
    ctl.trial = TRIAL;
    ctl.banned = true;
    expect((await loginRefusal(req(), supabase, "tester@example.com", USER)).refusal?.status).toBe(401);
    expect(trialAdmission).not.toHaveBeenCalled();
    ctl.banned = false;
    ctl.trial = null;
    const { signTrial } = await import("@/lib/trial-cookie");
    const withPass = new NextRequest("http://enki.test/api/auth/password/login", { method: "POST", headers: { cookie: `enki_trial_pass=${signTrial("pass", USER, Date.now() + 60_000, "pepper")}` } });
    const ended = (await loginRefusal(withPass, supabase, "tester@example.com", USER)).refusal!;
    expect([ended.status, (await ended.json()).trialEnded]).toEqual([403, true]);
  });

  it("asks nothing of a trial when the list admits the account", async () => {
    ctl.listed = true;
    expect(await loginRefusal(req(), supabase, "listed@example.com", USER)).toEqual({ refusal: null, ipHash: "iphash", trial: null });
    expect(trialAdmission).not.toHaveBeenCalled();
  });
});

describe("the session a trial login opens", () => {
  it("ends with the trial, opens the app with the trial's cookie, never the team's, and makes no beta member", async () => {
    const res = await openLoginSession(supabase, USER, "tester@example.com", "iphash", TRIAL);
    const [, , ttl] = ctl.minted[0] as [string, string, number];
    expect(Math.abs(ttl - (Date.parse(ENDS) - Date.now())) < 2000).toBe(true);
    expect(cookies(res)).toContain("enki_trial=");
    expect(cookies(res)).not.toContain("enki_team=");
    expect(ctl.admitted).toEqual([]);
  });

  it("an admitted login gets the member cookie until its session ends, its 30 days and its beta role", async () => {
    const res = await openLoginSession(supabase, USER, "listed@example.com", "iphash");
    expect(ctl.minted[0]).toEqual([USER, "iphash", undefined]);
    // Signed for the account, never the team code itself (DEC-434).
    const { readTrial } = await import("@/lib/trial-cookie");
    expect(readTrial("member", /enki_team=([^;]*)/.exec(cookies(res))?.[1], "pepper")).toEqual({ subject: USER, expiresAtMs: Date.parse(ENDS) });
    expect(ctl.admitted).toEqual([USER]);
  });
});

describe("the wiring", () => {
  it("the password login names the account to its trial check and opens the trial's session", () => {
    const login = src("app/api/auth/password/login/route.ts");
    expect(login).toContain("const gate = await loginRefusal(req, supabase, cred.email, cred.user_id);");
    expect(login).toContain("return openLoginSession(supabase, cred.user_id, cred.email, gate.ipHash, gate.trial);");
  });

  it("Google and X: a trial only off the list and unbanned, a session that ends with it, the trial's cookie", () => {
    const cb = src("app/api/auth/oauth/[provider]/callback/route.ts");
    expect(cb).toContain("const trial = allowlisted || banned ? null : await trialAdmission(supabase, req, userId);");
    expect(cb).toContain("const session = await mintUserSession(userId, ipHash, trial ? trialSessionMs(trial) : undefined);");
    expect(cb).toMatch(/if \(banned\) return revokeGateCookie\(res\);\n\s+if \(trial\) return grantTrialCookie\(res, userId, trial\);\n\s+if \(!allowlisted\) return res;/);
  });

  it("the banned door gives a tester the trial's cookie back, never the team's", () => {
    const me = src("app/api/ban/me/route.ts");
    // The access list decides, as every login asks it; staff are staff (review 2026-10-26).
    expect(me).toMatch(/if \(STAFF\.has\(String\(me\?\.role \?\? ""\)\) \|\| \(await accountAllowed\(supabase, userId\)\)\) \{\n\s+await admitAllowlisted\(supabase, userId\);/);
    expect(me).toContain('return grantGateCookie(NextResponse.json({ banned: false, admitted: true }), userId, String(session?.expires_at ?? ""));');
    expect(me).toContain("return trial ? grantTrialCookie(NextResponse.json({ banned: false, admitted: true }), userId, trial) : NextResponse.json({ banned: false });");
  });

  it("the client wall admits a trial account only while the server says its trial runs, and ends it on time", () => {
    const gate = src("components/BetaGate.tsx");
    expect(gate).toContain('if (BETA_ROLES.has(data.role ?? "user") || (data.role === "trial" && data.trial)) setAccess("ok");');
    expect(gate).toContain('const t = setTimeout(() => forgetSession(sessionAuthHeaders()["X-Session-Token"]), Math.max(0, left));');
    expect(src("app/api/users/handle/route.ts")).toContain('const trial = row.role === "trial" ? await activeTrial(supabase, userId) : null;');
  });

  it("the gate turns a trial code into a pass, after its own limit", () => {
    const gate = src("app/api/gate/route.ts");
    expect(gate).toContain('const limit = checkRequestRateLimit(rateLimitKey(req, "gate"), 10, 60_000);');
    expect(gate).toContain("if (trialCode) return grantTrialPass(NextResponse.json({ ok: true, trial: true }), trialCode);");
  });
});

describe("the trial's line at the top", () => {
  it("says when it ends, the day too when not today, and what the budget has left", () => {
    const now = new Date(2026, 9, 26, 14, 0);
    expect(trialLine({ endsAt: new Date(2026, 9, 26, 14, 35).toISOString(), budgetMicro: 2_000_000, spentMicro: 600_000 }, now)).toBe("Trial · ends 14:35 · $1.40 left");
    expect(trialLine({ endsAt: new Date(2026, 9, 28, 9, 5).toISOString(), budgetMicro: 5_000_000, spentMicro: 0 }, now)).toBe("Trial · ends 28 Oct, 09:05 · $5.00 left");
    expect(trialLine({ endsAt: new Date(2026, 9, 26, 15, 0).toISOString(), budgetMicro: 1_000_000, spentMicro: 1_200_000 }, now)).toBe("Trial · ends 15:00 · $0.00 left");
  });
});

describe("the review's fixes (2026-10-26)", () => {
  it("Google/X: off the list with no trial after all, no session, and an account made for it goes", () => {
    const cb = src("app/api/auth/oauth/[provider]/callback/route.ts");
    expect(cb).toContain("resolveIdentity(supabase, identity, claims.intent, !!trialPassCode(req));");
    expect(cb).toMatch(/if \(!allowlisted && !banned && !trial\) \{\n\s+if \(inserted\) \{[\s\S]*?return deny\("not_whitelisted"\);\n\s+\}\n\s+const session = await mintUserSession/);
  });

  it("a ban takes the trial's cookie too", async () => {
    const { revokeGateCookie } = await import("@/lib/allowlist");
    const { NextResponse } = await import("next/server");
    const set = revokeGateCookie(NextResponse.json({})).headers.getSetCookie().join("\n");
    expect(set).toMatch(/enki_team=;[^\n]*Max-Age=0/);
    expect(set).toMatch(/enki_trial=;[^\n]*Max-Age=0/);
  });

  it("the shell moves under the trial's line as under the 2FA bar", () => {
    expect(src("components/enki-shell/EnkiHome.tsx")).toContain('+ (showRecoveryBanner || needs2fa || trial ? " ek-with-banner" : "")');
  });

  it("an empty custom budget is refused, never a $0 code", () => {
    expect(src("app/admin/page.tsx")).toContain('budgetUsd: tr.budget !== "custom" ? Number(tr.budget) : tr.customBudget.trim() === "" ? NaN : Number(tr.customBudget),');
  });
});
