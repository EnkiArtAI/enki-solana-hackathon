import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID, createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Guardians remove a lost factor at once (Kev, 2026-11-07: "ok go for the guardians", "keine wartezeit, wir locken niemanden
 * der verifiziert wurde"). A signed-in owner names the factor; two confirmed guardians or more, by email or wallet, are asked;
 * the yes that reaches the owner's threshold (never below two) removes it, and every address of the owner hears. The real
 * routes and the real session lookup run; the database is a fake, the mail is captured, a wallet signs with a real ed25519 key.
 * Another account's rows stand first in every table a read could hit, its own ask running, and stay as they were.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
// A mail to one of these addresses does not go out.
const unsent = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string; subject: string; text: string }) => (unsent.has(m.to) ? { ok: false } : (mails.push(m), { ok: true })) }));
vi.mock("@simplewebauthn/server", async (orig) => ({
  ...(await orig<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: async () => ({ verified: true, registrationInfo: { credential: { id: "cred", publicKey: new Uint8Array(4), counter: 0, transports: [] } } }),
}));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
  process.env.NEXT_PUBLIC_SITE_ORIGIN = "https://enki.test";
});

import * as guardiansRoute from "../../app/api/auth/mfa/recovery/guardians/route";
import * as approveRoute from "../../app/api/recovery/approve/route";
import { POST as completeRoute } from "../../app/api/recovery/complete/route";
import { GET as status } from "../../app/api/auth/mfa/recovery/route";
import { POST as registerVerify } from "../../app/api/auth/passkey/register/verify/route";
import { setChallengeCookie } from "../webauthn";
import { guardianFactorMessage } from "../guardian-message";
import { RESET_ADVICE } from "../mfa";

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const SESSION = "sess";
const LOGIN = "owner@example.test";
const GOOGLE = "google@example.test";
const G1 = "g1@friends.test";
const G2 = "g2@friends.test";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const STRANGER = "99999999-9999-4999-8999-999999999999";
const SR = "88888888-8888-4888-8888-888888888888";
const STRANGER2 = "99999999-9999-4999-8999-999999999998";
const SR2 = "88888888-8888-4888-8888-888888888889";
const SG = ["77777777-7777-4777-8777-777777777771", "77777777-7777-4777-8777-777777777772"];
const strangerRows = () => ({
  users: [{ id: STRANGER, handle: "stranger" }],
  password_credentials: [{ user_id: STRANGER, email: "stranger-login@example.test", email_verified_at: "2026-10-01T00:00:00Z" }],
  auth_identities: [{ user_id: STRANGER, provider: "google", email: "stranger-google@example.test" }],
  mfa_factors: [{ id: randomUUID(), user_id: STRANGER, kind: "totp", secret_ct: "x", confirmed_at: "2026-10-07T00:00:00Z" }],
  webauthn_credentials: [{ id: randomUUID(), user_id: STRANGER, credential_id: "stranger", created_at: "2026-10-07T00:00:00Z" }],
  mfa_recovery_codes: [{ id: "stranger-code", user_id: STRANGER, code_hash: "stranger-hash", used_at: null }],
  recovery_guardians: SG.map((id, i) => ({ id, user_id: STRANGER, guardian_type: "email", value: `stranger-guardian-${i}@example.test`, status: "confirmed", invite_token: `st-${i}` })),
  // And a second account's running ask for passkeys: a new passkey's cancel with no account filter would close it.
  recovery_requests: [{ id: SR, user_id: STRANGER, status: "pending", factor: "totp", expires_at: FUTURE }, { id: SR2, user_id: STRANGER2, status: "pending", factor: "passkey", expires_at: FUTURE }],
  recovery_approvals: SG.map((guardian_id) => ({ request_id: SR, guardian_id, code_hash: sha("stranger-token"), approved_at: null })),
  recovery_settings: [{ user_id: STRANGER, threshold: 5 }],
});

let U = "";
const req = (url: string, body?: unknown, { token = SESSION as string | null, method = "POST", cookie = "" } = {}) => new NextRequest(`http://enki.test${url}`, {
  method,
  headers: { ...(token ? { "X-Session-Token": token } : {}), ...(cookie ? { cookie } : {}), "x-real-ip": randomUUID() },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const ask = (factor: unknown, token = SESSION) => guardiansRoute.POST(req("/api/auth/mfa/recovery/guardians", { factor }, { token }));
const withdraw = (token = SESSION) => guardiansRoute.DELETE(req("/api/auth/mfa/recovery/guardians", undefined, { token, method: "DELETE" }));
const yes = (requestId: string, guardianId: string, proof: Record<string, unknown>) => approveRoute.POST(req("/api/recovery/approve", { requestId, guardianId, ...proof }, { token: null }));
const info = (requestId: string, guardianId: string) => approveRoute.GET(req(`/api/recovery/approve?factor=${requestId}&g=${guardianId}`, undefined, { token: null, method: "GET" }));
const read = async () => (await status(new NextRequest("http://enki.test/api/auth/mfa/recovery", { headers: { "X-Session-Token": SESSION } }))).json() as Promise<Record<string, unknown>>;

const mine = () => db.tables.recovery_requests.filter((r) => r.user_id === U);
const askMails = () => mails.filter((m) => m.subject === "@kev asks for your help getting back into Enki Art");
const removedMails = () => mails.filter((m) => m.subject === "A factor was removed from your Enki account");
const factorKinds = () => db.tables.mfa_factors.filter((f) => f.user_id === U).map((f) => f.kind);
/** The ids and token in the link a guardian got by mail. */
const linkOf = (address: string) => {
  const m = /\/guardian\?factor=([\w-]+)&g=([\w-]+)&t=(\w+)/.exec(askMails().find((x) => x.to === address)!.text)!;
  return { requestId: m[1], guardianId: m[2], token: m[3] };
};
const guardian = (guardian_type: string, value: string, status = "confirmed") => {
  const id = randomUUID();
  db.tables.recovery_guardians.push({ id, user_id: U, guardian_type, value, status, invite_token: randomUUID() });
  return id;
};
const wallet = () => {
  const secret = ed25519.utils.randomPrivateKey();
  const address = new PublicKey(ed25519.getPublicKey(secret)).toBase58();
  return { address, sign: (message: string) => Buffer.from(ed25519.sign(new TextEncoder().encode(message), secret)).toString("base64") };
};
const asked = async (factor = "totp") => {
  const res = await ask(factor);
  expect(res.status).toBe(200);
  return (await res.json()) as { needed: number; emailed: number; wallets: { guardian: string; link: string }[] };
};

let seed: ReturnType<typeof strangerRows>;
beforeEach(() => {
  U = randomUUID();
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  seed = strangerRows();
  Object.assign(db.tables, structuredClone(seed), {
    auth_sessions: [{ token: SESSION, wallet_address: U, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() }],
    consumed_stepup_tokens: [], bans: [], user_wallets: [], mfa_recovery: [],
  });
  db.tables.users.push({ id: U, handle: "kev" });
  db.tables.password_credentials.push({ user_id: U, email: LOGIN, email_verified_at: "2026-10-01T00:00:00Z" });
  db.tables.auth_identities.push({ user_id: U, provider: "google", email: GOOGLE });
  db.tables.mfa_factors.push({ id: randomUUID(), user_id: U, kind: "totp", secret_ct: "x", confirmed_at: "2026-10-07T00:00:00Z" });
  db.state.failing = null;
  db.state.failNext = null;
  db.state.holdNext = null;
  mails.length = 0;
  unsent.clear();
});
afterEach(() => {
  expect(mails.filter((m) => m.to.startsWith("stranger"))).toEqual([]);
  for (const table of Object.keys(seed) as (keyof ReturnType<typeof strangerRows>)[]) {
    const ofStranger = (r: Record<string, unknown>) => r.user_id === STRANGER || r.user_id === STRANGER2 || r.id === STRANGER || r.id === "stranger-code" || r.request_id === SR;
    expect(db.tables[table].filter(ofStranger), table).toEqual(seed[table]);
  }
});

describe("asking the guardians", () => {
  it("needs two confirmed guardians by email or wallet: an authenticator, a phone, a pending or an unresponsive one do not count", async () => {
    guardian("email", G1);
    guardian("authenticator", "Authenticator app");
    guardian("phone", "+491701234567");
    guardian("email", G2, "pending");
    guardian("wallet", wallet().address, "unresponsive");
    const res = await ask("totp");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Asking your guardians needs two confirmed guardians or more, by email or wallet. Add them under Guardians." });
    expect(mine()).toEqual([]);
    expect(mails).toEqual([]);
  });

  it("asks each: email guardians get a link with their own token, wallet guardians' links come back, only hashes are stored, and every address of the owner hears", async () => {
    const g1 = guardian("email", G1);
    const g2 = guardian("email", G2);
    const w = wallet();
    const gw = guardian("wallet", w.address);
    const before = Date.now();
    const out = await asked();
    const [request] = mine();
    expect(request).toMatchObject({ status: "pending", factor: "totp" });
    expect(request.owner_key_hash ?? null).toBeNull();
    expect(Date.parse(String(request.expires_at)) - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(Date.parse(String(request.expires_at)) - before).toBeLessThanOrEqual(7 * 86_400_000 + 1000);
    expect(out).toEqual({ asked: true, needed: 2, emailed: 2, notReached: [], wallets: [{ guardian: `${w.address.slice(0, 6)}…${w.address.slice(-6)}`, link: `https://enki.test/guardian?factor=${request.id}&g=${gw}` }] });
    expect(askMails().map((m) => m.to)).toEqual([G1, G2]);
    const one = linkOf(G1);
    expect(one).toMatchObject({ requestId: request.id, guardianId: g1 });
    expect(linkOf(G2).guardianId).toBe(g2);
    expect(linkOf(G2).token).not.toBe(one.token);
    const rows = db.tables.recovery_approvals.filter((a) => a.request_id === request.id);
    expect(rows.map((r) => r.guardian_id)).toEqual([g1, g2, gw]);
    expect(rows[0].code_hash).toBe(sha(one.token));
    expect(JSON.stringify(rows)).not.toContain(one.token);
    const { text } = askMails()[0];
    expect(text).toContain("@kev named you as a recovery guardian on Enki Art and asks for your yes: they lost a security factor (their authenticator app).");
    expect(text).toContain("Your yes helps remove @kev's lost security factor so they can get into their money again. The moment 2 guardians say yes, it is removed.");
    expect(text).toContain("Only say yes if @kev asked you themselves, by phone or in person, not only by a message");
    expect(text).toContain("If they did not ask you themselves, do nothing: without your yes nothing changes, and the request ends in 7 days.");
    const owner = mails.filter((m) => m.subject === "Your guardians were asked to remove a factor from your Enki account");
    expect(owner.map((m) => m.to)).toEqual([LOGIN, GOOGLE]);
    expect(owner[0].text).toContain(`: g1…@friends.test, g2…@friends.test, ${w.address.slice(0, 6)}…${w.address.slice(-6)}. The moment 2 of them say yes, it is removed, with no wait.`);
    expect(owner[0].text).toContain(`withdraw it in Settings, Recovery, Lost a factor, tell your guardians not to say yes, and ${RESET_ADVICE}`);
    expect(owner[0].text).not.toContain("say no"); // the guardian's page has no "no", only "do nothing" (DEC-2026-11-07-33)
    expect(mails).toHaveLength(4);
  });

  // DEC-2026-11-07-32: a guardian whose mail did not go out has no link (only its token's hash is stored).
  it("an ask whose mails all failed is closed again, answers 502 and tells the owner nothing; a new one can go", async () => {
    guardian("email", G1);
    guardian("email", G2);
    unsent.add(G1);
    unsent.add(G2);
    const res = await ask("totp");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Your guardians' emails did not go out, so not enough of them could be asked. Nothing was asked. Try again in a minute." });
    expect(mine().map((r) => r.status)).toEqual(["cancelled"]);
    expect(mails).toEqual([]);
    expect((await read()).guardians).toMatchObject({ ask: null });
    unsent.clear();
    expect((await asked()).emailed).toBe(2);
  });

  it("fewer reached than must say yes is no ask either: one of two email guardians", async () => {
    guardian("email", G1);
    guardian("email", G2);
    unsent.add(G2);
    expect((await ask("totp")).status).toBe(502);
    expect(mine().map((r) => r.status)).toEqual(["cancelled"]);
    expect(mails.filter((m) => m.to === LOGIN || m.to === GOOGLE)).toEqual([]);
  });

  it("enough reached, a wallet guardian counting as reached: the ask stands, the answer names who was not, the owner hears only who was", async () => {
    guardian("email", G1);
    guardian("email", G2);
    const w = wallet();
    guardian("wallet", w.address);
    unsent.add(G2);
    const out = await asked();
    expect(out).toMatchObject({ needed: 2, emailed: 1, notReached: ["g2…@friends.test"] });
    expect(mine().map((r) => r.status)).toEqual(["pending"]);
    const owner = mails.filter((m) => m.subject === "Your guardians were asked to remove a factor from your Enki account");
    expect(owner.map((m) => m.to)).toEqual([LOGIN, GOOGLE]);
    expect(owner[0].text).toContain(`: g1…@friends.test, ${w.address.slice(0, 6)}…${w.address.slice(-6)}. The moment 2 of them say yes`);
  });

  it("one ask at a time; withdrawn, a new one can go; one past its 7 days blocks nothing and is closed", async () => {
    guardian("email", G1);
    guardian("email", G2);
    await asked();
    const again = await ask("totp");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "Your guardians were already asked. Withdraw that first to ask again." });
    expect(await (await withdraw()).json()).toEqual({ withdrawn: true });
    expect(mine().map((r) => r.status)).toEqual(["cancelled"]);
    expect((await withdraw()).status).toBe(404);
    await asked();
    mine()[1].expires_at = new Date(Date.now() - 1000).toISOString();
    await asked();
    expect(mine().map((r) => r.status)).toEqual(["cancelled", "expired", "pending"]);
  });

  it("withdrawing takes back the factor's ask only: a password reset the owner started stays", async () => {
    guardian("email", G1);
    guardian("email", G2);
    const reset = randomUUID();
    db.tables.recovery_requests.push({ id: reset, user_id: U, status: "pending", owner_key_hash: "k", expires_at: FUTURE });
    await asked();
    expect((await withdraw()).status).toBe(200);
    expect(mine().map((r) => [r.id === reset, r.status])).toEqual([[true, "pending"], [false, "cancelled"]]);
  });

  it("an ask that loses the race to another answers that one is open, and mails nobody", async () => {
    guardian("email", G1);
    guardian("email", G2);
    db.state.failNext = { table: "recovery_requests", op: "insert", code: "23505" };
    expect((await ask("totp")).status).toBe(409);
    expect(mails).toEqual([]);
  });

  it("approvals that cannot be written leave no ask behind and mail nobody", async () => {
    guardian("email", G1);
    guardian("email", G2);
    db.state.failNext = { table: "recovery_approvals", op: "insert", code: "XX000" };
    expect((await ask("totp")).status).toBe(500);
    expect(mine()).toEqual([]);
    expect(mails).toEqual([]);
  });

  it("five asks a day per account, refused ones included: a stolen session cannot flood the guardians", async () => {
    guardian("email", G1);
    guardian("email", G2);
    for (let i = 0; i < 5; i++) {
      expect((await ask("totp")).status).toBe(200);
      await withdraw();
    }
    expect((await ask("totp")).status).toBe(429);
    expect(askMails()).toHaveLength(10);
  });

  it("refuses a factor that is not set up, and needs a session", async () => {
    guardian("email", G1);
    guardian("email", G2);
    expect((await ask("passkey")).status).toBe(404);
    expect((await ask("totp", "nobody")).status).toBe(401);
    expect((await withdraw("nobody")).status).toBe(401);
    expect(mails).toEqual([]);
  });
});

describe("a guardian says yes", () => {
  const two = async () => {
    guardian("email", G1);
    guardian("email", G2);
    await asked();
    return [linkOf(G1), linkOf(G2)];
  };

  it("by the mail's link: counted, and nothing is removed until enough say yes", async () => {
    const [a] = await two();
    const res = await yes(a.requestId, a.guardianId, { token: a.token });
    expect(await res.json()).toEqual({ ok: true, approved: 1, needed: 2, done: false });
    expect(factorKinds()).toEqual(["totp"]);
    expect(removedMails()).toEqual([]);
    expect(await (await yes(a.requestId, a.guardianId, { token: a.token })).json()).toMatchObject({ approved: 1 });
  });

  it("the yes that reaches the number removes the factor at once, with the unused recovery codes, and every address of the owner hears", async () => {
    db.tables.mfa_recovery_codes.push({ id: randomUUID(), user_id: U, code_hash: "unused", used_at: null }, { id: randomUUID(), user_id: U, code_hash: "used", used_at: "2026-11-01T00:00:00Z" });
    const [a, b] = await two();
    await yes(a.requestId, a.guardianId, { token: a.token });
    const before = Date.now();
    const res = await yes(b.requestId, b.guardianId, { token: b.token });
    expect(await res.json()).toEqual({ ok: true, approved: 2, needed: 2, done: true });
    expect(factorKinds()).toEqual([]);
    expect(db.tables.mfa_recovery_codes.filter((c) => c.user_id === U).map((c) => c.code_hash)).toEqual(["used"]);
    expect(mine()[0].status).toBe("completed");
    expect(removedMails().map((m) => m.to)).toEqual([LOGIN, GOOGLE]);
    const { text } = removedMails()[0];
    expect(Date.parse(/account \((.+?)\):/.exec(text)![1])).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(text).toMatch(/^Your guardians removed your authenticator app from your Enki account \([^)]+\): 2 of them said yes\. /);
    expect(text).toContain("The recovery codes you had left stopped working too: the next factor you add comes with a new set.");
    expect(text).toContain(`If it was not, someone talked your guardians round and is using your session: ${RESET_ADVICE}`);
    const late = await yes(b.requestId, b.guardianId, { token: b.token });
    expect(late.status).toBe(400);
    expect(await late.json()).toEqual({ error: "This request is no longer open." });
  });

  it("a wrong token, another guardian's token or a token for another request counts nothing", async () => {
    const [a, b] = await two();
    for (const [id, g, token] of [[a.requestId, a.guardianId, "f".repeat(48)], [a.requestId, a.guardianId, b.token], [SR, SG[0], a.token], [a.requestId, a.guardianId, ""]]) {
      expect((await yes(id, g, { token })).status, `${g} ${token}`).not.toBe(200);
    }
    expect(db.tables.recovery_approvals.filter((r) => r.request_id === a.requestId && r.approved_at)).toEqual([]);
  });

  it("a wallet guardian says yes with a signature over this request; another wallet's, or one over another request, counts nothing", async () => {
    guardian("email", G1);
    const w = wallet();
    const gw = guardian("wallet", w.address);
    await asked();
    const id = String(mine()[0].id);
    const other = wallet();
    for (const signature of [other.sign(guardianFactorMessage(id)), w.sign(guardianFactorMessage(SR)), w.sign(`${guardianFactorMessage(id)} `)]) {
      const bad = await yes(id, gw, { signature });
      expect(bad.status).toBe(403);
    }
    expect(await (await yes(id, gw, { token: "anything" })).json()).toEqual({ error: "The signature doesn't match the guardian's wallet. Sign with the exact wallet that was invited." });
    expect(await (await yes(id, gw, { signature: w.sign(guardianFactorMessage(id)) })).json()).toEqual({ ok: true, approved: 1, needed: 2, done: false });
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("the number is the owner's threshold, never below two, never above the guardians who can be asked", async () => {
    for (const v of [G1, G2, "g3@friends.test"]) guardian("email", v);
    db.tables.recovery_settings.push({ user_id: U, threshold: 1 });
    expect((await asked()).needed).toBe(2);
    await withdraw();
    db.tables.recovery_settings.find((s) => s.user_id === U)!.threshold = 3;
    expect((await asked()).needed).toBe(3);
    await withdraw();
    guardian("phone", "+491701234567");
    guardian("authenticator", "Authenticator app");
    db.tables.recovery_settings.find((s) => s.user_id === U)!.threshold = 5;
    expect((await asked()).needed).toBe(3);
  });

  it("after the owner withdrew, or after 7 days, a yes counts nothing", async () => {
    const [a, b] = await two();
    await withdraw();
    expect((await yes(a.requestId, a.guardianId, { token: a.token })).status).toBe(400);
    mine()[0].status = "pending";
    mine()[0].expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await yes(b.requestId, b.guardianId, { token: b.token })).status).toBe(400);
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("a guardian removed since: their earlier yes no longer counts", async () => {
    guardian("email", "g3@friends.test");
    const [a, b] = await two();
    await yes(a.requestId, a.guardianId, { token: a.token });
    db.tables.recovery_guardians = db.tables.recovery_guardians.filter((g) => g.id !== a.guardianId);
    expect(await (await yes(b.requestId, b.guardianId, { token: b.token })).json()).toEqual({ ok: true, approved: 1, needed: 2, done: false });
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("a factor gone before the last yes: nothing to remove, the ask closes, and no removal is mailed", async () => {
    const [a, b] = await two();
    db.tables.mfa_factors = db.tables.mfa_factors.filter((f) => f.user_id !== U);
    db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: "mine", created_at: "2026-10-07T00:00:00Z" });
    await yes(a.requestId, a.guardianId, { token: a.token });
    expect((await yes(b.requestId, b.guardianId, { token: b.token })).status).toBe(200);
    expect(mine()[0].status).toBe("cancelled");
    expect(db.tables.webauthn_credentials.filter((c) => c.user_id === U)).toHaveLength(1);
    expect(removedMails()).toEqual([]);
  });

  it("a removal that fails brings the ask back, and the same yes removes it once it can", async () => {
    const [a, b] = await two();
    await yes(a.requestId, a.guardianId, { token: a.token });
    db.state.failNext = { table: "mfa_factors", op: "delete", code: "XX000" };
    expect((await yes(b.requestId, b.guardianId, { token: b.token })).status).toBe(500);
    expect(mine()[0].status).toBe("pending");
    expect(factorKinds()).toEqual(["totp"]);
    expect(removedMails()).toEqual([]);
    expect(await (await yes(b.requestId, b.guardianId, { token: b.token })).json()).toMatchObject({ done: true });
    expect(factorKinds()).toEqual([]);
  });

  it("an owner address list that cannot be read removes nothing", async () => {
    const [a, b] = await two();
    await yes(a.requestId, a.guardianId, { token: a.token });
    db.state.failNext = { table: "auth_identities", op: "select", code: "XX000" };
    expect((await yes(b.requestId, b.guardianId, { token: b.token })).status).toBe(500);
    expect(mine()[0].status).toBe("pending");
    expect(factorKinds()).toEqual(["totp"]);
  });

  it("two at the number at once remove once, and each address hears once", async () => {
    guardian("email", "g3@friends.test");
    const [a, b] = await two();
    const c = linkOf("g3@friends.test");
    const answers = await Promise.all([yes(a.requestId, a.guardianId, { token: a.token }), yes(b.requestId, b.guardianId, { token: b.token }), yes(c.requestId, c.guardianId, { token: c.token })]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(factorKinds()).toEqual([]);
    expect(removedMails()).toHaveLength(2);
  });

  it("a new factor of the named kind closes the ask: the guardians' yes must not remove the new one", async () => {
    db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: "first", created_at: "2026-10-07T00:00:00Z" });
    guardian("email", G1);
    guardian("email", G2);
    await asked("passkey");
    const issued = NextResponse.json({});
    setChallengeCookie(issued, "pk_reg_challenge", "challenge", U);
    const added = await registerVerify(req("/api/auth/passkey/register/verify", { response: { id: "cred" } }, { cookie: `pk_reg_challenge=${issued.cookies.get("pk_reg_challenge")!.value}` }));
    expect(added.status).toBe(200);
    expect(mine()[0].status).toBe("cancelled");
    const a = linkOf(G1);
    expect((await yes(a.requestId, a.guardianId, { token: a.token })).status).toBe(400);
    expect(db.tables.webauthn_credentials.filter((c) => c.user_id === U)).toHaveLength(2);
  });

  it("a new factor whose ask cannot be closed comes with no codes, and the ask still stands (DEC-2026-11-07-11 point 5)", async () => {
    db.tables.webauthn_credentials.push({ id: randomUUID(), user_id: U, credential_id: "first", created_at: "2026-10-07T00:00:00Z" });
    guardian("email", G1);
    guardian("email", G2);
    await asked("passkey");
    db.state.failNext = { table: "recovery_requests", op: "update", code: "XX000" };
    const issued = NextResponse.json({});
    setChallengeCookie(issued, "pk_reg_challenge", "challenge", U);
    const added = await registerVerify(req("/api/auth/passkey/register/verify", { response: { id: "cred" } }, { cookie: `pk_reg_challenge=${issued.cookies.get("pk_reg_challenge")!.value}` }));
    expect(added.status).toBe(200);
    expect(db.state.failNext).toBeNull();
    expect(await added.json()).toEqual({ verified: true });
    expect(mine()[0].status).toBe("pending");
    expect(db.tables.mfa_recovery_codes.filter((c) => c.user_id === U)).toEqual([]);
  });

  it("a guardian no longer confirmed: their yes answers not valid and writes nothing", async () => {
    const [a] = await two();
    db.tables.recovery_guardians.find((g) => g.id === a.guardianId)!.status = "unresponsive";
    const res = await yes(a.requestId, a.guardianId, { token: a.token });
    expect(res.status).toBe(404);
    expect(db.tables.recovery_approvals.filter((r) => r.request_id === a.requestId && r.approved_at)).toEqual([]);
  });

  it("twenty yeses and twenty reads a minute from one network, then 429, the right token included", async () => {
    const [a] = await two();
    const ip = randomUUID();
    const from = (method: string, body?: unknown) => new NextRequest(`http://enki.test/api/recovery/approve${method === "GET" ? `?factor=${a.requestId}&g=${a.guardianId}` : ""}`, {
      method, headers: { "x-real-ip": ip }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (let i = 0; i < 20; i++) expect((await approveRoute.POST(from("POST", { requestId: a.requestId, guardianId: a.guardianId, token: "f".repeat(48) }))).status).toBe(404);
    expect((await approveRoute.POST(from("POST", { requestId: a.requestId, guardianId: a.guardianId, token: a.token }))).status).toBe(429);
    expect(db.tables.recovery_approvals.filter((r) => r.request_id === a.requestId && r.approved_at)).toEqual([]);
    for (let i = 0; i < 20; i++) expect((await approveRoute.GET(from("GET"))).status).toBe(200);
    expect((await approveRoute.GET(from("GET"))).status).toBe(429);
  });

  it("the password reset's code path never counts or completes a factor's ask: it has no owner key", async () => {
    const [a] = await two();
    await yes(a.requestId, a.guardianId, { token: a.token });
    db.tables.recovery_settings.push({ user_id: U, threshold: 1 });
    const viaCode = await approveRoute.POST(req("/api/recovery/approve", { requestId: a.requestId, guardianId: a.guardianId, code: "1234567" }, { token: null }));
    expect(await viaCode.json()).toEqual({ error: "This recovery request isn't active" });
    const complete = await completeRoute(req("/api/recovery/complete", { requestId: a.requestId, ownerKey: "x".repeat(32), password: "a new password" }, { token: null }));
    expect(complete.status).toBe(400);
    expect(mine()[0].status).toBe("pending");
    expect(factorKinds()).toEqual(["totp"]);
  });
});

describe("what the guardian's page reads", () => {
  it("who asks and for what, and nothing for a link that is no ask", async () => {
    guardian("email", G1);
    guardian("email", G2);
    await asked();
    const a = linkOf(G1);
    expect(await (await info(a.requestId, a.guardianId)).json()).toEqual({ requesterHandle: "kev", factor: "authenticator app", guardianType: "email", maskedValue: "g1…@friends.test", alreadyApproved: false, open: true });
    await yes(a.requestId, a.guardianId, { token: a.token });
    expect(await (await info(a.requestId, a.guardianId)).json()).toMatchObject({ alreadyApproved: true });
    expect((await info(a.requestId, SG[0])).status).toBe(404);
    expect((await info(randomUUID(), a.guardianId)).status).toBe(404);
    expect((await info("not-an-id", a.guardianId)).status).toBe(404);
    const reset = randomUUID();
    db.tables.recovery_requests.push({ id: reset, user_id: U, status: "pending", owner_key_hash: "k", expires_at: FUTURE });
    db.tables.recovery_approvals.push({ request_id: reset, guardian_id: a.guardianId, code_hash: "c", approved_at: null });
    expect((await info(reset, a.guardianId)).status).toBe(404);
  });
});

describe("what Settings reads", () => {
  it("how many can be asked and must say yes, then the running ask with its wallet links and how many said yes", async () => {
    const g1 = guardian("email", G1);
    const w = wallet();
    const gw = guardian("wallet", w.address);
    expect((await read()).guardians).toEqual({ askable: 2, reachable: 2, total: 2, needed: 2, ask: null });
    await asked();
    const id = String(mine()[0].id);
    expect((await read()).guardians).toEqual({
      askable: 2, reachable: 2, total: 2, needed: 2,
      ask: { factor: "totp", approved: 0, needed: 2, expiresAt: mine()[0].expires_at, wallets: [{ guardian: `${w.address.slice(0, 6)}…${w.address.slice(-6)}`, link: `https://enki.test/guardian?factor=${id}&g=${gw}` }] },
    });
    await yes(id, g1, { token: linkOf(G1).token });
    expect(((await read()).guardians as { ask: { approved: number } }).ask.approved).toBe(1);
  });

  it("the ways back in: every guardian on the owner's list counts in the total, any type or status, another account's never; and every address", async () => {
    guardian("email", G1);
    guardian("wallet", wallet().address);
    guardian("email", G2, "pending");
    guardian("authenticator", "Authenticator app");
    guardian("wallet", wallet().address, "unresponsive");
    const out = await read();
    expect(out.guardians).toEqual({ askable: 2, reachable: 2, total: 5, needed: 2, ask: null });
    expect(out.addresses).toBe(2); // the login email and the Google account's
    db.tables.auth_identities = db.tables.auth_identities.filter((r) => r.user_id !== U);
    expect((await read()).addresses).toBe(1);
  });

  it("a guardians list that cannot be read is no total of zero", async () => {
    guardian("email", G1);
    guardian("email", G2);
    db.state.failNext = { table: "recovery_guardians", op: "select", code: "XX000", skip: 1 };
    const res = await status(new NextRequest("http://enki.test/api/auth/mfa/recovery", { headers: { "X-Session-Token": SESSION } }));
    expect(res.status).toBe(500);
  });

  it("before SQL 74 ran, the ask answers not available, and so does a guardian's yes", async () => {
    guardian("email", G1);
    guardian("email", G2);
    db.state.failNext = { table: "recovery_requests", op: "select", code: "42703" };
    const res = await ask("totp");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "This is not available yet" });
    db.state.failNext = { table: "recovery_requests", op: "select", code: "42703" };
    expect((await yes(SR, SG[0], { token: "t" })).status).toBe(503);
    expect(mails).toEqual([]);
  });
});
