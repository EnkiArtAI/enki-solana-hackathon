import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import type { VideoAdapter } from "@/lib/video/adapters/types";
import { VIDEO_ADAPTERS } from "@/lib/video/adapters";
import { VIDEO_MODELS } from "@/lib/video/models";
import { ROUTES_SQL, availableAt, loadVideoRoutes, type VideoRoute } from "@/lib/video/routes";
import { RATES } from "./rates";

/**
 * The operator's row (Kev, 2026-11-03: "wir wechseln den betreiber später"): SQL 68 and GET /api/video/models on PGlite,
 * after the real SQL 67, and each of the five conditions a model needs to be available. Blind spot: PGlite's stand-in is not
 * PostgREST; its PGRST205 on a missing table is what the live table answers (`video_routes 404 PGRST205`, read 2026-11-03).
 */
const pgs = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => pgs.client }));
import { GET } from "../../../app/api/video/models/route";

const MIGRATIONS = join(__dirname, "..", "..", "..", "migrations");
const file = (name: string) => readFileSync(join(MIGRATIONS, name), "utf8");
const SQL67 = file("2026-11-03-video-models.sql");
const SQL68 = file("2026-11-03-video-routes.sql");
const STUBS = `
  create role anon; create role authenticated; create role service_role bypassrls;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create table public.models (id uuid primary key default gen_random_uuid(), name text not null, price numeric, allowed_ratios text[], active boolean default true,
    created_at timestamptz default now(), max_reference_images int not null default 0, allowed_filetypes text[] not null default '{}', media_type text not null default 'image');
  insert into public.models (name, media_type) values ('Nano Banana Pro', 'image');
`;
const answer = async () => (await GET()).json() as Promise<Record<string, unknown> & { models: Array<Record<string, unknown>>; run?: string }>;
const WAN = "(select id from public.models where name = 'Wan 3.0')";
const WAN_COST = `update public.video_routes set cost = '{"480p": 50000, "720p": 100000, "1080p": 200000}' where model_id = ${WAN}`;

describe("SQL 68 and its read", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(STUBS);
    pgs.client = pglitePostgrest(db).client;
  }, 60_000);
  afterAll(async () => { await db.close(); });
  beforeEach(() => { vi.restoreAllMocks(); });

  it("before it runs the answer is empty, and it and the log name the file", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await answer()).toEqual({ models: [], run: "68-video-routes.sql" });
    expect(said).toHaveBeenCalledWith("[video] video_routes is missing or empty: run sql-to-run/68-video-routes.sql");
    expect(ROUTES_SQL).toBe("68-video-routes.sql");
  });

  it("run before SQL 67 it inserts nothing and still names the file; run again after 67 it fills the six rows", async () => {
    await db.exec(SQL68);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await answer()).run).toBe("68-video-routes.sql");
    await db.exec(SQL67);
    await db.exec(SQL68);
    const { models, run } = await answer();
    expect(run).toBeUndefined();
    expect(models.map((m) => m.id)).toEqual(VIDEO_MODELS.map((m) => m.id));
  });

  it("seeds the list rates, operator empty, which is what every test here prices", async () => {
    const { models } = await answer();
    expect(Object.fromEntries(models.map(({ id, cost, audioCost, clipsAdded }) => [id, { cost, audioCost, clipsAdded }]))).toEqual(RATES);
    const { rows } = await db.query<{ operator: string | null; provider_model: string | null; rate_operator: string | null }>("select operator, provider_model, rate_operator from public.video_routes");
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.operator === null && r.provider_model === null && r.rate_operator === null)).toBe(true);
  });

  it("answers rates and where a model can run, nowhere for now, and never who runs it", async () => {
    await db.exec(`update public.video_routes set operator = 'acme', provider_model = 'acme-video-9', rate_operator = 'acme' where model_id = ${WAN}`);
    expect(JSON.stringify(await answer())).not.toMatch(/acme|operator|provider/i);
    // No adapter under that name: an operator alone reaches nothing.
    expect((await answer()).models.every((m) => (m.available as unknown[]).length === 0)).toBe(true);
    await db.exec(`update public.video_routes set operator = null, provider_model = null, rate_operator = null`);
  });

  it("a re-run leaves a row as Kev left it", async () => {
    await db.exec(`update public.video_routes set cost = '{"480p": 1}' where model_id = ${WAN}`);
    await db.exec(SQL68);
    expect((await answer()).models.find((m) => m.id === "wan-3.0")!.cost).toEqual({ "480p": 1 });
    await db.exec(WAN_COST);
  });

  it("a stored cell that is no price is no cell", async () => {
    await db.exec(`update public.video_routes set cost = '{"480p": 0, "720p": "9", "1080p": 1.5, "4K": 7}' where model_id = ${WAN}`);
    expect((await answer()).models.find((m) => m.id === "wan-3.0")!.cost).toEqual({});
    await db.exec(WAN_COST);
  });

  it("an inactive model, or a row that is an image, has no route", async () => {
    await db.exec(`update public.models set active = false where name = 'Kling 4.0'`);
    expect((await answer()).models.map((m) => m.id)).not.toContain("kling-4.0");
    await db.exec(`update public.models set active = true where name = 'Kling 4.0'`);
    await db.exec(`update public.models set media_type = 'image' where name = 'Kling 3.0'`);
    expect((await answer()).models.map((m) => m.id)).not.toContain("kling-3.0");
    await db.exec(`update public.models set media_type = 'video' where name = 'Kling 3.0'`);
  });

  it("an operator needs its whole row, and the table is the service role's alone", async () => {
    await expect(db.exec(`update public.video_routes set operator = 'acme'`)).rejects.toThrow(/video_routes_operator_whole/);
    const { rows } = await db.query<{ grantee: string; privilege_type: string }>(
      "select grantee, privilege_type from information_schema.role_table_grants where table_name = 'video_routes' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') order by 1, 2",
    );
    expect(rows.map((g) => `${g.grantee}:${g.privilege_type}`)).toEqual(["service_role:INSERT", "service_role:SELECT", "service_role:UPDATE"]);
    const rls = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'video_routes'");
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });
});

describe("a model is available only when all five hold", () => {
  const ready: VideoAdapter = { configured: () => true, submit: async () => ({ taskId: "t" }), poll: async () => ({ state: "running" }) };
  const noKey: VideoAdapter = { ...ready, configured: () => false };
  const route = (over: Partial<VideoRoute> = {}): VideoRoute => ({ id: "x", modelId: "mx", operator: "acme", providerModel: "m", rateOperator: "acme", rate: { cost: { "480p": 1, "1080p": 2 }, clipsAdded: false }, ...over });
  const all = { acme: ready };

  it("all five: the resolutions with a rate cell", () => {
    expect(availableAt(route(), all)).toEqual(["480p", "1080p"]);
  });
  it("no operator", () => { expect(availableAt(route({ operator: null, rateOperator: null }), all)).toEqual([]); });
  it("no adapter under that name", () => { expect(availableAt(route({ operator: "other", rateOperator: "other" }), all)).toEqual([]); });
  it("its key is not set", () => { expect(availableAt(route(), { acme: noKey })).toEqual([]); });
  it("a rate left over from another operator", () => {
    expect(availableAt(route({ rateOperator: "before" }), all)).toEqual([]);
    expect(availableAt(route({ rateOperator: null }), all)).toEqual([]);
  });
  it("no rate cell at that resolution", () => {
    expect(availableAt(route({ rate: { cost: {}, clipsAdded: false } }), all)).toEqual([]);
    expect(availableAt(route({ rate: { cost: { "720p": 9 }, clipsAdded: false } }), all)).toEqual(["720p"]);
  });

  it("the registry holds the one operator's file; no image provider's key reaches anything", () => {
    vi.stubEnv("WAVESPEED_API_KEY", "set");
    vi.stubEnv("GEMINI_API_KEY", "set");
    expect(Object.keys(VIDEO_ADAPTERS)).toEqual(["byteplus"]);
    expect(availableAt(route())).toEqual([]);
    vi.unstubAllEnvs();
  });
});

describe("the read", () => {
  it("a failed read that is no missing table throws, so an outage is never read as 'no routes'", async () => {
    const fail = { code: "57014", message: "statement timeout" };
    const q = { select: () => q, eq: () => q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: fail }).then(ok) };
    await expect(loadVideoRoutes({ from: () => q } as never)).rejects.toEqual(fail);
  });
});
