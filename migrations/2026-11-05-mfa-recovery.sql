-- SQL 74: recovery codes and the way out for a lost factor (Kev, 2026-11-05: "was is mit wiederherstellungs codes, fix that",
-- "gehe dann das sicherste an"). A factor is removed only with every factor, so someone who lost one had no way out. Now one
-- single-use code removes a factor at once, and without a code one code to EVERY address of the account, all entered, removes it
-- at once too (Kev, 2026-11-07: "keine wartezeit"). With fewer than two addresses that path is not offered.
--
-- mfa_recovery_codes: ten single-use codes per account, stored only as an HMAC under a key derived from AUTH_PEPPER, over
-- user_id:code. A dump opens nothing.
-- mfa_recovery: one row per account, so at most one live set of mailed codes. failed_attempts is claimed with a conditional update
-- before a code is compared, as on mfa_factors, for recovery codes and mailed codes together. code_hashes: one keyed hash per
-- address, over user_id:address:code. The 5 day wait this file first held (code_hash, ready_at, cancel_token_hash) is gone:
-- changed 2026-11-07, before it ever ran.
--
-- VERIFIED live 2026-11-05 by Claude, read-only: mfa_recovery and mfa_recovery_codes answer `404 PGRST205`; users has 46 rows;
-- mfa_factors and webauthn_credentials 0, so no account has a factor today and none is without codes.
--
-- Before the deploy: the factor mails and the step-up dialog point at Settings, Recovery, Lost a factor, and that area is
-- hidden until this ran. Until it runs: factor setup works and answers no codes,
-- every new route answers 503 "This is not available yet" (asking guardians to remove a factor too), and Settings hides the area. Service role only, grants written out,
-- as Supabase announced an end to default grants on new tables (SQL 72). Additive and re-runnable.

CREATE TABLE IF NOT EXISTS public.mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_recovery_codes_unused ON public.mfa_recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS public.mfa_recovery (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  failed_attempts smallint NOT NULL DEFAULT 0,
  lockouts smallint NOT NULL DEFAULT 0,
  locked_until timestamptz,
  factor text CHECK (factor IN ('passkey', 'totp', 'email')),
  code_hashes text[],
  code_expires_at timestamptz,
  code_sent_at timestamptz,
  sends_day date,
  sends_count smallint NOT NULL DEFAULT 0
);

-- No policies: only the server's service role reads or writes them.
ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mfa_recovery_codes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.mfa_recovery FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mfa_recovery_codes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mfa_recovery TO service_role;

-- Guardians remove a lost factor at once (Kev, 2026-11-07: "ok go for the guardians", "keine wartezeit"): a request in
-- recovery_requests names the factor (NULL: a password reset's request, as before), with one recovery_approvals row per
-- guardian asked, as the guardian password reset uses them. VERIFIED live 2026-11-07 by Claude, read-only (OpenAPI): six
-- columns of the table's old design are NOT NULL with no default (contact_email_ct, contact_email_iv, contact_email_tag,
-- contact_email_kid, contact_email_lookup_hash, layer) and no route writes them, so no insert of the app could land (0 rows).
-- The same fix migrations/2026-07-12-recovery-guardians.sql made for recovery_guardians; the rollback keeps them nullable.
ALTER TABLE public.recovery_requests ADD COLUMN IF NOT EXISTS factor text CHECK (factor IN ('passkey', 'totp', 'email'));
ALTER TABLE public.recovery_requests ALTER COLUMN contact_email_ct DROP NOT NULL;
ALTER TABLE public.recovery_requests ALTER COLUMN contact_email_iv DROP NOT NULL;
ALTER TABLE public.recovery_requests ALTER COLUMN contact_email_tag DROP NOT NULL;
ALTER TABLE public.recovery_requests ALTER COLUMN contact_email_kid DROP NOT NULL;
ALTER TABLE public.recovery_requests ALTER COLUMN contact_email_lookup_hash DROP NOT NULL;
ALTER TABLE public.recovery_requests ALTER COLUMN layer DROP NOT NULL;
-- One running ask per account: of two asks at once, the second insert answers 23505.
CREATE UNIQUE INDEX IF NOT EXISTS recovery_requests_one_factor_ask ON public.recovery_requests (user_id) WHERE factor IS NOT NULL AND status = 'pending';

-- Check (two zeros on a first run; then codes and rows as accounts use them):
--   SELECT (SELECT count(*) FROM public.mfa_recovery_codes) AS codes, (SELECT count(*) FROM public.mfa_recovery) AS rows;

-- Rollback (every code and every open request goes; the routes answer as before this file ran):
--   DROP TABLE IF EXISTS public.mfa_recovery_codes; DROP TABLE IF EXISTS public.mfa_recovery; ALTER TABLE public.recovery_requests DROP COLUMN IF EXISTS factor;
