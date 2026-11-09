-- SQL 69: one row per video being made (Kev, 2026-11-03: "wir rollen danach die API routes erstmal aus"). A video takes minutes,
-- so a press leaves a job the cron (/api/cron/video-jobs) follows: submitting, running, transcoding, then delivered, failed or
-- refused. It is also the per-user handling log an operator's terms ask for (Kev, 2026-10-30: "die pflichten sollten wir alle
-- einbauen"): the user's hash, the operator, its task id and code, the settings, the consent. words_* is the sealed text and the
-- buyer's values, kept for the generations row at delivery. `video`: the stored files, written before the money moves, so a
-- crash after the capture still delivers them.
--
-- Why not generation_jobs: it has 0 rows, no code reads it, and it requires variable_values_ct/iv/tag/kid and image_count, a
-- purchase-era shape that would need dummy values (VERIFIED by OpenAPI 2026-11-03).
--
-- Also here, because a video's records need them:
--   generations_provider_check takes the one literal 'video'. The operator stays on this table, never on generations. Its other
--   literals are the code's Provider type and SQL 16's list; the constraint is not readable from outside, so a live row with any
--   other value makes this ADD fail loudly and changes nothing (BEGIN .. COMMIT).
--   Any CHECK on generated_images.storage_provider takes 'supabase'. NOT DETERMINED whether one exists: constraints do not show
--   in OpenAPI and a probe insert is a write. The DO block widens one if it is there and does nothing if not; its first real run
--   is its only real test, PGlite only simulates the constraint.
--
-- VERIFIED live 2026-11-03 by Claude, read-only: video_jobs answers 404 PGRST205; generation_payment_intents.id, users.id and
-- models.id are uuid; generations.provider holds gemini, openai, wavespeed and pollinations; generated_images.storage_provider
-- is required.
--
-- RUN BEFORE THE DEPLOY OF THE VIDEO ROUTES, with 70. Until it runs POST /api/video/intent answers 503 naming this file. Nobody
-- can pay until an operator is set anyway. Service role only, its grant written out. Re-runnable.

BEGIN;

CREATE TABLE IF NOT EXISTS public.video_jobs (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES public.users(id),
  intent_id          uuid        NOT NULL UNIQUE REFERENCES public.generation_payment_intents(id),
  prompt_id          uuid,
  model_id           uuid        NOT NULL,
  operator           text        NOT NULL,
  provider_model     text        NOT NULL,
  provider_task_id   text,
  settings           jsonb       NOT NULL,
  words_ct           text,
  words_iv           text,
  words_tag          text,
  words_kid          text,
  refs               jsonb,
  end_user_hash      text        NOT NULL,
  consent            boolean     NOT NULL DEFAULT false,
  status             text        NOT NULL DEFAULT 'submitting' CHECK (status IN ('submitting', 'running', 'transcoding', 'delivered', 'failed', 'refused')),
  attempt_count      integer     NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  provider_code      text,
  provider_usage     jsonb,
  error_class        text,
  video              jsonb,
  generated_image_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz
);
-- What the cron's minute reads, and a person's History.
CREATE INDEX IF NOT EXISTS video_jobs_due ON public.video_jobs (status, locked_until);
CREATE INDEX IF NOT EXISTS video_jobs_user ON public.video_jobs (user_id, created_at DESC);

ALTER TABLE public.video_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.video_jobs FROM PUBLIC, anon, authenticated;
-- Said out loud: Supabase announced an end to default grants on new tables for existing projects (changelog 45329).
GRANT SELECT, INSERT, UPDATE ON public.video_jobs TO service_role;

ALTER TABLE public.generations DROP CONSTRAINT IF EXISTS generations_provider_check;
ALTER TABLE public.generations ADD CONSTRAINT generations_provider_check
  CHECK (provider IN ('gemini', 'openai', 'wavespeed', 'pollinations', 'acedata', 'none', 'video'));

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'public.generated_images'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%storage_provider%'
  LOOP
    IF c.def NOT LIKE '%supabase%' THEN
      EXECUTE format('ALTER TABLE public.generated_images DROP CONSTRAINT %I', c.conname);
      EXECUTE format('ALTER TABLE public.generated_images ADD CONSTRAINT %I CHECK ((%s) OR storage_provider = ''supabase'')', c.conname, regexp_replace(c.def, '^CHECK\s*', ''));
    END IF;
  END LOOP;
END $$;

COMMIT;

-- Check (no rows yet; the first shows 'video', the second 'supabase' or nothing where no CHECK exists):
--   SELECT count(*) FROM public.video_jobs;
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.generations'::regclass AND conname = 'generations_provider_check';
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.generated_images'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%storage_provider%';

-- Rollback (only while no video was recorded: a row with provider 'video' or storage_provider 'supabase' makes the first fail):
--   ALTER TABLE public.generations DROP CONSTRAINT IF EXISTS generations_provider_check;
--   ALTER TABLE public.generations ADD CONSTRAINT generations_provider_check CHECK (provider IN ('gemini', 'openai', 'wavespeed', 'pollinations', 'acedata', 'none'));
--   DROP TABLE IF EXISTS public.video_jobs;
--   The widened storage_provider CHECK, if one was found, stays: it refuses nothing the old one took.
