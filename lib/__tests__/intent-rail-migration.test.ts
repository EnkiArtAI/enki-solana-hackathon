import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-18-intent-rail.sql in a real Postgres, on the live shape
 * of generation_payment_intents (columns from the OpenAPI schema, constraints
 * from Kev's pg_constraint paste, 2026-10-18): a batch opens atomically and
 * only inside the caps, a unit belongs to one rail, the new void reasons are
 * accepted and nothing else.
 */

const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-18-intent-rail.sql"), "utf8");
const BUYER = "So1anaBuyer";
const OTHER = "OtherBuyer";

describe("the intent rail migration", () => {
  let db: PGlite;
  let n = 0;
  const quote = async (over: Record<string, string> = {}) => {
    const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const cols = { id, buyer_wallet: BUYER, status: "quoted", expires_at: "now() + interval '5 minutes'", total_micro: "7560", ...over };
    const keys = Object.keys(cols);
    const vals = keys.map((k) => (k === "expires_at" || k === "total_micro" ? (cols as Record<string, string>)[k] : `'${(cols as Record<string, string>)[k]}'`));
    await db.exec(`insert into public.generation_payment_intents (${keys.join(", ")}) values (${vals.join(", ")})`);
    return id;
  };
  const open = (id: string, units: number, buyer = BUYER, maxOpen = 40, maxBuyer = 8, nonces?: string[]) =>
    db.query<{ id: string; unit_index: number; nonce_account: string; batch_intent_id: string; status: string; total_micro: string }>(
      `select id, unit_index, nonce_account, batch_intent_id, status, total_micro from public.open_intent_batch($1, $2, $3, $4, 'Authority', $5, $6)`,
      [id, buyer, units, nonces ?? Array.from({ length: units }, (_, i) => `Nonce-${id.slice(-4)}-${i}`), maxOpen, maxBuyer],
    );

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.generation_payment_intents (
        id uuid primary key, buyer_wallet text not null, prompt_id uuid, model_family text, resolution text,
        artist_wallet text, artist_amount_micro bigint default 0 check (artist_amount_micro >= 0),
        model_cost_micro bigint default 0 check (model_cost_micro >= 0), enki_fee_micro bigint default 0 check (enki_fee_micro >= 0),
        total_micro bigint not null check (total_micro >= 0), currency text, fee_bps int, fee_base text, fee_mode text,
        status text not null check (status = any (array['quoted','building','submitted','confirmed','failed','expired','authorized','generating','captured','voided'])),
        tx_signature text, expires_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(),
        last_valid_block_height bigint, consumed_at timestamptz, fulfilled_at timestamptz, fronted_atas jsonb,
        authorized_at timestamptz, nonce_account text, nonce_authority text, authorized_tx_ct text, authorized_tx_iv text,
        authorized_tx_tag text, authorized_tx_kid text, heartbeat_at timestamptz, captured_at timestamptz, voided_at timestamptz,
        void_reason text, applied_rule_id uuid, model_id uuid, quality text, boost boolean default false,
        reference_image_count int default 0, deposit_signature text, deposit_confirmed_at timestamptz,
        constraint generation_payment_intents_single_outcome check ((captured_at is null) or (voided_at is null)),
        constraint generation_payment_intents_void_reason_check check ((void_reason is null) or (void_reason = any (array['provider_failed','rejected','cancelled','abandoned','expired'])))
      );
      create table public.generation_escrow_deposits (intent_id uuid primary key);
      create table public.generation_escrow_recovery (intent_id uuid primary key);
      -- The one historical nonce row, as live: voided on devnet.
      insert into public.generation_payment_intents (id, buyer_wallet, status, total_micro, nonce_account, voided_at, void_reason)
        values ('00000000-0000-4000-8000-999999999999', 'Old', 'voided', 1, 'OldNonce', '2026-09-23', 'abandoned');
    `);
    await db.exec(SQL);
    await db.exec(SQL); // runs twice without harm
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("marks the historical nonce row closed, so it counts against no cap", async () => {
    const r = (await db.query<{ nonce_closed_at: string | null }>(`select nonce_closed_at from public.generation_payment_intents where nonce_account = 'OldNonce'`)).rows[0];
    expect(r.nonce_closed_at).not.toBeNull();
  });

  it("a re-run after go-live leaves a live voided unit's open nonce for the sweep (review 2026-10-18)", async () => {
    await db.exec(`insert into public.generation_payment_intents (id, buyer_wallet, status, total_micro, nonce_account, voided_at, void_reason)
      values ('00000000-0000-4000-8000-888888888888', 'Live', 'voided', 1, 'LiveNonce', now(), 'cancelled')`);
    await db.exec(SQL);
    const r = (await db.query<{ nonce_closed_at: string | null }>(`select nonce_closed_at from public.generation_payment_intents where nonce_account = 'LiveNonce'`)).rows[0];
    expect(r.nonce_closed_at).toBeNull();
    // Put the shared state back: an open nonce would count against the overall cap the later cases measure (verification 2026-10-18).
    await db.exec(`update public.generation_payment_intents set nonce_closed_at = now() where nonce_account = 'LiveNonce'`);
  });

  it("opens a batch: the quote becomes unit 0, clones carry its amounts, each unit reserves its own nonce", async () => {
    const id = await quote();
    const units = (await open(id, 3)).rows;
    expect(units.map((u) => u.unit_index)).toEqual([0, 1, 2]);
    expect(units[0].id).toBe(id);
    expect(new Set(units.map((u) => u.nonce_account)).size).toBe(3);
    expect(units.every((u) => u.batch_intent_id === id && u.status === "building" && String(u.total_micro) === "7560")).toBe(true);
  });

  it("refuses a second opening of the same intent", async () => {
    const id = await quote();
    await open(id, 1);
    await expect(open(id, 1, BUYER, 40, 8, ["Again"])).rejects.toThrow(/intent not open/);
  });

  it("refuses an intent that is not this buyer's fresh quote, or that escrow already holds", async () => {
    const other = await quote({ buyer_wallet: OTHER });
    await expect(open(other, 1)).rejects.toThrow(/intent not open/);
    const expired = await quote({ expires_at: "now() - interval '1 minute'" });
    await expect(open(expired, 1)).rejects.toThrow(/intent not open/);
    const confirmed = await quote({ status: "confirmed" });
    await expect(open(confirmed, 1)).rejects.toThrow(/intent not open/);
    const deposited = await quote();
    await db.exec(`insert into public.generation_escrow_deposits (intent_id) values ('${deposited}')`);
    await expect(open(deposited, 1)).rejects.toThrow(/intent not open/);
    const signed = await quote({ deposit_signature: "sig" });
    await expect(open(signed, 1)).rejects.toThrow(/intent not open/);
  });

  it("refuses when the units and the nonces differ, or the batch is not 1 to 24", async () => {
    const id = await quote();
    await expect(open(id, 2, BUYER, 40, 8, ["only-one"])).rejects.toThrow(/units and nonces differ/);
    await expect(open(id, 25)).rejects.toThrow(/units and nonces differ/);
  });

  it("opens nothing past the buyer's cap or the overall cap, and leaves the quote untouched", async () => {
    // Buyer already holds 4 open units from the tests above.
    const id = await quote();
    expect((await open(id, 5, BUYER, 40, 8)).rows).toEqual([]);
    const row = (await db.query<{ status: string; nonce_account: string | null }>(`select status, nonce_account from public.generation_payment_intents where id = $1`, [id])).rows[0];
    expect(row).toEqual({ status: "quoted", nonce_account: null });
    expect((await open(id, 4, BUYER, 40, 8)).rows).toHaveLength(4);
    const other = await quote({ buyer_wallet: OTHER });
    expect((await open(other, 1, OTHER, 8, 8)).rows).toEqual([]);
  });

  it("opens exactly up to the overall cap, and refuses one past it while the buyer has room (round 4, 2026-10-19)", async () => {
    const openAll = Number((await db.query<{ n: string }>(`select count(*) as n from public.generation_payment_intents where nonce_account is not null and nonce_closed_at is null`)).rows[0].n);
    const a = await quote({ buyer_wallet: "CapBuyerA" });
    expect((await open(a, 2, "CapBuyerA", openAll + 1, 8)).rows).toEqual([]);
    expect((await open(a, 2, "CapBuyerA", openAll + 2, 8)).rows).toHaveLength(2);
  });

  it("frees a buyer's slot once a unit's nonce is closed", async () => {
    await db.exec(`update public.generation_payment_intents set nonce_closed_at = now() where buyer_wallet = '${BUYER}' and unit_index = 0`);
    const id = await quote();
    expect((await open(id, 1, BUYER, 40, 8)).rows.length).toBeGreaterThan(0);
  });

  it("accepts the two new void reasons and nothing else", async () => {
    const id = await quote();
    await db.exec(`update public.generation_payment_intents set void_reason = 'capture_failed', voided_at = now(), status = 'voided' where id = '${id}'`);
    await db.exec(`update public.generation_payment_intents set void_reason = 'unfunded' where id = '${id}'`);
    await expect(db.exec(`update public.generation_payment_intents set void_reason = 'nope' where id = '${id}'`)).rejects.toThrow(/void_reason_check/);
  });

  it("keeps one rail per row and a unit inside its batch", async () => {
    const id = await quote();
    await expect(db.exec(`update public.generation_payment_intents set deposit_signature = 's', nonce_account = 'n-${id}' where id = '${id}'`)).rejects.toThrow(/one_rail/);
    await expect(db.exec(`update public.generation_payment_intents set unit_index = 0 where id = '${id}'`)).rejects.toThrow(/_unit/);
    await expect(db.exec(`update public.generation_payment_intents set batch_intent_id = '${id}', unit_index = 24 where id = '${id}'`)).rejects.toThrow(/_unit/);
  });

  it("never lets two units share a nonce account", async () => {
    const a = await quote(), b = await quote();
    await db.exec(`update public.generation_payment_intents set nonce_account = 'Shared' where id = '${a}'`);
    await expect(db.exec(`update public.generation_payment_intents set nonce_account = 'Shared' where id = '${b}'`)).rejects.toThrow(/unique|duplicate/i);
  });

  it("lets only the service role open a batch", async () => {
    const id = await quote();
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(open(id, 1), role).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
  });
});
