-- Trial codes (Kev, 2026-10-26: "trial go"). The owner (moderation_policy.owner_user_id) makes a code with a
-- number of uses (or none), minutes of access, an optional expiry and a budget per tester in micro-USDC
-- (1 USD = 1,000,000). A tester types it at /gate, signs in with their own account, and the code is redeemed
-- for that account, once per account and code. The trial ends when its minutes pass or the code's expiry comes,
-- whichever is first; renders spend the budget at the full price the tester sees. Read by lib/trial.ts.
--
--   trial_codes        a code, kept only as its keyed hash (lib/trial.ts hashTrialCode): the table never holds
--                      a code that works
--   trial_redemptions  one per account and code: when its trial ends and what it has spent
--   trial_spend        one per render: the amount taken from the budget, given back when nothing was delivered
--   generations.rail   also 'trial', the rail a render on a trial budget is recorded under
--   roles              also 'trial', the role a tester's account takes, so the client wall lets it in
--
-- Not probed live: every name is new, and the rail CHECK is found by what it checks, not by its name.
-- Requires roles (2026-07-12-user-roles.sql) and generations.rail (2026-10-14-users-origin-generations-rail.sql).
-- Run BEFORE deploying the trial codes. Re-runnable: ON CONFLICT, IF NOT EXISTS, OR REPLACE, and the rail CHECK
-- is dropped and added again.
BEGIN;

INSERT INTO public.roles (key, label, is_staff) VALUES ('trial', 'Trial tester', false)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.trial_codes (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash      text        NOT NULL UNIQUE,
  note           text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 120),
  max_uses       int         CHECK (max_uses IS NULL OR max_uses > 0),     -- NULL: as many as come
  uses           int         NOT NULL DEFAULT 0 CHECK (uses >= 0),
  access_minutes int         NOT NULL CHECK (access_minutes BETWEEN 5 AND 43200),  -- 5 minutes to 30 days
  expires_at     timestamptz,
  budget_micro   bigint      NOT NULL CHECK (budget_micro BETWEEN 0 AND 1000000000),  -- up to 1,000 USD a tester
  created_by     uuid        NOT NULL REFERENCES public.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);

CREATE TABLE IF NOT EXISTS public.trial_redemptions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id     uuid        NOT NULL REFERENCES public.trial_codes(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz NOT NULL,
  spent_micro bigint      NOT NULL DEFAULT 0 CHECK (spent_micro >= 0),
  UNIQUE (code_id, user_id)
);
-- What every admission and every render asks: this account's latest trial.
CREATE INDEX IF NOT EXISTS trial_redemptions_user_ends_idx ON public.trial_redemptions (user_id, ends_at DESC);

CREATE TABLE IF NOT EXISTS public.trial_spend (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  redemption_id uuid        NOT NULL REFERENCES public.trial_redemptions(id) ON DELETE CASCADE,
  amount_micro  bigint      NOT NULL CHECK (amount_micro > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz
);

-- Only the server's service role reads or writes them; no policy grants anyone else.
ALTER TABLE public.trial_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trial_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trial_spend ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trial_codes, public.trial_redemptions, public.trial_spend FROM anon, authenticated;

-- A render on a trial budget says so. The old CHECK was made inline by 2026-10-14, so its name was generated:
-- every CHECK that names the rail column goes, whatever it is called, and the one below takes its place.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.generations'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ~ '\mrail\M'
  LOOP
    EXECUTE format('ALTER TABLE public.generations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.generations
  ADD CONSTRAINT generations_rail_check CHECK (rail IN ('web', 'free', 'x402', 'mcp', 'trial'));

-- The account's running trial: not past its end, its code not revoked; the one that ends last.
CREATE OR REPLACE FUNCTION public.active_trial(p_user_id uuid)
RETURNS TABLE (redemption_id uuid, code_id uuid, ends_at timestamptz, budget_micro bigint, spent_micro bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT r.id, r.code_id, r.ends_at, c.budget_micro, r.spent_micro
      FROM trial_redemptions r JOIN trial_codes c ON c.id = r.code_id
     WHERE r.user_id = p_user_id AND r.ends_at > clock_timestamp() AND c.revoked_at IS NULL
     ORDER BY r.ends_at DESC
     LIMIT 1;
END $$;

-- Spends one use of a code on an account. No row: the code is unknown, revoked, past its date or used up, or
-- this account already had its trial from it (a code is used once per account; while that trial runs it is
-- handed back, so a second sign-in on the same pass does not cost a use).
CREATE OR REPLACE FUNCTION public.redeem_trial_code(p_code_id uuid, p_user_id uuid)
RETURNS TABLE (redemption_id uuid, ends_at timestamptz, budget_micro bigint, spent_micro bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_code trial_codes%ROWTYPE;
  v_red  trial_redemptions%ROWTYPE;
  v_now  timestamptz;
BEGIN
  IF p_code_id IS NULL OR p_user_id IS NULL THEN
    RETURN;
  END IF;
  -- One redeemer of a code at a time, so two testers cannot both take its last use. The clock is read after
  -- waiting for the lock, as claim_free_generation does.
  SELECT * INTO v_code FROM trial_codes c WHERE c.id = p_code_id FOR UPDATE;
  v_now := clock_timestamp();
  IF v_code.id IS NULL OR v_code.revoked_at IS NOT NULL
     OR (v_code.expires_at IS NOT NULL AND v_code.expires_at <= v_now) THEN
    RETURN;
  END IF;
  SELECT * INTO v_red FROM trial_redemptions r WHERE r.code_id = p_code_id AND r.user_id = p_user_id;
  IF v_red.id IS NOT NULL THEN
    IF v_red.ends_at > v_now THEN
      RETURN QUERY SELECT v_red.id, v_red.ends_at, v_code.budget_micro, v_red.spent_micro;
    END IF;
    RETURN;
  END IF;
  IF v_code.max_uses IS NOT NULL AND v_code.uses >= v_code.max_uses THEN
    RETURN;
  END IF;
  INSERT INTO trial_redemptions (code_id, user_id, started_at, ends_at)
    VALUES (p_code_id, p_user_id, v_now,
            LEAST(v_now + make_interval(mins => v_code.access_minutes), COALESCE(v_code.expires_at, 'infinity')))
    RETURNING * INTO v_red;
  UPDATE trial_codes c SET uses = c.uses + 1 WHERE c.id = p_code_id;
  RETURN QUERY SELECT v_red.id, v_red.ends_at, v_code.budget_micro, v_red.spent_micro;
END $$;

-- Takes a render's price from the account's running trial before it renders. NULL: no running trial, or the
-- price would pass what is left of the budget.
CREATE OR REPLACE FUNCTION public.claim_trial_spend(p_user_id uuid, p_amount_micro bigint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_redemption uuid;
  v_budget     bigint;
  v_spent      bigint;
  v_id         uuid;
BEGIN
  IF p_user_id IS NULL OR p_amount_micro IS NULL OR p_amount_micro <= 0 THEN
    RETURN NULL;
  END IF;
  -- One claim per account at a time, so two renders cannot both fit into the same remainder.
  PERFORM pg_advisory_xact_lock(hashtextextended('trial_spend:' || p_user_id::text, 0));
  SELECT t.redemption_id, t.budget_micro INTO v_redemption, v_budget FROM active_trial(p_user_id) t;
  IF v_redemption IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT r.spent_micro INTO v_spent FROM trial_redemptions r WHERE r.id = v_redemption FOR UPDATE;
  -- Compared as the remainder, so no amount can overflow the sum.
  IF p_amount_micro > v_budget - v_spent THEN
    RETURN NULL;
  END IF;
  INSERT INTO trial_spend (redemption_id, amount_micro) VALUES (v_redemption, p_amount_micro) RETURNING id INTO v_id;
  UPDATE trial_redemptions r SET spent_micro = r.spent_micro + p_amount_micro WHERE r.id = v_redemption;
  RETURN v_id;
END $$;

-- Gives a claim back to its trial when the render delivered nothing. Once: true when released now, false for an
-- unknown claim or one already released.
CREATE OR REPLACE FUNCTION public.release_trial_spend(p_spend_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_redemption uuid;
  v_amount     bigint;
BEGIN
  UPDATE trial_spend s SET released_at = now()
   WHERE s.id = p_spend_id AND s.released_at IS NULL
   RETURNING s.redemption_id, s.amount_micro INTO v_redemption, v_amount;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE trial_redemptions r SET spent_micro = GREATEST(0, r.spent_micro - v_amount) WHERE r.id = v_redemption;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.active_trial(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_trial_code(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_trial_spend(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_trial_spend(uuid) FROM PUBLIC, anon, authenticated;
-- Supabase has service_role; a bare Postgres (the offline check) may not.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.active_trial(uuid), public.redeem_trial_code(uuid, uuid),
      public.claim_trial_spend(uuid, bigint), public.release_trial_spend(uuid) TO service_role;
  END IF;
END $$;

COMMIT;

-- Read back:
--   SELECT key, label, is_staff FROM public.roles WHERE key = 'trial';
--   SELECT to_regclass('public.trial_codes'), to_regclass('public.trial_redemptions'), to_regclass('public.trial_spend');
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.generations'::regclass AND contype = 'c';
--   SELECT proname FROM pg_proc WHERE proname IN ('active_trial', 'redeem_trial_code', 'claim_trial_spend', 'release_trial_spend');

-- Rollback (drops every code, redemption and claim; only while no generation row says rail 'trial'):
--   DROP FUNCTION IF EXISTS public.release_trial_spend(uuid);
--   DROP FUNCTION IF EXISTS public.claim_trial_spend(uuid, bigint);
--   DROP FUNCTION IF EXISTS public.redeem_trial_code(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.active_trial(uuid);
--   DROP TABLE IF EXISTS public.trial_spend, public.trial_redemptions, public.trial_codes;
--   ALTER TABLE public.generations DROP CONSTRAINT IF EXISTS generations_rail_check;
--   ALTER TABLE public.generations ADD CONSTRAINT generations_rail_check CHECK (rail IN ('web', 'free', 'x402', 'mcp'));
--   UPDATE public.users SET role = 'user' WHERE role = 'trial';
--   DELETE FROM public.roles WHERE key = 'trial';
