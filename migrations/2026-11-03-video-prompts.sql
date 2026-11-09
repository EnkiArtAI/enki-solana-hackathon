-- SQL 52: the columns a video prompt and a video render need (Kev, 2026-11-03: "roll dann videos bei explore aus ...
-- komprimiert ... endlos laufleiste für alle videos"). Old surfaces stay safe without an edit: a video prompt's
-- showcase_images holds its poster, and its generated_images row has storage_url = the 720p file, mime_type video/mp4,
-- and preview_url, thumbnail_url, view_url and tiny_url = the poster, so a grid, an OG card and a search show the poster.
--   prompts.media_type:       'image' for every row today, 'video' for a video prompt.
--   prompts.showcase_video:   { preview, v720, v1080, poster, width, height, durationMs }, https addresses, v1080 null
--                             where the source has none. lib/video/renditions.ts reads it.
--   generated_images.video:   the same object, for one render.
--   generated_images.duration_ms: the render's length.
--
-- VERIFIED live 2026-11-03 by Claude, read-only: prompts has neither media_type nor showcase_video (OpenAPI, and
-- `select=media_type` answers 400 42703), generated_images has neither video nor duration_ms, prompts holds 279 rows.
-- Until this runs: All and Images work as before, Videos answers empty and logs this file's name
-- (lib/marketplace/video-columns.ts). No new table, so no grant. Re-runnable.

ALTER TABLE public.prompts
  ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'image' CHECK (media_type IN ('image', 'video')),
  ADD COLUMN IF NOT EXISTS showcase_video jsonb;

ALTER TABLE public.generated_images
  ADD COLUMN IF NOT EXISTS video jsonb,
  ADD COLUMN IF NOT EXISTS duration_ms integer;

-- A world of the wall: one medium, newest first (app/api/marketplace/prompts).
CREATE INDEX IF NOT EXISTS prompts_media_listed_idx ON public.prompts (media_type, created_at DESC) WHERE is_listed;

-- Check:
--   SELECT media_type, count(*) FROM public.prompts GROUP BY media_type;
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'prompts' AND column_name IN ('media_type', 'showcase_video')) OR (table_name = 'generated_images' AND column_name IN ('video', 'duration_ms')));

-- Rollback (a video prompt then reads as an image prompt with its poster):
--   DROP INDEX IF EXISTS public.prompts_media_listed_idx;
--   ALTER TABLE public.generated_images DROP COLUMN IF EXISTS duration_ms, DROP COLUMN IF EXISTS video;
--   ALTER TABLE public.prompts DROP COLUMN IF EXISTS showcase_video, DROP COLUMN IF EXISTS media_type;
