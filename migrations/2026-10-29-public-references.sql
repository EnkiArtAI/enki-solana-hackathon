-- References shown with a public image (Kev, 2026-10-29: "after checking an image to be public, i should as well check
-- if the reference images used to render shall also made public with a small hint, that this helps people your
-- process more"; "go D"). Read by lib/public-references.ts, written by PATCH /api/images/[id] { references }.
--
--   generated_images.references_public  the owner's choice to show the reference images the render was sent, beside
--                  the image once it is public. Off for every image: a reference can be a private photo, and until
--                  its owner says so it stays theirs (DEC-2026-10-17-51).
-- VERIFIED live 2026-10-29 by Claude, read-only: generated_images has no such column (public 2, private 54).
-- Re-runnable.
BEGIN;

ALTER TABLE public.generated_images ADD COLUMN IF NOT EXISTS references_public boolean NOT NULL DEFAULT false;

COMMIT;

-- Read back:
--   SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
--   WHERE table_name = 'generated_images' AND column_name = 'references_public';

-- Rollback (every image's references are its owner's again):
--   ALTER TABLE public.generated_images DROP COLUMN IF EXISTS references_public;
