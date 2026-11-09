import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * DEC-511: app/api/follows/route.ts. A signed-in viewer follows someone else (bell off, against the live column
 * default notify_on_new_prompt = true), turns the bell on and off for both kinds of post, and unfollows.
 */
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let queries = 0;

const query = (table: string) => {
  queries++;
  const filters: ((r: Row) => boolean)[] = [];
  let op: { kind: "select" | "update" | "upsert" | "delete"; values?: Row; ignore?: boolean } = { kind: "select" };
  let one = false;
  const q = {
    select: () => q,
    update: (values: Row) => { op = { kind: "update", values }; return q; },
    upsert: (values: Row, o: { onConflict: string; ignoreDuplicates: boolean }) => {
      expect(o.onConflict).toBe("follower_id,followee_id");
      op = { kind: "upsert", values, ignore: o.ignoreDuplicates };
      return q;
    },
    delete: () => { op = { kind: "delete" }; return q; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    is: (c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return q; },
    maybeSingle: () => { one = true; return q; },
    then: (ok: (v: unknown) => unknown) => {
      const rows = tables[table] ?? [];
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op.kind === "update") hit.forEach((r) => Object.assign(r, op.values));
      if (op.kind === "delete") tables[table] = rows.filter((r) => !hit.includes(r));
      if (op.kind === "upsert") {
        const v = op.values as Row;
        const dup = rows.find((r) => r.follower_id === v.follower_id && r.followee_id === v.followee_id);
        if (!dup) rows.push({ ...v });
        else if (!op.ignore) Object.assign(dup, v);
      }
      return Promise.resolve(one ? { data: hit[0] ?? null, error: null } : { data: hit, error: null, count: hit.length }).then(ok);
    },
  };
  return q;
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: query }) }));
const ME = "0b5f2c1e-1111-4222-8333-444455556666";
const HER = "9c1d2e3f-1111-4222-8333-444455556666";
const GONE = "7a7a7a7a-1111-4222-8333-444455556666";
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async (_s: unknown, t: string | null) => (t === "me" ? ME : null) }));

import { GET, POST } from "../../app/api/follows/route";

const as = (token: string | null) => (token ? { "X-Session-Token": token } : {}) as Record<string, string>;
const read = async (user: string, token: string | null = "me") => {
  const res = await GET(new NextRequest(`http://enki.test/api/follows?user=${user}`, { headers: as(token) }));
  return [res.status, await res.json()];
};
const post = async (body: unknown, token: string | null = "me") => {
  const req = new Request("http://enki.test/api/follows", { method: "POST", headers: { "Content-Type": "application/json", ...as(token) }, body: JSON.stringify(body) });
  const res = await POST(req as unknown as NextRequest);
  return [res.status, await res.json()];
};
const row = () => tables.follows.find((r) => r.follower_id === ME && r.followee_id === HER);

beforeEach(() => {
  tables = { users: [{ id: ME, deleted_at: null }, { id: HER, deleted_at: null }, { id: GONE, deleted_at: "2026-10-01T00:00:00Z" }], follows: [] };
});

describe("following someone", () => {
  it("follows with the bell off, and says so", async () => {
    expect(await read(HER)).toEqual([200, { following: false, notify: false }]);
    expect(await post({ user: HER, follow: true })).toEqual([200, { following: true }]);
    expect(row()).toMatchObject({ notify_on_new_prompt: false, notify_on_new_post: false });
    expect(await read(HER)).toEqual([200, { following: true, notify: false }]);
  });

  it("turns the bell on and off for both kinds of post, only once followed", async () => {
    expect((await post({ user: HER, notify: true }))[0]).toBe(409);
    await post({ user: HER, follow: true });
    expect(await post({ user: HER, notify: true })).toEqual([200, { following: true, notify: true }]);
    expect(row()).toMatchObject({ notify_on_new_prompt: true, notify_on_new_post: true });
    expect(await read(HER)).toEqual([200, { following: true, notify: true }]);
    // Following again keeps the bell.
    await post({ user: HER, follow: true });
    expect(row()).toMatchObject({ notify_on_new_prompt: true, notify_on_new_post: true });
    await post({ user: HER, notify: false });
    expect(row()).toMatchObject({ notify_on_new_prompt: false, notify_on_new_post: false });
  });

  it("unfollows", async () => {
    await post({ user: HER, follow: true });
    expect(await post({ user: HER, follow: false })).toEqual([200, { following: false, notify: false }]);
    expect(tables.follows).toEqual([]);
  });

  it("refuses yourself, a deleted account, a bad id, a guest and a body without a choice", async () => {
    expect((await post({ user: ME, follow: true }))[0]).toBe(400);
    expect((await post({ user: GONE, follow: true }))[0]).toBe(404);
    expect((await post({ user: "nope", follow: true }))[0]).toBe(404);
    expect((await post({ user: HER, follow: true }, null))[0]).toBe(401);
    expect((await post({ user: HER, follow: "yes" }))[0]).toBe(400);
    expect(tables.follows).toEqual([]);
    queries = 0;
    expect(await read(HER, null)).toEqual([200, { following: false, notify: false }]);
    expect(queries).toBe(0);
  });
});
