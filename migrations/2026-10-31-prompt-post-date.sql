-- Kev, 2026-10-31: "save inside of the prompts the date of the post so that i can as well later sort after release date".
-- An imported prompt keeps the date its post went up on X. X ids carry their own time (ms = (id >> 22) + 1288834974657),
-- so the date comes from the post's id, also for the hunted prompts made before this file.
BEGIN;

ALTER TABLE public.prompts ADD COLUMN IF NOT EXISTS source_posted_at timestamptz;
-- How far an imported prompt spread on X: its core post's likes, reposts and quotes and their sums over the chain it
-- was forwarded through (Kev, 2026-10-31: "how contagious a tweet gets ... list it somewhere for each image").
ALTER TABLE public.prompts ADD COLUMN IF NOT EXISTS source_reach jsonb;

UPDATE public.prompts p
SET source_posted_at = to_timestamp(((substring(h.normalized_source_url from 'status/([0-9]+)$')::bigint >> 22) + 1288834974657) / 1000.0)
FROM public.hunt_submissions h
WHERE h.minted_prompt_id = p.id AND p.source_posted_at IS NULL AND h.normalized_source_url ~ 'status/[0-9]+$';

-- Imported prompts made before carry no aspect ratio, so cards cropped them to 4:5 (Kev, 2026-10-31): their first
-- picture's own width and height (generated_images, recorded at the import).
UPDATE public.prompts p
SET aspect_ratio = g.width || ':' || g.height
FROM public.generated_images g
WHERE g.prompt_id = p.id AND g.sequence_index = 0 AND g.is_uploaded AND g.width > 0 AND g.height > 0
  AND p.aspect_ratio IS NULL AND p.source_posted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS prompts_source_posted_at_idx ON public.prompts (source_posted_at DESC) WHERE source_posted_at IS NOT NULL;

COMMIT;

-- Rollback: DROP INDEX IF EXISTS public.prompts_source_posted_at_idx; ALTER TABLE public.prompts DROP COLUMN IF EXISTS source_posted_at;
