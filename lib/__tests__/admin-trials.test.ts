import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Trial codes in the admin panel (Kev, 2026-10-26): the owner
 * (moderation_policy.owner_user_id) makes a code with a number of uses or
 * none, minutes of access, an optional expiry and a budget per tester, sees
 * who redeemed each, and revokes one. The code is shown once and kept only as
 * its keyed hash; the admin log keeps the settings, never the code or the note.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null, actor: "owner-1" }));
// buildCouncil closes expired proposals with .lt(), which the shared fake does not filter by; no proposal is seeded here.
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => {
    const client = db.current!.client as unknown as { from: (t: string) => Record<string, unknown>; rpc: unknown };
    return { ...client, from: (t: string) => { const q = client.from(t); q.lt = () => q; return q; } };
  },
}));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => db.actor }));
vi.mock("@/lib/trial", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/trial")>();
  return { ...real, newTrialCode: vi.fn(real.newTrialCode) };
});
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64"); });

import { GET, POST } from "../../app/api/admin/route";
import { hashTrialCode, newTrialCode } from "@/lib/trial";

const ROOT = join(__dirname, "..", "..");
const CODE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const HASH = "f".repeat(64);
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();
const anHourAgo = () => new Date(Date.now() - 3600_000).toISOString();

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("http://enki.test/api/admin", { method: "POST", body: JSON.stringify(body) }));
const read = async () => ((await (await GET(new NextRequest("http://enki.test/api/admin"))).json()) as { trials: unknown });
const tables = () => db.current!.tables;
const create = (config: Record<string, unknown>, note?: string) => post({ resource: "trial", action: "create", note, config });
const GOOD = { maxUses: 5, accessMinutes: 60, expiresAt: null, budgetUsd: 2.5 };

beforeEach(() => {
  db.actor = "owner-1";
  db.current = fakePostgrest();
  const t = db.current.tables;
  t.moderation_policy = [{ id: 1, owner_user_id: "owner-1", council_enabled: false, quorum: 3, proposal_ttl_days: 7 }];
  t.users = [
    { id: "owner-1", role: "admin", handle: "kev" }, { id: "admin-2", role: "admin", handle: "other" },
    { id: "t1", role: "trial", handle: "tess" }, { id: "t2", role: "trial", handle: null },
    { id: "b1", role: "beta", handle: "member" }, { id: "t3", role: "trial" }, { id: "t4", role: "trial" },
  ];
  t.trial_codes = [];
  t.trial_redemptions = [];
  t.admin_actions = [];
  vi.mocked(newTrialCode).mockClear();
});

describe("reading the codes", () => {
  it("gives the owner each code with its testers, their handle and email, and never the hash", async () => {
    tables().trial_codes = [{
      id: CODE_ID, code_hash: HASH, note: "meetup", max_uses: null, uses: 2, access_minutes: 60, expires_at: null,
      budget_micro: "1000000", created_at: "2026-10-26T10:00:00.000Z", revoked_at: null, created_by: "owner-1",
    }];
    tables().trial_redemptions = [
      { code_id: CODE_ID, user_id: "t1", started_at: "2026-10-26T11:00:00.000Z", ends_at: "2026-10-26T12:00:00.000Z", spent_micro: "250000" },
      { code_id: CODE_ID, user_id: "t2", started_at: "2026-10-26T11:30:00.000Z", ends_at: "2026-10-26T12:30:00.000Z", spent_micro: 0 },
    ];
    tables().password_credentials = [{ user_id: "t1", email: "tess@password.example" }];
    tables().auth_identities = [
      { user_id: "t1", provider: "google", email: "tess@google.example" },
      { user_id: "t2", provider: "x", email: null },
      { user_id: "t2", provider: "google", email: "t2@google.example" },
    ];
    const body = await read();
    expect(body.trials).toEqual({
      ready: true,
      codes: [{
        id: CODE_ID, note: "meetup", maxUses: null, uses: 2, accessMinutes: 60, expiresAt: null, budgetMicro: 1_000_000,
        createdAt: "2026-10-26T10:00:00.000Z", revokedAt: null,
        testers: [
          { userId: "t1", handle: "tess", email: "tess@password.example", startedAt: "2026-10-26T11:00:00.000Z", endsAt: "2026-10-26T12:00:00.000Z", spentMicro: 250_000 },
          { userId: "t2", handle: null, email: "t2@google.example", startedAt: "2026-10-26T11:30:00.000Z", endsAt: "2026-10-26T12:30:00.000Z", spentMicro: 0 },
        ],
      }],
    });
    expect(JSON.stringify(body)).not.toMatch(/code_hash|fffffff/);
  });

  it("gives everyone else null: an admin who is not the owner, and anyone while no owner is set", async () => {
    db.actor = "admin-2";
    expect((await read()).trials).toBeNull();
    db.actor = "owner-1";
    tables().moderation_policy = [];
    expect((await read()).trials).toBeNull();
  });

  it("says not ready, with no codes, until the SQL ran", async () => {
    for (const code of ["PGRST205", "42P01"]) {
      db.current!.state.failing = { table: "trial_codes", code };
      expect((await read()).trials).toEqual({ ready: false, codes: [] });
    }
  });
});

describe("creating a code", () => {
  it("is the owner's alone, as is revoking one", async () => {
    db.actor = "admin-2";
    for (const res of [await create(GOOD), await post({ resource: "trial", action: "revoke", id: CODE_ID })]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Owner only" });
    }
    expect(tables().trial_codes).toEqual([]);
    expect(tables().admin_actions).toEqual([]);
  });

  it("answers a new code once and stores only its keyed hash, with the settings in micro-USDC", async () => {
    const res = await create(GOOD, "  Berlin meetup  ");
    expect(res.status).toBe(200);
    const { ok, code, id } = (await res.json()) as { ok: boolean; code: string; id: string };
    expect(newTrialCode).toHaveBeenCalledOnce();
    expect(code).toBe(vi.mocked(newTrialCode).mock.results[0].value);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(ok).toBe(true);
    const row = tables().trial_codes[0];
    expect(id).toBe(row.id);
    expect(row).toMatchObject({ code_hash: hashTrialCode(code), note: "Berlin meetup", max_uses: 5, access_minutes: 60, expires_at: null, budget_micro: 2_500_000, created_by: "owner-1" });
    expect(JSON.stringify(row)).not.toContain(code.replace(/-/g, "").slice(0, 8));
  });

  // trial_codes.note is NOT NULL DEFAULT '' (migrations/2026-10-26-trial-codes.sql): a code without a note writes
  // the empty one, never null, or its insert would fail on the live table (this fake has no NOT NULL).
  it("writes an empty note, not null, for a code without one", async () => {
    expect((await create(GOOD)).status).toBe(200);
    expect(tables().trial_codes[0].note).toBe("");
  });

  it("takes null as unlimited and refuses a count left out or out of range", async () => {
    expect((await create({ ...GOOD, maxUses: null })).status).toBe(200);
    expect(tables().trial_codes[0].max_uses).toBeNull();
    for (const maxUses of [undefined, 0, 100_001, 2.5, "5"]) expect((await create({ ...GOOD, maxUses })).status).toBe(400);
    expect((await create({ ...GOOD, maxUses: 100_000 })).status).toBe(200);
  });

  it("refuses minutes, budgets and expiries out of range, and keeps a future expiry as an instant", async () => {
    for (const accessMinutes of [4, 43_201, undefined]) expect((await create({ ...GOOD, accessMinutes })).status).toBe(400);
    for (const budgetUsd of [-0.01, 1000.01, 0.005, "1", undefined]) expect((await create({ ...GOOD, budgetUsd })).status).toBe(400);
    for (const expiresAt of [anHourAgo(), "", "soon", undefined]) expect((await create({ ...GOOD, expiresAt })).status).toBe(400);
    expect(tables().trial_codes).toEqual([]);
    const at = inAnHour();
    expect((await create({ ...GOOD, accessMinutes: 43_200, budgetUsd: 0, expiresAt: at })).status).toBe(200);
    expect(tables().trial_codes[0]).toMatchObject({ access_minutes: 43_200, budget_micro: 0, expires_at: at });
    expect((await create({ ...GOOD, budgetUsd: 1.1 })).status).toBe(200);
    expect(tables().trial_codes[1].budget_micro).toBe(1_100_000);
  });

  it("makes no code without the pepper its hash needs", async () => {
    const pepper = process.env.AUTH_PEPPER;
    delete process.env.AUTH_PEPPER;
    try {
      const res = await create(GOOD);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Trial codes need AUTH_PEPPER" });
    } finally {
      process.env.AUTH_PEPPER = pepper;
    }
    expect(tables().trial_codes).toEqual([]);
  });

  it("logs the settings, never the code or the note", async () => {
    const at = inAnHour();
    const { code } = (await (await create({ ...GOOD, expiresAt: at }, "Berlin meetup")).json()) as { code: string };
    const row = tables().admin_actions[0];
    expect(row).toMatchObject({ actor_id: "owner-1", action: "trial.create", target: null });
    expect(row.detail).toEqual({ config: { maxUses: 5, accessMinutes: 60, expiresAt: at, budgetUsd: 2.5 }, outcome: { httpStatus: 200 } });
    const logged = JSON.stringify(tables().admin_actions);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(code.replace(/-/g, ""));
    expect(logged).not.toContain("Berlin");
  });
});

describe("revoking a code", () => {
  beforeEach(() => {
    tables().trial_codes = [{ id: CODE_ID, revoked_at: null }, { id: OTHER_ID, revoked_at: null }];
    tables().trial_redemptions = [
      { id: "r1", code_id: CODE_ID, user_id: "t1", ends_at: inAnHour() },
      { id: "r2", code_id: CODE_ID, user_id: "b1", ends_at: inAnHour() },
      { id: "r3", code_id: CODE_ID, user_id: "t3", ends_at: anHourAgo() },
      { id: "r4", code_id: OTHER_ID, user_id: "t4", ends_at: inAnHour() },
    ];
    // t1 signed in with a wallet attached since (its session keyed by the address), b1 is on the list as well.
    tables().user_wallets = [{ user_id: "t1", address: "So1TesterWallet", removed_at: null }, { user_id: "b1", address: "So1MemberWallet", removed_at: null }];
    tables().auth_sessions = ["t1", "So1TesterWallet", "b1", "So1MemberWallet", "t3", "t4"].map((w) => ({ wallet_address: w }));
  });

  it("ends its running trials and signs out the testers it let in; a member of the access list keeps the session", async () => {
    const before = new Date().toISOString();
    const res = await post({ resource: "trial", action: "revoke", id: CODE_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [mine, other] = tables().trial_codes;
    expect(String(mine.revoked_at) >= before).toBe(true);
    expect(other.revoked_at).toBeNull();
    const ends = Object.fromEntries(tables().trial_redemptions.map((r) => [r.id, String(r.ends_at)]));
    expect(ends.r1).toBe(mine.revoked_at);
    expect(ends.r2).toBe(mine.revoked_at);
    expect(ends.r3 < before).toBe(true);
    expect(ends.r4 > String(mine.revoked_at)).toBe(true);
    // Both keys of a tester go (review 2026-10-26: a wallet-keyed session outlived the revoke); the member keeps both.
    expect(tables().auth_sessions.map((s) => s.wallet_address)).toEqual(["b1", "So1MemberWallet", "t3", "t4"]);
    expect(tables().admin_actions[0]).toMatchObject({ action: "trial.revoke", target: CODE_ID });
  });

  it("keeps the first revocation's time", async () => {
    tables().trial_codes[0].revoked_at = "2026-10-01T00:00:00.000Z";
    expect((await post({ resource: "trial", action: "revoke", id: CODE_ID })).status).toBe(200);
    expect(tables().trial_codes[0].revoked_at).toBe("2026-10-01T00:00:00.000Z");
  });

  it("refuses a bad id and an unknown one", async () => {
    expect((await post({ resource: "trial", action: "revoke", id: "nope" })).status).toBe(400);
    expect((await post({ resource: "trial", action: "revoke", id: "aaaaaaaa-0000-4000-8000-000000000009" })).status).toBe(404);
    expect(tables().auth_sessions).toHaveLength(6);
  });
});

describe("the source", () => {
  const API = readSource(join(ROOT, "app", "api", "admin", "route.ts"));
  const PAGE = readSource(join(ROOT, "app", "admin", "page.tsx"));
  const AUDIT = readSource(join(ROOT, "lib", "admin", "audit.ts"));

  it("reads the codes for the owner only, and makes each with newTrialCode, stored hashed", () => {
    expect(API).toContain("const trials = council.isOwner ? await buildTrials(supabase) : null;");
    expect(API).toContain('if (!pol?.owner_user_id || String(pol.owner_user_id) !== userId) return NextResponse.json({ error: "Owner only" }, { status: 403 });');
    expect(API).toContain("const code = newTrialCode();\n      const codeHash = hashTrialCode(code);");
    expect(API).toContain("code_hash: codeHash, note:");
    expect(API).toContain('.select("id, note, max_uses, uses, access_minutes, expires_at, budget_micro, created_at, revoked_at")');
  });

  it("keeps the code and the note out of the admin log's whitelists", () => {
    const list = (name: string) => AUDIT.match(new RegExp(`const ${name} = \\[([^\\]]*)\\] as const;`))?.[1] ?? "";
    for (const name of ["SETTINGS", "OUTCOME"]) {
      expect(list(name)).toContain('"status"');
      expect(list(name)).not.toMatch(/"(code|note|codeHash|code_hash)"/);
    }
  });

  it("shows the Trials tab only when the server sent trials, and sends unlimited as null with the note beside config", () => {
    expect(PAGE).toContain('(t.id !== "trials" || d.trials)');
    expect(PAGE).toContain('{tab === "trials" && d.trials && (!d.trials.ready ? (');
    expect(PAGE).toContain("sql-to-run/38-trial-codes.sql");
    expect(PAGE).toContain("maxUses: tr.unlimited ? null : Number(tr.uses) || 0,");
    expect(PAGE).toContain('await post({ resource: "trial", action: "create", note: tr.note.trim(), config }, "", (cur) => cur);');
    expect(PAGE).toContain("Shown once. Copy it now.");
    expect(PAGE).toContain("await navigator.clipboard.writeText(code);");
  });

  it("sizes the tab by the space it has: one column and cards below 640 px, labels above values below 360 px", () => {
    expect(PAGE).toContain(".trl{container-type:inline-size;container-name:trl}");
    expect(PAGE).toMatch(/@container trl \(max-width: 640px\)\{\n\s+\.trl-form\{grid-template-columns:minmax\(0,1fr\)\}\n\s+\.trl-table thead\{display:none\}/);
    expect(PAGE).toMatch(/@container trl \(max-width: 360px\)\{\n\s+\.trl-table td\{display:block;text-align:left\}/);
    expect(PAGE).toContain('<div className="trl">');
  });
});
