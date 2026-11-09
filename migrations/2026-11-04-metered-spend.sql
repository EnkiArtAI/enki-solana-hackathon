-- SQL 72: the daily spend breaker (key-theft measures, Kev 2026-11-04: "ffmpeg ja, build"). What Enki may commit to metered
-- providers in one UTC day, reserved here before a render or a judge runs on Enki's money, across every serverless function:
-- $100 by default, the app passes METERED_SPEND_USD_PER_DAY. In micro-USD, the unit of model_cost_micro.
-- At the cap reserve_metered_spend answers allowed = false and adds nothing. The day's first refusal says first_refusal = true
-- once, and only that answer sends the day's one mail; a mail that did not go out clears the mark, so a later refusal tries
-- again. A cap of 0 closes on purpose: no mark and no mail.
--
-- A reservation is one UPDATE that re-reads its own WHERE under the row's lock, so two functions at the cap cannot both pass
-- (READ COMMITTED re-evaluates the WHERE on the row the first writer left). No advisory lock is needed: there is one row a day.
-- The day's rows stay, one a day: how much was reserved, and when the cap was first met.
--
-- VERIFIED live 2026-11-04 by Claude, read-only: metered_spend_days answers 404 PGRST205 and rpc/reserve_metered_spend
-- 404 PGRST202.
-- Before this runs: lib/generation/spend-cap.ts refuses every metered render and every new paid order, unlike SQL 63 ("could
-- not check its daily limit"). So run this BEFORE the deploy. Port 3008 reads the live database and refuses too, until it has run.
-- It is harmless alone: no code calls it until that deploy. Service role only. Re-runnable.
BEGIN;

CREATE TABLE IF NOT EXISTS public.metered_spend_days (
  day              date        PRIMARY KEY,
  reserved_micro   bigint      NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0),
  first_refused_at timestamptz
);

ALTER TABLE public.metered_spend_days ENABLE ROW LEVEL SECURITY;
-- Said out loud: Supabase announced an end to default grants on new tables for existing projects (changelog 45329). Both
-- functions write as their owner and no code reads the table, so nobody gets a grant on it.
REVOKE ALL ON public.metered_spend_days FROM PUBLIC, anon, authenticated;

-- A wrong call raises: a zero or a missing amount must never read as a free pass, and a raise is a refusal in the app.
CREATE OR REPLACE FUNCTION public.reserve_metered_spend(p_micro bigint, p_cap_micro bigint)
RETURNS TABLE (spend_day date, allowed boolean, first_refusal boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_day date;
BEGIN
  IF p_micro IS NULL OR p_micro <= 0 OR p_cap_micro IS NULL OR p_cap_micro < 0 THEN
    RAISE EXCEPTION 'An amount above 0 and a cap of 0 or more are required' USING ERRCODE = '22023';
  END IF;
  v_day := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  INSERT INTO public.metered_spend_days (day) VALUES (v_day) ON CONFLICT (day) DO NOTHING;
  UPDATE public.metered_spend_days SET reserved_micro = reserved_micro + p_micro
   WHERE day = v_day AND reserved_micro + p_micro <= p_cap_micro;
  IF FOUND THEN
    RETURN QUERY SELECT v_day, true, false;
    RETURN;
  END IF;
  UPDATE public.metered_spend_days SET first_refused_at = clock_timestamp()
   WHERE day = v_day AND first_refused_at IS NULL AND p_cap_micro > 0;
  RETURN QUERY SELECT v_day, false, FOUND;
END $$;

-- Gives back what was reserved for a call that was never billed, on the day it was reserved. Never below 0.
CREATE OR REPLACE FUNCTION public.release_metered_spend(p_day date, p_micro bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_day IS NULL OR p_micro IS NULL OR p_micro <= 0 THEN
    RAISE EXCEPTION 'A day and an amount above 0 are required' USING ERRCODE = '22023';
  END IF;
  UPDATE public.metered_spend_days SET reserved_micro = greatest(0, reserved_micro - p_micro) WHERE day = p_day;
END $$;

-- The day's mail did not go out: the next refusal is the first again. Only the mail's own failure calls this.
CREATE OR REPLACE FUNCTION public.clear_first_refusal_metered_spend(p_day date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.metered_spend_days SET first_refused_at = NULL WHERE day = p_day;
END $$;

REVOKE ALL ON FUNCTION public.reserve_metered_spend(bigint, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_metered_spend(date, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_first_refusal_metered_spend(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_metered_spend(bigint, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_metered_spend(date, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_first_refusal_metered_spend(date) TO service_role;

COMMIT;

-- Check (empty is fine; 3 rows from the second):
--   SELECT * FROM public.metered_spend_days ORDER BY day DESC LIMIT 7;
--   SELECT proname FROM pg_proc WHERE proname LIKE '%metered_spend';

-- Rollback (every metered render then refuses until the code that calls it is reverted too):
--   DROP FUNCTION IF EXISTS public.reserve_metered_spend(bigint, bigint);
--   DROP FUNCTION IF EXISTS public.release_metered_spend(date, bigint);
--   DROP FUNCTION IF EXISTS public.clear_first_refusal_metered_spend(date);
--   DROP TABLE IF EXISTS public.metered_spend_days;
