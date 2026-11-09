-- SQL 75: the yearly check of each guardian (Kev, 2026-11-07, on a guardian who lost their own access: "jährlichen check dann
-- einbauen"). Once a year each confirmed guardian by email or wallet gets a "still reachable?" ask: an email guardian a link,
-- a wallet guardian a link its owner sends, signed on /guardian. An answer, or a yes to a request of the owner, stamps
-- checked_at. No answer within 14 days sets unreachable_at: Settings shows them as not reachable, and every address of the
-- owner hears. The daily cron /api/cron/guardian-check (vercel.json) does nothing until this ran, and answers 503 saying so.
--
-- VERIFIED live 2026-11-07 by Claude, read-only (OpenAPI): recovery_guardians has confirmed_at and created_at and none of the
-- four columns below; 1 row, 0 confirmed.
--
-- Any time, before or after the deploy. Additive and re-runnable. recovery_guardians keeps its RLS (on, no policy) and grants.

ALTER TABLE public.recovery_guardians ADD COLUMN IF NOT EXISTS checked_at timestamptz;     -- the last answer, or a yes to a request
ALTER TABLE public.recovery_guardians ADD COLUMN IF NOT EXISTS check_sent_at timestamptz;  -- the open check went out; NULL: none open
ALTER TABLE public.recovery_guardians ADD COLUMN IF NOT EXISTS check_token_hash text;      -- an email guardian's link token, SHA-256 only
ALTER TABLE public.recovery_guardians ADD COLUMN IF NOT EXISTS unreachable_at timestamptz; -- 14 days without an answer; the owner was told

-- Check (zeros on a first run):
--   SELECT count(*) FILTER (WHERE check_sent_at IS NOT NULL) AS open, count(*) FILTER (WHERE unreachable_at IS NOT NULL) AS unreachable FROM public.recovery_guardians;

-- Rollback (every open check and every mark goes; the cron answers 503 again):
--   ALTER TABLE public.recovery_guardians DROP COLUMN IF EXISTS checked_at, DROP COLUMN IF EXISTS check_sent_at, DROP COLUMN IF EXISTS check_token_hash, DROP COLUMN IF EXISTS unreachable_at;
