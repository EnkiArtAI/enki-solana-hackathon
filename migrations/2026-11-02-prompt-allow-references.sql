-- Kev, 2026-11-01: "bei jedem bild von image ui reference images möglich sein ... die sind bei jedem free image ein muss,
-- wobei bei premium images das eingestellt werden kann". A premium prompt's creator may switch buyers' reference images
-- off. On by default, so every prompt there is keeps today's behaviour; a free prompt ignores it and always takes them.
-- A text that names "Reference image k" is always saved as on (app/api/prompt).
BEGIN;

ALTER TABLE public.prompts ADD COLUMN IF NOT EXISTS allow_references boolean NOT NULL DEFAULT true;

COMMIT;

-- Read back: SELECT count(*), count(*) FILTER (WHERE allow_references) FROM public.prompts; -- both the same right after it ran
-- Rollback: ALTER TABLE public.prompts DROP COLUMN IF EXISTS allow_references;
