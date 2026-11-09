import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import { encryptPrompt } from "@/backend/encryption";

/**
 * A database for the video routes: stubs of the live tables as OpenAPI showed them 2026-11-03, under the real SQL 52, 67, 68, 69
 * and 70. Storage is a recorder, since PGlite has none. Blind spot: PGlite's stand-in is not PostgREST, and nothing here is
 * Supabase Storage: no size limit, no MIME list, no Range.
 */
const sql = (name: string) => readFileSync(join(__dirname, "..", "..", "..", "migrations", name), "utf8");

export const USER = "00000000-0000-4000-8000-0000000000aa";
export const ARTIST = "00000000-0000-4000-8000-000000000001";
export const PREMIUM = "00000000-0000-4000-8000-0000000000b1";
export const OPEN = "00000000-0000-4000-8000-0000000000b2";
export const WALLET = "BuyerWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const STUBS = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create table public.users (id uuid primary key, deleted_at timestamptz, account_status text default 'active', adult_confirmed_at timestamptz);
  insert into public.users (id) values ('${USER}'), ('${ARTIST}');
  create table public.bans (id uuid primary key default gen_random_uuid(), user_id uuid, lifted_at timestamptz, expires_at timestamptz);
  create table public.user_wallets (user_id uuid, address text, chain_family text, removed_at timestamptz);
  insert into public.user_wallets (user_id, address, chain_family) values ('${ARTIST}', 'ArtistWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'solana');
  create table public.models (id uuid primary key default gen_random_uuid(), name text not null, price numeric, allowed_ratios text[], active boolean default true,
    created_at timestamptz default now(), max_reference_images int not null default 0, allowed_filetypes text[] not null default '{}', media_type text not null default 'image');
  create table public.prompts (id uuid primary key default gen_random_uuid(), creator_id uuid, title text, tags text[], price_usd_cents int default 0, prompt_type text default 'free', is_free_showcase boolean default false,
    is_listed boolean default true, listing_status text default 'active', deleted_at timestamptz, showcase_images jsonb default '[]', created_at timestamptz default now(), is_adult boolean default false,
    public_prompt_text text, encrypted_content text, encrypted_content_iv text, encrypted_content_tag text, encrypted_content_kid text, ai_model text, ai_settings jsonb);
  create table public.generation_payment_intents (id uuid primary key default gen_random_uuid(), buyer_wallet text not null, prompt_id text, model_id uuid, model_family text not null, resolution text not null,
    quality text, boost boolean not null default false, reference_image_count int not null default 0, artist_wallet text, artist_amount_micro bigint not null, model_cost_micro bigint not null, enki_fee_micro bigint not null,
    total_micro bigint not null, currency text not null default 'USDC', fee_bps int not null, fee_base text not null, fee_mode text not null, status text not null default 'quoted', tx_signature text,
    expires_at timestamptz not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), consumed_at timestamptz, fulfilled_at timestamptz, fronted_atas jsonb,
    authorized_at timestamptz, nonce_account text, nonce_authority text, authorized_tx_ct text, authorized_tx_iv text, authorized_tx_tag text, authorized_tx_kid text, captured_at timestamptz, voided_at timestamptz,
    void_reason text, applied_rule_id uuid, deposit_signature text, batch_intent_id uuid, unit_index smallint, capture_started_at timestamptz, nonce_closed_at timestamptz);
  create table public.generations (id uuid primary key default gen_random_uuid(), user_id uuid not null, prompt_id uuid not null, final_prompt_ct text not null, final_prompt_iv text, final_prompt_tag text, final_prompt_kid text,
    effective_prompt_ct text, effective_prompt_iv text, effective_prompt_tag text, effective_prompt_kid text, variable_values_ct text, variable_values_iv text, variable_values_tag text, variable_values_kid text,
    aspect_ratio text, resolution text, provider text, provider_model text, transaction_hash text, chain_key text, amount_paid_cents int, amount_paid_micro bigint, created_at timestamptz default now(), model_id uuid,
    boost boolean default false, seed bigint, output_width int, output_height int, output_bytes int, output_format text, generation_ms int, workflow jsonb, payment_intent_id uuid, rail text,
    constraint generations_provider_check check (provider in ('gemini', 'openai', 'wavespeed', 'pollinations', 'acedata', 'none')));
  create table public.generation_references (generation_id uuid);
  create table public.generated_images (id uuid primary key default gen_random_uuid(), user_id uuid not null, generation_id uuid, prompt_id uuid, sequence_index smallint not null default 0, storage_provider text not null,
    storage_url text not null, preview_url text, thumbnail_url text, view_url text, tiny_url text, width int, height int, file_size_bytes int, mime_type text not null, is_uploaded boolean not null default false,
    is_watermarked boolean not null default false, visibility text not null default 'private', accepted boolean not null default false, is_adult boolean not null default false, created_at timestamptz default now(), deleted_at timestamptz);
  create table public.prompt_variables (id uuid primary key default gen_random_uuid(), prompt_id uuid, name text, label text, description text, data_type text, default_value text, is_required boolean, position int, min_value numeric, max_value numeric, options jsonb, deleted_at timestamptz);
  insert into public.prompt_variables (prompt_id, name, label, data_type, is_required, position) values ('${PREMIUM}', 'city', 'city', 'text', true, 0);
  create table public.reference_uploads (id uuid primary key default gen_random_uuid(), user_id uuid not null, path text not null, thumb_path text, content_hash text not null, created_at timestamptz not null default now(), deleted_at timestamptz);
  insert into public.prompts (id, creator_id, title, price_usd_cents, prompt_type, public_prompt_text) values ('${PREMIUM}', '${ARTIST}', 'premium', 40, 'paid', null), ('${OPEN}', '${ARTIST}', 'open', 0, 'free', 'open words');
`;
const ALL_SQL = ["2026-11-03-video-prompts.sql", "2026-11-03-video-models.sql", "2026-11-03-video-routes.sql", "2026-11-03-video-jobs.sql", "2026-11-03-intent-hold.sql"];

/** The recorder behind `client.storage`: what was put, taken down, read and signed. */
export function storageStub(buckets = ["videos", "video-originals", "reference-uploads"]) {
  const log = { put: [] as Array<{ bucket: string; path: string; bytes: number; options: Record<string, unknown> }>, removed: [] as string[], files: new Map<string, Buffer>(), failPut: null as RegExp | null };
  return {
    log,
    getBucket: async (id: string) => (buckets.includes(id) ? { data: { id }, error: null } : { data: null, error: { message: "Bucket not found" } }),
    from: (bucket: string) => ({
      upload: async (path: string, bytes: Buffer, options: Record<string, unknown>) => {
        if (log.failPut?.test(`${bucket}/${path}`)) return { data: null, error: { message: "refused" } };
        log.put.push({ bucket, path, bytes: bytes.length, options });
        return { data: { path }, error: null };
      },
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://store.test/${bucket}/${path}` } }),
      remove: async (paths: string[]) => { log.removed.push(...paths); return { data: paths, error: null }; },
      download: async (path: string) => {
        const file = log.files.get(path);
        return file ? { data: new Blob([new Uint8Array(file)]), error: null } : { data: null, error: { message: "gone" } };
      },
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://store.test/signed/${path}` }, error: null }),
    }),
  };
}

export type VideoDb = { db: PGlite; client: SupabaseClient; storage: ReturnType<typeof storageStub>; close(): Promise<void> };

/** `files`: the migrations to run; the whole set by default. */
export async function videoDb(files: string[] = ALL_SQL): Promise<VideoDb> {
  const db = await PGlite.create();
  await db.exec(STUBS + files.map(sql).join("\n"));
  if (files.includes("2026-11-03-video-prompts.sql")) await db.exec("update public.prompts set media_type = 'video'");
  await sealArtistText(db, "secret words over [city]");
  const storage = storageStub();
  const client = Object.assign(pglitePostgrest(db).client as object, { storage }) as unknown as SupabaseClient;
  return { db, client, storage, close: () => db.close() };
}

/** The premium prompt's text, sealed as a release seals it; FIELD_ENCRYPTION_KEY_B64 must be set. */
export async function sealArtistText(db: PGlite, text: string) {
  const sealed = encryptPrompt(text);
  await db.query("update public.prompts set encrypted_content = $2, encrypted_content_iv = $3, encrypted_content_tag = $4, encrypted_content_kid = $5 where id = $1", [PREMIUM, sealed.encryptedContent, sealed.iv, sealed.authTag, sealed.kid ?? null]);
}

/** The route of one model set as its operator's: what Kev's one UPDATE does, and what the plan calls the swap. */
export const setOperator = (db: PGlite, name: string, operator: string) => db.exec(
  `update public.video_routes set operator = '${operator}', provider_model = 'stub-model', rate_operator = '${operator}' where model_id = (select id from public.models where name = '${name}')`,
);

/** A paid unit as /authorize and /submit leave it: signed, unbroadcast, unclaimed. */
export async function paidUnit(db: PGlite, over: { promptId?: string | null; artist?: number; settings?: object; total?: number } = {}): Promise<string> {
  const model = (await db.query<{ id: string }>(`select id from public.models where name = 'Seedance 2.5'`)).rows[0].id;
  const { rows } = await db.query<{ id: string }>(
    `insert into public.generation_payment_intents (buyer_wallet, prompt_id, model_id, model_family, resolution, artist_amount_micro, model_cost_micro, enki_fee_micro, total_micro, fee_bps, fee_base, fee_mode, status, expires_at, authorized_at, nonce_account, video_settings)
     values ($1, $2, $3, 'Seedance 2.5', '480p', $4, 411200, 38800, $5, 1000, 'b', 'm', 'generating', now() + interval '1 hour', now(), 'Nonce' || gen_random_uuid(), $6) returning id`,
    [WALLET, over.promptId ?? null, model, over.artist ?? 0, over.total ?? 450000, JSON.stringify(over.settings ?? { modelId: "seedance-2.5", seconds: 4, aspect: "16:9", resolution: "480p", audio: true, bitrate: "high" })],
  );
  await db.query(`update public.generation_payment_intents set batch_intent_id = id, unit_index = 0 where id = $1`, [rows[0].id]);
  return rows[0].id;
}
