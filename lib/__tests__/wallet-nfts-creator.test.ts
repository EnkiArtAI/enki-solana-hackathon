import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Filter by NFT is the owner's alone (Kev, 2026-11-03, DEC-2026-11-03-57, which reverses DEC-2026-11-03-16). The route
 * answers ?creator= before it reads anything: no session, no table, no index call, no count against any limit, so a
 * foreign wallet's unmoderated pictures can never be asked for. The tables are a small PostgREST that records each read,
 * and the control below shows these stubs see the own list's reads.
 */
type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  session: null as string | null,
  tables: {} as Record<string, Row[]>,
  reads: [] as string[],
  sessions: 0,
}));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => { s.sessions += 1; return s.session; } }));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: (table: string) => {
      s.reads.push(table);
      let rows = [...(s.tables[table] ?? [])];
      const c: Record<string, unknown> = {
        select: () => c,
        eq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] === v); return c; },
        is: (k: string) => { rows = rows.filter((r) => r[k] == null); return c; },
        order: () => c,
        limit: () => c,
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok),
      };
      return c;
    },
  }),
}));

import { GET as list } from "../../app/api/wallet/nfts/route";

const RPC = "https://rpc.test/?api-key=k";
const MIRA = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
// Base58 has no 0, O, I or l.
const PUBLIC = "PubLicAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECOND = "SecondBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const MINE = "MineDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

let owners: string[] = [];
const ask = (query: string, viewer: string | null = VIEWER) => {
  s.session = viewer;
  return list(new NextRequest(`http://enki.test/api/wallet/nfts${query}`, { headers: { "X-Session-Token": "tok" } }));
};

beforeEach(() => {
  s.reads = [];
  s.sessions = 0;
  s.tables = {
    user_wallets: [{ user_id: MIRA, address: PUBLIC, chain_family: "solana", removed_at: null }, { user_id: VIEWER, address: MINE, chain_family: "solana", removed_at: null }],
    linked_wallets: [{ user_id: VIEWER, address: SECOND }],
  };
  owners = [];
  vi.stubEnv("SOLANA_RPC_URL", RPC);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== RPC) throw new Error(`unexpected fetch ${url}`);
    owners.push((JSON.parse(String(init?.body)) as { params: { ownerAddress: string } }).params.ownerAddress);
    return Response.json({ jsonrpc: "2.0", id: "x", result: { items: [{ id: "a", content: { metadata: { name: "a" }, links: { image: "https://host.test/a.png" } } }] } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("someone else's NFTs", () => {
  it.each([["a handle", "?creator=mira"], ["an id", `?creator=${MIRA}`], ["the viewer's own handle", "?creator=viewer"], ["no name", "?creator="], ["a name beside others", "?x=1&creator=mira"]])(
    "cannot be asked for by %s: refused before anything is read", async (_n, query) => {
      const res = await ask(query);
      expect([res.status, await res.json()]).toEqual([404, { error: "Creator not found" }]);
      expect(s.sessions).toBe(0);
      expect(s.reads).toEqual([]);
      expect(owners).toEqual([]);
    },
  );

  it("the same without a session", async () => {
    const res = await ask("?creator=mira", null);
    expect([res.status, await res.json()]).toEqual([404, { error: "Creator not found" }]);
    expect(s.reads).toEqual([]);
  });

  it("count against no limit: the thirty-first is still refused as not found, and the viewer's own thirty stand", async () => {
    for (let i = 0; i < 31; i++) expect((await ask("?creator=mira", "looker")).status).toBe(404);
    for (let i = 0; i < 30; i++) expect((await ask("", "looker")).status).toBe(200);
    expect((await ask("", "looker")).status).toBe(429);
  });
});

describe("control: the own list, with these same stubs", () => {
  it("reads the viewer's wallets, their own and the one they linked, and no one else's", async () => {
    const res = await ask("");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { wallets: number }).wallets).toBe(2);
    expect(s.sessions).toBe(1);
    expect(s.reads).toEqual(expect.arrayContaining(["user_wallets", "linked_wallets"]));
    expect(owners).toEqual([MINE, SECOND]);
  });

  it("still needs a session", async () => {
    const res = await ask("", null);
    expect([res.status, await res.json()]).toEqual([401, { error: "Not signed in" }]);
    expect(owners).toEqual([]);
  });
});
