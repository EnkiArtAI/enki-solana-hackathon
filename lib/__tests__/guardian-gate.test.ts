import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";

/**
 * Guardians now remove a lost factor at once (DEC-2026-11-07-11), so a guardian planted by a stolen session would be a way to
 * strip the owner's factors. With a factor in place, every action of the owner that makes or reopens a guardian asks every
 * factor, as a factor's removal does: adding one, lowering the threshold, and a re-invite, which mails a pending or unresponsive
 * guardian a fresh invite. The real route, the real session lookup and the real step-up check run; the database is a fake.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string; subject: string; text: string }) => { mails.push(m); return { ok: true }; } }));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { GET as listGuardians, POST as addGuardian, PATCH as setThreshold } from "../../app/api/recovery/guardians/route";
import { POST as confirmGuardian } from "../../app/api/recovery/guardians/confirm/route";
import { mintStepUpToken } from "../webauthn";

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const STRANGER = "99999999-9999-4999-8999-999999999999";
const STRANGER_GUARDIAN = { id: "stranger-guardian", user_id: STRANGER, guardian_type: "email", value: "stranger-guardian@example.test", status: "pending", invite_token: "stranger-invite", reminder_count: 3 };
let U = "";
const req = (method: string, body: unknown, tokens: string[] = []) => new NextRequest("http://enki.test/api/recovery/guardians", {
  method,
  headers: { "X-Session-Token": "s", "x-real-ip": randomUUID(), ...(tokens.length ? { "X-StepUp-Token": tokens.join(",") } : {}) },
  body: JSON.stringify(body),
});
const every = async () => [await mintStepUpToken(U, "guardians", "totp"), await mintStepUpToken(U, "guardians", "passkey")];
const planted = () => {
  const id = randomUUID();
  db.tables.recovery_guardians.push({ id, user_id: U, guardian_type: "email", value: "planted@evil.test", status: "unresponsive", invite_token: "old-invite", reminder_count: 3 });
  return id;
};
const twoFactors = () => {
  db.tables.mfa_factors.push({ id: randomUUID(), user_id: U, kind: "totp", secret_ct: "x", confirmed_at: "2026-10-07T00:00:00Z" });
  db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: "mine", created_at: "2026-10-07T00:00:00Z" });
};

beforeEach(() => {
  U = randomUUID();
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  Object.assign(db.tables, {
    auth_sessions: [{ token: "s", wallet_address: U, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() }],
    users: [{ id: U, handle: "kev" }],
    password_credentials: [{ user_id: U, email: "owner@example.test", email_verified_at: "2026-10-01T00:00:00Z" }],
    mfa_factors: [], webauthn_credentials: [], consumed_stepup_tokens: [], bans: [], user_wallets: [], recovery_settings: [],
    recovery_guardians: [{ ...STRANGER_GUARDIAN }],
  });
  mails.length = 0;
});
afterEach(() => {
  expect(db.tables.recovery_guardians.filter((g) => g.user_id === STRANGER)).toEqual([STRANGER_GUARDIAN]);
  expect(mails.filter((m) => m.to.startsWith("stranger"))).toEqual([]);
});

describe("with a factor, every factor makes or reopens a guardian", () => {
  it("adding one: a single factor of two is not enough", async () => {
    twoFactors();
    const one = await addGuardian(req("POST", { guardianType: "email", value: "friend@example.test" }, [await mintStepUpToken(U, "guardians", "totp")]));
    expect(one.status).toBe(401);
    expect(await one.json()).toMatchObject({ all: true, missing: ["passkey"] });
    expect(db.tables.recovery_guardians.filter((g) => g.user_id === U)).toEqual([]);
    expect((await addGuardian(req("POST", { guardianType: "email", value: "friend@example.test" }, await every()))).status).toBe(201);
  });

  it("lowering the threshold: the same", async () => {
    twoFactors();
    expect((await setThreshold(req("PATCH", { threshold: 2 }, [await mintStepUpToken(U, "guardians", "passkey")]))).status).toBe(401);
    expect((await setThreshold(req("PATCH", { threshold: 2 }, await every()))).status).toBe(200);
  });

  it("a re-invite: it mails a guardian who never confirmed a fresh invite, so it asks every factor and changes nothing without them", async () => {
    twoFactors();
    const id = planted();
    for (const tokens of [[], [await mintStepUpToken(U, "guardians", "totp")]]) {
      const res = await addGuardian(req("POST", { reinviteId: id }, tokens));
      expect(res.status).toBe(401);
    }
    expect(db.tables.recovery_guardians.find((g) => g.id === id)).toMatchObject({ status: "unresponsive", invite_token: "old-invite" });
    expect(mails).toEqual([]);
    const res = await addGuardian(req("POST", { reinviteId: id }, await every()));
    expect(res.status).toBe(200);
    expect(db.tables.recovery_guardians.find((g) => g.id === id)).toMatchObject({ status: "pending", reminder_count: 0 });
    expect(mails.map((m) => m.to)).toEqual(["planted@evil.test"]);
  });
});

describe("without a factor", () => {
  it("a re-invite goes as before", async () => {
    const id = planted();
    expect((await addGuardian(req("POST", { reinviteId: id }))).status).toBe(200);
    expect(mails.map((m) => m.to)).toEqual(["planted@evil.test"]);
  });
});

// An email guardian confirms by holding the invite link alone (app/api/recovery/guardians/confirm), so the link travels only to
// that inbox: a session with no factor that read it could confirm a guardian who never agreed (DEC-2026-11-07-28).
describe("a session alone confirms no email guardian", () => {
  const pending = () => {
    db.tables.recovery_guardians.push(
      { id: randomUUID(), user_id: U, guardian_type: "email", value: "friend@example.test", status: "pending", invite_token: "friend-invite", reminder_count: 0 },
      { id: randomUUID(), user_id: U, guardian_type: "wallet", value: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", status: "pending", invite_token: "wallet-invite", reminder_count: 0 },
      { id: randomUUID(), user_id: U, guardian_type: "wallet", value: "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", status: "confirmed", invite_token: "confirmed-invite", reminder_count: 0 },
    );
  };
  const list = async () => (await listGuardians(new NextRequest("http://enki.test/api/recovery/guardians", { headers: { "X-Session-Token": "s" } }))).json() as Promise<{ guardians: { guardianType: string; inviteToken: string | null }[] }>;

  it("the list carries no email guardian's invite token, only a wallet guardian's, whose confirm needs that wallet's signature", async () => {
    twoFactors();
    pending();
    const out = await list();
    // What a stolen session with no factor would do: post each token the list gives to the public confirm route.
    for (const g of out.guardians) {
      await confirmGuardian(new NextRequest("http://enki.test/api/recovery/guardians/confirm", { method: "POST", headers: { "x-real-ip": randomUUID() }, body: JSON.stringify({ token: g.inviteToken ?? "" }) }));
    }
    expect(db.tables.recovery_guardians.filter((g) => g.user_id === U).map((g) => g.status)).toEqual(["pending", "pending", "confirmed"]);
    expect(out.guardians.map((g) => [g.guardianType, g.inviteToken])).toEqual([["email", null], ["wallet", "wallet-invite"], ["wallet", null]]);
    expect(JSON.stringify(out)).not.toContain("friend-invite");
  });

  it("nor does adding one or re-inviting one: the invite goes to the guardian's inbox", async () => {
    const added = await addGuardian(req("POST", { guardianType: "email", value: "friend@example.test" }));
    expect(added.status).toBe(201);
    expect(((await added.json()) as { guardian: { inviteToken: string | null } }).guardian.inviteToken).toBeNull();
    const id = planted();
    const again = await addGuardian(req("POST", { reinviteId: id }));
    expect(((await again.json()) as { guardian: { inviteToken: string | null } }).guardian.inviteToken).toBeNull();
    expect(mails.map((m) => m.to)).toEqual(["friend@example.test", "planted@evil.test"]);
  });

  it("Settings offers Copy link only for a wallet guardian", () => {
    const panel = readSource(join(__dirname, "..", "..", "components", "settings", "RecoveryPanel.tsx"));
    expect(panel).toContain('{g.status === "pending" && g.guardianType === "wallet" && (\n                  <button className="set-btn set-btn-outline" onClick={() => copyInvite(g)}>Copy link</button>');
  });
});

describe("Settings", () => {
  it("re-invites through the step-up the other guardian changes use", () => {
    const panel = readSource(join(__dirname, "..", "..", "components", "settings", "use-guardians.ts"));
    const reInvite = /const reInvite = async \(id: string\) => \{([\s\S]*?)\n  \};/.exec(panel)![1];
    expect(reInvite).toContain('guarded("guardians", (h) => fetch("/api/recovery/guardians", {');
    expect(reInvite).toContain("...sessionAuthHeaders(), ...h");
  });

  // DEC-2026-11-08-41: the list moved into the hook, its read is still started by the panel's mount effect, signed in.
  it("the panel starts the guardians' read with its passkeys', from the hook", () => {
    const panel = readSource(join(__dirname, "..", "..", "components", "settings", "RecoveryPanel.tsx"));
    expect(panel).toContain("guardians, setGuardians, loadGuardians, threshold,");
    expect(panel).toContain("} = useGuardians();");
    // Signed out, the guardians clear with the passkeys, as before FE-5a (DEC-2026-11-08-44).
    expect(panel).toMatch(/if \(!authed\) \{ setPasskeys\(\[\]\); setGuardians\(\[\]\); return; \}\n\s+loadPasskeys\(\);\n\s+loadGuardians\(\);\n\s+\}, \[authed, loadPasskeys, loadGuardians\]\);/);
    const hook = readSource(join(__dirname, "..", "..", "components", "settings", "use-guardians.ts"));
    expect(hook).toMatch(/const loadGuardians = useCallback\(async \(\) => \{\n\s+try \{\n\s+const res = await fetch\("\/api\/recovery\/guardians", \{ headers: sessionAuthHeaders\(\) \}\);/);
    expect(hook).toMatch(/\} catch \{ setGuardians\(\[\]\); \}\n\s+refreshRecoveryStatus\(\);/);
  });
});
