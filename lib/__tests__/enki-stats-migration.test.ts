import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-29-enki-stats.sql in a real Postgres, on Supabase's roles and default privileges, over the live
 * columns it reads (read back 2026-10-29): every figure in the period and in the last 24 hours, the accounts that drop
 * out, what is artist revenue and what is not, when an image was posted, and the ranked creators.
 */
const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-29-enki-stats.sql"), "utf8");
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C, D, E, F, G, H] = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
const [pA1, pA2, pC1, pF1, pH1, pA3] = [11, 12, 13, 14, 15, 16].map(id);
const [iA1, iA2, iA3, iA4, iC1, iB1, iB2, iE1] = [21, 22, 23, 24, 25, 26, 27, 28].map(id);
const I = Array.from({ length: 13 }, (_, k) => id(31 + k));
const MAIN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", DEV = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ago = (s: string) => `now() - interval '${s}'`;

type Stats = { totals: Record<string, [number, number]>; views: number; board: Record<string, unknown>[] };

describe("the Enki stats migration", () => {
  let db: PGlite;
  const stats = async (since: string | null, sort = "revenue", limit = 25) =>
    (await db.query<{ s: Stats }>(`select public.enki_stats(${since === null ? "null" : ago(since)}, $1, $2) as s`, [sort, limit])).rows[0].s;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
      create table public.users (id uuid primary key, handle text, created_at timestamptz not null default now(),
        deleted_at timestamptz, account_status text, hide_from_leaderboard boolean not null default false);
      create table public.bans (id serial, user_id uuid, lifted_at timestamptz, expires_at timestamptz);
      create table public.prompts (id uuid primary key, creator_id uuid, is_listed boolean, listing_status text,
        deleted_at timestamptz, published_at timestamptz, views bigint);
      create table public.generated_images (id uuid primary key, user_id uuid, visibility text, is_uploaded boolean,
        deleted_at timestamptz, created_at timestamptz not null default now());
      create table public.generations (id serial, payment_intent_id uuid, chain_key text, user_id uuid, transaction_hash text);
      create table public.user_wallets (user_id uuid, address text);
      create table public.reactions (target_type text, target_uuid uuid, user_id uuid, reaction_type text, created_at timestamptz);
      create table public.prompt_comments (prompt_id text, user_id uuid, created_at timestamptz);
      create table public.follows (follower_id uuid, followee_id uuid, created_at timestamptz);
      create table public.licence_credits (source text, role text, mint text, micro bigint, prompt_id uuid, user_id uuid,
        created_at timestamptz);
      create table public.generation_payment_intents (id uuid primary key, prompt_id text, status text,
        captured_at timestamptz, fulfilled_at timestamptz, artist_amount_micro bigint, buyer_wallet text);
      create table public.generation_escrow_recovery (intent_id uuid, mint text, state text, delivered_units smallint,
        original_artist_unit_micro bigint, confirmed_at timestamptz);

      -- ann, bob, eve (ban lifted), fay (off the board) and hal count; cat deleted, dan banned, gus suspended do not.
      insert into public.users (id, handle, created_at, deleted_at, account_status, hide_from_leaderboard) values
        ('${A}', 'ann', ${ago("10 days")}, null, 'active', false), ('${B}', 'bob', ${ago("2 hours")}, null, null, false),
        ('${C}', 'cat', ${ago("1 hour")}, now(), 'active', false), ('${D}', 'dan', ${ago("1 hour")}, null, 'active', false),
        ('${E}', 'eve', ${ago("40 days")}, null, 'active', false), ('${F}', 'fay', ${ago("3 days")}, null, 'active', true),
        ('${G}', 'gus', ${ago("1 hour")}, null, 'suspended', false), ('${H}', 'hal', ${ago("40 days")}, null, 'active', false);
      insert into public.bans (user_id, lifted_at, expires_at) values
        ('${D}', null, null), ('${E}', ${ago("1 day")}, null), ('${B}', null, ${ago("1 day")});
      insert into public.prompts values
        ('${pA1}', '${A}', true, 'active', null, ${ago("5 days")}, 100), ('${pA2}', '${A}', false, 'draft', null, null, 7),
        ('${pC1}', '${C}', true, 'active', null, ${ago("5 days")}, 50), ('${pF1}', '${F}', true, 'active', null, ${ago("1 hour")}, 3),
        ('${pH1}', '${H}', false, 'draft', null, null, 0), ('${pA3}', '${A}', true, 'active', now(), ${ago("1 day")}, 1000);
      -- Before the migration: iA1 was public already; iB2 and iE1 are private renders; an upload, a deleted render
      -- and the deleted account's never count.
      insert into public.generated_images values
        ('${iA1}', '${A}', 'public', false, null, ${ago("20 days")}), ('${iA2}', '${A}', 'private', false, null, ${ago("3 days")}),
        ('${iA3}', '${A}', 'private', true, null, ${ago("1 hour")}), ('${iA4}', '${A}', 'public', false, now(), ${ago("1 hour")}),
        ('${iC1}', '${C}', 'public', false, null, ${ago("1 hour")}), ('${iB2}', '${B}', 'private', false, null, ${ago("1 hour")}),
        ('${iE1}', '${E}', 'private', false, null, ${ago("1 hour")});
      insert into public.reactions values
        ('prompt', '${pA1}', '${B}', 'like', ${ago("2 days")}), ('generated_image', '${iA1}', '${E}', 'like', ${ago("1 hour")}),
        ('prompt', '${pC1}', '${B}', 'like', ${ago("1 hour")}), ('prompt', '${pA1}', '${E}', 'other', ${ago("1 hour")}),
        -- on a deleted prompt and a deleted image: nobody can see them.
        ('prompt', '${pA3}', '${B}', 'like', ${ago("1 hour")}), ('generated_image', '${iA4}', '${B}', 'like', ${ago("1 hour")});
      insert into public.prompt_comments values ('${pA1}', '${B}', ${ago("1 hour")}), ('${pA1}', '${C}', ${ago("1 hour")}),
        ('${pA3}', '${B}', ${ago("1 hour")});
      insert into public.follows values ('${B}', '${A}', ${ago("1 hour")}), ('${E}', '${F}', ${ago("10 days")}),
        ('${E}', '${B}', ${ago("2 days")}), ('${F}', '${B}', ${ago("2 days")}), ('${A}', '${C}', ${ago("1 hour")});

      -- Revenue. Counted: ann's x402 credit, a direct intent capture, a withheld share (its credit, once), an escrow
      -- settlement (2 units at the original 0.30, once, though its intent looks captured); fay's credit found by its
      -- prompt. Never: devnet, a referrer, voided, undelivered, a devnet render, devnet or released escrow, a deleted
      -- account's capture, and ann paying for her own prompt (x402 from her account, an intent credit, a direct
      -- capture and an escrow, from her wallet in any case).
      insert into public.user_wallets values ('${A}', 'WalletAnn');
      insert into public.licence_credits values
        ('x402:one', 'artist', '${MAIN}', 1500000, '${pA1}', '${A}', ${ago("1 hour")}),
        ('x402:dev', 'artist', '${DEV}', 9000000, '${pA1}', '${A}', ${ago("1 hour")}),
        ('x402:one', 'referrer', '${MAIN}', 5000000, '${pA1}', '${E}', ${ago("1 hour")}),
        ('x402:two', 'artist', '${MAIN}', 250000, '${pF1}', null, ${ago("3 days")}),
        ('intent:${I[1]}', 'artist', '${MAIN}', 800000, '${pA1}', '${A}', ${ago("5 days")}),
        ('x402:self', 'artist', '${MAIN}', 2000000, '${pA1}', '${A}', ${ago("1 hour")}),
        ('intent:${I[10]}', 'artist', '${MAIN}', 600000, '${pA1}', '${A}', ${ago("1 hour")});
      insert into public.generation_payment_intents values
        ('${I[0]}', '${pA1}', 'captured', ${ago("2 days")}, ${ago("2 days")}, 700000),
        ('${I[1]}', '${pA1}', 'captured', ${ago("5 days")}, ${ago("5 days")}, 800000),
        ('${I[2]}', '${pA1}', 'voided', null, null, 100000),
        ('${I[3]}', '${pA1}', 'captured', ${ago("1 hour")}, null, 400000),
        ('${I[4]}', '${pA1}', 'captured', ${ago("1 hour")}, ${ago("1 hour")}, 450000),
        ('${I[5]}', '${pA1}', 'confirmed', ${ago("4 days")}, ${ago("4 days")}, 300000),
        ('${I[6]}', '${pA1}', 'confirmed', null, ${ago("4 days")}, 300000),
        ('${I[7]}', '${pA1}', 'confirmed', null, null, 300000),
        ('${I[8]}', '${pC1}', 'captured', ${ago("1 hour")}, ${ago("1 hour")}, 999000),
        ('${I[9]}', '${pH1}', 'confirmed', null, null, 300000);
      insert into public.generation_payment_intents values
        ('${I[10]}', '${pA1}', 'captured', ${ago("1 hour")}, ${ago("1 hour")}, 600000, 'walletann'),
        ('${I[11]}', '${pA1}', 'captured', ${ago("1 hour")}, ${ago("1 hour")}, 650000, 'WALLETANN'),
        ('${I[12]}', '${pA1}', 'confirmed', null, ${ago("1 hour")}, 400000, 'WalletAnn');
      insert into public.generations (payment_intent_id, chain_key, user_id, transaction_hash) values
        ('${I[0]}', 'solana', '${B}', null), ('${I[1]}', 'solana', '${B}', null), ('${I[3]}', 'solana', '${B}', null),
        ('${I[4]}', 'solana-devnet', '${B}', null), ('${I[5]}', 'solana', '${B}', null), ('${I[8]}', 'solana', '${B}', null),
        (null, 'solana', '${B}', 'one'), (null, 'solana', '${A}', 'self'), ('${I[10]}', 'solana', '${A}', null),
        ('${I[11]}', 'solana', null, null);
      insert into public.generation_escrow_recovery values
        ('${I[5]}', '${MAIN}', 'confirmed', 2, 300000, ${ago("4 days")}), ('${I[6]}', '${DEV}', 'confirmed', 2, 300000, ${ago("4 days")}),
        ('${I[7]}', '${MAIN}', 'released', null, 300000, null), ('${I[9]}', '${MAIN}', 'released', null, 300000, null),
        ('${I[12]}', '${MAIN}', 'confirmed', 2, 400000, ${ago("1 hour")});
    `);
    await db.exec(SQL);
    // After it: bob posts a new image, ann makes iA2 public.
    await db.exec(`insert into public.generated_images (id, user_id, visibility, is_uploaded) values ('${iB1}', '${B}', 'public', false);
      update public.generated_images set visibility = 'public' where id = '${iA2}';`);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("runs twice without harm", async () => {
    const before = (await db.query(`select id, published_at from public.generated_images order by id`)).rows;
    await db.exec(SQL);
    expect((await db.query(`select id, published_at from public.generated_images order by id`)).rows).toEqual(before);
  });

  it("dates a post when the image first went public, whoever wrote it, and keeps that date", async () => {
    const at = async (img: string) => (await db.query<{ p: Date | null; c: Date }>(
      `select published_at as p, created_at as c from public.generated_images where id = $1`, [img])).rows[0];
    const old = await at(iA1);
    expect(old.p).toEqual(old.c);
    expect((await at(iB1)).p).not.toBeNull();
    const first = (await at(iA2)).p;
    expect(first).not.toBeNull();
    expect((await at(iA3)).p).toBeNull();
    await db.exec(`update public.generated_images set visibility = 'private' where id = '${iA2}';
      update public.generated_images set visibility = 'public' where id = '${iA2}';`);
    expect((await at(iA2)).p).toEqual(first);
  });

  it("counts every figure all time and in the last 24 hours, without deleted, inactive or banned accounts", async () => {
    const s = await stats(null);
    expect(s.totals).toEqual({
      users: [5, 1], prompts: [2, 1], posts: [3, 2], images: [5, 3], revenue: [3850000, 1500000],
      likes: [2, 1], comments: [1, 1], followers: [4, 1],
    });
    expect(s.views).toBe(110);
  });

  it("narrows to the period, and the last 24 hours stay the last 24 hours", async () => {
    const week = await stats("7 days");
    expect(week.totals).toEqual({
      users: [2, 1], prompts: [2, 1], posts: [2, 2], images: [4, 3], revenue: [3850000, 1500000],
      likes: [2, 1], comments: [1, 1], followers: [3, 1],
    });
    expect((await stats("30 days")).totals.users).toEqual([3, 1]);
  });

  it("ranks the creators by public activity in the column asked for, without whoever hid or did nothing public", async () => {
    const all = await stats(null);
    expect(all.board).toEqual([
      { rank: 1, handle: "ann", prompts: 1, posts: 2, revenue: 3600000, views: 107, likes: 2, comments: 0, followers: 1 },
      { rank: 2, handle: "bob", prompts: 0, posts: 1, revenue: 0, views: 0, likes: 0, comments: 1, followers: 2 },
    ]);
    expect((await stats(null, "followers")).board.map((r) => r.handle)).toEqual(["bob", "ann"]);
    expect((await stats(null, "comments")).board.map((r) => r.handle)).toEqual(["bob", "ann"]);
    expect((await stats(null, "bogus")).board.map((r) => r.handle)).toEqual(["ann", "bob"]);
    expect((await stats(null, "followers", 1)).board.map((r) => r.handle)).toEqual(["bob"]);
    expect((await stats("1 day")).board).toEqual([
      { rank: 1, handle: "ann", prompts: 0, posts: 1, revenue: 1500000, views: 107, likes: 1, comments: 0, followers: 1 },
      { rank: 2, handle: "bob", prompts: 0, posts: 1, revenue: 0, views: 0, likes: 0, comments: 1, followers: 0 },
    ]);
  });

  it("is the server's only", async () => {
    for (const [role, can] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
      expect((await db.query(`select has_function_privilege($1, 'public.enki_stats(timestamptz, text, integer)', 'execute') as can`, [role])).rows)
        .toEqual([{ can }]);
    }
  });

  it("rolls back to the table as it was", async () => {
    await db.exec(ROLLBACK);
    expect((await db.query(`select to_regprocedure('public.enki_stats(timestamptz, text, integer)') as f`)).rows).toEqual([{ f: null }]);
    expect((await db.query(`select count(*)::int as n from information_schema.columns where table_name = 'generated_images' and column_name = 'published_at'`)).rows)
      .toEqual([{ n: 0 }]);
    await db.exec(`update public.generated_images set visibility = 'public' where id = '${iA3}'`);
  });
});
