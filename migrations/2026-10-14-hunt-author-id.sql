-- The X author of a referred post, by X's numeric user id (Kev, 2026-10-14):
-- the author's vault is derived from it (docs/ESCROW-V2-SHARES.md §2), never
-- from the handle, which changes hands. Written by POST /api/prompt when a
-- referred post is published; old rows stay NULL and earn the author nothing
-- until re-imported.
--
-- Probed live 2026-10-14: hunt_submissions has source_author_handle (text) and
-- no id column. Additive and idempotent.
BEGIN;
ALTER TABLE public.hunt_submissions ADD COLUMN IF NOT EXISTS source_author_id text;
CREATE INDEX IF NOT EXISTS hunt_submissions_source_author_id_idx ON public.hunt_submissions (source_author_id) WHERE source_author_id IS NOT NULL;
COMMIT;

-- Read back: SELECT column_name FROM information_schema.columns WHERE table_name = 'hunt_submissions' AND column_name = 'source_author_id';
-- Rollback: ALTER TABLE public.hunt_submissions DROP COLUMN IF EXISTS source_author_id;
