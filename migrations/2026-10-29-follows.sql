-- Follows (Kev, 2026-10-29: "go A": a Follow button on someone else's profile, and once followed a bell left of it
-- for notifications of their new posts). Read and written only by app/api/follows/route.ts (service role).
--
-- The table already exists live, made outside the repo. VERIFIED 2026-10-29 by Claude, read-only: follows(follower_id
-- uuid, followee_id uuid, created_at timestamptz default now(), notify_on_new_prompt boolean default true,
-- notify_on_new_post boolean default false), primary key (follower_id, followee_id), both ids FK to users(id), 0 rows;
-- an insert with the anon key is refused (401, 42501). The CREATE below is for a fresh database and changes nothing
-- live. What this adds: nobody follows themselves, the index the fan-out reads (whose followers, by followee_id; the
-- primary key leads with follower_id), and RLS with the grants revoked so only the server reaches the table.
-- Re-runnable.
BEGIN;

CREATE TABLE IF NOT EXISTS public.follows (
  follower_id          uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  followee_id          uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  notify_on_new_prompt boolean     NOT NULL DEFAULT true,
  notify_on_new_post   boolean     NOT NULL DEFAULT false,
  PRIMARY KEY (follower_id, followee_id)
);

ALTER TABLE public.follows DROP CONSTRAINT IF EXISTS follows_not_self;
ALTER TABLE public.follows ADD CONSTRAINT follows_not_self CHECK (follower_id <> followee_id);

CREATE INDEX IF NOT EXISTS follows_followee_idx ON public.follows (followee_id);

ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.follows FROM PUBLIC, anon, authenticated;

COMMIT;

-- Read back:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.follows'::regclass AND conname = 'follows_not_self';
--   SELECT to_regclass('public.follows_followee_idx');
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'follows';

-- Rollback (keeps the table and every follow, as it was before this file):
--   ALTER TABLE public.follows DROP CONSTRAINT IF EXISTS follows_not_self;
--   DROP INDEX IF EXISTS public.follows_followee_idx;
