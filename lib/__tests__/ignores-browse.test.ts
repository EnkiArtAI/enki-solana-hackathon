import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakePostgrest } from "./_fake-postgrest";
import { DbUnreachableError } from "@/lib/db-error";

/**
 * Whom a viewer ignores leaves the feed, search and a prompt's images (Kev, 2026-10-29: "i dont see the prompts and
 * images of the person anymore, but can still stumble over his creations later through comments or so or show in the
 * filters that also ignored ppl shall be visible"): not an artist's own shelf, not the Likes and bookmarks the viewer
 * picked, and not with ?ignored=1 (the feed's Show ignored pill, for the feed and search; a prompt's images and the
 * search suggestions have none). A guest costs no read; a read that fails (SQL 48 not
 * run) ignores nobody; an unreachable database is the outage 503.
 */
const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null, reads: [] as string[] }));
const who = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({
  from: (t: string) => { db.reads.push(t); return (db.current!.client as SupabaseClient).from(t); },
  // search_prompts ranks every prompt seeded, in order; nothing else is asked here.
  rpc: async (fn: string) => {
    if (fn === "search_creators") return { data: [], error: null };
    if (fn === "suggest_titles") return { data: (db.current!.tables.prompts ?? []).map((p) => ({ id: p.id, title: p.title })), error: null };
    if (fn !== "search_prompts") throw new Error(`rpc ${fn}`);
    return { data: (db.current!.tables.prompts ?? []).map((p) => ({ id: p.id, rank: 1 })), error: null };
  },
}) }));
vi.mock("@/lib/adult-content", async (original) => ({
  ...(await original<typeof import("@/lib/adult-content")>()),
  viewer: async () => ({ userId: who.id, showAdult: false }),
}));
vi.mock("@/lib/session-user", async (original) => ({
  ...(await original<typeof import("@/lib/session-user")>()),
  resolveSessionUserId: async (_s: unknown, t: string | null) => {
    if (t === "unreadable") throw new Error("auth_sessions 500");
    return t === "viewer" ? who.id : null;
  },
}));

import { GET as feed } from "../../app/api/marketplace/prompts/route";
import { GET as search } from "../../app/api/search/route";
import { GET as strip } from "../../app/api/prompts/[id]/images/route";
import { GET as suggest } from "../../app/api/search/suggest/route";
import { ignoredIds, withoutIgnored, MAX_IGNORED } from "@/lib/ignores";

const ME = "00000000-0000-4000-8000-000000000001";
const ANN = "00000000-0000-4000-8000-000000000002";
const BOB = "00000000-0000-4000-8000-000000000003";
const CAT = "00000000-0000-4000-8000-000000000004";
const P = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const prompt = (n: number, creator: string) => ({
  id: P(n), creator_id: creator, title: `p${n}`, prompt_type: "free", is_listed: true, listing_status: "active",
  deleted_at: null, is_adult: false, showcase_images: [],
});
const image = (id: string, user: string) => ({
  id, prompt_id: P(1), user_id: user, storage_url: `https://blob/${id}.png`, preview_url: null, thumbnail_url: null,
  visibility: "public", is_uploaded: false, deleted_at: null, is_adult: false, created_at: "2026-10-29T10:00:00Z",
});

let ip = 0;
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const feedOf = async (query = "") => {
  const res = await feed(new NextRequest(`http://enki.test/api/marketplace/prompts?limit=12${query}`));
  return [res.status, res.status === 200 ? ids((await res.json()).prompts) : null];
};
const searchOf = async (query = "", token: string | null = "viewer") => {
  const headers: Record<string, string> = { "x-real-ip": `10.7.0.${++ip}`, ...(token ? { "X-Session-Token": token } : {}) };
  const res = await search(new NextRequest(`http://enki.test/api/search?q=p&type=prompts${query}`, { headers }));
  return [res.status, res.status === 200 ? ids((await res.json()).prompts) : null];
};
const suggestOf = async (token: string | null = "viewer") => {
  const headers: Record<string, string> = { "x-real-ip": `10.6.0.${++ip}`, ...(token ? { "X-Session-Token": token } : {}) };
  const res = await suggest(new NextRequest("http://enki.test/api/search/suggest?q=p", { headers }));
  return [res.status, res.status === 200 ? ids((await res.json()).titles) : null];
};
const stripOf = async (query = "") => {
  const res = await strip(new Request(`http://enki.test/api/prompts/${P(1)}/images${query}`), { params: Promise.resolve({ id: P(1) }) });
  return [res.status, res.status === 200 ? ids((await res.json()).images) : null];
};

beforeEach(() => {
  db.current = fakePostgrest();
  db.reads = [];
  who.id = ME;
  db.current.tables.users = [ME, ANN, BOB, CAT].map((id, i) => ({ id, handle: `u${i}`, display_name: null, account_status: "active", deleted_at: null }));
  db.current.tables.bans = [];
  db.current.tables.prompts = [prompt(1, ANN), prompt(2, BOB), prompt(3, CAT), prompt(4, ANN)];
  db.current.tables.generated_images = [image("i1", ANN), image("i2", BOB), image("i3", CAT)];
  // I ignore Ann and Bob; Cat ignores Ann, which is nothing to me.
  db.current.tables.user_ignores = [{ user_id: ME, ignored_id: ANN }, { user_id: ME, ignored_id: BOB }, { user_id: CAT, ignored_id: ANN }];
});

describe("the home feed", () => {
  it("leaves out whom I ignore, and shows them with ?ignored=1", async () => {
    expect(await feedOf()).toEqual([200, [P(3)]]);
    expect(await feedOf("&ignored=1")).toEqual([200, [P(1), P(2), P(3), P(4)]]);
    expect(await feedOf("&ignored=0")).toEqual([200, [P(3)]]);
  });

  it("shows an ignored artist's own shelf, and the Likes and bookmarks I picked", async () => {
    expect(await feedOf(`&creator=${ANN}`)).toEqual([200, [P(1), P(4)]]);
    expect(await feedOf(`&ids=${P(2)}&ids=${P(3)}`)).toEqual([200, [P(2), P(3)]]);
  });

  it("is everyone's for a guest, at no extra read", async () => {
    who.id = null;
    expect(await feedOf()).toEqual([200, [P(1), P(2), P(3), P(4)]]);
    expect(db.reads).not.toContain("user_ignores");
  });

  it("is everyone's while the table is not there yet (SQL 48), and the outage 503 when the database is unreachable", async () => {
    db.current!.state.failing = { table: "user_ignores", code: "PGRST205" };
    expect(await feedOf()).toEqual([200, [P(1), P(2), P(3), P(4)]]);
    db.current!.state.failing = { table: "user_ignores", code: "ECONNREFUSED" };
    expect(await feedOf()).toEqual([503, null]);
  });
});

describe("search", () => {
  it("leaves out whom I ignore, and shows them with ?ignored=1", async () => {
    expect(await searchOf()).toEqual([200, [P(3)]]);
    expect(await searchOf("&ignored=1")).toEqual([200, [P(1), P(2), P(3), P(4)]]);
  });

  it("is everyone's without a session, or with one that cannot be read, at no extra read", async () => {
    expect(await searchOf("", null)).toEqual([200, [P(1), P(2), P(3), P(4)]]);
    expect(await searchOf("", "unreadable")).toEqual([200, [P(1), P(2), P(3), P(4)]]);
    expect(db.reads).not.toContain("user_ignores");
  });

  it("answers the outage as one when the database is unreachable", async () => {
    db.current!.state.failing = { table: "user_ignores", code: "ECONNREFUSED" };
    expect(await searchOf()).toEqual([503, null]);
  });
});

describe("a prompt's images", () => {
  it("leave out the images of whom I ignore, whatever the address says", async () => {
    expect(await stripOf()).toEqual([200, ["i3"]]);
    expect(await stripOf("?ignored=1")).toEqual([200, ["i3"]]);
  });

  it("are everyone's for a guest, at no extra read, and the outage 503 when the database is unreachable", async () => {
    who.id = null;
    expect(await stripOf()).toEqual([200, ["i1", "i2", "i3"]]);
    expect(db.reads).not.toContain("user_ignores");
    who.id = ME;
    db.current!.state.failing = { table: "user_ignores", code: "ECONNREFUSED" };
    expect(await stripOf()).toEqual([503, null]);
  });
});

describe("search suggestions", () => {
  it("never suggest a title by whom I ignore", async () => {
    expect(await suggestOf()).toEqual([200, [P(3)]]);
  });

  it("are everyone's without a session, or with one that cannot be read, at no extra read", async () => {
    expect(await suggestOf(null)).toEqual([200, [P(1), P(2), P(3), P(4)]]);
    expect(await suggestOf("unreadable")).toEqual([200, [P(1), P(2), P(3), P(4)]]);
    expect(db.reads).not.toContain("user_ignores");
  });

  it("ask nothing about ignores when no title matched", async () => {
    db.current!.tables.prompts = [];
    expect(await suggestOf()).toEqual([200, []]);
    expect(db.reads).not.toContain("user_ignores");
  });

  it("keep every title when the filter read fails, and answer the outage as one", async () => {
    db.current!.state.failing = { table: "prompts", code: "XX000" };
    expect(await suggestOf()).toEqual([200, [P(1), P(2), P(3), P(4)]]);
    db.current!.state.failing = { table: "user_ignores", code: "ECONNREFUSED" };
    expect(await suggestOf()).toEqual([503, null]);
  });
});

describe("lib/ignores", () => {
  const client = () => db.current!.client as SupabaseClient;

  it("reads my own ignores, at most 150", async () => {
    expect(await ignoredIds(client(), ME)).toEqual([ANN, BOB]);
    db.current!.tables.user_ignores = Array.from({ length: 200 }, (_, i) => ({ user_id: ME, ignored_id: `x-${i}` }));
    expect(await ignoredIds(client(), ME)).toHaveLength(MAX_IGNORED);
  });

  it("ignores nobody for a guest, and when the read fails; throws the outage when the database is unreachable", async () => {
    expect(await ignoredIds(client(), null)).toEqual([]);
    db.current!.state.failing = { table: "user_ignores", code: "XX000" };
    expect(await ignoredIds(client(), ME)).toEqual([]);
    db.current!.state.failing = { table: "user_ignores", code: "ECONNREFUSED" };
    await expect(ignoredIds(client(), ME)).rejects.toBeInstanceOf(DbUnreachableError);
  });

  it("adds the filter only when someone is ignored", () => {
    const calls: unknown[][] = [];
    const q = { not: (...a: unknown[]) => { calls.push(a); return q; } };
    expect(withoutIgnored(q, "creator_id", [])).toBe(q);
    expect(calls).toEqual([]);
    withoutIgnored(q, "creator_id", [ANN, BOB]);
    expect(calls).toEqual([["creator_id", "in", `(${ANN},${BOB})`]]);
  });
});
