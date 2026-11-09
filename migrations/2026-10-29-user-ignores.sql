-- Ignoring people (Kev, 2026-10-29: "i also want an 'ignore' function so that i dont see the prompts and images of the
-- person anymore, but can still stumble over his creations later through comments or so or show in the filters that
-- also ignored ppl shall be visible just in case i want to catch up on their shit too. no ban function. that must also
-- be place into the profile settings where i see the list of people i ignored"). Read and written only by
-- app/api/ignores/route.ts and lib/ignores.ts (service role): the feed, search and a prompt's images leave out the people
-- a viewer ignores, unless the feed's Show ignored pill asks for them. Nobody is told; following and messages stay.
--
-- VERIFIED live 2026-10-29 by Claude, read-only (GET): no block, mute or ignore table exists (131 tables; user_ignores
-- answers 404 PGRST205); users.id is the uuid primary key; prompts.creator_id and generated_images.user_id are uuid
-- NOT NULL with 0 nulls, so the routes' "not in" filter never drops a row without an owner. Re-checked 2026-10-29
-- before the cap trigger was added: user_ignores still answers 404 PGRST205 (SQL 48 not run), no rpc named *ignor*.
-- Service role only. Re-runnable.
BEGIN;

CREATE TABLE IF NOT EXISTS public.user_ignores (
  user_id    uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  ignored_id uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ignored_id)
);

ALTER TABLE public.user_ignores DROP CONSTRAINT IF EXISTS user_ignores_not_self;
ALTER TABLE public.user_ignores ADD CONSTRAINT user_ignores_not_self CHECK (user_id <> ignored_id);

ALTER TABLE public.user_ignores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_ignores FROM PUBLIC, anon, authenticated;

-- At most 150 per account (lib/ignores.ts MAX_IGNORED: each browse read carries the whole list in its URL), counted
-- one ignore at a time per account, so two at once cannot both slip under it (review 2026-10-29: a count in the route
-- let 149 become 151, and the reads that stop at 150 then lost one). Someone already ignored is not counted, so
-- ignoring them again at the cap still meets the primary key: a yes.
CREATE OR REPLACE FUNCTION public.user_ignores_cap() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('user_ignores:' || NEW.user_id::text, 0));
  IF (SELECT count(*) FROM public.user_ignores WHERE user_id = NEW.user_id AND ignored_id <> NEW.ignored_id) >= 150 THEN
    RAISE EXCEPTION 'You can ignore up to 150 people' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.user_ignores_cap() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_ignores_cap() TO service_role;
DROP TRIGGER IF EXISTS user_ignores_cap ON public.user_ignores;
CREATE TRIGGER user_ignores_cap BEFORE INSERT ON public.user_ignores
  FOR EACH ROW EXECUTE FUNCTION public.user_ignores_cap();

COMMIT;

-- Read back:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.user_ignores'::regclass AND conname = 'user_ignores_not_self';
--   SELECT tgname FROM pg_trigger WHERE tgname = 'user_ignores_cap';
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'user_ignores';
--   SELECT has_table_privilege('anon', 'public.user_ignores', 'select');

-- Rollback (every ignore is forgotten; the feed, search and a prompt's images show everyone again):
--   DROP TABLE IF EXISTS public.user_ignores;
--   DROP FUNCTION IF EXISTS public.user_ignores_cap();
