-- SQL 67: the video generators in the models table (Kev, 2026-11-03: "generatoren seedance 2.0, seedance 2.5, kling 3.0,
-- kling 4.0 und was wir noch so eingestellt haben"), named exactly as Create > Video's rows (lib/video/models.ts label),
-- with their shapes and how many reference pictures each takes from those rows. This fills Explore's Video branch of the
-- generator filter (useModelCatalogue) and the filter's aliases; a video prompt's ai_model holds one of these names.
--
-- RUN ONLY AFTER the deploy of DEC-2026-11-03-63: before it an image route resolves these rows as it does any other.
-- price 0 says nothing: a video's price comes from its own route row later. It is here because a NULL price reads as 0 in
-- useModelLimits anyway, and models are read `order by price`; `free` stays false, that flag comes from the route.
--
-- VERIFIED live 2026-11-03 by Claude, read-only: models has id, name, price, allowed_ratios, active, created_at,
-- max_reference_images, allowed_filetypes, media_type; six rows, all media_type image, none of these names.
-- No new table, so no grant. Only names that are absent are added: a row Kev edited stays as he left it. Re-runnable.

INSERT INTO public.models (id, name, price, allowed_ratios, active, max_reference_images, allowed_filetypes, media_type)
SELECT gen_random_uuid(), v.name, 0, v.ratios, true, v.refs, ARRAY['image/png', 'image/jpeg', 'image/webp'], 'video'
FROM (VALUES
  ('Seedance 2.5',          ARRAY['16:9', '9:16', '1:1', '21:9', '4:3', '3:4', 'auto'], 30),
  ('Seedance 2.0',          ARRAY['16:9', '9:16', '1:1', '21:9', '4:3', '3:4', 'auto'], 9),
  ('Kling 4.0',             ARRAY['16:9', '9:16', '1:1', '21:9'], 0),
  ('Kling 3.0',             ARRAY['16:9', '9:16', '1:1'], 0),
  ('Gemini Omni 1.1 Flash', ARRAY['16:9', '9:16'], 0),
  ('Wan 3.0',               ARRAY['16:9', '9:16', '1:1', '21:9', '4:3', '3:4', 'auto'], 10)
) AS v(name, ratios, refs)
WHERE NOT EXISTS (SELECT 1 FROM public.models m WHERE m.name = v.name);

-- Check (six rows):
--   SELECT name, media_type, active, price, allowed_ratios, max_reference_images FROM public.models WHERE media_type = 'video' ORDER BY name;

-- Rollback (the Video branch goes; a prompt that names one of them keeps its text in ai_model):
--   DELETE FROM public.models WHERE media_type = 'video' AND name IN ('Seedance 2.5', 'Seedance 2.0', 'Kling 4.0', 'Kling 3.0', 'Gemini Omni 1.1 Flash', 'Wan 3.0');
