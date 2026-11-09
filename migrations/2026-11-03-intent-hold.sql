-- SQL 70: a video's held payment (Kev, 2026-08-06: "once the image goes through, we will receive the money"). A video takes
-- minutes, and the sweep voids any claimed payment after 6 (lib/payments/authorization ABANDONED_AFTER_MS, a bound the image
-- route's function budget makes true). hold_until: the sweep leaves this row alone until then. Only a video unit sets it, so every
-- image row reads NULL and is swept as before. video_settings: the sum of a video's settings, what /api/video/jobs runs, and what
-- marks an intent as a video's.
--
-- VERIFIED live 2026-11-03 by Claude, read-only: `generation_payment_intents?select=hold_until` answers 400 42703; the table has
-- consumed_at, capture_started_at, batch_intent_id, unit_index and no hold column. open_intent_batch clones through to_jsonb(parent)
-- (37-intent-rail.sql), so a clone would carry both.
--
-- Any time, before or after the deploy: the sweep falls back to its old read on a 42703, so a deploy before this file does not
-- switch the sweep off. Until it runs POST /api/video/intent answers 503 naming this file. Re-runnable.

ALTER TABLE public.generation_payment_intents
  ADD COLUMN IF NOT EXISTS hold_until timestamptz,
  ADD COLUMN IF NOT EXISTS video_settings jsonb;

-- Check (two rows; the count is 0 until a video is paid for):
--   SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'generation_payment_intents' AND column_name IN ('hold_until', 'video_settings');
--   SELECT count(*) FROM public.generation_payment_intents WHERE video_settings IS NOT NULL;

-- Rollback (a video in flight then falls to the 6-minute sweep):
--   ALTER TABLE public.generation_payment_intents DROP COLUMN IF EXISTS hold_until, DROP COLUMN IF EXISTS video_settings;
