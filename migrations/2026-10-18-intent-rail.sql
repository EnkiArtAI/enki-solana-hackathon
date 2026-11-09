-- The intent (durable-nonce) rail comes back next to escrow (Kev, 2026-10-18:
-- "wir brauchen intents wieder", "so, dass wir das einfach umknipsen auf
-- escrow können"). One intent row per image: a batch is the quoted row plus
-- cloned unit rows, each with its own nonce account and held transaction.
--
-- Probed live 2026-10-18 (read-only OpenAPI + Kev's pg_constraint paste):
-- batch_intent_id, unit_index, capture_started_at, nonce_closed_at and RPC
-- open_intent_batch are absent; void_reason allows provider_failed, rejected,
-- cancelled, abandoned, expired; status already allows building, authorized,
-- generating, captured, voided; single_outcome is CHECK (captured_at IS NULL
-- OR voided_at IS NULL). 84 intents: 60 confirmed by escrow, 1 ever had a
-- nonce (devnet, voided 2026-09-23), 0 carry both rails.
--
-- Run BEFORE deploying the intent rail. Re-runnable: IF NOT EXISTS, and each
-- constraint is dropped and added again.

ALTER TABLE public.generation_payment_intents
  ADD COLUMN IF NOT EXISTS batch_intent_id    uuid REFERENCES public.generation_payment_intents(id),
  ADD COLUMN IF NOT EXISTS unit_index         smallint,
  ADD COLUMN IF NOT EXISTS capture_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS nonce_closed_at    timestamptz;

-- A capture that did not land, and a render whose buyer no longer held the USDC.
ALTER TABLE public.generation_payment_intents
  DROP CONSTRAINT IF EXISTS generation_payment_intents_void_reason_check;
ALTER TABLE public.generation_payment_intents
  ADD CONSTRAINT generation_payment_intents_void_reason_check CHECK (void_reason IS NULL OR void_reason IN
    ('provider_failed', 'rejected', 'cancelled', 'abandoned', 'expired', 'unfunded', 'capture_failed'));

-- A unit names its batch (the quoted row, unit 0) and its place in it, or neither.
ALTER TABLE public.generation_payment_intents
  DROP CONSTRAINT IF EXISTS generation_payment_intents_unit;
ALTER TABLE public.generation_payment_intents
  ADD CONSTRAINT generation_payment_intents_unit CHECK
    ((batch_intent_id IS NULL AND unit_index IS NULL) OR (batch_intent_id IS NOT NULL AND unit_index BETWEEN 0 AND 23));

-- One rail per intent: an escrow deposit and a nonce never share a row.
ALTER TABLE public.generation_payment_intents
  DROP CONSTRAINT IF EXISTS generation_payment_intents_one_rail;
ALTER TABLE public.generation_payment_intents
  ADD CONSTRAINT generation_payment_intents_one_rail CHECK (deposit_signature IS NULL OR nonce_account IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS generation_payment_intents_batch_unit
  ON public.generation_payment_intents (batch_intent_id, unit_index) WHERE batch_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS generation_payment_intents_nonce_account
  ON public.generation_payment_intents (nonce_account) WHERE nonce_account IS NOT NULL;
-- What the caps count: nonce accounts that hold rent.
CREATE INDEX IF NOT EXISTS generation_payment_intents_open_nonce
  ON public.generation_payment_intents (buyer_wallet) WHERE nonce_account IS NOT NULL AND nonce_closed_at IS NULL;
-- What the 30-minute pause counts: captures that did not land.
CREATE INDEX IF NOT EXISTS generation_payment_intents_failed_capture
  ON public.generation_payment_intents (buyer_wallet, voided_at) WHERE void_reason = 'capture_failed';

-- The one historical nonce row (devnet, voided 2026-09-23) holds no open account. Bounded by date so a re-run after
-- go-live never marks a live voided unit's still-open nonce as closed (its rent would be lost to the sweep).
UPDATE public.generation_payment_intents SET nonce_closed_at = voided_at
  WHERE nonce_account IS NOT NULL AND voided_at IS NOT NULL AND nonce_closed_at IS NULL
    AND voided_at < timestamptz '2026-10-18 00:00:00+00';

-- Opens a batch of p_units units on a quoted intent, atomically, BEFORE any
-- nonce account exists on chain: the quoted row becomes unit 0, units 1..N-1
-- are clones of it, each reserves one of p_nonces. Refused (no rows) when the
-- open nonce accounts would pass p_max_open overall or p_max_open_buyer for
-- this buyer (Kev, 2026-10-18: "8 offene käufe pro person max"); raises when
-- the intent is not a fresh quote of this buyer or already belongs to escrow.
CREATE OR REPLACE FUNCTION public.open_intent_batch(
  p_intent uuid, p_buyer text, p_units int, p_nonces text[], p_authority text, p_max_open int, p_max_open_buyer int
) RETURNS SETOF public.generation_payment_intents
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  parent generation_payment_intents%ROWTYPE;
  open_all int;
  open_buyer int;
BEGIN
  IF p_units NOT BETWEEN 1 AND 24 OR coalesce(array_length(p_nonces, 1), 0) <> p_units THEN
    RAISE EXCEPTION 'open_intent_batch: units and nonces differ' USING ERRCODE = '22023';
  END IF;
  -- One opener at a time, so two batches cannot both pass the caps.
  PERFORM pg_advisory_xact_lock(hashtext('open_intent_batch'));
  SELECT * INTO parent FROM generation_payment_intents g
   WHERE g.id = p_intent AND g.buyer_wallet = p_buyer AND g.status = 'quoted' AND g.expires_at > now()
     AND g.deposit_signature IS NULL AND g.nonce_account IS NULL AND g.batch_intent_id IS NULL
     AND g.authorized_at IS NULL AND g.captured_at IS NULL AND g.voided_at IS NULL
   FOR UPDATE;
  IF NOT FOUND
     OR EXISTS (SELECT 1 FROM generation_escrow_deposits d WHERE d.intent_id = p_intent)
     OR EXISTS (SELECT 1 FROM generation_escrow_recovery r WHERE r.intent_id = p_intent) THEN
    RAISE EXCEPTION 'open_intent_batch: intent not open' USING ERRCODE = 'P0002';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE g.buyer_wallet = p_buyer) INTO open_all, open_buyer
    FROM generation_payment_intents g WHERE g.nonce_account IS NOT NULL AND g.nonce_closed_at IS NULL;
  IF open_all + p_units > p_max_open OR open_buyer + p_units > p_max_open_buyer THEN
    RETURN;
  END IF;
  UPDATE generation_payment_intents g SET batch_intent_id = p_intent, unit_index = 0, nonce_account = p_nonces[1],
    nonce_authority = p_authority, status = 'building', updated_at = now()
   WHERE g.id = p_intent;
  INSERT INTO generation_payment_intents
    SELECT (jsonb_populate_record(NULL::generation_payment_intents, to_jsonb(parent) || jsonb_build_object(
      'id', gen_random_uuid(), 'batch_intent_id', p_intent, 'unit_index', i - 1, 'nonce_account', p_nonces[i],
      'nonce_authority', p_authority, 'status', 'building', 'created_at', now(), 'updated_at', now()))).*
    FROM generate_series(2, p_units) AS i;
  RETURN QUERY SELECT * FROM generation_payment_intents g WHERE g.batch_intent_id = p_intent ORDER BY g.unit_index;
END $$;

REVOKE ALL ON FUNCTION public.open_intent_batch(uuid, text, int, text[], text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_intent_batch(uuid, text, int, text[], text, int, int) TO service_role;

-- Read back:
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'generation_payment_intents'
--    AND column_name IN ('batch_intent_id', 'unit_index', 'capture_started_at', 'nonce_closed_at');
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'generation_payment_intents_void_reason_check';

-- Rollback (only while no row uses the new columns or reasons):
--   DROP FUNCTION IF EXISTS public.open_intent_batch(uuid, text, int, text[], text, int, int);
--   DROP INDEX IF EXISTS public.generation_payment_intents_failed_capture;
--   DROP INDEX IF EXISTS public.generation_payment_intents_open_nonce;
--   DROP INDEX IF EXISTS public.generation_payment_intents_nonce_account;
--   DROP INDEX IF EXISTS public.generation_payment_intents_batch_unit;
--   ALTER TABLE public.generation_payment_intents DROP CONSTRAINT IF EXISTS generation_payment_intents_one_rail;
--   ALTER TABLE public.generation_payment_intents DROP CONSTRAINT IF EXISTS generation_payment_intents_unit;
--   ALTER TABLE public.generation_payment_intents DROP CONSTRAINT IF EXISTS generation_payment_intents_void_reason_check;
--   ALTER TABLE public.generation_payment_intents ADD CONSTRAINT generation_payment_intents_void_reason_check CHECK (void_reason IS NULL OR void_reason IN ('provider_failed', 'rejected', 'cancelled', 'abandoned', 'expired'));
--   ALTER TABLE public.generation_payment_intents DROP COLUMN IF EXISTS nonce_closed_at, DROP COLUMN IF EXISTS capture_started_at, DROP COLUMN IF EXISTS unit_index, DROP COLUMN IF EXISTS batch_intent_id;
