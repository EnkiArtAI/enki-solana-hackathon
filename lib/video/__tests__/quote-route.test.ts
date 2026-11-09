import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import { microToUsd } from "@/lib/generation-checkout";
import { computeQuote } from "@/lib/payments/generation-quote";
import { videoLeg, videoSplit } from "@/lib/video/charge";
import { VIDEO_MODELS, startSettings, videoPrice } from "@/lib/video/models";
import { quoteVideo } from "@/lib/video/quote";
import { loadVideoRoutes } from "@/lib/video/routes";
import { RATES } from "./rates";

/**
 * POST /api/video/quote and quoteVideo on PGlite, with the real SQL 52, 67 and 68: what the chip shows is what computeQuote
 * answers for the same settings, a premium prompt adds its artist, and nothing is asked of any host. The session is stubbed
 * (lib/auth's own tests hold it). Blind spot: stubbed sessions, no wallet flow; PGlite is not PostgREST.
 */
const pgs = vi.hoisted(() => ({ client: null as unknown, user: { userId: "00000000-0000-4000-8000-0000000000aa" } as { userId: string } | null, refused: 0 }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => pgs.client }));
vi.mock("@/lib/session-user", async (original) => ({
  ...(await original<typeof import("@/lib/session-user")>()),
  resolveOwnerIds: async (_s: unknown, t: string | null) => (t === "artist" ? ["00000000-0000-4000-8000-000000000001"] : null),
}));
vi.mock("@/lib/auth", () => ({
  requireAuth: async () => { if (!pgs.user) throw new Error("no session"); return { ...pgs.user, walletAddress: "w" }; },
  authRefusal: () => { pgs.refused++; return new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 }); },
  checkRateLimit: () => true,
}));
import { POST } from "../../../app/api/video/quote/route";

const MIG = join(__dirname, "..", "..", "..", "migrations");
const sql = (name: string) => readFileSync(join(MIG, name), "utf8");
const ARTIST = "00000000-0000-4000-8000-000000000001";
const PREMIUM = "00000000-0000-4000-8000-0000000000b1";
const OPEN = "00000000-0000-4000-8000-0000000000b2";
const IMAGE = "00000000-0000-4000-8000-0000000000b3";
const NO_WALLET = "00000000-0000-4000-8000-0000000000b4";
const DRAFT = "00000000-0000-4000-8000-0000000000b5";
const STUBS = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create table public.users (id uuid primary key, deleted_at timestamptz, account_status text default 'active');
  insert into public.users (id) values ('${ARTIST}'), ('00000000-0000-4000-8000-000000000002');
  create table public.bans (id uuid primary key default gen_random_uuid(), user_id uuid, lifted_at timestamptz, expires_at timestamptz);
  create table public.user_wallets (user_id uuid, address text, chain_family text, removed_at timestamptz);
  insert into public.user_wallets (user_id, address, chain_family) values ('${ARTIST}', 'ArtistWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'solana');
  create table public.models (id uuid primary key default gen_random_uuid(), name text not null, price numeric, allowed_ratios text[], active boolean default true,
    created_at timestamptz default now(), max_reference_images int not null default 0, allowed_filetypes text[] not null default '{}', media_type text not null default 'image');
  create table public.prompts (id uuid primary key, creator_id uuid, title text, price_usd_cents int default 0, prompt_type text default 'free', is_free_showcase boolean default false,
    is_listed boolean default true, listing_status text default 'active', deleted_at timestamptz, showcase_images jsonb default '[]', created_at timestamptz default now());
  create table public.generated_images (id uuid primary key default gen_random_uuid());
`;
const ROWS = `
  insert into public.prompts (id, creator_id, title, price_usd_cents, prompt_type, media_type) values
    ('${PREMIUM}', '${ARTIST}', 'premium video', 40, 'paid', 'video'),
    ('${OPEN}', '${ARTIST}', 'open video', 0, 'free', 'video'),
    ('${IMAGE}', '${ARTIST}', 'an image', 40, 'paid', 'image'),
    ('${NO_WALLET}', '00000000-0000-4000-8000-000000000002', 'no wallet', 40, 'paid', 'video');
  insert into public.prompts (id, creator_id, title, prompt_type, media_type, is_listed) values ('${DRAFT}', '${ARTIST}', 'draft', 'free', 'video', false);
`;
const SD = VIDEO_MODELS[0];
const ask = (over: object = {}) => ({ modelId: SD.id, settings: startSettings(SD), ...over });
let address = 0;
const post = (body: unknown) => POST(new NextRequest("http://enki.test/api/video/quote", { method: "POST", body: JSON.stringify(body), headers: { "x-real-ip": `10.8.${++address >> 8}.${address & 255}` } }));
const json = async (body: unknown) => { const r = await post(body); return { status: r.status, body: await r.json() as Record<string, never> }; };

describe("before SQL 68", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(STUBS + sql("2026-11-03-video-prompts.sql") + sql("2026-11-03-video-models.sql"));
    pgs.client = pglitePostgrest(db).client;
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("answers no price and names the file", async () => {
    const { status, body } = await json(ask());
    expect([status, body]).toEqual([503, { error: "Video prices need sql-to-run/68-video-routes.sql." }]);
  });
});

describe("the quote", () => {
  let db: PGlite;
  let host: ReturnType<typeof vi.fn>;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(STUBS + sql("2026-11-03-video-prompts.sql") + sql("2026-11-03-video-models.sql") + sql("2026-11-03-video-routes.sql") + ROWS);
    pgs.client = pglitePostgrest(db).client;
  }, 60_000);
  afterAll(async () => { await db.close(); });
  beforeEach(() => {
    pgs.user = { userId: "00000000-0000-4000-8000-0000000000aa" };
    host = vi.fn(async () => { throw new Error("no host may be asked"); });
    vi.stubGlobal("fetch", host);
  });
  const total = (b: Record<string, never>) => Number((b.quote as { breakdown: { totalAmount: string } }).breakdown.totalAmount);

  it("own draft: the chip's number, nothing for an artist, not available, no host asked", async () => {
    const { status, body } = await json(ask());
    expect(status).toBe(200);
    const q = body.quote as { breakdown: Record<string, string>; available: boolean; promptId: null; modelId: string; settings: object; expiresAt: string };
    expect(`$${microToUsd(q.breakdown.totalAmount)}`).toBe(videoPrice(SD, RATES[SD.id], startSettings(SD)));
    expect(q.breakdown).toMatchObject({ artistAmount: "0", modelCost: "411200", enkiFee: "38800", enkiTotal: "450000", totalAmount: "450000" });
    expect(q).toMatchObject({ promptId: null, modelId: "seedance-2.5", settings: startSettings(SD), available: false });
    expect(Date.parse(q.expiresAt)).toBeGreaterThan(Date.now());
    expect(host).not.toHaveBeenCalled();
  });

  it("a video prompt is not sold on an image model, by any path that prices through computeQuote", async () => {
    const image = { modelFamily: "nano-banana-pro", resolution: "2K" as const };
    expect(await computeQuote(pgs.client as never, { promptId: PREMIUM, ...image })).toEqual({ ok: false, status: 422, error: "This prompt makes videos." });
    expect(await computeQuote(pgs.client as never, { promptId: OPEN, ...image })).toMatchObject({ ok: false, status: 422 });
    // Its creator's own render is as ever.
    expect((await computeQuote(pgs.client as never, { promptId: PREMIUM, ...image, sessionToken: "artist", artistWalletOptional: true })).ok).toBe(true);
    // The rail it was meant for, an image prompt on an image model and no prompt at all stand.
    expect((await computeQuote(pgs.client as never, { promptId: IMAGE, ...image })).ok).toBe(true);
    expect((await computeQuote(pgs.client as never, { ...image })).ok).toBe(true);
    const leg = videoLeg(SD, RATES[SD.id], startSettings(SD))!;
    expect((await computeQuote(pgs.client as never, { promptId: PREMIUM, modelFamily: SD.label, video: leg })).ok).toBe(true);
  });

  it("equals what computeQuote returns for the same settings", async () => {
    const leg = videoLeg(SD, RATES[SD.id], startSettings(SD))!;
    const direct = await computeQuote(pgs.client as never, { promptId: PREMIUM, modelFamily: SD.label, video: leg });
    expect(direct.ok).toBe(true);
    const shown = await quoteVideo(pgs.client as never, ask({ promptId: PREMIUM, clipTenths: 0 }) as never);
    expect(shown.ok && direct.ok && shown.split).toEqual(direct.ok && direct.split);
    expect(direct.ok && direct.split).toEqual(videoSplit(400_000, leg));
    expect(direct.ok && direct.artistWallet).toBe("ArtistWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("premium adds the artist and 10% of the artist; an open prompt adds nothing", async () => {
    const premium = await json(ask({ promptId: PREMIUM }));
    expect(total(premium.body)).toBe(450_000 + 400_000 + 40_000);
    expect((premium.body.quote as { breakdown: { artistAmount: string } }).breakdown.artistAmount).toBe("400000");
    expect(total((await json(ask({ promptId: OPEN }))).body)).toBe(450_000);
  });

  it("takes the prompt's rules from computeQuote: a draft answers 404, a missing payout wallet 422", async () => {
    expect((await json(ask({ promptId: DRAFT }))).status).toBe(404);
    const noWallet = await json(ask({ promptId: NO_WALLET }));
    expect(noWallet.status).toBe(422);
    expect(noWallet.body.error).toBe("Artist payout wallet not configured for this prompt");
  });

  it("an image prompt is no video's, and a prompt that is not there answers as one", async () => {
    expect(await json(ask({ promptId: IMAGE }))).toEqual({ status: 422, body: { error: "This prompt makes images." } });
    expect((await json(ask({ promptId: "00000000-0000-4000-8000-0000000000ff" }))).status).toBe(404);
  });

  it("reads the settings as the model takes them, and says so", async () => {
    const k4 = VIDEO_MODELS.find((m) => m.id === "kling-4.0")!;
    const { body } = await json({ modelId: k4.id, settings: { seconds: 60, aspect: "4:3", resolution: "480p", audio: false, bitrate: "high" } });
    expect((body.quote as { settings: object }).settings).toEqual({ seconds: 30, aspect: "16:9", resolution: "720p", audio: true, bitrate: "high" });
    expect(total(body)).toBe(videoLeg(k4, RATES[k4.id], { seconds: 30, aspect: "16:9", resolution: "720p", audio: true, bitrate: "high" })!.cents * 10_000);
  });

  it("no price where the rate is unread, or a cell is gone: never a number under the bill", async () => {
    expect(await json(ask({ clipTenths: 100 }))).toEqual({ status: 422, body: { error: "Seedance 2.5 has no price for these settings yet." } });
    const wan = VIDEO_MODELS.find((m) => m.id === "wan-3.0")!;
    expect((await json({ modelId: wan.id, settings: startSettings(wan), clipTenths: 100 })).status).toBe(200);
  });

  it("one video, whatever is asked: a count, an amount or an unknown field is refused, on its own and in a batch", async () => {
    for (const extra of [{ count: 2 }, { units: 2 }, { amount: 1 }, { totalMicro: 1 }]) {
      expect((await json(ask(extra))).status, JSON.stringify(extra)).toBe(400);
      expect((await json({ items: [ask(extra)] })).status, JSON.stringify(extra)).toBe(400);
    }
    expect((await json({ ...ask(), settings: { ...startSettings(SD), count: 2 } })).status).toBe(400);
  });

  it("an unknown generator is 400; a batch answers in order, a refusal in its own place", async () => {
    expect((await json(ask({ modelId: "veo-3.1" }))).status).toBe(400);
    const { status, body } = await json({ items: [ask(), ask({ modelId: "veo-3.1" }), ask({ promptId: IMAGE }), ask({ promptId: PREMIUM })] });
    expect(status).toBe(200);
    const quotes = body.quotes as unknown as Array<{ error?: string; breakdown?: { totalAmount: string } }>;
    expect(quotes.map((q) => q.error ?? q.breakdown?.totalAmount)).toEqual(["450000", "Unknown video generator", "This prompt makes images.", "890000"]);
  });

  it("needs a session", async () => {
    pgs.user = null;
    expect((await post(ask())).status).toBe(401);
  });

  it("every video costs: a zero, a cell that is gone and a rate that rounds to no cent are no price, never a $0 charge", async () => {
    const row = (await db.query<{ id: string }>(`select id from public.models where name = '${SD.label}'`)).rows[0].id;
    const stored = (await db.query<{ cost: object }>("select cost from public.video_routes where model_id = $1", [row])).rows[0].cost;
    const set = (cost: object) => db.query("update public.video_routes set cost = $1 where model_id = $2", [JSON.stringify(cost), row]);
    const none = { status: 422, body: { error: "Seedance 2.5 has no price for these settings yet." } };
    for (const cost of [{ "480p": 0 }, { "480p": -102800 }, { "720p": 231100 }, { "480p": 100 }, { "480p": 1 }, { "480p": "free" }]) {
      await set(cost);
      expect(await json(ask())).toEqual(none);
      expect(await json(ask({ promptId: OPEN }))).toEqual(none);
    }
    // A zero is no cell at all, so no resolution can read as available on it.
    await set({ "480p": 0 });
    expect((await loadVideoRoutes(pgs.client as never))?.find((r) => r.id === SD.id)?.rate.cost).toEqual({});
    // The smallest rate that still rounds to a cent: its quote is above zero.
    await set({ "480p": 1137 });
    expect(total((await json(ask({ promptId: OPEN }))).body)).toBe(10_000);
    await set(stored);
    expect(total((await json(ask({ promptId: OPEN }))).body)).toBe(450_000);
  });

  it("a pricing rule never touches a video: the rules are not even read", async () => {
    const read: string[] = [];
    const client = pgs.client as { from: (t: string) => unknown };
    const spy = { ...client, from: (t: string) => { read.push(t); return client.from(t); } };
    const q = await computeQuote(spy as never, { modelFamily: SD.label, buyer: "00000000-0000-4000-8000-0000000000aa", video: videoLeg(SD, RATES[SD.id], startSettings(SD))! });
    expect(q.ok).toBe(true);
    expect(read).toEqual([]);
  });
});
