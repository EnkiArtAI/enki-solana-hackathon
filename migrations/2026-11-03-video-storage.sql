-- SQL 66: where videos are kept (DEC-2026-11-03-68). `generations` takes png, jpeg and webp only, and the store's other
-- public bucket is the profiles', so neither fits:
--   videos:          public. preview.mp4, v720.mp4, v1080.mp4 and poster.webp of each video. 50 MB a file: a 30 s v1080 is
--                    about 16 MB (0.54 MB a second, measured 2026-11-03). The transcode writes here, the slice that builds it.
--   video-originals: private. What the provider delivered, up to 500 MB, for a later re-encode; no public address.
-- Only the service role writes (it needs no policy). Made so again if anyone changed them, as SQL 51 does.
--
-- VERIFIED live 2026-11-03 by Claude, read-only: the buckets are profiles, generations, reference-uploads and
-- moderation-evidence, so both names are new. NOT DETERMINED: the project's global file size limit, which the service key
-- cannot read and which caps these below 500 MB if it is lower (Supabase dashboard, Storage settings).
-- Nothing reads these yet. Re-runnable, any time.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('videos', 'videos', true, 52428800, ARRAY['video/mp4', 'image/webp']),
  ('video-originals', 'video-originals', false, 524288000, ARRAY['video/mp4', 'video/quicktime'])
ON CONFLICT (id) DO UPDATE
  SET public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Check:
--   SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id IN ('videos', 'video-originals');

-- Rollback (a bucket that holds files cannot be deleted by SQL: empty it on the dashboard's Storage page first):
--   DELETE FROM storage.buckets WHERE id IN ('videos', 'video-originals');
