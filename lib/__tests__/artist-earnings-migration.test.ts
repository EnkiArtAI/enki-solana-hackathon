import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-29-artist-earnings.sql in a real Postgres, over what 2026-07-14-hall-of-fame.sql left (live):
 * one function hands out what each artist earned, the Hall of Fame and its trend read the same figure, the
 * deployment's chain picks the money, enki_stats is left to SQL 49, and the rollback puts the old functions back.
 */
const M = (f: string) => readFileSync(join(__dirname, "..", "..", "migrations", f), "utf8");
const HALL = M("2026-07-14-hall-of-fame.sql"), STATS = M("2026-10-29-enki-stats.sql"), SQL = M("2026-10-29-artist-earnings.sql");
const ENKI3 = "public.enki_stats(timestamptz, text, integer)";
const ROLLBACK = SQL.slice(SQL.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C, D, E, F, G, H] = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
const [pA1, pA2, pC1, pF1, pH1, pA3] = [11, 12, 13, 14, 15, 16].map(id);
const [iA1, iA2, iA3, iA4, iC1, iB1, iB2, iE1] = [21, 22, 23, 24, 25, 26, 27, 28].map(id);
const I = Array.from({ length: 13 }, (_, k) => id(31 + k));
const MAIN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", DEV = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ago = (s: string) => `now() - interval '${s}'`;

type Earned = { creator_id: string; prompt_id: string | null; micro: number; earned_at: Date };
type Board = { creator_id: string; handle: string; total_cents: number; best_prompt_id: string | null; best_prompt_title: string | null };

describe("the artist earnings migration", () => {
  let db: PGlite;
  const earned = async (args: string) =>
    (await db.query<Earned>(`select creator_id, prompt_id, micro::int as micro, earned_at from public.artist_earnings(${args}) order by micro`)).rows;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
      create table public.users (id uuid primary key, handle text, created_at timestamptz not null default now(),
        deleted_at timestamptz, account_status text);
      create table public.bans (id serial, user_id uuid, lifted_at timestamptz, expires_at timestamptz);
      create table public.prompts (id uuid primary key, creator_id uuid, is_listed boolean, listing_status text,
        deleted_at timestamptz, published_at timestamptz, views bigint, title text);
      create table public.generated_images (id uuid primary key, user_id uuid, visibility text, is_uploaded boolean,
        deleted_at timestamptz, created_at timestamptz not null default now());
      create table public.generations (id serial, payment_intent_id uuid, chain_key text, user_id uuid, transaction_hash text,
        prompt_id uuid, created_at timestamptz not null default now(), deleted_at timestamptz);
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
      -- The table nothing writes, as 2026-07-14 expects it.
      create table public.prompt_purchases (seller_id uuid, prompt_id uuid, creator_earnings_cents int, status text, completed_at timestamptz);

      insert into public.users (id, handle, created_at, deleted_at, account_status) values
        ('${A}', 'ann', ${ago("10 days")}, null, 'active'), ('${B}', 'bob', ${ago("2 hours")}, null, null),
        ('${C}', 'cat', ${ago("1 hour")}, now(), 'active'), ('${D}', 'dan', ${ago("1 hour")}, null, 'active'),
        ('${E}', 'eve', ${ago("40 days")}, null, 'active'), ('${F}', 'fay', ${ago("3 days")}, null, 'active'),
        ('${G}', 'gus', ${ago("1 hour")}, null, 'suspended'), ('${H}', 'hal', ${ago("40 days")}, null, 'active');
      insert into public.bans (user_id, lifted_at, expires_at) values
        ('${D}', null, null), ('${E}', ${ago("1 day")}, null), ('${B}', null, ${ago("1 day")});
      insert into public.prompts values
        ('${pA1}', '${A}', true, 'active', null, ${ago("5 days")}, 100, 'Lighthouse'), ('${pA2}', '${A}', false, 'draft', null, null, 7, 'd'),
        ('${pC1}', '${C}', true, 'active', null, ${ago("5 days")}, 50, 'Cat'), ('${pF1}', '${F}', true, 'active', null, ${ago("1 hour")}, 3, 'Fay'),
        ('${pH1}', '${H}', false, 'draft', null, null, 0, 'h'), ('${pA3}', '${A}', true, 'active', now(), ${ago("1 day")}, 1000, 'gone');
      insert into public.generated_images values
        ('${iA1}', '${A}', 'public', false, null, ${ago("20 days")}), ('${iA2}', '${A}', 'private', false, null, ${ago("3 days")}),
        ('${iA3}', '${A}', 'private', true, null, ${ago("1 hour")}), ('${iA4}', '${A}', 'public', false, now(), ${ago("1 hour")}),
        ('${iC1}', '${C}', 'public', false, null, ${ago("1 hour")}), ('${iB2}', '${B}', 'private', false, null, ${ago("1 hour")}),
        ('${iE1}', '${E}', 'private', false, null, ${ago("1 hour")}), ('${iB1}', '${B}', 'public', false, null, now());
      insert into public.reactions values
        ('prompt', '${pA1}', '${B}', 'like', ${ago("2 days")}), ('generated_image', '${iA1}', '${E}', 'like', ${ago("1 hour")}),
        ('prompt', '${pC1}', '${B}', 'like', ${ago("1 hour")}), ('prompt', '${pA1}', '${E}', 'other', ${ago("1 hour")}),
        ('prompt', '${pA3}', '${B}', 'like', ${ago("1 hour")}), ('generated_image', '${iA4}', '${B}', 'like', ${ago("1 hour")});
      insert into public.prompt_comments values ('${pA1}', '${B}', ${ago("1 hour")}), ('${pA1}', '${C}', ${ago("1 hour")}),
        ('${pA3}', '${B}', ${ago("1 hour")});
      insert into public.follows values ('${B}', '${A}', ${ago("1 hour")}), ('${E}', '${F}', ${ago("10 days")}),
        ('${E}', '${B}', ${ago("2 days")}), ('${F}', '${B}', ${ago("2 days")}), ('${A}', '${C}', ${ago("1 hour")});

      -- The money of enki-stats-migration.test.ts: mainnet counts ann 1.5M (x402), 800k (withheld intent share), 700k
      -- (direct capture), 600k (escrow, 2 units), fay 250k (a credit found by its prompt), cat 999k (an account enki_stats
      -- drops); devnet counts ann 9M (x402), 450k (a devnet render's capture), 600k (devnet escrow). Never: a referrer,
      -- voided, undelivered, released, ann paying for her own prompt from her account or wallet.
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
        ('${I[0]}', '${pA1}', 'captured', ${ago("2 days")}, ${ago("2 days")}, 700000, null),
        ('${I[1]}', '${pA1}', 'captured', ${ago("5 days")}, ${ago("5 days")}, 800000, null),
        ('${I[2]}', '${pA1}', 'voided', null, null, 100000, null),
        ('${I[3]}', '${pA1}', 'captured', ${ago("1 hour")}, null, 400000, null),
        ('${I[4]}', '${pA1}', 'captured', ${ago("1 hour")}, ${ago("1 hour")}, 450000, null),
        ('${I[5]}', '${pA1}', 'confirmed', ${ago("4 days")}, ${ago("4 days")}, 300000, null),
        ('${I[6]}', '${pA1}', 'confirmed', null, ${ago("4 days")}, 300000, null),
        ('${I[7]}', '${pA1}', 'confirmed', null, null, 300000, null),
        ('${I[8]}', '${pC1}', 'captured', ${ago("1 hour")}, ${ago("1 hour")}, 999000, null),
        ('${I[9]}', '${pH1}', 'confirmed', null, null, 300000, null),
        ('${I[10]}', '${pA1}', 'captured', ${ago("1 hour")}, ${ago("1 hour")}, 600000, 'walletann'),
        ('${I[11]}', '${pA1}', 'captured', ${ago("1 hour")}, ${ago("1 hour")}, 650000, 'WALLETANN'),
        ('${I[12]}', '${pA1}', 'confirmed', null, ${ago("1 hour")}, 400000, 'WalletAnn');
      insert into public.generations (payment_intent_id, chain_key, user_id, transaction_hash) values
        ('${I[0]}', 'solana', '${B}', null), ('${I[1]}', 'solana', '${B}', null), ('${I[3]}', 'solana', '${B}', null),
        ('${I[4]}', 'solana-devnet', '${B}', null), ('${I[5]}', 'solana', '${B}', null), ('${I[8]}', 'solana', '${B}', null),
        (null, 'solana', '${B}', 'one'), (null, 'solana', '${A}', 'self'), ('${I[10]}', 'solana', '${A}', null),
        ('${I[11]}', 'solana', null, null);
      -- Two renders of ann's prompt for the generations trend: today and three days ago.
      insert into public.generations (prompt_id, created_at, user_id, deleted_at) values ('${pA1}', now(), '${B}', null), ('${pA1}', ${ago("3 days")}, '${B}', null),
        ('${pA1}', now(), '${B}', now());
      insert into public.generation_escrow_recovery values
        ('${I[5]}', '${MAIN}', 'confirmed', 2, 300000, ${ago("4 days")}), ('${I[6]}', '${DEV}', 'confirmed', 2, 300000, ${ago("4 days")}),
        ('${I[7]}', '${MAIN}', 'released', null, 300000, null), ('${I[9]}', '${MAIN}', 'released', null, 300000, null),
        ('${I[12]}', '${MAIN}', 'confirmed', 2, 400000, ${ago("1 hour")});
    `);
    await db.exec(HALL);
    await db.exec(STATS);
    await db.exec(`update public.users set hide_from_leaderboard = true where id = '${F}'`);
    await db.exec(SQL);
  }, 90_000);
  afterAll(async () => { await db.close(); });

  it("runs twice without harm, and leaves enki_stats to SQL 49", async () => {
    const once = await earned("null");
    await db.exec(SQL);
    expect(await earned("null")).toEqual(once);
    expect((await db.query(`select to_regprocedure('${ENKI3}')::text as f`)).rows).toEqual([{ f: "enki_stats(timestamp with time zone,text,integer)" }]);
  });

  it("hands out each paid render the artist earned from, for everyone or for some creators", async () => {
    const all = await earned("null");
    expect(all.map((r) => [r.creator_id, r.micro])).toEqual([
      [F, 250000], [A, 600000], [A, 700000], [A, 800000], [C, 999000], [A, 1500000],
    ]);
    expect(all.find((r) => r.micro === 250000)?.prompt_id).toBe(pF1);
    expect((await earned(`${ago("1 day")}`)).map((r) => r.micro)).toEqual([999000, 1500000]);
    expect((await earned(`null, array['${F}']::uuid[]`)).map((r) => r.micro)).toEqual([250000]);
    expect((await earned(`null, array['${A}']::uuid[]`)).map((r) => r.micro)).toEqual([600000, 700000, 800000, 1500000]);
    expect(await earned(`null, '{}'::uuid[]`)).toEqual([]);
  });

  it("counts the money of the chain asked for: devnet test money on a devnet checkout, never mixed", async () => {
    expect((await earned("null, null, 'solana-devnet'")).map((r) => [r.creator_id, r.micro])).toEqual([[A, 450000], [A, 600000], [A, 9000000]]);
  });

  it("ranks the Hall of Fame by the same money, in cents, without whoever hid from it", async () => {
    const board = async (args: string) => (await db.query<Board>(`select creator_id, handle, total_cents::int as total_cents, best_prompt_id, best_prompt_title from public.leaderboard_earnings(${args})`)).rows;
    expect(await board("null")).toEqual([
      { creator_id: A, handle: "ann", total_cents: 360, best_prompt_id: pA1, best_prompt_title: "Lighthouse" },
      { creator_id: C, handle: "cat", total_cents: 100, best_prompt_id: pC1, best_prompt_title: "Cat" },
    ]);
    expect((await board(`${ago("1 day")}, 20`)).map((r) => r.total_cents)).toEqual([150, 100]);
    expect((await board("null, 1")).map((r) => r.handle)).toEqual(["ann"]);
    expect((await board("null, 20, 'solana-devnet'")).map((r) => [r.handle, r.total_cents])).toEqual([["ann", 1005]]);
  });

  it("draws both trend lines, by day, only for the creators named and a period given", async () => {
    const earn = await db.query<{ creator_id: string; cents: number }>(
      `select creator_id, cents::int as cents from public.leaderboard_earn_series(array['${A}', '${C}']::uuid[], ${ago("14 days")}) order by creator_id, cents`);
    expect(earn.rows).toEqual([{ creator_id: A, cents: 60 }, { creator_id: A, cents: 70 }, { creator_id: A, cents: 80 }, { creator_id: A, cents: 150 }, { creator_id: C, cents: 100 }]);
    const days = await db.query<{ n: number }>(`select count(distinct day)::int as n from public.leaderboard_earn_series(array['${A}']::uuid[], ${ago("14 days")})`);
    expect(days.rows).toEqual([{ n: 4 }]);
    expect((await db.query(`select * from public.leaderboard_earn_series(array['${A}']::uuid[], null)`)).rows).toEqual([]);
    expect((await db.query(`select * from public.leaderboard_earn_series(null, ${ago("14 days")})`)).rows).toEqual([]);
    const gen = await db.query<{ n: number }>(`select n::int as n from public.leaderboard_gen_series(array['${A}']::uuid[], ${ago("14 days")}) order by day`);
    expect(gen.rows).toEqual([{ n: 1 }, { n: 1 }]);
  });

  it("is the server's only, as the caller", async () => {
    for (const fn of ["artist_earnings(timestamptz, uuid[], text)",
      "leaderboard_earnings(timestamptz, int, text)", "leaderboard_earn_series(uuid[], timestamptz, text)", "leaderboard_gen_series(uuid[], timestamptz)"]) {
      for (const [role, can] of [["anon", false], ["authenticated", false], ["service_role", true]] as const) {
        expect((await db.query(`select has_function_privilege($1, 'public.${fn}', 'execute') as can`, [role])).rows, `${role} ${fn}`).toEqual([{ can }]);
      }
      expect((await db.query(`select prosecdef from pg_proc where oid = 'public.${fn}'::regprocedure`)).rows).toEqual([{ prosecdef: false }]);
    }
    expect((await db.query(`select to_regprocedure('public.leaderboard_earnings(timestamptz, int)') as f`)).rows).toEqual([{ f: null }]);
  });

  it("rolls back to the functions as they were, reading prompt_purchases", async () => {
    await db.exec(ROLLBACK);
    await db.exec(HALL);
    expect((await db.query(`select to_regprocedure('public.artist_earnings(timestamptz, uuid[], text)') as f`)).rows).toEqual([{ f: null }]);
    await db.exec(`insert into public.prompt_purchases values ('${B}', '${pA1}', 1234, 'completed', now())`);
    const rows = await db.query<{ total_cents: number; handle: string }>(`select handle, total_cents::int as total_cents from public.leaderboard_earnings(null, 20)`);
    expect(rows.rows).toEqual([{ handle: "bob", total_cents: 1234 }]);
  });
});
