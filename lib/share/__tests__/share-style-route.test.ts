import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ShareStyle } from "../doc";

/**
 * GET and PUT /api/users/share-style over a stand-in client that filters as the real one does, so "only my row" is a fact of
 * its rows and not of a mock's say-so; both failures of a missing column as postgrest answers them (VERIFIED live 2026-11-02
 * and 2026-11-04: 42703 on a read, PGRST204 on a write). Blind spot: the real table is first met when SQL 71 has run.
 */
type Row = { id: string; handle?: string; share_style?: unknown };
const state = vi.hoisted(() => ({
  rows: [] as Row[],
  readError: null as { code: string; message: string } | null,
  writeError: null as { code: string; message: string } | null,
  calls: [] as { op: string; cols?: string; eq?: [string, string]; payload?: unknown }[],
  limit: { allowed: true, retryAfterSeconds: 9 },
  limitCalls: [] as unknown[][],
}));

vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: (table: string) => {
      if (table !== "users") throw new Error(`unexpected table ${table}`);
      const call: (typeof state.calls)[number] = { op: "select" };
      state.calls.push(call);
      const b = {
        select(cols: string) { if (call.op === "select") call.cols = cols; return b; },
        update(payload: unknown) { call.op = "update"; call.payload = payload; return b; },
        eq(col: string, value: string) { call.eq = [col, value]; return b; },
        maybeSingle: async () => {
          const error = call.op === "select" ? state.readError : state.writeError;
          if (error) return { data: null, error };
          const hit = call.eq ? state.rows.filter((r) => r[call.eq![0] as "id"] === call.eq![1]) : state.rows;
          if (call.op === "update") hit.forEach((r) => Object.assign(r, call.payload));
          return { data: hit[0] ?? null, error: null };
        },
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/session-user", async (original) => ({
  ...(await original<typeof import("@/lib/session-user")>()),
  resolveSessionUserId: async (_s: unknown, token: string | null) => (token === "me" ? "user-me" : token === "gone" ? "user-gone" : null),
}));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit")>()),
  checkRequestRateLimit: (...args: unknown[]) => { state.limitCalls.push(args); return state.limit; },
}));

import { GET, PUT } from "../../../app/api/users/share-style/route";

const bk = [{ key: "title", on: true }];
const part = (ratio = "4:5"): NonNullable<ShareStyle["image"]> => ({ ratio, bg: { mode: "solid", c: "#ffffff" }, els: [{ id: 1, k: "title", x: 6, y: 4, w: 88, h: 10, rot: 0, font: "Inter", color: "#111111", align: "left" }], bk: bk as never });
const set = (): NonNullable<ShareStyle["set"]> => {
  const { ratio, bg, els } = part("1:1");
  return { ov: { ratio, bg, els }, per: { ratio, bg, els }, bk: bk as never };
};
const URL_ = "http://enki.test/api/users/share-style";
const get = (token?: string) => GET(new NextRequest(URL_, { headers: token ? { "X-Session-Token": token } : {} }));
const put = (body: unknown, token: string | undefined = "me") => PUT(new NextRequest(URL_, { method: "PUT", headers: token ? { "X-Session-Token": token } : {}, body: typeof body === "string" ? body : JSON.stringify(body) }));
const mine = () => state.rows.find((r) => r.id === "user-me")!;
const theirs = () => state.rows.find((r) => r.id === "user-other")!;
const updates = () => state.calls.filter((c) => c.op === "update");
const COLUMN_MISSING_READ = { code: "42703", message: "column users.share_style does not exist" };
const COLUMN_MISSING_WRITE = { code: "PGRST204", message: "Could not find the 'share_style' column of 'users' in the schema cache" };

beforeEach(() => {
  state.rows = [{ id: "user-me", handle: "mira", share_style: null }, { id: "user-other", handle: "other", share_style: { image: part("16:9") } }];
  state.readError = state.writeError = null;
  state.calls = [];
  state.limit = { allowed: true, retryAfterSeconds: 9 };
  state.limitCalls = [];
});

describe("nobody without a session", () => {
  it("GET and PUT answer 401 and read nothing", async () => {
    expect((await get()).status).toBe(401);
    expect((await get("stranger")).status).toBe(401);
    expect((await put({ image: part() }, "stranger")).status).toBe(401);
    expect(state.calls).toEqual([]);
    expect(state.limitCalls).toEqual([]);
    expect(mine().share_style).toBeNull();
  });
});

describe("GET", () => {
  it("no style kept yet: null, and no run", async () => {
    const res = await get("me");
    expect([res.status, await res.json()]).toEqual([200, { style: null }]);
  });

  it("the caller's own, read by their id, its two columns and no more", async () => {
    mine().share_style = { image: part() };
    const res = await get("me");
    expect(await res.json()).toEqual({ style: { image: part() } });
    expect(state.calls).toEqual([{ op: "select", cols: "id, share_style", eq: ["id", "user-me"] }]);
  });

  it("a stored value that does not hold is no style", async () => {
    mine().share_style = { image: { ...part(), ratio: "the words" } };
    expect(await (await get("me")).json()).toEqual({ style: null });
  });

  it("what goes out is what parseStyle lets through", async () => {
    mine().share_style = { image: { ...part(), words: "ZZ-secret-ZZ" }, secret: "ZZ-secret-ZZ" };
    expect(JSON.stringify(await (await get("me")).json())).not.toContain("ZZ-secret-ZZ");
  });

  it("before SQL 71 (42703): 200, no style, and the file to run", async () => {
    state.readError = COLUMN_MISSING_READ;
    const res = await get("me");
    expect([res.status, await res.json()]).toEqual([200, { style: null, run: "71-share-style.sql" }]);
  });

  it("PGRST204 on a read counts the same; any other error does not pretend", async () => {
    state.readError = COLUMN_MISSING_WRITE;
    expect((await (await get("me")).json()).run).toBe("71-share-style.sql");
    state.readError = { code: "XX000", message: "boom" };
    expect((await get("me")).status).toBe(500);
  });

  it("an unreachable database: the one 503", async () => {
    state.readError = { code: "", message: "TypeError: fetch failed" };
    const res = await get("me");
    expect([res.status, (await res.json()).code]).toEqual([503, "DB_UNAVAILABLE"]);
  });
});

describe("PUT", () => {
  it("writes the caller's row: their id, that one column; the other row is untouched", async () => {
    const before = structuredClone(theirs());
    const res = await put({ image: part() });
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
    expect(mine().share_style).toEqual({ image: part() });
    expect(theirs()).toEqual(before);
    expect(updates()).toEqual([{ op: "update", payload: { share_style: { image: part() } }, eq: ["id", "user-me"] }]);
    expect(state.calls[0]).toEqual({ op: "select", cols: "id, share_style", eq: ["id", "user-me"] });
    expect(mine().handle).toBe("mira");
  });

  it("the part it carries, the others as they were", async () => {
    await put({ image: part("4:5") });
    await put({ set: set() });
    expect(mine().share_style).toEqual({ image: part("4:5"), set: set() });
    await put({ image: part("1:1") });
    expect(mine().share_style).toEqual({ image: part("1:1"), set: set() });
  });

  it("a stored value that does not hold is left behind, not merged", async () => {
    mine().share_style = { video: { ratio: "the words" } };
    await put({ image: part() });
    expect(mine().share_style).toEqual({ image: part() });
  });

  it("a text field smuggled in is dropped from what is written", async () => {
    const res = await put({ secret: "ZZ-secret-ZZ", image: { ...part(), title: "ZZ-secret-ZZ", els: [{ ...part().els[0], text: "ZZ-secret-ZZ", src: "https://x.test/ZZ-secret-ZZ" }] } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(mine().share_style)).not.toContain("ZZ-secret-ZZ");
    expect(mine().share_style).toEqual({ image: part() });
  });

  it.each<[string, unknown]>([
    ["an unknown kind", { image: { ...part(), els: [{ ...part().els[0], k: "words" }] } }],
    ["more than the cap", { image: part(), pad: "x".repeat(65 * 1024) }],
    ["a body that is no JSON", "the words"],
    ["an array", [part()]],
  ])("%s: 400, its sentence, nothing written", async (_name, body) => {
    const res = await put(body);
    expect([res.status, (await res.json()).error]).toEqual([400, "That style could not be read."]);
    expect(updates()).toEqual([]);
    expect(mine().share_style).toBeNull();
  });

  it("before SQL 71, on the read (42703): 503 with the file to run, nothing written", async () => {
    state.readError = COLUMN_MISSING_READ;
    const res = await put({ image: part() });
    const body = await res.json();
    expect([res.status, body.run]).toEqual([503, "71-share-style.sql"]);
    expect(updates()).toEqual([]);
  });

  it("before SQL 71, on the write (PGRST204): 503 with the file to run", async () => {
    state.writeError = COLUMN_MISSING_WRITE;
    const res = await put({ image: part() });
    expect([res.status, (await res.json()).run]).toEqual([503, "71-share-style.sql"]);
    expect(mine().share_style).toBeNull();
  });

  it("no fake success: a write that failed or met no row is not ok", async () => {
    state.writeError = { code: "XX000", message: "boom" };
    expect((await put({ image: part() })).status).toBe(500);
    state.writeError = null;
    expect((await put({ image: part() }, "gone")).status).toBe(500);
    state.writeError = { code: "", message: "fetch failed" };
    expect((await put({ image: part() })).status).toBe(503);
  });

  it("a failed read writes nothing over what might be there", async () => {
    state.readError = { code: "XX000", message: "boom" };
    expect((await put({ image: part() })).status).toBe(500);
    expect(updates()).toEqual([]);
  });

  describe("a body past a style's size", () => {
    const stream = (chunks: number, size = 1024) => {
      let sent = 0, cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) { if (sent >= chunks) return c.close(); sent++; c.enqueue(new TextEncoder().encode("x".repeat(size))); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      return { body, sent: () => sent, cancelled: () => cancelled };
    };
    const send = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => PUT(new NextRequest(URL_, { method: "PUT", headers: { "X-Session-Token": "me", ...headers }, body, duplex: "half" } as never));

    it("is refused where the size is passed: the rest is never read, nothing is parsed", async () => {
      const s = stream(1000), parse = vi.spyOn(JSON, "parse");
      const res = await send(s.body);
      expect(res.status).toBe(400);
      expect(s.sent()).toBeLessThan(70);
      expect(s.cancelled()).toBe(true);
      expect(parse).not.toHaveBeenCalled();
      parse.mockRestore();
      expect(updates()).toEqual([]);
    });
    it("a Content-Length past it is refused with nothing read", async () => {
      const s = stream(1);
      expect((await send(s.body, { "Content-Length": String(65 * 1024) })).status).toBe(400);
      expect(s.sent()).toBe(0);
    });
    it("a style just under it still lands, however it is split", async () => {
      const text = JSON.stringify({ image: part() }), bytes = new TextEncoder().encode(text);
      const body = new ReadableStream<Uint8Array>({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } });
      expect((await send(body)).status).toBe(200);
      expect(mine().share_style).toEqual({ image: part() });
    });
    it("no body, and junk: refused, not thrown", async () => {
      expect((await PUT(new NextRequest(URL_, { method: "PUT", headers: { "X-Session-Token": "me" } }))).status).toBe(400);
      expect((await put("not json")).status).toBe(400);
    });
  });

  it("a read's limit: per account, 120 a minute, its own count; over it 429 before anything is read", async () => {
    await get("me");
    expect(state.limitCalls).toEqual([["share-style:read:user-me", 120, 60_000]]);
    state.calls = [];
    state.limit = { allowed: false, retryAfterSeconds: 9 };
    const res = await get("me");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("9");
    expect(state.calls).toEqual([]);
  });

  it("the limit: per account, 30 a minute; over it 429 before anything is read", async () => {
    await put({ image: part() });
    expect(state.limitCalls).toEqual([["share-style:user-me", 30, 60_000]]);
    state.calls = [];
    state.limit = { allowed: false, retryAfterSeconds: 9 };
    expect((await put({ image: part() })).status).toBe(429);
    expect(state.calls).toEqual([]);
  });
});
