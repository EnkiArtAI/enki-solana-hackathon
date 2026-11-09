-- SQL 60: two small renditions of a prompt's example images (Kev, 2026-11-02: "stärkere kompression ... bei den
-- vorschaubildern unter dem eigentlichen großen bild können wir ruhig noch weniger als 1280 nehmen"):
--   view_url: WebP 1280 px q80, what the image view's stage shows (fullscreen keeps preview_url, 2048 px q90);
--   tiny_url: WebP 192 px q60, what its 64 px tiles show.
-- Made only for images that are a prompt's examples (lib/generation/small-renditions), not for every render. Measured on
-- 24 live images 2026-11-02: stage 216.7 KB -> 95.2 KB, tile 13.7 KB -> 3.9 KB (medians).
-- Before this runs nothing breaks: the reads fall back to preview_url and thumbnail_url and nothing is written.

ALTER TABLE public.generated_images
  ADD COLUMN IF NOT EXISTS view_url text,
  ADD COLUMN IF NOT EXISTS tiny_url text;

-- Check:
--   SELECT count(*) FILTER (WHERE view_url IS NOT NULL) AS with_view, count(*) AS rows FROM public.generated_images;

-- Rollback:
--   ALTER TABLE public.generated_images DROP COLUMN IF EXISTS view_url, DROP COLUMN IF EXISTS tiny_url;
