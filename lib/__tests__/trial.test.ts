import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { readTrial, signTrial, TRIAL_COOKIE, TRIAL_PASS_COOKIE } from "@/lib/trial-cookie";
import { grantTrialCookie, grantTrialPass, hashTrialCode, newTrialCode, normalizeTrialCode, redeemableCode, trialAdmission, trialSessionMs } from "@/lib/trial";

/** Trial codes (Kev, 2026-10-26): what the codes and the two signed cookies promise. */
const SECRET = "pepper-for-tests";
const USER = "11111111-1111-4111-8111-111111111111";
const CODE_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => { vi.stubEnv("AUTH_PEPPER", SECRET); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("a trial cookie", () => {
  it("reads back what this server signed, for its kind, until it expires", async () => {
    const now = Date.now();
    const value = await signTrial("trial", USER, now + 60_000, SECRET);
    expect(await readTrial("trial", value, SECRET, now)).toEqual({ subject: USER, expiresAtMs: now + 60_000 });
    expect(await readTrial("trial", value, SECRET, now + 60_000)).toBeNull();
    expect(await readTrial("pass", value, SECRET, now)).toBeNull();
    expect(await readTrial("trial", value, "another-secret", now)).toBeNull();
  });

  it("refuses one changed anywhere: the account, the end, the signature, or a made-up one", async () => {
    const now = Date.now();
    const [subject, exp, sig] = (await signTrial("trial", USER, now + 60_000, SECRET)).split(".");
    for (const forged of [
      `${CODE_ID}.${exp}.${sig}`,
      `${subject}.${Number(exp) + 3_600_000}.${sig}`,
      `${subject}.${exp}.${sig.slice(0, -2)}AA`,
      `${subject}.${exp}`,
      "",
      undefined,
    ]) expect(await readTrial("trial", forged, SECRET, now), String(forged)).toBeNull();
  });
});

describe("a trial code", () => {
  it("is 16 letters and digits without I, O, 0 or 1, in fours, and new each time", () => {
    const codes = Array.from({ length: 50 }, newTrialCode);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(new Set(codes).size).toBe(50);
  });

  it("is compared as its letters and digits, upper case", () => {
    expect(normalizeTrialCode(" k7qm-2xpa rr9w-55hb ")).toBe("K7QM2XPARR9W55HB");
    expect(hashTrialCode("k7qm-2xpa-rr9w-55hb")).toBe(hashTrialCode("K7QM2XPARR9W55HB"));
  });

  it("is kept only as a keyed hash: another code, another hash; none without the pepper", () => {
    const h = hashTrialCode("K7QM-2XPA-RR9W-55HB")!;
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("K7QM");
    expect(hashTrialCode("K7QM-2XPA-RR9W-55HC")).not.toBe(h);
    vi.stubEnv("AUTH_PEPPER", "");
    expect(hashTrialCode("K7QM-2XPA-RR9W-55HB")).toBeNull();
  });
});

// A fake client: each table or function answers what a test sets.
type Answer = { data: unknown; error: { code?: string; message?: string } | null };
const db = { codes: null as Answer | null, rpc: {} as Record<string, Answer>, updates: [] as unknown[], calls: [] as string[] };
const client = () => ({
  from: (table: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) c[m] = () => c;
    c.maybeSingle = async () => (table === "trial_codes" ? db.codes : { data: null, error: null });
    c.update = (row: unknown) => { db.updates.push({ table, row }); return { eq: () => ({ eq: async () => ({ error: null }) }) }; };
    return c;
  },
  rpc: async (name: string, args: unknown) => {
    db.calls.push(name);
    const answer = db.rpc[name] ?? { data: null, error: null };
    // As the database: a redemption is the account's running trial from then on.
    if (name === "redeem_trial_code" && Array.isArray(answer.data) && answer.data.length) db.rpc.active_trial = answer;
    return { ...answer, args };
  },
}) as never;
beforeEach(() => { db.codes = null; db.rpc = {}; db.updates = []; db.calls = []; });

describe("a typed code at the gate", () => {
  const row = (over: Record<string, unknown> = {}) => ({ data: { id: CODE_ID, max_uses: 3, uses: 1, expires_at: null, revoked_at: null, ...over }, error: null });
  it("names its code while it can be redeemed", async () => {
    db.codes = row();
    expect(await redeemableCode(client(), "K7QM-2XPA-RR9W-55HB")).toBe(CODE_ID);
  });

  it("is refused when revoked, past its date, used up, unknown, or not a code at all; and before the migration", async () => {
    for (const over of [{ revoked_at: "2026-10-26T00:00:00Z" }, { expires_at: "2000-01-01T00:00:00Z" }, { uses: 3 }]) {
      db.codes = row(over);
      expect(await redeemableCode(client(), "K7QM-2XPA-RR9W-55HB"), JSON.stringify(over)).toBeNull();
    }
    db.codes = row({ max_uses: null, uses: 999 });
    expect(await redeemableCode(client(), "K7QM-2XPA-RR9W-55HB")).toBe(CODE_ID);
    db.codes = { data: null, error: null };
    expect(await redeemableCode(client(), "K7QM-2XPA-RR9W-55HB")).toBeNull();
    db.codes = row();
    expect(await redeemableCode(client(), "short")).toBeNull();
    db.codes = { data: null, error: { code: "PGRST205" } };
    expect(await redeemableCode(client(), "K7QM-2XPA-RR9W-55HB")).toBeNull();
  });
});

describe("a login on a trial", () => {
  const TRIAL = { redemption_id: "r1", ends_at: new Date(Date.now() + 30 * 60_000).toISOString(), budget_micro: "2000000", spent_micro: 0 };
  const req = async (pass?: string) => new NextRequest("http://enki.test/api/auth/password/login", {
    headers: pass ? { cookie: `${TRIAL_PASS_COOKIE}=${pass}` } : {},
  });

  it("keeps the account's running trial, without spending the code again", async () => {
    db.rpc.active_trial = { data: [TRIAL], error: null };
    expect(await trialAdmission(client(), await req(), USER)).toEqual({ redemptionId: "r1", endsAt: TRIAL.ends_at, budgetMicro: 2_000_000, spentMicro: 0 });
    expect([db.updates, db.calls]).toEqual([[], ["active_trial"]]);
  });

  // Review 2026-10-26: a second code was thrown away while an earlier trial ran.
  it("spends a second code too while an earlier trial runs, and keeps the one that ends last", async () => {
    db.rpc.active_trial = { data: [TRIAL], error: null };
    db.rpc.redeem_trial_code = { data: [{ ...TRIAL, redemption_id: "r2" }], error: null };
    const pass = signTrial("pass", CODE_ID, Date.now() + 60_000, SECRET);
    expect((await trialAdmission(client(), await req(pass), USER))?.redemptionId).toBe("r2");
    expect(db.calls).toEqual(["redeem_trial_code", "active_trial"]);
  });

  it("spends the code this browser redeemed on this account, and marks it a trial account", async () => {
    db.rpc.active_trial = { data: [], error: null };
    db.rpc.redeem_trial_code = { data: [TRIAL], error: null };
    const pass = await signTrial("pass", CODE_ID, Date.now() + 60_000, SECRET);
    expect((await trialAdmission(client(), await req(pass), USER))?.redemptionId).toBe("r1");
    expect(db.updates).toEqual([{ table: "users", row: { role: "trial" } }]);
  });

  it("lets nothing in without a running trial or a signed pass, or when the code is spent", async () => {
    db.rpc.active_trial = { data: [], error: null };
    db.rpc.redeem_trial_code = { data: [TRIAL], error: null };
    expect(await trialAdmission(client(), await req(), USER)).toBeNull();
    expect(await trialAdmission(client(), await req(`${CODE_ID}.${Date.now() + 60_000}.forged`), USER)).toBeNull();
    const pass = await signTrial("pass", CODE_ID, Date.now() + 60_000, SECRET);
    db.rpc.redeem_trial_code = { data: [], error: null };
    expect(await trialAdmission(client(), await req(pass), USER)).toBeNull();
    expect(db.updates).toEqual([]);
  });
});

describe("the cookies a trial login gets", () => {
  it("open the app until the trial ends, and spend the pass", async () => {
    const endsAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const res = await grantTrialCookie(NextResponse.json({}), USER, { redemptionId: "r1", endsAt, budgetMicro: 1, spentMicro: 0 });
    const trial = res.cookies.get(TRIAL_COOKIE)!;
    expect(await readTrial("trial", trial.value, SECRET)).toMatchObject({ subject: USER, expiresAtMs: Date.parse(endsAt) });
    expect([trial.httpOnly, trial.path, Math.abs(Number(trial.maxAge) - 600) <= 1]).toEqual([true, "/", true]);
    expect(res.cookies.get(TRIAL_PASS_COOKIE)).toMatchObject({ value: "", maxAge: 0 });
    expect(trialSessionMs({ redemptionId: "r1", endsAt, budgetMicro: 1, spentMicro: 0 }, Date.parse(endsAt) - 5000)).toBe(5000);
  });

  it("a pass lasts half an hour for this code", async () => {
    const res = await grantTrialPass(NextResponse.json({}), CODE_ID);
    const pass = res.cookies.get(TRIAL_PASS_COOKIE)!;
    expect([pass.maxAge, pass.httpOnly, (await readTrial("pass", pass.value, SECRET))?.subject]).toEqual([1800, true, CODE_ID]);
  });
});

describe("the proxy", () => {
  // The proxy reads the settings it requires (ENV-01); the pepper is the test's.
  const visit = async (path: string, cookie?: string) => {
    const { stubRequiredEnv } = await import("@/lib/__tests__/_required-env");
    stubRequiredEnv();
    vi.stubEnv("AUTH_PEPPER", SECRET);
    vi.stubEnv("TEAM_ACCESS_CODE", "team-code");
    const { proxy } = await import("../../proxy");
    return proxy(new NextRequest(`http://enki.test${path}`, cookie ? { headers: { cookie } } : {}));
  };
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("opens pages and APIs to a running trial, as to the team", async () => {
    const trial = signTrial("trial", USER, Date.now() + 60_000, SECRET);
    expect(passes(await visit("/home", `${TRIAL_COOKIE}=${trial}`))).toBe(true);
    expect(passes(await visit("/api/prompts", `${TRIAL_COOKIE}=${trial}`))).toBe(true);
  });

  it("sends an ended, forged or pass-only browser to the landing", async () => {
    const ended = signTrial("trial", USER, Date.now() - 1, SECRET);
    const pass = signTrial("pass", CODE_ID, Date.now() + 60_000, SECRET);
    for (const cookie of [`${TRIAL_COOKIE}=${ended}`, `${TRIAL_COOKIE}=${USER}.${Date.now() + 60_000}.forged`, `${TRIAL_PASS_COOKIE}=${pass}`, `${TRIAL_COOKIE}=${pass}`]) {
      const res = await visit("/home", cookie);
      expect(new URL(res.headers.get("location")!).pathname, cookie).toBe("/");
    }
  });
});
