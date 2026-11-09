import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Kev, 2026-11-05: a banned account's funds door is /banned, and deletion takes the session that opens it. So a
 * guardian-approved deletion does not finalise while a ban is active: the request stays open. The real routes and the
 * real ban read run; the database is a fake.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
vi.mock("@/lib/mailer", () => ({ sendMail: async () => ({ ok: true }) }));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64"); });

import { GET as poll, POST as start } from "../../app/api/account/delete/route";
import { POST as approve } from "../../app/api/account/delete/approve/route";
import { sha256 } from "@/lib/password-reset";

const KEY = "the-owner-key";
const LATER = () => new Date(Date.now() + 3_600_000).toISOString();
const EARLIER = () => new Date(Date.now() - 3_600_000).toISOString();
let U = "";
let REQUEST = "";

const answer = () => poll(new NextRequest(`http://enki.test/api/account/delete?id=${REQUEST}&key=${KEY}`));
const account = () => db.tables.users.find((u) => u.id === U)!;
const ban = (extra: Record<string, unknown> = {}) => db.tables.bans.push({ id: randomUUID(), user_id: U, lifted_at: null, reason: "x", expires_at: null, created_at: "2026-10-01T00:00:00Z", ...extra });

beforeEach(() => {
  U = randomUUID();
  REQUEST = randomUUID();
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  Object.assign(db.tables, {
    users: [{ id: U, handle: "kev", deleted_at: null, account_status: "active" }],
    auth_sessions: [{ token: "tok", wallet_address: U, expires_at: LATER() }],
    auth_identities: [{ provider: "google", subject: "g1", user_id: U }],
    user_wallets: [],
    bans: [],
    recovery_settings: [{ user_id: U, threshold: 2 }],
    recovery_guardians: [],
    deletion_requests: [{ id: REQUEST, user_id: U, status: "pending", expires_at: LATER(), owner_key_hash: sha256(KEY) }],
    deletion_approvals: [
      { request_id: REQUEST, guardian_id: "g1", approve_token: "t1", approved_at: "2026-11-05T00:00:00Z" },
      { request_id: REQUEST, guardian_id: "g2", approve_token: "t2", approved_at: "2026-11-05T00:00:00Z" },
    ],
  });
  db.state.failing = null;
  db.state.failNext = null;
});

describe("a guardian-approved deletion", () => {
  it("finalises when no ban runs", async () => {
    const res = await answer();
    expect(await res.json()).toMatchObject({ status: "completed", done: true });
    expect(account().deleted_at).not.toBeNull();
    expect(db.tables.deletion_requests[0].status).toBe("completed");
    expect(db.tables.auth_sessions).toEqual([]);
  });

  it("is held while a ban runs: nothing is deleted, the request stays open, and the poll has a sentence to show", async () => {
    ban();
    const res = await answer();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "held", approved: 2, threshold: 2 });
    expect(body.done).toBeUndefined();
    expect(body.message).toContain("is suspended");
    expect(body.message).toContain("funds");
    expect(account().deleted_at).toBeNull();
    expect(account().account_status).toBe("active");
    expect(db.tables.deletion_requests[0].status).toBe("pending");
    expect(db.tables.auth_sessions).toHaveLength(1);
    expect(db.tables.auth_identities).toHaveLength(1);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("finalises on the next poll once the ban is lifted", async () => {
    ban();
    expect((await (await answer()).json()).status).toBe("held");
    db.tables.bans[0].lifted_at = "2026-11-05T01:00:00Z";
    expect((await (await answer()).json()).status).toBe("completed");
    expect(account().deleted_at).not.toBeNull();
  });

  it("a ban that ran out holds nothing, and neither does another account's", async () => {
    ban({ expires_at: EARLIER() });
    db.tables.bans.push({ id: "other", user_id: randomUUID(), lifted_at: null, reason: "x", expires_at: null, created_at: "2026-10-01T00:00:00Z" });
    expect((await (await answer()).json()).status).toBe("completed");
  });

  it("fails closed when the ban cannot be read: nothing is deleted, and the poll goes on", async () => {
    db.state.failing = { table: "bans", code: "XX000" };
    const res = await answer();
    expect(res.status).toBe(503);
    expect((await res.json()).done).toBeUndefined();
    expect(account().deleted_at).toBeNull();
    expect(db.tables.deletion_requests[0].status).toBe("pending");
    expect(db.tables.auth_sessions).toHaveLength(1);
  });

  it("below the threshold, or expired, stays what it was, ban or not", async () => {
    ban();
    db.tables.deletion_approvals[1].approved_at = null;
    expect(await (await answer()).json()).toEqual({ status: "pending", approved: 1, threshold: 2 });
    db.tables.deletion_approvals[1].approved_at = "2026-11-05T00:00:00Z";
    db.tables.deletion_requests[0].expires_at = EARLIER();
    expect(await (await answer()).json()).toEqual({ status: "expired", approved: 2, threshold: 2 });
    expect(account().deleted_at).toBeNull();
  });

  it("a guardian's approval only records the approval: the owner's poll is what finalises", async () => {
    ban();
    db.tables.deletion_approvals[1].approved_at = null;
    const res = await approve(new NextRequest("http://enki.test/api/account/delete/approve", { method: "POST", body: JSON.stringify({ token: "t2" }) }));
    expect(res.status).toBe(200);
    expect(db.tables.deletion_approvals[1].approved_at).not.toBeNull();
    expect(account().deleted_at).toBeNull();
    expect(db.tables.deletion_requests[0].status).toBe("pending");
  });
});

describe("a deletion with no guardians", () => {
  it("cannot start on a banned session: it resolves to nobody", async () => {
    ban();
    const res = await start(new NextRequest("http://enki.test/api/account/delete", { method: "POST", headers: { "X-Session-Token": "tok" }, body: JSON.stringify({ confirm: "kev" }) }));
    expect(res.status).toBe(401);
    expect(account().deleted_at).toBeNull();
  });
});
