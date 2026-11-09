import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSource } from "@/lib/__tests__/_read-source";
import { imageIdWithin, payerAccount, userIdForPayer } from "@/lib/generation/record";

/**
 * Agents are full accounts (Kev, 2026-10-14): a wallet that pays through x402
 * has its renders recorded under the account it is linked to (a brand's
 * agent) or its own, made at its first paid render with the rows a wallet
 * login makes. And every account says where it came from (users.origin), every
 * render which way it came (generations.rail), so the share of agents, e-mail
 * and wallet customers is one GROUP BY.
 */
type Call = { table: string; op: "select" | "insert" | "delete"; values?: Record<string, unknown>; filters: unknown[][] };

function fakeDb(answer: (c: Call) => unknown) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = (name: string) => (...a: unknown[]) => { call.filters.push([name, ...a]); return b; };
    for (const k of ["eq", "ilike", "is"]) b[k] = chain(k);
    b.select = () => b;
    b.insert = (v: Record<string, unknown>) => { call.op = "insert"; call.values = v; return b; };
    b.delete = () => { call.op = "delete"; return b; };
    b.maybeSingle = () => b;
    b.single = () => b;
    b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(() => answer(call)).then(ok, bad);
    return b;
  };
  return { calls, client: { from } as unknown as SupabaseClient };
}

const WALLET = "7Yk3r9dQmPvZx1aBcDeFgHiJkLmNoPqRsTuVwXyZ1234";
const none = { data: null, error: null };
const inserts = (calls: Call[], table: string) => calls.filter((c) => c.table === table && c.op === "insert").map((c) => c.values);

describe("userIdForPayer", () => {
  it("answers the account a wallet is linked to first, exactly by address, and reads nothing else", async () => {
    const { client, calls } = fakeDb((c) => (c.table === "linked_wallets" ? { data: { user_id: "u-brand" }, error: null } : none));
    expect(await userIdForPayer(client, WALLET)).toBe("u-brand");
    expect(calls.map((c) => c.table)).toEqual(["linked_wallets"]);
    expect(calls[0].filters).toContainEqual(["eq", "address", WALLET]);
  });

  it("answers the wallet's own account next, case-insensitively, among the live wallet rows", async () => {
    const { client, calls } = fakeDb((c) => (c.table === "user_wallets" ? { data: { user_id: "u-own" }, error: null } : none));
    expect(await userIdForPayer(client, WALLET)).toBe("u-own");
    expect(calls.map((c) => c.table)).toEqual(["linked_wallets", "user_wallets"]);
    expect(calls[1].filters).toContainEqual(["ilike", "address", WALLET]);
    expect(calls[1].filters).toContainEqual(["is", "removed_at", null]);
    expect(inserts(calls, "users")).toEqual([]);
  });

  it("makes the account at the first paid render: an agent user and its primary Solana wallet, as a login would", async () => {
    const { client, calls } = fakeDb((c) => (c.table === "users" && c.op === "insert" ? { data: { id: "u-new" }, error: null } : c.op === "insert" ? { error: null } : none));
    expect(await userIdForPayer(client, WALLET)).toBe("u-new");
    expect(inserts(calls, "users")).toEqual([{ origin: "agent" }]);
    expect(inserts(calls, "user_wallets")).toEqual([{ user_id: "u-new", address: WALLET, chain_family: "solana", wallet_type: "external_eoa", is_primary: true }]);
  });

  it("mints nothing on a lookup that did not answer, and nothing for an empty address or no client", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, calls } = fakeDb((c) => (c.table === "user_wallets" ? { data: null, error: { message: "db down" } } : none));
    expect(await userIdForPayer(client, WALLET)).toBeNull();
    expect(inserts(calls, "users")).toEqual([]);
    expect(await userIdForPayer(client, "")).toBeNull();
    expect(await userIdForPayer(null, WALLET)).toBeNull();
    expect(calls).toHaveLength(2);
    warn.mockRestore();
  });

  it("loses the race gracefully: the orphan user goes, the wallet row that won is the account", async () => {
    let wallets = 0;
    const { client, calls } = fakeDb((c) => {
      if (c.table === "users" && c.op === "insert") return { data: { id: "u-orphan" }, error: null };
      if (c.table === "user_wallets" && c.op === "insert") return { error: { code: "23505", message: "duplicate" } };
      if (c.table === "user_wallets") return ++wallets === 1 ? none : { data: { user_id: "u-winner" }, error: null };
      return none;
    });
    expect(await userIdForPayer(client, WALLET)).toBe("u-winner");
    const gone = calls.find((c) => c.table === "users" && c.op === "delete");
    expect(gone?.filters).toContainEqual(["eq", "id", "u-orphan"]);
    expect(calls.map((c) => `${c.table}:${c.op}`)).toEqual(["linked_wallets:select", "user_wallets:select", "users:insert", "user_wallets:insert", "users:delete", "user_wallets:select"]);
  });

  it("gives up on any other wallet write failure, without an orphan and without guessing another account", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let wallets = 0;
    const { client, calls } = fakeDb((c) => {
      if (c.table === "users" && c.op === "insert") return { data: { id: "u-orphan" }, error: null };
      if (c.table === "user_wallets" && c.op === "insert") return { error: { code: "23514", message: "check" } };
      // A second wallet lookup would find someone: a check failure is no race, so it must not be asked.
      if (c.table === "user_wallets") return ++wallets === 1 ? none : { data: { user_id: "u-someone" }, error: null };
      return none;
    });
    expect(await userIdForPayer(client, WALLET)).toBeNull();
    expect(calls.map((c) => `${c.table}:${c.op}`)).toEqual(["linked_wallets:select", "user_wallets:select", "users:insert", "user_wallets:insert", "users:delete"]);
    warn.mockRestore();
  });
});

describe("payerAccount (ENG-07): a blip no longer leaves a paid render unrecorded", () => {
  it("asks again when the lookup did not answer, and finds the account", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let tries = 0;
    const { client } = fakeDb((c) => {
      if (c.table !== "user_wallets") return none;
      return ++tries === 1 ? { data: null, error: { message: "db down" } } : { data: { user_id: "u-own" }, error: null };
    });
    expect(await payerAccount(client, WALLET, { gapMs: 0 })).toBe("u-own");
    expect(tries).toBe(2);
    warn.mockRestore();
  });

  it("gives up after three tries and mints nothing on a lookup that never answered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, calls } = fakeDb((c) => (c.table === "user_wallets" ? { data: null, error: { message: "db down" } } : none));
    expect(await payerAccount(client, WALLET, { gapMs: 0 })).toBeNull();
    expect(calls.filter((c) => c.table === "user_wallets")).toHaveLength(3);
    expect(inserts(calls, "users")).toEqual([]);
    warn.mockRestore();
  });

  it("asks nothing without a client or an address", async () => {
    expect(await payerAccount(null, WALLET)).toBeNull();
    const { client, calls } = fakeDb(() => none);
    expect(await payerAccount(client, "")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("imageIdWithin (REC-1): the answer names the gallery row when it can, and never waits long", () => {
  const later = <T,>(ms: number, v: T) => new Promise<T>((done) => setTimeout(() => done(v), ms));

  it("answers the gallery row's id when the record lands in time", async () => {
    expect(await imageIdWithin(later(1, { generationId: "g", imageId: "img" }), 1_000)).toBe("img");
  });

  it("answers null and stops waiting when the record is slow; the record itself goes on", async () => {
    const slow = later(200, { generationId: "g", imageId: "img" });
    const started = Date.now();
    expect(await imageIdWithin(slow, 20)).toBeNull();
    expect(Date.now() - started).toBeLessThan(150);
    expect((await slow)?.imageId).toBe("img");
  });

  it("answers null for a record without a gallery row, none at all, or one that threw", async () => {
    expect(await imageIdWithin(later(1, { generationId: "g", imageId: null }), 1_000)).toBeNull();
    expect(await imageIdWithin(later(1, null), 1_000)).toBeNull();
    expect(await imageIdWithin(Promise.reject(new Error("boom")), 1_000)).toBeNull();
  });
});

describe("origin and rail", () => {
  const ROOT = join(__dirname, "..", "..");
  const src = (...p: string[]) => readSource(join(ROOT, ...p));

  it("every account says where it came from", () => {
    expect(src("app", "api", "auth", "session", "route.ts")).toContain('const userInsert = await supabase.from("users").insert({ origin: "wallet" }).select("id").single();');
    expect(src("lib", "access-invite.ts")).toContain('.insert({ account_status: "active", role: "beta", origin: "email" })');
    expect(src("lib", "generation", "record.ts")).toContain('const made = await supabase.from("users").insert({ origin: "agent" }).select("id").single();');
  });

  it("every render says which way it came", () => {
    expect(src("lib", "generation", "record.ts")).toContain("rail: rec.rail,");
    expect(src("lib", "generation", "record.ts")).toContain('export type GenerationRail = "web" | "free" | "x402" | "mcp";');
    expect(src("app", "api", "generate-image", "route.ts")).toContain('rail: "web",');
    expect(src("app", "api", "generate-free", "route.ts")).toContain('rail: "free",');
    expect(src("app", "api", "x402", "generate", "route.ts")).toContain('rail: "x402",');
  });

  it("has its migration", () => {
    expect(existsSync(join(ROOT, "migrations", "2026-10-14-users-origin-generations-rail.sql"))).toBe(true);
  });
});
