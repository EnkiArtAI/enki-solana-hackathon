-- SQL 64: the posts the Prompt Hunter keeps out of Pending imports and does not throw away (Kev, 2026-11-03: "video posts
-- bitte in einen reiter im admin bereich da speichern bis wir den implementieren die tage. nicht verwerfen, we will
-- implement them, save them"; "ein prompt ohne media soll separat geloggt sein in nem reiter, damit ich mir das so
-- angucken kann"). lib/hunter/creator-run writes it; the admin's Videos and No media tabs read it. One row a post:
--   kind 'video':    a post with a video, on the post or in the author's reply. With pictures too its find goes on beside it.
--   kind 'no_media': a post with words that may hold a prompt, and no picture and no video anywhere, or none that could be read.
--   replies: [{ id, url, text }], the author's replies. videos: each video as FxTwitter gives it (every address, poster,
--   duration, size), reply_id when it sits in a reply. photos: the picture addresses. reach: lib/hunter/fx-api reachOf.
-- Addresses only: no file is downloaded. A post deleted on X can take its video with it; the download belongs to the video
-- import. handle carries no foreign key, unlike hunter_posts: removing a creator from the list must not delete what was saved.
--
-- VERIFIED live 2026-11-03 by Claude, read-only: hunter_parked answers 404 PGRST205, no table with "park" in its name in
-- the API schema; hunter_posts.outcome has no CHECK ("no_media" -> 23503, FK-failing insert, rows landed: 0), so it is not
-- widened here.
-- Until this runs: a Play, Play links or Add link stops at the first post that has a video or no media, says to run this,
-- and skips nothing, so nothing is lost and the next Play reads that post again; the tabs say to run it; the rest of the
-- admin page and every post with pictures only work as before. Service role only. Re-runnable.

CREATE TABLE IF NOT EXISTS public.hunter_parked (
  post_id   text        PRIMARY KEY,
  kind      text        NOT NULL CHECK (kind IN ('video', 'no_media')),
  handle    text        NOT NULL,
  author_id text,
  url       text        NOT NULL,
  post_text text        NOT NULL DEFAULT '',
  replies   jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(replies) = 'array'),
  videos    jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(videos) = 'array'),
  photos    jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(photos) = 'array'),
  reach     jsonb,
  why       text,
  read_at   timestamptz NOT NULL DEFAULT now()
);

-- A tab: one kind, newest first, the id breaking ties so pages neither overlap nor skip.
CREATE INDEX IF NOT EXISTS hunter_parked_kind_read_idx ON public.hunter_parked (kind, read_at DESC, post_id);

ALTER TABLE public.hunter_parked ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hunter_parked FROM PUBLIC, anon, authenticated;
-- Said out loud: Supabase announced an end to default grants on new tables for existing projects (changelog 45329).
GRANT SELECT, INSERT, UPDATE ON public.hunter_parked TO service_role;

-- Check:
--   SELECT kind, count(*) FROM public.hunter_parked GROUP BY kind;

-- Rollback (the saved posts go with it; the posts' hunter_posts rows stay, so a Play does not read them again):
--   DROP TABLE IF EXISTS public.hunter_parked;
