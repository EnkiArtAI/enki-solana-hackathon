import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";

/**
 * The yearly check of each guardian (Kev, 2026-11-07: "jährlichen check dann einbauen"). The real cron route, the real public
 * confirm route, the real approve route, the real Settings reads and the real session lookup run; the database is a fake, the
 * mail is captured, a wallet signs with a real ed25519 key. Another account's guardians stand first in recovery_guardians, one
 * of them with an open check, and stay as they were; no mail reaches that account.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[], failTo: null as string | null }));
vi.mock("@/lib/mailer", () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    if (m.to === mail.failTo) return { ok: false };
    mail.sent.push(m);
    return { ok: true };
  },
}));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
  process.env.NEXT_PUBLIC_SITE_ORIGIN = "https://enki.test";
});

import { GET as cron } from "../../app/api/cron/guardian-check/route";
import * as confirmRoute from "../../app/api/recovery/guardians/confirm/route";
import * as approveRoute from "../../app/api/recovery/approve/route";
import { GET as guardiansList } from "../../app/api/recovery/guardians/route";
import { GET as status } from "../../app/api/auth/mfa/recovery/route";
import { POST as askRoute } from "../../app/api/auth/mfa/recovery/guardians/route";
import { guardianCheckMessage } from "../guardian-message";
import { ANSWER_WITHIN_MS, ASKS_PER_RUN, CHECK_EVERY_MS, CHECK_NOT_READY } from "../recovery/guardian-check";

const DAY = 24 * 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const SESSION = "sess";
const LOGIN = "owner@example.test";
const GOOGLE = "google@example.test";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const STRANGER = "99999999-9999-4999-8999-999999999999";
const SG = ["77777777-7777-4777-8777-777777777771", "77777777-7777-4777-8777-777777777772"];
const strangerRows = () => ({
  users: [{ id: STRANGER, handle: "stranger", deleted_at: null }],
  password_credentials: [{ user_id: STRANGER, email: "stranger-login@example.test", email_verified_at: "2026-10-01T00:00:00Z" }],
  recovery_guardians: [
    { id: SG[0], user_id: STRANGER, guardian_type: "email", value: "stranger-g0@example.test", status: "confirmed", confirmed_at: ago(30 * DAY), created_at: ago(30 * DAY), checked_at: null, check_sent_at: null, check_token_hash: null, unreachable_at: null, invite_token: "st-0" },
    { id: SG[1], user_id: STRANGER, guardian_type: "email", value: "stranger-g1@example.test", status: "confirmed", confirmed_at: ago(400 * DAY), created_at: ago(400 * DAY), checked_at: null, check_sent_at: ago(3 * DAY), check_token_hash: sha("stranger-token"), unreachable_at: null, invite_token: "st-1" },
  ],
});

let U = "";
let seed: ReturnType<typeof strangerRows>;
const guardian = (guardian_type: string, value: string, more: Record<string, unknown> = {}) => {
  const id = randomUUID();
  db.tables.recovery_guardians.push({
    id, user_id: U, guardian_type, value, status: "confirmed", confirmed_at: ago(400 * DAY), created_at: ago(400 * DAY),
    checked_at: null, check_sent_at: null, check_token_hash: null, unreachable_at: null, invite_token: randomUUID(), ...more,
  });
  return id;
};
const row = (id: string) => db.tables.recovery_guardians.find((g) => g.id === id)!;
const wallet = () => {
  const secret = ed25519.utils.randomPrivateKey();
  const address = new PublicKey(ed25519.getPublicKey(secret)).toBase58();
  return { address, sign: (message: string) => Buffer.from(ed25519.sign(new TextEncoder().encode(message), secret)).toString("base64") };
};
const run = (auth = "Bearer cron-test") => cron(new NextRequest("http://enki.test/api/cron/guardian-check", { headers: { authorization: auth } }));
const pub = (url: string, body?: unknown) => new NextRequest(`http://enki.test${url}`, {
  method: body === undefined ? "GET" : "POST", headers: { "x-real-ip": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const info = (id: string, t?: string) => confirmRoute.GET(pub(`/api/recovery/guardians/confirm?check=${id}${t ? `&t=${t}` : ""}`));
const answer = (body: Record<string, unknown>) => confirmRoute.POST(pub("/api/recovery/guardians/confirm", body));
const own = (path: string) => new NextRequest(`http://enki.test${path}`, { headers: { "X-Session-Token": SESSION, "x-real-ip": randomUUID() } });
/** The token in the check link an email guardian got. */
const tokenOf = (address: string) => {
  const m = /\/guardian\?check=([\w-]+)&t=(\w+)/.exec(mail.sent.find((x) => x.to === address)!.text)!;
  return { id: m[1], token: m[2] };
};
const ownerMails = (subject: string) => mail.sent.filter((m) => m.subject === subject);
const WALLET_SUBJECT = "Send your wallet guardians their yearly check";
const GONE_SUBJECT = "A guardian of your Enki account could not be reached";

beforeEach(() => {
  U = randomUUID();
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  seed = strangerRows();
  Object.assign(db.tables, structuredClone(seed), {
    auth_sessions: [{ token: SESSION, wallet_address: U, wallet_type: "password", expires_at: FUTURE, created_at: new Date().toISOString() }],
    auth_identities: [], mfa_factors: [], webauthn_credentials: [], mfa_recovery_codes: [], mfa_recovery: [], consumed_stepup_tokens: [],
    bans: [], user_wallets: [], recovery_requests: [], recovery_approvals: [], recovery_settings: [],
  });
  db.tables.users.push({ id: U, handle: "kev", deleted_at: null });
  db.tables.password_credentials.push({ user_id: U, email: LOGIN, email_verified_at: "2026-10-01T00:00:00Z" });
  db.tables.auth_identities.push({ user_id: U, provider: "google", email: GOOGLE });
  db.state.failing = null;
  db.state.failNext = null;
  db.state.holdNext = null;
  mail.sent.length = 0;
  mail.failTo = null;
  vi.stubEnv("CRON_SECRET", "cron-test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  expect(mail.sent.filter((m) => m.to.startsWith("stranger"))).toEqual([]);
  for (const table of Object.keys(seed) as (keyof ReturnType<typeof strangerRows>)[]) {
    expect(db.tables[table].filter((r) => r.user_id === STRANGER || r.id === STRANGER), table).toEqual(seed[table]);
  }
});

describe("the daily cron asks the guardians who are due", () => {
  it("asks an email guardian a year after their confirmation: a link with its own token, only its hash stored", async () => {
    const g = guardian("email", "g1@friends.test");
    guardian("email", "young@friends.test", { confirmed_at: ago(100 * DAY), created_at: ago(100 * DAY) });
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, asked: 1, failed: 0, unreachable: 0 });
    expect(mail.sent.map((m) => m.to)).toEqual(["g1@friends.test"]);
    const m = mail.sent[0];
    expect(m.subject).toBe("Still there? A yearly check for @kev's recovery guardians");
    expect(m.text).toBe(`@kev named you as a recovery guardian on Enki Art. Once a year we check that every guardian can still be reached. One click tells us you can:\n\nhttps://enki.test/guardian?check=${g}&t=${tokenOf("g1@friends.test").token}\n\n` +
      "It moves no money and approves nothing. If you do not answer within 14 days, @kev is told you could not be reached and can pick someone else.");
    const { token } = tokenOf("g1@friends.test");
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(row(g).check_token_hash).toBe(sha(token));
    expect(JSON.stringify(db.tables.recovery_guardians)).not.toContain(token);
    expect(Date.parse(String(row(g).check_sent_at))).toBeGreaterThan(Date.now() - 60_000);
    // The next day: open already, nothing again.
    mail.sent.length = 0;
    expect(await (await run()).json()).toEqual({ ready: true, asked: 0, failed: 0, unreachable: 0 });
    expect(mail.sent).toEqual([]);
  });

  it("counts the year from the last answer, then the confirmation, then the invite", async () => {
    guardian("email", "answered@friends.test", { checked_at: ago(200 * DAY) });
    guardian("email", "invited@friends.test", { confirmed_at: null, created_at: ago(366 * DAY) });
    guardian("email", "edge@friends.test", { confirmed_at: ago(CHECK_EVERY_MS - DAY), created_at: ago(CHECK_EVERY_MS - DAY) });
    await run();
    expect(mail.sent.map((m) => m.to)).toEqual(["invited@friends.test"]);
  });

  it("never asks or marks a pending, unresponsive, authenticator or phone guardian", async () => {
    guardian("email", "p@friends.test", { status: "pending" });
    const u = guardian("email", "u@friends.test", { status: "unresponsive", check_sent_at: ago(20 * DAY) });
    guardian("authenticator", "Authenticator app");
    guardian("phone", "+491701234567");
    expect(await (await run()).json()).toEqual({ ready: true, asked: 0, failed: 0, unreachable: 0 });
    expect(mail.sent).toEqual([]);
    expect(row(u).unreachable_at).toBeNull();
  });

  it("a wallet guardian's link goes to every address of the owner, to send; it carries no token", async () => {
    const w = wallet();
    const g = guardian("wallet", w.address);
    await run();
    const sent = ownerMails(WALLET_SUBJECT);
    expect(sent.map((m) => m.to).sort()).toEqual([GOOGLE, LOGIN]);
    expect(sent[0].text).toBe("Once a year we check that your guardians on Enki Art can still be reached. We cannot write to a wallet, so send each wallet guardian their link yourself. They open it and sign with that wallet:\n\n" +
      `${w.address.slice(0, 6)}…${w.address.slice(-6)}: https://enki.test/guardian?check=${g}\n\n` +
      "No answer within 14 days and Settings, Recovery, Guardians shows them as not reachable. Each link is there too: Copy check link.");
    expect(row(g).check_token_hash).toBeNull();
    expect(row(g).check_sent_at).not.toBeNull();
  });

  it("an email that could not be sent closes its check again, turns the run red, and is due the next day", async () => {
    const g = guardian("email", "g1@friends.test");
    mail.failTo = "g1@friends.test";
    const res = await run();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ready: true, asked: 0, failed: 1, unreachable: 0 });
    expect(row(g).check_sent_at).toBeNull();
    expect(row(g).check_token_hash).toBeNull();
    mail.failTo = null;
    await run();
    expect(mail.sent.map((m) => m.to)).toEqual(["g1@friends.test"]);
  });

  it("leaves a deleted owner's guardians alone: neither asked nor, with a check open 20 days, marked", async () => {
    guardian("email", "g1@friends.test");
    const open = guardian("email", "late@friends.test", { check_sent_at: ago(20 * DAY), check_token_hash: sha("t1") });
    db.tables.users.find((u) => u.id === U)!.deleted_at = ago(DAY);
    expect(await (await run()).json()).toEqual({ ready: true, asked: 0, failed: 0, unreachable: 0 });
    expect(row(open).unreachable_at).toBeNull();
    expect(mail.sent).toEqual([]);
  });

  // Account deletion keeps recovery_guardians (app/api/account/delete/route.ts softDelete), and such a guardian is never asked,
  // so it stays due: it must not take a slot under the cap (DEC-2026-11-07-35).
  it(`a deleted owner's ${ASKS_PER_RUN} due guardians, first in the table, leave a live owner's guardian its ask on the first run`, async () => {
    const gone = randomUUID();
    db.tables.users.push({ id: gone, handle: "gone", deleted_at: ago(DAY) });
    db.tables.recovery_guardians.unshift(...Array.from({ length: ASKS_PER_RUN }, (_, i) => ({
      id: randomUUID(), user_id: gone, guardian_type: "email", value: `gone-${i}@friends.test`, status: "confirmed", confirmed_at: ago(400 * DAY), created_at: ago(400 * DAY),
      checked_at: null, check_sent_at: null, check_token_hash: null, unreachable_at: null,
    })));
    guardian("email", "live@friends.test");
    expect(await (await run()).json()).toEqual({ ready: true, asked: 1, failed: 0, unreachable: 0 });
    expect(mail.sent.map((m) => m.to)).toEqual(["live@friends.test"]);
    expect(db.tables.recovery_guardians.filter((g) => g.user_id === gone).every((g) => !g.check_sent_at)).toBe(true);
  });

  it(`asks at most ${ASKS_PER_RUN} a run; the rest the next day`, async () => {
    for (let i = 0; i < ASKS_PER_RUN + 1; i++) guardian("email", `g${i}@friends.test`);
    expect(((await (await run()).json()) as { asked: number }).asked).toBe(ASKS_PER_RUN);
    expect(((await (await run()).json()) as { asked: number }).asked).toBe(1);
  });

  it("of two runs at once, one asks", async () => {
    guardian("email", "g1@friends.test");
    let release!: () => void;
    db.state.holdNext = { table: "recovery_guardians", until: new Promise<void>((r) => { release = r; }), skip: 1 }; // the claim of the first run
    const first = run();
    await new Promise((r) => setTimeout(r, 20));
    const second = await run();
    release();
    await first;
    expect(((await second.json()) as { asked: number }).asked + ((await (await first).json()) as { asked: number }).asked).toBe(1);
    expect(mail.sent.map((m) => m.to)).toEqual(["g1@friends.test"]);
  });

  it("before SQL 75 ran it reads nothing more, sends nothing and says why", async () => {
    guardian("email", "g1@friends.test");
    db.state.failNext = { table: "recovery_guardians", op: "select", code: "42703" };
    const res = await run();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: CHECK_NOT_READY });
    expect(CHECK_NOT_READY).toBe("The yearly guardian check is not available yet: SQL 75 (75-guardian-check.sql) has not run.");
    expect(mail.sent).toEqual([]);
  });

  it("needs the cron secret", async () => {
    guardian("email", "g1@friends.test");
    expect((await run("Bearer wrong")).status).toBe(401);
    expect(mail.sent).toEqual([]);
  });

  it("is scheduled daily", () => {
    const crons = JSON.parse(readFileSync(join(__dirname, "..", "..", "vercel.json"), "utf8")).crons as { path: string; schedule: string }[];
    expect(crons.find((c) => c.path === "/api/cron/guardian-check")?.schedule).toBe("41 9 * * *");
  });
});

describe("no answer within 14 days", () => {
  it("marks the guardian not reachable and tells every address of the owner once; 13 days is not yet", async () => {
    const late = guardian("email", "late@friends.test", { check_sent_at: ago(ANSWER_WITHIN_MS + 60_000), check_token_hash: sha("t1") });
    const fresh = guardian("email", "fresh@friends.test", { check_sent_at: ago(13 * DAY), check_token_hash: sha("t2") });
    expect(await (await run()).json()).toEqual({ ready: true, asked: 0, failed: 0, unreachable: 1 });
    expect(row(late).unreachable_at).not.toBeNull();
    expect(row(late).check_sent_at).not.toBeNull(); // the link still works: a late answer counts
    expect(row(fresh).unreachable_at).toBeNull();
    const sent = ownerMails(GONE_SUBJECT);
    expect(sent.map((m) => m.to).sort()).toEqual([GOOGLE, LOGIN]);
    expect(sent[0].text).toBe("la…@friends.test did not answer the yearly check within 14 days, so Settings, Recovery, Guardians shows this guardian as not reachable. " +
      "If you lose a security factor, guardians you cannot reach may leave you without a way back. They are still asked and their yes still counts, but replace them: add another guardian in Settings (that asks for every factor you have), then remove the one not reachable. If they answer later, they count as reachable again.");
    mail.sent.length = 0;
    expect(await (await run()).json()).toEqual({ ready: true, asked: 0, failed: 0, unreachable: 0 });
    expect(mail.sent).toEqual([]);
  });

  // DEC-2026-11-07-33: Enki cannot write to a wallet, so a wallet guardian saw the check only if the owner sent its link.
  it("a wallet guardian not reachable: the mail first names the step that fixes it, sending the check link, with the email guardian beside it", async () => {
    const w = wallet();
    guardian("wallet", w.address, { check_sent_at: ago(15 * DAY) });
    guardian("email", "late@friends.test", { check_sent_at: ago(15 * DAY), check_token_hash: sha("t1") });
    expect(await (await run()).json()).toMatchObject({ unreachable: 2 });
    const masked = `${w.address.slice(0, 6)}…${w.address.slice(-6)}`;
    expect(ownerMails(GONE_SUBJECT)[0].text).toBe(`${masked}, la…@friends.test did not answer the yearly check within 14 days, so Settings, Recovery, Guardians shows these guardians as not reachable. ` +
      `We cannot write to a wallet, so ${masked} saw the check only if you sent its link: send it now (Settings, Recovery, Guardians, Copy check link), or replace them as below. ` +
      "If you lose a security factor, guardians you cannot reach may leave you without a way back. They are still asked and their yes still counts, but replace them: add another guardian in Settings (that asks for every factor you have), then remove the one not reachable. If they answer later, they count as reachable again.");
  });

  it("each owner hears only of their own guardians", async () => {
    guardian("email", "late@friends.test", { check_sent_at: ago(15 * DAY) });
    const other = randomUUID();
    db.tables.users.push({ id: other, handle: "other", deleted_at: null });
    db.tables.password_credentials.push({ user_id: other, email: "other@example.test", email_verified_at: "2026-10-01T00:00:00Z" });
    db.tables.recovery_guardians.push({ id: randomUUID(), user_id: other, guardian_type: "email", value: "theirs@friends.test", status: "confirmed", confirmed_at: ago(400 * DAY), created_at: ago(400 * DAY), check_sent_at: ago(15 * DAY), unreachable_at: null });
    await run();
    const sent = ownerMails(GONE_SUBJECT);
    expect(sent.find((m) => m.to === "other@example.test")!.text).toContain("th…@friends.test");
    expect(sent.find((m) => m.to === "other@example.test")!.text).not.toContain("la…@friends.test");
    expect(sent.find((m) => m.to === LOGIN)!.text).not.toContain("th…@friends.test");
  });
});

describe("the guardian answers", () => {
  it("an email guardian's link shows who asks, and one click stamps them reachable; the link then is spent", async () => {
    const g = guardian("email", "g1@friends.test");
    await run();
    const { token } = tokenOf("g1@friends.test");
    expect(await (await info(g, token)).json()).toEqual({ requesterHandle: "kev", guardianType: "email", maskedValue: "g1…@friends.test", sentAt: row(g).check_sent_at });
    expect((await info(g, "0".repeat(48))).status).toBe(404);
    expect((await info(g)).status).toBe(404);
    expect((await info(SG[1], token)).status).toBe(404); // another guardian's open check, this token
    expect((await answer({ check: g, token: "0".repeat(48) })).status).toBe(404);
    expect(row(g).checked_at).toBeNull();
    const res = await answer({ check: g, token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(Date.parse(String(row(g).checked_at))).toBeGreaterThan(Date.now() - 60_000);
    expect(row(g)).toMatchObject({ check_sent_at: null, check_token_hash: null, unreachable_at: null });
    expect((await answer({ check: g, token })).status).toBe(404);
    expect((await info(g, token)).status).toBe(404);
  });

  it("a late answer clears the mark", async () => {
    const g = guardian("email", "late@friends.test", { check_sent_at: ago(20 * DAY), check_token_hash: sha("late-token"), unreachable_at: ago(6 * DAY) });
    expect((await answer({ check: g, token: "late-token" })).status).toBe(200);
    expect(row(g).unreachable_at).toBeNull();
  });

  it("a wallet guardian signs this guardian's open check with that wallet; an old check's signature or another wallet's is refused", async () => {
    const w = wallet();
    const g = guardian("wallet", w.address);
    await run();
    const sentAt = String(row(g).check_sent_at);
    const shown = (await (await info(g)).json()) as { sentAt: string; guardianType: string; maskedValue: string };
    expect(shown).toEqual({ requesterHandle: "kev", guardianType: "wallet", maskedValue: `${w.address.slice(0, 6)}…${w.address.slice(-6)}`, sentAt });
    expect((await answer({ check: g, signature: w.sign(guardianCheckMessage(g, ago(400 * DAY))) })).status).toBe(403);
    expect((await answer({ check: g, signature: w.sign(guardianCheckMessage(SG[0], sentAt)) })).status).toBe(403);
    expect((await answer({ check: g, signature: wallet().sign(guardianCheckMessage(g, sentAt)) })).status).toBe(403);
    expect((await answer({ check: g, token: "x" })).status).toBe(403);
    expect(row(g).checked_at).toBeNull();
    expect((await answer({ check: g, signature: w.sign(guardianCheckMessage(g, sentAt)) })).status).toBe(200);
    expect(row(g).check_sent_at).toBeNull();
    expect(row(g).checked_at).not.toBeNull();
  });

  it("no open check, a guardian no longer confirmed, or a link that is no id answers not valid", async () => {
    const g = guardian("email", "g1@friends.test", { check_sent_at: ago(DAY), check_token_hash: sha("tok") });
    row(g).status = "pending";
    expect((await info(g, "tok")).status).toBe(404);
    expect((await answer({ check: g, token: "tok" })).status).toBe(404);
    row(g).status = "confirmed";
    row(g).check_sent_at = null;
    expect((await answer({ check: g, token: "tok" })).status).toBe(404);
    expect((await info("not-an-id", "tok")).status).toBe(404);
    expect((await answer({ check: "not-an-id", token: "tok" })).status).toBe(400);
  });

  it("before SQL 75 ran the page and the answer say not available", async () => {
    const g = guardian("email", "g1@friends.test");
    db.state.failNext = { table: "recovery_guardians", op: "select", code: "42703" };
    const res = await info(g, "tok");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "This is not available yet" });
    db.state.failNext = { table: "recovery_guardians", op: "select", code: "42703" };
    expect((await answer({ check: g, token: "tok" })).status).toBe(503);
  });

  it("an invite link still confirms as before: the check branch takes only check links", async () => {
    const id = randomUUID();
    db.tables.recovery_guardians.push({ id, user_id: U, guardian_type: "email", value: "new@friends.test", status: "pending", invite_token: "invite-tok" });
    expect(await (await confirmRoute.GET(pub("/api/recovery/guardians/confirm?token=invite-tok"))).json()).toMatchObject({ guardianType: "email", status: "pending" });
    expect((await confirmRoute.POST(pub("/api/recovery/guardians/confirm", { token: "invite-tok" }))).status).toBe(200);
    expect(row(id).status).toBe("confirmed");
  });
});

describe("a yes to a request answers the check too", () => {
  it("a yes to a lost factor's ask stamps the guardian reachable; a wrong token does not", async () => {
    db.tables.mfa_factors.push({ id: randomUUID(), user_id: U, kind: "totp", secret_ct: "x", confirmed_at: "2026-10-07T00:00:00Z" });
    const g = guardian("email", "g1@friends.test", { check_sent_at: ago(20 * DAY), check_token_hash: sha("c"), unreachable_at: ago(6 * DAY) });
    guardian("email", "g2@friends.test");
    const R = randomUUID();
    db.tables.recovery_requests.push({ id: R, user_id: U, status: "pending", factor: "totp", expires_at: FUTURE });
    db.tables.recovery_approvals.push({ request_id: R, guardian_id: g, code_hash: sha("ask-token"), approved_at: null });
    expect((await approveRoute.POST(pub("/api/recovery/approve", { requestId: R, guardianId: g, token: "f".repeat(48) }))).status).toBe(404);
    expect(row(g).unreachable_at).not.toBeNull();
    const res = await approveRoute.POST(pub("/api/recovery/approve", { requestId: R, guardianId: g, token: "ask-token" }));
    expect(await res.json()).toMatchObject({ ok: true, approved: 1, needed: 2 });
    expect(row(g)).toMatchObject({ check_sent_at: null, check_token_hash: null, unreachable_at: null });
    expect(row(g).checked_at).not.toBeNull();
  });

  it("an approval of a password reset by its code stamps the guardian reachable; a wrong code does not", async () => {
    const g = guardian("email", "g1@friends.test", { unreachable_at: ago(DAY), check_sent_at: ago(20 * DAY) });
    const R = randomUUID();
    db.tables.recovery_requests.push({ id: R, user_id: U, status: "pending", owner_key_hash: "k", expires_at: FUTURE });
    db.tables.recovery_approvals.push({ request_id: R, guardian_id: g, code_hash: sha("1234567"), approved_at: null });
    expect((await approveRoute.POST(pub("/api/recovery/approve", { requestId: R, guardianId: g, code: "7654321" }))).status).toBe(400);
    expect(row(g).unreachable_at).not.toBeNull();
    expect((await approveRoute.POST(pub("/api/recovery/approve", { requestId: R, guardianId: g, code: "1234567" }))).status).toBe(200);
    expect(row(g).unreachable_at).toBeNull();
    expect(row(g).checked_at).not.toBeNull();
  });
});

describe("what Settings reads", () => {
  it("the guardian list carries an open check and the mark per guardian; before SQL 75 ran, none, and the list still loads", async () => {
    const open = guardian("wallet", wallet().address, { check_sent_at: ago(DAY) });
    const gone = guardian("email", "late@friends.test", { check_sent_at: ago(20 * DAY), unreachable_at: ago(6 * DAY) });
    const fine = guardian("email", "fine@friends.test");
    const list = async () => ((await (await guardiansList(own("/api/recovery/guardians"))).json()) as { guardians: { id: string; checkOpen: boolean; unreachable: boolean }[] }).guardians;
    const by = (gs: Awaited<ReturnType<typeof list>>, id: string) => gs.find((x) => x.id === id)!;
    const gs = await list();
    expect(gs).toHaveLength(3);
    expect(by(gs, open)).toMatchObject({ checkOpen: true, unreachable: false });
    expect(by(gs, gone)).toMatchObject({ checkOpen: true, unreachable: true });
    expect(by(gs, fine)).toMatchObject({ checkOpen: false, unreachable: false });
    db.state.failNext = { table: "recovery_guardians", op: "select", code: "42703", skip: 2 }; // past the list and the threshold's count
    const before = await list();
    expect(before).toHaveLength(3);
    expect(before.every((x) => !x.checkOpen && !x.unreachable)).toBe(true);
  });

  it("a guardian not reachable still counts toward the threshold and is still asked, but not as reachable", async () => {
    db.tables.mfa_factors.push({ id: randomUUID(), user_id: U, kind: "totp", secret_ct: "x", confirmed_at: "2026-10-07T00:00:00Z" });
    db.tables.mfa_recovery.push({ user_id: U, failed_attempts: 0, lockouts: 0, locked_until: null, factor: null, code_hashes: null, code_expires_at: null, code_sent_at: null, sends_day: null, sends_count: 0 });
    db.tables.recovery_settings.push({ user_id: U, threshold: 3 });
    guardian("email", "g1@friends.test");
    guardian("email", "g2@friends.test");
    guardian("email", "late@friends.test", { check_sent_at: ago(20 * DAY), unreachable_at: ago(6 * DAY) });
    const read = async () => ((await (await status(own("/api/auth/mfa/recovery"))).json()) as { guardians: Record<string, unknown> }).guardians;
    expect(await read()).toEqual({ askable: 3, reachable: 2, total: 3, needed: 3, ask: null });
    db.state.failNext = { table: "recovery_guardians", op: "select", code: "42703", skip: 2 }; // the mark's own read, before SQL 75
    expect(await read()).toEqual({ askable: 3, reachable: 3, total: 3, needed: 3, ask: null });
    db.state.failNext = { table: "recovery_guardians", op: "select", code: "XX000", skip: 2 }; // any other failure is no count
    expect((await status(own("/api/auth/mfa/recovery"))).status).toBe(500);
    const res = await askRoute(new NextRequest("http://enki.test/api/auth/mfa/recovery/guardians", { method: "POST", headers: { "X-Session-Token": SESSION, "x-real-ip": randomUUID() }, body: JSON.stringify({ factor: "totp" }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ needed: 3, emailed: 3 });
    expect(mail.sent.some((m) => m.to === "late@friends.test")).toBe(true);
  });

  it("Settings shows the mark, the open check and the wallet's check link, in the theme's badge", () => {
    const panel = readSource(join(__dirname, "..", "..", "components", "settings", "RecoveryPanel.tsx"));
    expect(panel).toContain('g.unreachable ? <span className="set-badge-warn">Not reachable</span> : <span className="set-badge-good">✓ Confirmed</span>');
    expect(panel).toContain('? g.guardianType === "wallet"\n                  ? "Did not answer the yearly check within 14 days. We cannot write to a wallet: send them the check link (Copy check link), or add another guardian, then remove this one."\n                  : "Did not answer the yearly check within 14 days. Add another guardian, then remove this one."');
    expect(panel).toContain('"Yearly check: copy their link and send it, they sign with this wallet."');
    expect(panel).toContain('"Yearly check sent: one click in their email confirms they can still be reached."');
    expect(panel).toContain("{g.status === \"confirmed\" && g.checkOpen && g.guardianType === \"wallet\" && (");
    expect(panel).toContain(">Copy check link</button>");
    // The copy itself lives in Settings' guardian hook (DEC-2026-11-08-41).
    expect(readSource(join(__dirname, "..", "..", "components", "settings", "use-guardians.ts")))
      .toContain("navigator.clipboard.writeText(`${window.location.origin}/guardian?check=${encodeURIComponent(g.id)}`)");
  });

  it("the guardian's page: the check link, its words, one click for email, the wallet signs the open check", () => {
    const page = readSource(join(__dirname, "..", "..", "app", "guardian", "page.tsx"));
    expect(page).toContain('const check = params.get("check");');
    expect(page).toContain('<GuardianCheck guardianId={check} token={params.get("t") ?? ""} />');
    expect(page).toContain("One click tells us you can: it moves no money and approves nothing.");
    expect(page).toContain('"Yes, I can still be reached"');
    expect(page).toContain('"Sign and confirm"');
    expect(page).toContain("signMessage(new TextEncoder().encode(guardianCheckMessage(guardianId, info.sentAt)))");
    expect(page).toContain("body: JSON.stringify({ check: guardianId, ...proof })");
  });
});
