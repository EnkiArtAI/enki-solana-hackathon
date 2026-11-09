import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { readSource } from "./_read-source";

/**
 * DEC-513 (Kev, 2026-10-29: "messages shall contain: normal messages and requests ... click on 'accept message' and
 * then it gets moved to normal chat"): app/api/messages names each conversation a request or not, counts the requests,
 * takes one in on Accept, and writing in a conversation takes it in for the writer.
 */
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let overview: { data: Row[] | null; error: { message: string } | null };
let failUpdate: string | null;
// Columns the live table does not have yet: naming one in a select fails the read, as PostgREST does (42703).
let missing: string[];

const query = (table: string) => {
  const filters: ((r: Row) => boolean)[] = [];
  let op: { kind: "select" | "update" | "insert"; values?: Row } = { kind: "select" };
  let sort: ((x: Row, y: Row) => number) | null = null;
  let refused = false;
  const run = () => {
    if (refused) return { data: null, error: { message: "column does not exist" } };
    const rows = tables[table] ?? [];
    if (op.kind === "insert") {
      const row = { id: `m${rows.length + 1}`, created_at: `2026-10-29T12:00:0${rows.length}Z`, image_path: null, ...op.values };
      rows.push(row);
      return { data: row, error: null };
    }
    const hit = rows.filter((r) => filters.every((f) => f(r)));
    if (sort) hit.sort(sort);
    if (op.kind === "update") {
      if (failUpdate && op.values && failUpdate in op.values) return { data: null, error: { message: `column ${failUpdate} does not exist` } };
      hit.forEach((r) => Object.assign(r, op.values));
    }
    return { data: hit, error: null };
  };
  const q = {
    select: (cols = "*") => { refused ||= missing.some((c) => cols.split(/,\s*/).includes(c)); return q; },
    insert: (values: Row) => { op = { kind: "insert", values }; return q; },
    update: (values: Row) => { op = { kind: "update", values }; return q; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    is: (c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return q; },
    gt: (c: string, v: string) => { filters.push((r) => String(r[c]) > v); return q; },
    order: (c: string, o: { ascending: boolean }) => { sort = (x, y) => (String(x[c]) < String(y[c]) ? -1 : 1) * (o.ascending ? 1 : -1); return q; },
    limit: () => q,
    // Only the forward-only cursor's shape, "<col>.is.null,<col>.lt.<time>".
    or: (expr: string) => {
      const [, c, v] = /^(\w+)\.is\.null,\1\.lt\.(.+)$/.exec(expr) ?? [];
      if (c) filters.push((r) => r[c] == null || String(r[c]) < v);
      return q;
    },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
    single: async () => run(),
    then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
  };
  return q;
};
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({ from: query, rpc: async () => overview, storage: { from: () => ({ createSignedUrls: async () => ({ data: [] }) }) } }),
}));
const A = "0b5f2c1e-1111-4222-8333-444455556666";
const B = "9c1d2e3f-1111-4222-8333-444455556666";
const T = "7a7a7a7a-1111-4222-8333-444455556666";
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async (_s: unknown, t: string | null) => ({ a: A, b: B } as Record<string, string>)[t ?? ""] ?? null }));

import { GET, POST } from "../../app/api/messages/route";

const post = async (as: string, body: unknown) => {
  const res = await POST(new NextRequest("http://enki.test/api/messages", { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": as }, body: JSON.stringify(body) }));
  return [res.status, await res.json()];
};
const list = async (as: string) => (await GET(new NextRequest("http://enki.test/api/messages", { headers: { "X-Session-Token": as } }))).json();
const thread = () => tables.dm_threads[0];
const ov = (over: Row) => ({ thread_id: T, peer_id: A, peer_handle: "ann", peer_name: null, peer_avatar: null, last_at: "2026-10-29T10:00:00Z", last_body: "hi", last_sender: A, last_has_image: false, unread: 1, accepted: false, ...over });

beforeEach(() => {
  // A wrote to B: A took it in by writing, B has not.
  tables = { dm_threads: [{ id: T, user_a: A, user_b: B, a_last_read_at: null, b_last_read_at: null, a_accepted_at: "2026-10-29T10:00:00Z", b_accepted_at: null }], dm_messages: [] };
  overview = { data: [], error: null };
  failUpdate = null;
  missing = [];
});

describe("message requests", () => {
  it("names a request and counts it; a request nobody wrote in is not shown; before SQL 42 everything is a conversation", async () => {
    overview.data = [ov({}), ov({ thread_id: "t2", last_at: null, last_body: null, last_sender: null, unread: 0 }), ov({ thread_id: "t3", accepted: true })];
    const got = await list("b");
    expect(got.threads.map((t: Row) => [t.id, t.accepted])).toEqual([[T, false], ["t3", true]]);
    expect([got.requests, got.unreadTotal]).toEqual([1, 2]);
    overview.data = [ov({ accepted: undefined })];
    expect((await list("b")).threads[0].accepted).toBe(true);
    overview = { data: null, error: { message: "boom" } };
    expect(await list("b")).toEqual({ threads: [], unreadTotal: 0, requests: 0 });
  });

  it("takes a request in on Accept, for me only and once", async () => {
    expect(await post("b", { threadId: T, accept: true })).toEqual([200, { ok: true }]);
    const at = thread().b_accepted_at;
    expect(typeof at).toBe("string");
    expect(thread().a_accepted_at).toBe("2026-10-29T10:00:00Z");
    await post("b", { threadId: T, accept: true });
    expect(thread().b_accepted_at).toBe(at);
  });

  it("says so when requests are not there yet, and keeps a stranger out", async () => {
    failUpdate = "b_accepted_at";
    expect(await post("b", { threadId: T, accept: true })).toEqual([503, { error: "Message requests are not available yet" }]);
    failUpdate = null;
    tables.dm_threads[0].user_a = "00000000-0000-4000-8000-000000000001";
    expect((await post("b", { threadId: T, accept: true }))[0]).toBe(200);
    expect((await post("a", { threadId: T, accept: true }))[0]).toBe(404);
  });

  it("is taken in by writing in it, and the writer's earlier time stays", async () => {
    expect((await post("b", { threadId: T, body: "hello back" }))[0]).toBe(201);
    expect(thread().b_accepted_at).toBe(tables.dm_messages[0].created_at);
    await post("a", { threadId: T, body: "again" });
    expect(thread().a_accepted_at).toBe("2026-10-29T10:00:00Z");
  });

  it("still sends before SQL 42", async () => {
    failUpdate = "b_accepted_at";
    expect((await post("b", { threadId: T, body: "hello back" }))[0]).toBe(201);
    expect(thread().b_accepted_at).toBeNull();
  });

  it("an image sent takes it in too", () => {
    const route = readSource(join(__dirname, "..", "..", "app", "api", "messages", "image", "route.ts"));
    expect(route).toMatch(/\.update\(\{ last_message_at: msg\.created_at, \[readColFor\(thread, userId\)\]: msg\.created_at \}\)\n\s+\.eq\("id", threadId\);\n\s+await acceptOnSend\(supabase, thread, userId, msg\.created_at\);/);
  });
});

/**
 * Kev, 2026-10-29: "the decline button for message requests, just add a delete button, no decline button". Delete moves
 * my cleared time to the newest message I was shown (SQL 47): the thread's messages leave out what came up to it, for me
 * only, and what comes after shows on its own.
 */
describe("deleting a request", () => {
  const msg = (id: string, body: string, at: string) => ({ id, thread_id: T, sender_id: A, body, image_path: null, created_at: at });
  const seed = () => tables.dm_messages.push(msg("m1", "one", "2026-10-29T10:00:00Z"), msg("m2", "two", "2026-10-29T10:01:00Z"));
  const del = (as: string, upTo: unknown) => post(as, { threadId: T, delete: true, upTo });
  const bodies = async (as: string, after?: string) => {
    const res = await GET(new NextRequest(`http://enki.test/api/messages?thread=${T}${after ? `&after=${after}` : ""}`, { headers: { "X-Session-Token": as } }));
    return res.status === 200 ? ((await res.json()).messages as Row[]).map((m) => m.body) : res.status;
  };

  it("hides it up to the newest message I was shown, for me only, and a new message shows on its own", async () => {
    seed();
    expect(await del("b", "2026-10-29T10:01:00Z")).toEqual([200, { ok: true }]);
    expect([thread().b_cleared_at, thread().a_cleared_at]).toEqual(["2026-10-29T10:01:00Z", undefined]);
    expect([await bodies("b"), await bodies("b", "2026-10-29T09:00:00Z")]).toEqual([[], []]);
    expect(await bodies("a")).toEqual(["one", "two"]);
    tables.dm_messages.push(msg("m3", "three", "2026-10-29T10:02:00Z"));
    expect([await bodies("b"), await bodies("b", "2026-10-29T09:00:00Z")]).toEqual([["three"], ["three"]]);
  });

  it("refuses a time to come, or none, and never moves back", async () => {
    for (const upTo of [new Date(Date.now() + 60_000).toISOString(), "soon", undefined, 5]) {
      expect(await del("b", upTo)).toEqual([400, { error: "Bad request" }]);
    }
    expect(thread().b_cleared_at).toBeUndefined();
    await del("b", "2026-10-29T10:01:00Z");
    expect((await del("b", "2026-10-29T10:00:00Z"))[0]).toBe(200);
    expect(thread().b_cleared_at).toBe("2026-10-29T10:01:00Z");
  });

  it("says so before SQL 47, shows a conversation whole until then, and keeps a stranger out", async () => {
    failUpdate = "b_cleared_at";
    expect(await del("b", "2026-10-29T10:01:00Z")).toEqual([503, { error: "Deleting requests is not available yet" }]);
    failUpdate = null;
    missing = ["a_cleared_at", "b_cleared_at"];
    seed();
    expect(await bodies("b")).toEqual(["one", "two"]);
    missing = [];
    tables.dm_threads[0].user_a = "00000000-0000-4000-8000-000000000001";
    expect((await del("a", "2026-10-29T10:01:00Z"))[0]).toBe(404);
    expect([thread().a_cleared_at, thread().b_cleared_at]).toEqual([undefined, undefined]);
  });
});
