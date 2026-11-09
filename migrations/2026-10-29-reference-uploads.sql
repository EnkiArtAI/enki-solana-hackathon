-- Saved reference images (Kev, 2026-10-29: "the images uploaded via ref image uploading must remain in that image
-- upload UI until i delete them, this must be the database of uploaded referenced images"). One row per picture an
-- account uploaded in the image UI's reference picker; the picker lists them newest first until the tile's x deletes
-- the row. Read and written only by app/api/references and lib/reference-library.ts (service role).
--
-- The picture and its tile are kept in the PRIVATE bucket "reference-uploads" (<user>/<sha256>.<ext> and
-- <user>/<sha256>.tile.webp), never on the public store a render's references use: an upload is image-checked only at
-- the render that sends it (app/api/generate-image), so until then only its owner reaches it, through addresses signed
-- for an hour (DEC-525). A render stores its own copy of the bytes it sent, after the check
-- (lib/generation/reference-images.ts, references/<user>/<sha256>.<ext>), so nothing else names these files: deleting
-- a saved reference removes them and marks the row deleted_at, the picker then hides an earlier render's reference of
-- the same picture (named by the same sha256) too, and saving the picture again brings the row back.
--
-- VERIFIED live 2026-10-29 by Claude, read-only (GET/HEAD): 133 tables, none for saved references (reference_uploads
-- answers 404 PGRST205, and a HEAD count on it answers 204 with no count and no error, postgrest-js 2.103.3);
-- users.id is the uuid primary key; generation_reference_images holds 13 rows, all 13 named
-- references/<user uuid>/<sha256>.<ext>; the storage buckets are "profiles" and "generations" (both public, the second
-- made by the same INSERT as below, migrations/2026-10-06-generations-bucket.sql), so "reference-uploads" is new.
-- Service role only. Re-runnable.
BEGIN;

CREATE TABLE IF NOT EXISTS public.reference_uploads (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- In the bucket reference-uploads: the picture, and its tile (a WebP of at most 256 px), null when none was stored.
  path         text        NOT NULL,
  thumb_path   text,
  -- sha256 of the picture's bytes: the same picture saved again is this row, moved to the top.
  content_hash text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Deleted by its owner (its files are gone); saving the picture again clears it.
  deleted_at   timestamptz,
  CONSTRAINT reference_uploads_one_per_picture UNIQUE (user_id, content_hash)
);

ALTER TABLE public.reference_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reference_uploads FROM PUBLIC, anon, authenticated;

-- At most 50 kept per account (lib/reference-library.ts MAX_REFERENCES), counted one save at a time per account, so
-- two at once cannot both slip under it. Neither a deleted one nor the picture being saved counts: saving it again at
-- the cap is the route's upsert on (user_id, content_hash), which moves it to the top, a yes.
CREATE OR REPLACE FUNCTION public.reference_uploads_cap() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('reference_uploads:' || NEW.user_id::text, 0));
  IF (SELECT count(*) FROM public.reference_uploads
      WHERE user_id = NEW.user_id AND deleted_at IS NULL AND content_hash <> NEW.content_hash) >= 50 THEN
    RAISE EXCEPTION 'You can keep up to 50 references' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.reference_uploads_cap() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reference_uploads_cap() TO service_role;
DROP TRIGGER IF EXISTS reference_uploads_cap ON public.reference_uploads;
CREATE TRIGGER reference_uploads_cap BEFORE INSERT ON public.reference_uploads
  FOR EACH ROW EXECUTE FUNCTION public.reference_uploads_cap();

-- The private bucket: no public address, only the service role writes (it needs no policy), 4 MB a file (a saved
-- picture is at most 3 MB: lib/reference-library.ts readUpload). Made so again if anyone changed it (made it public).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('reference-uploads', 'reference-uploads', false, 4194304, ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

COMMIT;

-- Read back:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.reference_uploads'::regclass AND conname = 'reference_uploads_one_per_picture';
--   SELECT tgname FROM pg_trigger WHERE tgname = 'reference_uploads_cap';
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'reference_uploads';
--   SELECT has_table_privilege('anon', 'public.reference_uploads', 'select');
--   SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'reference-uploads';

-- Rollback (every saved reference is forgotten; the picker shows this visit's uploads and the earlier renders'
-- references, as before). The bucket and its files stay: a bucket that holds files cannot be deleted by SQL, so empty
-- and delete "reference-uploads" on the dashboard's Storage page. Once SQL 53 has run, the bucket also holds Studio's
-- pictures (folder studio): then delete only the other folders (one per account) and keep the bucket.
--   DROP TABLE IF EXISTS public.reference_uploads;
--   DROP FUNCTION IF EXISTS public.reference_uploads_cap();
