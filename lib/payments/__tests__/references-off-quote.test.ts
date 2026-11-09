import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";

/**
 * A premium prompt whose creator switched buyers' reference images off (SQL 62): the quote every paid path prices through
 * refuses them, so no intent is ever written with them, on a real Postgres, with SQL 62 and without it. The UI hiding is
 * not the guard. A refused request costs nothing and says so plainly.
 */
const pgs = vi.hoisted(() => ({ client: null as unknown }));
const who = vi.hoisted(() => ({ ME: "00000000-0000-4000-8000-000000000001", BUYER: "00000000-0000-4000-8000-000000000002" }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => pgs.client }));
vi.mock("@/lib/session-user", async (original) => ({
  ...(await original<typeof import("@/lib/session-user")>()),
  resolveOwnerIds: async (_s: unknown, t: string | null) => (t === "me" ? [who.ME] : t === "buyer" ? [who.BUYER] : null),
}));
vi.mock("@/lib/auth", () => ({
  requireAuth: async (req: Request) => {
    const me = req.headers.get("X-Session-Token") === "me";
    return { userId: me ? who.ME : who.BUYER, walletAddress: me ? "WalletOfTheCreator" : "WalletOfTheBuyer" };
  },
  authRefusal: () => new Response("", { status: 401 }), checkRateLimit: () => true,
}));
vi.mock("@/lib/rate-limit", () => ({ checkRequestRateLimit: () => ({ allowed: true }), rateLimitKey: () => "key", rateLimitResponse: () => new Response("", { status: 429 }) }));
vi.mock("@/lib/webauthn", () => ({ resolveStableUserId: async () => "buyer-id", requireActionStepUp: async () => null }));
// The model row is not what this file is about: any id is GPT Image 2, taking up to 4 references.
vi.mock("@/lib/generation/models", async (original) => ({
  ...(await original<typeof import("@/lib/generation/models")>()),
  resolveModel: async () => ({ id: "00000000-0000-4000-8000-00000000000a", name: "GPT Image 2", maxRefs: 4, maxResolution: "4K", supportsQuality: false, normal: { provider: "openai" } }),
}));

import { computeQuote } from "@/lib/payments/generation-quote";
import { POST as quoteRoute } from "../../../app/api/payments/generation/quote/route";
import { POST as intentRoute } from "../../../app/api/payments/generation/intent/route";

const { ME, BUYER } = who;
const SQL = readFileSync(join(__dirname, "..", "..", "..", "migrations", "2026-11-02-prompt-allow-references.sql"), "utf8");
const REFUSED = "This prompt does not take reference images. Nothing was charged.";
const MODEL = "00000000-0000-4000-8000-00000000000a";
const STUBS = `
  create table public.users (id uuid primary key, role text default 'user', deleted_at timestamptz, account_status text default 'active');
  insert into public.users (id) values ('${ME}'), ('${BUYER}');
  create table public.bans (user_id uuid, lifted_at timestamptz, expires_at timestamptz);
  create table public.user_wallets (user_id uuid, address text, chain_family text, removed_at timestamptz);
  insert into public.user_wallets values ('${ME}', 'So1anaWa11etOfTheCreator111111111111111111', 'solana', null);
  create table public.pricing_rules (id uuid primary key, active boolean);
  create table public.prompts (id uuid primary key default gen_random_uuid(), creator_id uuid, price_usd_cents int, prompt_type text, is_free_showcase boolean default false,
    is_listed boolean default true, listing_status text default 'active', deleted_at timestamptz);
  create table public.generation_payment_intents (id uuid primary key default gen_random_uuid(), buyer_wallet text, prompt_id uuid, model_id text, model_family text, resolution text,
    quality text, boost boolean, reference_image_count int, artist_wallet text, artist_amount_micro bigint, model_cost_micro bigint, enki_fee_micro bigint, total_micro bigint, fee_bps int, fee_base text, fee_mode text,
    expires_at timestamptz, applied_rule_id uuid);
`;

let db: PGlite;
let supabase: SupabaseClient;
const prompt = async (fields: { type?: string; allow?: boolean; free?: boolean } = {}) => {
  const { rows } = await db.query<{ id: string }>(`insert into public.prompts (creator_id, price_usd_cents, prompt_type, is_free_showcase) values ($1, 40, $2, $3) returning id`,
    [ME, fields.type ?? "paid", fields.free ?? false]);
  if (fields.allow === false) await db.query(`update public.prompts set allow_references = false where id = $1`, [rows[0].id]);
  return rows[0].id;
};
const ask = (promptId: string, references: number, sessionToken: string | null = "buyer") =>
  computeQuote(supabase, { promptId, modelFamily: "gpt-image-2", resolution: "2K", referenceImageCount: references, sessionToken });
const post = (route: (r: NextRequest) => Promise<Response>, path: string, body: unknown, token = "buyer") =>
  route(new NextRequest(`http://enki.test/api/payments/generation/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": token }, body: JSON.stringify(body) }));
const settings = (promptId: string, referenceImageCount: number) => ({ promptId, modelId: MODEL, resolution: "2K", referenceImageCount });
const intents = async () => (await db.query(`select 1 from public.generation_payment_intents`)).rows.length;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(STUBS);
  supabase = pglitePostgrest(db).client as unknown as SupabaseClient;
  pgs.client = supabase;
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec(`truncate public.prompts, public.generation_payment_intents`); });

describe("before SQL 62", () => {
  it("a premium prompt quotes with references as today", async () => {
    expect(await ask(await prompt(), 2)).toMatchObject({ ok: true });
  });
});

describe("with SQL 62", () => {
  beforeAll(async () => { await db.exec(SQL); });

  it("a buyer's references on a switched-off prompt are refused, plainly, a request without any is priced", async () => {
    const id = await prompt({ allow: false });
    expect(await ask(id, 1)).toEqual({ ok: false, status: 422, error: REFUSED });
    expect(await ask(id, 0)).toMatchObject({ ok: true });
    // No count at all, as the x402 rail asks (it refuses them itself: x402-settle-route.test.ts).
    expect(await computeQuote(supabase, { promptId: id, modelFamily: "gpt-image-2", resolution: "2K" })).toMatchObject({ ok: true });
  });

  it("a prompt left on keeps today's behaviour, and references still price more than none", async () => {
    const id = await prompt();
    const none = await ask(id, 0);
    const two = await ask(id, 2);
    expect(two.ok && none.ok && two.split.totalMicro > none.split.totalMicro).toBe(true);
  });

  it("a free prompt ignores it", async () => {
    expect(await ask(await prompt({ type: "free", allow: false }), 1)).toMatchObject({ ok: true });
    expect(await ask(await prompt({ type: "create-now", free: true, allow: false }), 1)).toMatchObject({ ok: true });
  });

  it("its creator's own test render is as ever; nobody else, and no session, is them", async () => {
    const id = await prompt({ allow: false });
    expect(await ask(id, 1, "me")).toMatchObject({ ok: true });
    expect(await ask(id, 1, null)).toMatchObject({ ok: false, status: 422 });
  });

  it("a read of the setting that fails prices nothing", async () => {
    const id = await prompt({ allow: false });
    const failing = { from: (table: string) => (table !== "prompts" ? supabase.from(table) : {
      select: (cols: string) => (cols.includes("allow_references")
        ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "fetch failed" } }) }) }
        : supabase.from(table).select(cols)),
    }) } as unknown as SupabaseClient;
    expect(await computeQuote(failing, { promptId: id, modelFamily: "gpt-image-2", resolution: "2K", referenceImageCount: 1, sessionToken: "buyer" })).toMatchObject({ ok: false, status: 503 });
    // Without references nothing asks it, so an outage of this one read costs them no quote.
    expect(await computeQuote(failing, { promptId: id, modelFamily: "gpt-image-2", resolution: "2K", sessionToken: "buyer" })).toMatchObject({ ok: true });
  });

  it("the quote route says so, for one and for each item of a picker's batch", async () => {
    const id = await prompt({ allow: false });
    const one = await post(quoteRoute, "quote", settings(id, 1));
    expect([one.status, ((await one.json()) as { error: string }).error]).toEqual([422, REFUSED]);
    const batch = await post(quoteRoute, "quote", { items: [settings(id, 0), settings(id, 1)] });
    const { quotes } = (await batch.json()) as { quotes: { error?: string; breakdown?: unknown }[] };
    expect(quotes[0].breakdown).toBeTruthy();
    expect(quotes[1]).toEqual({ error: REFUSED });
  });

  it("the intent route writes no intent, so nothing can be signed or charged; without references it does", async () => {
    const id = await prompt({ allow: false });
    const refused = await post(intentRoute, "intent", settings(id, 1));
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([422, REFUSED]);
    expect(await intents()).toBe(0);
    expect((await post(intentRoute, "intent", settings(id, 0))).status).toBe(200);
    expect(await intents()).toBe(1);
    expect((await post(intentRoute, "intent", settings(id, 1), "me")).status).toBe(200);
    expect(await intents()).toBe(2);
  });
});
