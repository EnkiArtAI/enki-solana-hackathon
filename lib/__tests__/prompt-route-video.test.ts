import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pglitePostgrest } from "./_pglite-postgrest";

/**
 * Release of a video prompt (Kev, 2026-11-03: "allow also only the creation of 1 video for premium prompts"), POST and GET
 * /api/prompt on a real Postgres before and after SQL 52: one render, the creator's own, a real video; an image save reads
 * nothing of it. Generated SQL only; every check is stubbed, showsAdultRender is the real one. Blind spot: PGlite is not
 * PostgREST, the render rows are written here (nothing makes one until the next slice), and no storage is involved.
 */
const pgs = vi.hoisted(() => ({ client: null as unknown, iv: 0 }));
const who = vi.hoisted(() => ({ ME: "00000000-0000-4000-8000-000000000001", OTHER: "00000000-0000-4000-8000-000000000002" }));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64"); });
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => pgs.client }));
vi.mock("@/lib/crypto", () => ({
  encryptString: (text: string) => ({ encrypted: text, iv: `iv-${++pgs.iv}`, authTag: "tag", kid: "k1" }),
  decryptString: ({ encrypted }: { encrypted: string }) => encrypted,
}));
vi.mock("@/lib/session-user", async (original) => {
  const of = (t: string | null) => (t === "me" ? who.ME : t === "other" ? who.OTHER : null);
  return {
    ...(await original<typeof import("@/lib/session-user")>()),
    resolveSessionUserId: async (_s: unknown, t: string | null) => of(t),
    resolveSessionUserWithBan: async (_s: unknown, t: string | null) => ({ userId: of(t), ban: null }),
    resolveOwnerIds: async (_s: unknown, t: string | null) => (of(t) ? [of(t)] : null),
  };
});
vi.mock("@/lib/moderation", () => ({ moderate: async () => ({ allowed: true }), screenFirst: () => null, CLIENT_BLOCK_MESSAGE: "blocked" }));
vi.mock("@/lib/moderation-enforcement", () => ({ recordModerationEvent: async () => {} }));
vi.mock("@/lib/moderation/warnings", () => ({ recordWarning: async () => ({}), warningMessage: () => "warned" }));
vi.mock("@/lib/moderation/prompt-check", async (original) => ({ ...(await original<typeof import("@/lib/moderation/prompt-check")>()), checkPrompt: async () => ({ verdict: "clear" }) }));
vi.mock("@/lib/moderation/prompt-pause", () => ({ isPaused: async () => false }));
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), checkRequestRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/mfa", () => ({ enrolledFactors: async () => [] }));
vi.mock("@/lib/notifications", () => ({ notifyFollowers: async () => {} }));
vi.mock("@/lib/generation/small-renditions", () => ({ ensureShowcaseRenditions: async () => {} }));

import { GET as editorRead, POST as save } from "../../app/api/prompt/route";

const { ME, OTHER } = who;
const SQL52 = readFileSync(join(__dirname, "..", "..", "migrations", "2026-11-03-video-prompts.sql"), "utf8");
const STUBS = `
  create table public.users (id uuid primary key, origin text, deleted_at timestamptz, account_status text default 'active');
  insert into public.users (id) values ('${ME}'), ('${OTHER}');
  create table public.bans (user_id uuid, lifted_at timestamptz, expires_at timestamptz);
  create table public.user_wallets (user_id uuid, address text, chain_family text, removed_at timestamptz);
  insert into public.user_wallets values ('${ME}', 'So1anaWa11etOfTheCreator111111111111111111', 'solana', null);
  create table public.prompts (id uuid primary key default gen_random_uuid(), creator_id uuid, title text, description text, ai_model text, ai_settings jsonb,
    encrypted_content text, encrypted_content_iv text, encrypted_content_tag text, encrypted_content_kid text, is_listed boolean default false, listing_status text default 'draft',
    delisted_at timestamptz, listed_at timestamptz, published_at timestamptz, deleted_at timestamptz, showcase_images jsonb default '[]', showcase_before_images jsonb default '[]',
    is_adult boolean default false, category text, tags text[], price_usd_cents int, aspect_ratio text, photo_count int, prompt_type text, resolution text,
    is_free_showcase boolean default false, public_prompt_text text, updated_at timestamptz, created_at timestamptz, allow_references boolean default true);
  create table public.prompt_variables (id uuid primary key default gen_random_uuid(), prompt_id uuid, name text, label text, description text, data_type text, default_value text,
    is_required boolean, position int, min_value numeric, max_value numeric, options jsonb, created_at timestamptz, updated_at timestamptz, deleted_at timestamptz);
  create table public.generated_images (id uuid primary key default gen_random_uuid(), storage_url text, preview_url text, thumbnail_url text, view_url text, tiny_url text, user_id uuid,
    mime_type text, is_uploaded boolean default false, is_adult boolean default false, deleted_at timestamptz);
`;
const FILES = { preview: "https://v/p.mp4", v720: "https://v/720.mp4", v1080: null, poster: "https://v/poster.webp", width: 480, height: 854, durationMs: 6000 };
const MINE = "00000000-0000-4000-8000-0000000000a1";
const THEIRS = "00000000-0000-4000-8000-0000000000a2";
const PICTURE = "00000000-0000-4000-8000-0000000000a3";
const NOT_A_FILM = "00000000-0000-4000-8000-0000000000a6";
const NO_FILES = "00000000-0000-4000-8000-0000000000a7";
const GONE = "00000000-0000-4000-8000-0000000000a4";
const ADULT = "00000000-0000-4000-8000-0000000000a5";
const RENDERS = `
  insert into public.generated_images (id, user_id, storage_url, thumbnail_url, mime_type, video, is_adult, deleted_at) values
    ('${MINE}', '${ME}', '${FILES.v720}', '${FILES.poster}', 'video/mp4', '${JSON.stringify(FILES)}', false, null),
    ('${THEIRS}', '${OTHER}', 'https://t/720.mp4', 'https://t/poster.webp', 'video/mp4', '${JSON.stringify({ ...FILES, poster: "https://t/poster.webp" })}', false, null),
    ('${PICTURE}', '${ME}', 'https://a/1.png', 'https://a/1t.png', 'image/png', null, false, null),
    ('${GONE}', '${ME}', 'https://g/720.mp4', 'https://g/poster.webp', 'video/mp4', '${JSON.stringify({ ...FILES, poster: "https://g/poster.webp" })}', false, now()),
    ('${NO_FILES}', '${ME}', 'https://f/720.mp4', 'https://f/poster.webp', 'video/mp4', '{"v720": "http://not-https/x.mp4"}', false, null),
    ('${NOT_A_FILM}', '${ME}', 'https://n/1.png', 'https://n/poster.webp', 'image/png', '${JSON.stringify(FILES)}', false, null),
    ('${ADULT}', '${ME}', 'https://x/720.mp4', 'https://x/poster.webp', 'video/mp4', '${JSON.stringify({ ...FILES, poster: "https://x/poster.webp" })}', true, null);
`;
const BASE = { title: "Rain", content: "Rain over [city]", variables: [{ name: "city", label: "city", type: "text", defaultValue: "Rome", required: true, position: 0 }], aiModel: "Seedance 2.5", aiModels: ["Seedance 2.5", "Kling 4.0"], category: "Portrait", promptType: "premium-prompt", price: 0.4, release: true, aspectRatio: "9:16", resolution: "720p" };
const post = async (body: Record<string, unknown>, token = "me") => {
  const res = await save(new Request("http://enki.test/api/prompt", { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": token }, body: JSON.stringify({ ...BASE, ...body }) }));
  return { status: res.status, ...(await res.json()) } as { status: number; id: string; error?: string; run?: string; adult?: boolean };
};
const VIDEO = { mediaType: "video", showcaseVideoImageId: MINE };
const IMAGE = { aiModel: "Nano Banana Pro", aiModels: ["Nano Banana Pro"], resolution: "2K", aspectRatio: "1:1", uploadedPhotos: [] };

describe("before SQL 52", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(STUBS);
    pgs.client = pglitePostgrest(db).client;
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); await db.close(); });

  it("a video release answers 503 naming the file, and nothing is written", async () => {
    const r = await post(VIDEO);
    expect([r.status, r.error, r.run]).toEqual([503, "Video prompts need sql-to-run/52-video-prompts.sql. Nothing was saved.", "52-video-prompts.sql"]);
    expect((await db.query("select id from public.prompts")).rows).toEqual([]);
    expect((await post({ mediaType: "video" })).status).toBe(503);
  });

  it("an image save is as it was, whether it says so or not, and the editor reads an image", async () => {
    const r = await post(IMAGE);
    expect(r.status).toBe(200);
    expect((await post({ ...IMAGE, mediaType: "image" })).status).toBe(200);
    const read = await editorRead(new Request(`http://enki.test/api/prompt?id=${r.id}`, { headers: { "X-Session-Token": "me" } }));
    expect((await read.json() as { mediaType: string }).mediaType).toBe("image");
  });
});

describe("after SQL 52", () => {
  let db: PGlite;
  let now = 1_900_000_000_000;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(STUBS + SQL52 + RENDERS);
    pgs.client = pglitePostgrest(db).client;
  }, 60_000);
  afterAll(async () => { await db.close(); });
  // A minute past what lib/marketplace/video-columns kept: this database is read anew.
  beforeEach(async () => { now += 61_000; vi.spyOn(Date, "now").mockReturnValue(now); await db.exec(`truncate public.prompts, public.prompt_variables`); });
  const row = async (id: string) => (await db.query<Record<string, unknown>>(`select media_type, showcase_images, showcase_video, ai_model, ai_settings, is_listed, is_adult, resolution, aspect_ratio from public.prompts where id = $1`, [id])).rows[0];

  it("releases one render: the poster its picture, the files beside it, listed, and the generators on offer kept", async () => {
    const r = await post(VIDEO);
    expect(r.status).toBe(200);
    expect(await row(r.id)).toMatchObject({
      media_type: "video", showcase_images: [FILES.poster], showcase_video: FILES, ai_model: "Seedance 2.5", ai_settings: { models: ["Seedance 2.5", "Kling 4.0"] },
      is_listed: true, is_adult: false, resolution: "720p", aspect_ratio: "9:16",
    });
  });

  it("the editor reads it back as a video, its poster as the live image", async () => {
    const r = await post(VIDEO);
    const read = await (await editorRead(new Request(`http://enki.test/api/prompt?id=${r.id}`, { headers: { "X-Session-Token": "me" } }))).json() as { mediaType: string; uploadedPhotos: string[] };
    expect([read.mediaType, read.uploadedPhotos]).toEqual(["video", [FILES.poster]]);
  });

  it("an 18+ render marks the prompt, by the real read of its poster", async () => {
    const r = await post({ ...VIDEO, showcaseVideoImageId: ADULT });
    expect([r.status, r.adult]).toEqual([200, true]);
    expect((await row(r.id)).is_adult).toBe(true);
  });

  it("refuses a render of someone else's, a picture, a deleted one, one that does not exist: nothing written", async () => {
    const NOPE = { status: 422, error: "The video must be one of your own renders on Enki. Nothing was saved." };
    for (const id of [THEIRS, PICTURE, NOT_A_FILM, NO_FILES, GONE, "00000000-0000-4000-8000-0000000000ff"]) {
      expect(await post({ ...VIDEO, showcaseVideoImageId: id }), id).toMatchObject(NOPE);
    }
    expect((await db.query("select id from public.prompts")).rows).toEqual([]);
  });

  it("refuses more than one, in either field", async () => {
    const ONE = { status: 422, error: "A video prompt shows one video. Nothing was saved." };
    expect(await post({ ...VIDEO, showcaseVideoImageId: [MINE, ADULT] })).toMatchObject(ONE);
    expect(await post({ ...VIDEO, uploadedPhotos: ["https://a/1.png", "https://a/2.png"] })).toMatchObject(ONE);
  });

  it("a new video prompt needs its video; an id that is none is asked again; an unknown medium is refused", async () => {
    expect(await post({ mediaType: "video" })).toMatchObject({ status: 422, error: "Make the video first. Nothing was saved." });
    expect((await post({ ...VIDEO, showcaseVideoImageId: "x" })).status).toBe(400);
    expect((await post({ ...VIDEO, mediaType: "audio" })).status).toBe(400);
    expect((await post({ mediaType: "image", showcaseVideoImageId: MINE })).status).toBe(400);
  });

  it("runs only on video generators", async () => {
    const NOPE = { status: 422, error: "A video prompt runs on video generators. Nothing was saved." };
    expect(await post({ ...VIDEO, aiModel: "Nano Banana Pro" })).toMatchObject(NOPE);
    expect(await post({ ...VIDEO, aiModels: ["Seedance 2.5", "Nano Banana Pro"] })).toMatchObject(NOPE);
  });

  it("a released prompt keeps what it makes, both ways; an update of a video keeps its video", async () => {
    const v = await post(VIDEO);
    expect(await post({ ...IMAGE, id: v.id, mediaType: "image" })).toMatchObject({ status: 422, error: "A released prompt keeps what it makes. Nothing was saved." });
    const i = await post(IMAGE);
    expect(await post({ ...VIDEO, id: i.id })).toMatchObject({ status: 422, error: "A released prompt keeps what it makes. Nothing was saved." });
    const same = await post({ id: v.id, mediaType: "video", uploadedPhotos: [FILES.poster], title: "Rain again" });
    expect(same.status).toBe(200);
    expect(await row(v.id)).toMatchObject({ media_type: "video", showcase_video: FILES, showcase_images: [FILES.poster] });
  });

  it("an image save names nothing and reads nothing of it: it stays an image with no file", async () => {
    const r = await post(IMAGE);
    expect(await row(r.id)).toMatchObject({ media_type: "image", showcase_video: null, showcase_images: [] });
    // Past what lib/marketplace/video-columns kept: a read would show.
    now += 61_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const spy = vi.fn();
    const client = pgs.client as { from: (t: string) => unknown };
    const { videoForSave } = await import("@/lib/video/release");
    await videoForSave({ ...client, from: (t: string) => { spy(t); return client.from(t); } } as never, { uploadedPhotos: ["https://a/1.png"] }, [ME]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("nobody else may release over it, and no session saves nothing", async () => {
    const v = await post(VIDEO);
    expect((await post({ ...VIDEO, id: v.id }, "other")).status).toBe(404);
    expect((await post(VIDEO, "nobody")).status).toBe(401);
  });
});
