import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "./_pglite-postgrest";

/**
 * What a clearance already let through (review of DEC-2026-11-02-20): the real POST /api/prompt and the real clearance
 * functions on a real Postgres with the real migrations. The sealed preview is the hunter's token; no picture is read or
 * stored (storeImportedPhotoSet is a stub, the checksums are made up), no model is asked and nothing is viewed.
 */
const pgs = vi.hoisted(() => ({ client: null as unknown, iv: 0, stored: 0, beforeStore: null as null | (() => Promise<void>) }));
const who = vi.hoisted(() => ({ ME: "00000000-0000-4000-8000-000000000001", OWNER: "00000000-0000-4000-8000-000000000002" }));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64"); });
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => pgs.client }));
vi.mock("@/lib/crypto", () => ({
  encryptString: (text: string) => ({ encrypted: text, iv: `iv-${++pgs.iv}`, authTag: "tag", kid: "k1" }),
  decryptString: ({ encrypted }: { encrypted: string }) => encrypted,
}));
vi.mock("@/lib/session-user", async (original) => {
  const of = (t: string | null) => (t === "me" ? who.ME : null);
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
vi.mock("@/lib/moderation/prompt-pause", () => ({ isPaused: async () => false }));
vi.mock("@/lib/adult-content", () => ({ showsAdultRender: async () => false, mayShowAdult: () => true, viewer: async () => null }));
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), checkRequestRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/mfa", () => ({ enrolledFactors: async () => [] }));
vi.mock("@/lib/notifications", () => ({ notifyFollowers: async () => {} }));
vi.mock("@/lib/generation/small-renditions", () => ({ ensureShowcaseRenditions: async () => {} }));
vi.mock("@/lib/referral/post-photos", async (original) => ({
  ...(await original<typeof import("@/lib/referral/post-photos")>()),
  storeImportedPhotoSet: async (photos: { url: string }[]) => {
    pgs.stored += 1;
    await pgs.beforeStore?.();
    return photos.map((p) => ({ url: `https://blob.test/${p.url.length}.jpg`, previewUrl: null, thumbnailUrl: null, width: 8, height: 8, mimeType: "image/jpeg", bytes: 1 }));
  },
}));

import { POST as save } from "../../app/api/prompt/route";
import { sealPreview } from "@/lib/referral/preview-token";
import { casedImages, clearImageCase, noteClearedPublish, takeBackClearance } from "@/lib/moderation/image-clearance";
import { PHOTOS_REFUSED, PHOTOS_UNCHECKED } from "@/lib/referral/judge-post";

const { ME, OWNER } = who;
const ROOT = join(__dirname, "..", "..");
const migration = (f: string) => readFileSync(join(ROOT, "migrations", f), "utf8");
const SQL = migration("2026-11-02-image-clearances.sql");
const SHA = "a".repeat(64);
const OTHER = "b".repeat(64);
const EVENT = "00000000-0000-4000-8000-00000000aaa1";
const TEN_DAYS = 10 * 24 * 60 * 60 * 1000;

let db: PGlite;
let client: SupabaseClient;

/** A find sealed as the hunter seals it: for ten days more, and waiting that long is the point. */
const token = (sha256s: string[]) => sealPreview({
  v: 1, userId: ME, exp: Date.now() + TEN_DAYS,
  source: { url: "https://x.com/a/status/1", normalized: `x.com/status/${++pgs.iv}`, handle: "a", authorId: "1" },
  prompt: "A lighthouse at dawn, soft fog, 35mm film grain", generators: [],
  photos: sha256s.map((sha256, i) => ({ url: `https://pbs.twimg.com/media/${i}.png`, sha256 })),
  title: "Lighthouse at dawn", category: "More", tags: [], adult: false,
});
const publish = async (sha256s: string[]) => {
  const res = await save(new Request("http://enki.test/api/prompt", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": "me" },
    body: JSON.stringify({ imported: token(sha256s), title: "Lighthouse at dawn", category: "More", aiModel: "Nano Banana Pro", aiModels: ["Nano Banana Pro"], promptType: "free-prompt", price: 0, release: true, content: "", photoCount: sha256s.length, variables: [], uploadedPhotos: [], referenceImages: [] }),
  }));
  return { status: res.status, ...(await res.json()) } as { status: number; id?: string; error?: string };
};
const seedCase = (sha: string, id = EVENT, category = "csam", rules = "array['image-check']") => db.exec(`
  insert into public.automod_events (id, user_id, surface, decision, severity, tier, category, matched_rules, scores, prompt_hash, review_state)
  values ('${id}', '${ME}', 'prompt-hunter', 'block', 'review', 2, '${category}', ${rules}, '{}', '${sha}', 'pending');`);
const look = () => db.exec(`insert into public.artist_text_reveals (event_id, revealed_by, reason) values ('${EVENT}', '${OWNER}', 'To decide whether this is a false alarm.')`);
const clear = async () => { await look(); expect(await clearImageCase(client, EVENT, { prompt_hash: SHA }, OWNER, null)).toEqual({ answer: { cleared: SHA } }); };
const prompt = async (id: string) => (await db.query<{ is_listed: boolean; has_delisted: boolean }>(`select is_listed, delisted_at is not null as has_delisted from public.prompts where id = $1`, [id])).rows[0];
const notes = async () => (await db.query<{ sha256: string; prompt_id: string }>(`select sha256, prompt_id::text from public.image_clearance_prompts order by sha256`)).rows;
const promptCount = async () => (await db.query<{ n: number }>(`select count(*)::int as n from public.prompts`)).rows[0].n;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.users (id uuid primary key, handle text, role text, origin text, deleted_at timestamptz, account_status text default 'active');
    insert into public.users (id, origin) values ('${ME}', 'imported'), ('${OWNER}', null);
    create table public.bans (id uuid primary key default gen_random_uuid(), user_id uuid, lifted_at timestamptz, expires_at timestamptz);
    create table public.strikes (id uuid primary key default gen_random_uuid());
    create table public.moderation_policy (id int primary key, owner_user_id uuid);
    insert into public.moderation_policy (id, owner_user_id) values (1, '${OWNER}');
    create table public.user_wallets (user_id uuid, address text, chain_family text, removed_at timestamptz);
    create table public.prompts (id uuid primary key default gen_random_uuid(), creator_id uuid, title text, description text, ai_model text, ai_settings jsonb,
      encrypted_content text, encrypted_content_iv text, encrypted_content_tag text, encrypted_content_kid text, is_listed boolean default false, listing_status text default 'draft',
      delisted_at timestamptz, listed_at timestamptz, published_at timestamptz, deleted_at timestamptz, showcase_images jsonb default '[]', showcase_before_images jsonb default '[]',
      is_adult boolean default false, category text, tags text[], price_usd_cents int, aspect_ratio text, photo_count int, prompt_type text, resolution text,
      is_free_showcase boolean default false, public_prompt_text text, updated_at timestamptz, created_at timestamptz, source_posted_at timestamptz, allow_references boolean not null default true);
    create table public.prompt_variables (id uuid primary key default gen_random_uuid(), prompt_id uuid, name text, label text, description text, data_type text, default_value text,
      is_required boolean, position int, min_value numeric, max_value numeric, options jsonb, created_at timestamptz, updated_at timestamptz, deleted_at timestamptz);
    create table public.generated_images (id uuid primary key default gen_random_uuid(), storage_url text, user_id uuid, prompt_id uuid, sequence_index int, storage_provider text, preview_url text, thumbnail_url text,
      width int, height int, mime_type text, file_size_bytes int, is_uploaded boolean, is_adult boolean, is_watermarked boolean, visibility text, accepted boolean, title text, description text, deleted_at timestamptz);
    create table public.hunt_submissions (id uuid primary key default gen_random_uuid(), hunter_user_id uuid, source_url text, normalized_source_url text, source_platform text, status text, minted_prompt_id uuid, source_author_id text, source_author_handle text);
  `);
  for (const f of ["2026-08-04-automod-events.sql", "2026-08-05-automod-events-append-only.sql", "2026-10-03-artist-text-reveals.sql"]) await db.exec(migration(f));
  await db.exec(`alter table public.automod_events add column if not exists evidence_kid text;`);
  client = pglitePostgrest(db).client as unknown as SupabaseClient;
  pgs.client = client;
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  pgs.stored = 0;
  pgs.beforeStore = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await db.exec(`
    set session_replication_role = replica;
    drop function if exists public.clear_image_case(uuid, text, uuid, text);
    drop table if exists public.image_clearance_prompts; drop table if exists public.image_clearances;
    delete from public.artist_text_reveals; delete from public.automod_events;
    set session_replication_role = default;
    truncate public.prompts, public.hunt_submissions;
  `);
  await db.exec(SQL);
  await seedCase(SHA);
});

describe("a find waiting when its clearance is taken back", () => {
  it("publishes while the clearance stands, and only then notes the prompt, before the listing", async () => {
    await clear();
    const r = await publish([SHA]);
    expect(r.status).toBe(200);
    expect(await prompt(r.id!)).toEqual({ is_listed: true, has_delisted: false });
    expect(await notes()).toEqual([{ sha256: SHA, prompt_id: r.id }]);
  });

  it("is refused at its publish after the take-back, though its sealed token is still good: nothing stored, no prompt", async () => {
    await clear();
    const sealed = await takeBackClearance(client, { prompt_hash: SHA }, OWNER);
    expect(sealed).toEqual({ answer: { revoked: 1 } });
    expect(await publish([SHA])).toEqual({ status: 422, error: PHOTOS_REFUSED });
    expect(pgs.stored).toBe(0);
    expect(await promptCount()).toBe(0);
  });

  it("is refused for one held picture among others", async () => {
    expect(await publish([OTHER, SHA])).toEqual({ status: 422, error: PHOTOS_REFUSED });
    expect(pgs.stored).toBe(0);
  });

  it("a take-back while the picture is being stored: nothing is listed", async () => {
    await clear();
    pgs.beforeStore = async () => { await takeBackClearance(client, { prompt_hash: SHA }, OWNER); };
    expect(await publish([SHA])).toEqual({ status: 422, error: PHOTOS_REFUSED });
    const { rows } = await db.query<{ is_listed: boolean }>(`select is_listed from public.prompts`);
    expect(rows.every((p) => !p.is_listed)).toBe(true);
  });

  it("a clearance still standing lets a later publish through again", async () => {
    await clear();
    await takeBackClearance(client, { prompt_hash: SHA }, OWNER);
    // The new look must lie after the take-back (created_at > revoked_at): within one clock tick it failed 1 run in 3.
    await new Promise((r) => setTimeout(r, 5));
    await look();
    expect(await clearImageCase(client, EVENT, { prompt_hash: SHA }, OWNER, null)).toMatchObject({ answer: { cleared: SHA } });
    expect((await publish([SHA])).status).toBe(200);
  });
});

describe("a case on bytes that never had a clearance", () => {
  it("holds back a find whose token says its bytes passed, whatever the case's state", async () => {
    for (const state of ["pending", "overturned", "upheld"]) {
      await db.exec(`update public.automod_events set review_state = '${state}' where id = '${EVENT}'`);
      expect(await publish([SHA])).toEqual({ status: 422, error: PHOTOS_REFUSED });
    }
  });

  it("leaves a picture no case names alone, and notes nothing", async () => {
    const r = await publish([OTHER]);
    expect(r.status).toBe(200);
    expect(await notes()).toEqual([]);
    expect((await prompt(r.id!)).is_listed).toBe(true);
    expect((await publish([])).status).toBe(200);
  });

  it("reads only a child-safety image case: not a text record under the same hash", async () => {
    await seedCase(OTHER, "00000000-0000-4000-8000-00000000aaa2", "explicit_sexual");
    await seedCase(OTHER, "00000000-0000-4000-8000-00000000aaa3", "csam", "array['tier1']");
    expect((await publish([OTHER])).status).toBe(200);
  });

  it("answers not now when the cases cannot be read: nothing published", async () => {
    await db.exec(`alter table public.automod_events rename to automod_events_away`);
    try {
      expect(await publish([OTHER])).toEqual({ status: 503, error: PHOTOS_UNCHECKED });
    } finally {
      await db.exec(`alter table public.automod_events_away rename to automod_events`);
    }
    expect(await promptCount()).toBe(0);
  });

  it("before SQL 61 the same: a case holds its bytes, a clean find publishes as today", async () => {
    await db.exec(`drop function public.clear_image_case(uuid, text, uuid, text); drop table public.image_clearance_prompts; drop table public.image_clearances;`);
    expect(await publish([SHA])).toEqual({ status: 422, error: PHOTOS_REFUSED });
    expect((await publish([OTHER])).status).toBe(200);
    expect(await casedImages(client, [SHA, OTHER])).toEqual({ held: [SHA], cleared: [] });
  });
});

describe("a prompt already published when its clearance is taken back", () => {
  it("comes down, named in the answer; another prompt stays", async () => {
    await clear();
    const r = await publish([SHA]);
    const stays = await publish([OTHER]);
    expect(await takeBackClearance(client, { prompt_hash: SHA }, OWNER)).toEqual({ answer: { revoked: 1, unlisted: 1, prompts: r.id } });
    expect(await prompt(r.id!)).toEqual({ is_listed: false, has_delisted: true });
    expect(await prompt(stays.id!)).toEqual({ is_listed: true, has_delisted: false });
  });

  it("a second press names nothing new and rewrites no takedown", async () => {
    await clear();
    const r = await publish([SHA]);
    await takeBackClearance(client, { prompt_hash: SHA }, OWNER);
    const [{ at }] = (await db.query<{ at: string }>(`select delisted_at::text as at from public.prompts where id = '${r.id}'`)).rows;
    await new Promise((done) => setTimeout(done, 5));
    expect(await takeBackClearance(client, { prompt_hash: SHA }, OWNER)).toEqual({ answer: { revoked: 0 } });
    expect((await db.query<{ at: string }>(`select delisted_at::text as at from public.prompts where id = '${r.id}'`)).rows[0].at).toBe(at);
  });

  it("a failed takedown says so, and the next press finishes it although nothing is left to revoke", async () => {
    await clear();
    const r = await publish([SHA]);
    await db.exec(`alter table public.prompts add constraint boom check (delisted_at is null) not valid`);
    const failed = await takeBackClearance(client, { prompt_hash: SHA }, OWNER);
    await db.exec(`alter table public.prompts drop constraint boom`);
    expect(failed).toMatchObject({ status: 500, error: expect.stringMatching(/^The clearance is taken back, but its prompts did not come down/) });
    expect(await takeBackClearance(client, { prompt_hash: SHA }, OWNER)).toEqual({ answer: { revoked: 0, unlisted: 1, prompts: r.id } });
    expect((await prompt(r.id!)).is_listed).toBe(false);
  });

  it("a failed read of the notes says none came down", async () => {
    await clear();
    await db.exec(`alter table public.image_clearance_prompts rename column prompt_id to prompt_away`);
    const failed = await takeBackClearance(client, { prompt_hash: SHA }, OWNER);
    await db.exec(`alter table public.image_clearance_prompts rename column prompt_away to prompt_id`);
    expect(failed).toMatchObject({ status: 500, error: expect.stringMatching(/^The clearance is taken back, but its prompts could not be read/) });
  });

  it("a note that cannot be written lists nothing", async () => {
    await clear();
    await db.exec(`alter table public.image_clearance_prompts add constraint boom check (prompt_id is null) not valid`);
    const r = await publish([SHA]);
    await db.exec(`alter table public.image_clearance_prompts drop constraint boom`);
    expect(r.status).toBe(500);
    const { rows } = await db.query<{ is_listed: boolean }>(`select is_listed from public.prompts`);
    expect(rows.every((p) => !p.is_listed)).toBe(true);
  });

  it("noteClearedPublish answers false once one of the checksums is taken back", async () => {
    await clear();
    expect(await noteClearedPublish(client, [SHA], "00000000-0000-4000-8000-00000000bbb1")).toBe(true);
    await takeBackClearance(client, { prompt_hash: SHA }, OWNER);
    expect(await noteClearedPublish(client, [SHA], "00000000-0000-4000-8000-00000000bbb2")).toBe(false);
  });
});

describe("the migration's note table", () => {
  it("holds a sha256, is the service role's alone, runs twice, and its rollback drops it", async () => {
    await db.exec(`insert into public.image_clearance_prompts (sha256, prompt_id) values ('${SHA}', '00000000-0000-4000-8000-00000000bbb1')`);
    await expect(db.exec(`insert into public.image_clearance_prompts (sha256, prompt_id) values ('nope', '00000000-0000-4000-8000-00000000bbb1')`)).rejects.toThrow(/check constraint/);
    await expect(db.exec(`insert into public.image_clearance_prompts (sha256, prompt_id) values ('${SHA}', '00000000-0000-4000-8000-00000000bbb1')`)).rejects.toThrow(/duplicate key/);
    // Supabase's default privileges would hand a new table to anon and authenticated: the file takes that back.
    await db.exec(`grant select on public.image_clearance_prompts to anon, authenticated`);
    await db.exec(SQL);
    expect(await notes()).toHaveLength(1);
    const can = async (role: string) => (await db.query<{ can: boolean }>(`select has_table_privilege('${role}', 'public.image_clearance_prompts', 'select') as can`)).rows[0].can;
    expect([await can("anon"), await can("authenticated")]).toEqual([false, false]);
    expect((await db.query<{ rowsecurity: boolean }>(`select rowsecurity from pg_tables where tablename = 'image_clearance_prompts'`)).rows).toEqual([{ rowsecurity: true }]);
    await db.exec(/-- Rollback[^\n]*\n--\s+(.+)\n/.exec(SQL)![1]);
    expect((await db.query(`select 1 from pg_tables where tablename = 'image_clearance_prompts'`)).rows).toEqual([]);
    await db.exec(SQL);
  });
});
