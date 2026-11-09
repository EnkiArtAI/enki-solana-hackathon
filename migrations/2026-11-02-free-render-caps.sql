-- SQL 63: the daily caps behind the bot guard on free renders (Kev, 2026-10-30: "ich will auch nicht, dass bots über x402
-- free generations haben bei mir. only humans are allowed to have 1 for free"). All accounts together FREE_RENDERS_PER_DAY
-- a UTC day (default 200, the app passes it), one hashed address one a UTC day (a shared office is the accepted cost),
-- an unknown address counted under one shared bucket. On top of the account's own two ever (SQL 57), which it leaves alone.
-- The route claims here after the session and the human check, before any model call and before the account's claim, and
-- deletes the row again on every answer that delivered no image, so a refused or failed try uses up nothing.
--
-- It holds hashes and no address (lib/ip-hash hashIp), and only for the day in hand: each claim removes earlier days' rows.
-- free_render_full_days has no address at all and stays: on which days the cap was reached, so Kev can see whether a stronger
-- human proof is needed. Reached, not delivered: renders still running hold places, and a failed one gives its place back.
-- A day's first refusal inserts its row, and only that answer says to send the day's one mail. A limit of 0 closes free
-- renders on purpose: no row and no mail, so the record measures demand alone.
--
-- VERIFIED live 2026-11-02 by Claude, read-only: free_render_claims and free_render_full_days answer 404 PGRST205 (a
-- plain read; a head read answers 204 with no error on a missing table and shows nothing), a function that does not exist
-- answers 404 PGRST202.
-- Before this runs: the route answers as today (the account's two ever and the per-address request limit), logs one
-- warning per server process and refuses nothing for its absence. Service role only. Re-runnable.
BEGIN;

CREATE TABLE IF NOT EXISTS public.free_render_claims (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  day        date        NOT NULL,
  ip_bucket  text        NOT NULL CHECK (ip_bucket <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS free_render_claims_day_bucket_idx ON public.free_render_claims (day, ip_bucket);

CREATE TABLE IF NOT EXISTS public.free_render_full_days (
  day              date        PRIMARY KEY,
  first_refused_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.free_render_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.free_render_full_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.free_render_claims FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.free_render_full_days FROM PUBLIC, anon, authenticated;
-- Said out loud: Supabase announced an end to default grants on new tables for existing projects (changelog 45329).
-- A place given back (its WHERE reads the id). claim_free_render writes both tables as its owner, and no code reads the full days.
GRANT SELECT, DELETE ON public.free_render_claims TO service_role;

-- refused: NULL with a claim_id, else 'day' (all accounts) or 'ip' (this address). first_refusal: this is the day's first
-- answer 'day' under a limit above 0. A wrong call raises: the app must never read a bad argument as a free render.
CREATE OR REPLACE FUNCTION public.claim_free_render(p_ip_bucket text, p_day_limit int, p_ip_limit int)
RETURNS TABLE (claim_id uuid, refused text, first_refusal boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_day date;
  v_id uuid;
  v_new int;
BEGIN
  IF p_ip_bucket IS NULL OR p_ip_bucket = '' OR p_day_limit IS NULL OR p_ip_limit IS NULL THEN
    RAISE EXCEPTION 'A bucket and both limits are required' USING ERRCODE = '22023';
  END IF;
  -- One claim at a time across all accounts, so parallel requests cannot pass the cap. Held for a few statements, and the
  -- caller has already spent a single-use token to get here. The day is read after waiting for the lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('free_render_claims', 0));
  v_day := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  DELETE FROM public.free_render_claims WHERE free_render_claims.day < v_day;
  IF (SELECT count(*) FROM public.free_render_claims WHERE free_render_claims.day = v_day) >= p_day_limit THEN
    IF p_day_limit > 0 THEN
      INSERT INTO public.free_render_full_days (day) VALUES (v_day) ON CONFLICT (day) DO NOTHING;
      GET DIAGNOSTICS v_new = ROW_COUNT;
    END IF;
    RETURN QUERY SELECT NULL::uuid, 'day'::text, COALESCE(v_new, 0) = 1;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.free_render_claims
      WHERE free_render_claims.day = v_day AND ip_bucket = p_ip_bucket) >= p_ip_limit THEN
    RETURN QUERY SELECT NULL::uuid, 'ip'::text, false;
    RETURN;
  END IF;
  INSERT INTO public.free_render_claims (day, ip_bucket) VALUES (v_day, p_ip_bucket) RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, NULL::text, false;
END $$;

REVOKE ALL ON FUNCTION public.claim_free_render(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_free_render(text, int, int) TO service_role;

COMMIT;

-- Check:
--   SELECT count(*) AS claims_today FROM public.free_render_claims WHERE day = (now() AT TIME ZONE 'UTC')::date;
--   SELECT * FROM public.free_render_full_days ORDER BY day DESC LIMIT 7;

-- Rollback (the route goes back to today's limits by itself, with its one warning):
--   DROP FUNCTION IF EXISTS public.claim_free_render(text, int, int);
--   DROP TABLE IF EXISTS public.free_render_claims;
--   DROP TABLE IF EXISTS public.free_render_full_days;
