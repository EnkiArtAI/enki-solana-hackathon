-- Kev, 2026-10-31: "mach bitte einfach 2 bilder gratis pro account for ever. danach ist auffüllen angesagt."
-- Two free baseline-model images per account, ever (was one per UTC day: 2026-10-12-free-daily-quota.sql).
-- Same signatures, for rolling deploys: a caller still passing 1 grants at most one in the account's lifetime, and
-- resets_at is NULL (nothing resets). Claims made before count: an account that had two free images has none left.
-- A failed render still releases its claim (the app deletes the row).
BEGIN;

CREATE OR REPLACE FUNCTION public.claim_free_generation(p_user_id uuid, p_limit int)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_limit IS NULL OR p_limit <= 0 THEN
    RETURN NULL;
  END IF;
  -- One claim at a time per account, so two parallel requests cannot both take the last one.
  PERFORM pg_advisory_xact_lock(hashtextextended('free_generation_claims:' || p_user_id::text, 0));
  IF (SELECT count(*) FROM public.free_generation_claims WHERE user_id = p_user_id) >= LEAST(p_limit, 2) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.free_generation_claims (user_id, created_at)
    VALUES (p_user_id, clock_timestamp()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.free_generation_quota(p_user_id uuid)
RETURNS TABLE (used int, "limit" int, remaining int, exhausted boolean, resets_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_used int;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'An account is required' USING ERRCODE = '22023';
  END IF;
  SELECT count(*)::int INTO v_used FROM public.free_generation_claims WHERE user_id = p_user_id;
  RETURN QUERY SELECT v_used, 2, GREATEST(0, 2 - v_used), v_used >= 2, NULL::timestamptz;
END $$;

REVOKE ALL ON FUNCTION public.claim_free_generation(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.free_generation_quota(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_free_generation(uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.free_generation_quota(uuid) TO service_role;

COMMIT;

-- Rollback: run migrations/2026-10-12-free-daily-quota.sql again (one per UTC day).
