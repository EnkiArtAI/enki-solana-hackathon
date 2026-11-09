-- SQL 61: a human's false alarm on a child-safety image case (Kev, 2026-11-02, the case of an imported creator's post).
-- The moderation owner looks at the case's image by the logged reveal and overturns it; this row then lets exactly those
-- bytes through on the hunter's import (lib/moderation/image-clearance, lib/referral/judge-post). Every other route keeps
-- refusing them, other bytes are judged as ever, and the case, its verdict and its evidence copy stay. An uphold takes it
-- back: a find still waiting is refused at its publish, a prompt it was published to comes down.
-- It holds the checksum and no image: sha256 is automod_events.prompt_hash of the case, the sha256 of the judged bytes
-- (lib/moderation/image-case). Who, when and which case; revoked_at when an uphold took it back, and such a row stays.
--
-- VERIFIED live 2026-11-02 by Claude, read-only: image_clearances and image_clearance_prompts answer 404 PGRST205,
-- clear_image_case 404 PGRST202; automod_events.id, users.id, artist_text_reveals.event_id and revealed_by are uuid; the
-- one child-safety image case holds a 64-hex prompt_hash.
-- Before this runs: an image case's overturn answers 503 "needs SQL 61" and changes nothing; an uphold, every other
-- overturn and every import work as today, except that bytes with an image case stay out in every mode, nothing being
-- able to clear them. Service role only. Re-runnable.
--
-- cleared_by and revoked_by carry no foreign key, as artist_text_reveals.revealed_by: the record outlives the account.
CREATE TABLE IF NOT EXISTS public.image_clearances (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256     text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  event_id   uuid        NOT NULL REFERENCES public.automod_events(id),
  cleared_by uuid        NOT NULL,
  cleared_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT image_clearances_revoked_whole CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- One standing clearance per case: pressing twice is one decision.
CREATE UNIQUE INDEX IF NOT EXISTS image_clearances_one_standing ON public.image_clearances (event_id) WHERE revoked_at IS NULL;
-- What the hunter's import asks.
CREATE INDEX IF NOT EXISTS image_clearances_standing_sha256 ON public.image_clearances (sha256) WHERE revoked_at IS NULL;

ALTER TABLE public.image_clearances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.image_clearances FROM PUBLIC, anon, authenticated;
-- Said out loud: Supabase announced an end to default grants on new tables for existing projects (changelog 45329).
-- A read, and an uphold's update; the insert is clear_image_case's, as its owner.
GRANT SELECT, UPDATE ON public.image_clearances TO service_role;

-- The prompts cleared bytes were published to, written before the listing: what a take-back must reach. prompt_id carries
-- no foreign key, so the note outlives a deleted prompt, as artist_text_reveals.prompt_id.
CREATE TABLE IF NOT EXISTS public.image_clearance_prompts (
  sha256     text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  prompt_id  uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sha256, prompt_id)
);
ALTER TABLE public.image_clearance_prompts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.image_clearance_prompts FROM PUBLIC, anon, authenticated;
-- The note a publish writes and an uphold reads.
GRANT SELECT, INSERT ON public.image_clearance_prompts TO service_role;

-- The overturn: the clearance and the case's own review in one transaction, so no clearance stands behind a failed answer
-- and no process death leaves one without its case. Pressed twice: the first press's clearance stands.
CREATE OR REPLACE FUNCTION public.clear_image_case(p_event_id uuid, p_sha256 text, p_cleared_by uuid, p_notes text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.image_clearances (sha256, event_id, cleared_by) VALUES (p_sha256, p_event_id, p_cleared_by)
    ON CONFLICT (event_id) WHERE revoked_at IS NULL DO NOTHING;
  UPDATE public.automod_events
    SET review_state = 'overturned', reviewed_by = p_cleared_by, reviewed_at = now(), review_notes = p_notes
    WHERE id = p_event_id;
END $$;

REVOKE ALL ON FUNCTION public.clear_image_case(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_image_case(uuid, text, uuid, text) TO service_role;

-- Check:
--   SELECT count(*) AS rows, count(*) FILTER (WHERE revoked_at IS NULL) AS standing FROM public.image_clearances;
--   SELECT count(*) AS prompts_noted FROM public.image_clearance_prompts;

-- Rollback (every cleared image counts as unreviewed again; the cases and the admin log stay; a prompt already taken down stays down):
--   DROP FUNCTION IF EXISTS public.clear_image_case(uuid, text, uuid, text); DROP TABLE IF EXISTS public.image_clearance_prompts; DROP TABLE IF EXISTS public.image_clearances;
