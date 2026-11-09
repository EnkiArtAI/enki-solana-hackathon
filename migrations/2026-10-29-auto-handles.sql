-- Every account has a name (Kev, 2026-10-29: "a creator without a handle -> this should not be the case as every newly
-- logged in creator should have some random name on the platform and then also appear on the leaderboard if their
-- prompts are being printed").
--
--   users.handle_auto   Enki picked this name, its owner has not chosen one. The first-login picker
--                       (components/enki-shell/UsernameOnboard.tsx) still opens for such an account, and PUT
--                       /api/users/handle may replace the name once (app/api/users/handle/route.ts).
--   random_handle()     <tone>_<artist>_<4 digits> from the picker's own TONES and ARTISTS, e.g. velvet_muse_0427: at
--                       most 19 characters, always lib/handle-rules.ts HANDLE_VALID, never a reserved name. Drawn again
--                       until no account has it, in any case (citext).
--   trigger             a new account without a name gets one, marked handle_auto, whoever inserts it (wallet, email,
--                       Google, X, agent). A later change of the name that does not change handle_auto itself is the
--                       owner's choice (the picker, a rename on the profile) and clears it; the same name written again
--                       is no change.
--   backfill            the accounts without a name and not deleted get one; each draw sees the names drawn before it.
--
-- VERIFIED live 2026-10-29 by Claude, read-only: users(id uuid, handle public.citext, deleted_at timestamptz, created_at
-- timestamptz) exist and handle_auto does not (42703); 39 accounts, 30 without a handle, none of them deleted (16 origin
-- null, 13 wallet, 1 agent); every one of the 9 handles fits ^[a-z0-9_]{3,20}$ and none looks like tone_artist_0000; no
-- function random_handle; user_handle_history has 0 rows. Whether handle has a unique index was not determined (the
-- draw does not rely on one).
-- random_handle() is the service role's only. Re-runnable: a second run draws nothing.
BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS handle_auto boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.users.handle_auto IS 'Enki picked this name, its owner has not chosen one';

CREATE OR REPLACE FUNCTION public.random_handle() RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  -- The picker's TONES and ARTISTS (components/enki-shell/UsernameOnboard.tsx); a test keeps the two the same.
  tones   text[] := ARRAY['ember', 'quiet', 'neon', 'lunar', 'velvet', 'wild', 'paper', 'golden', 'misty', 'cobalt'];
  artists text[] := ARRAY['muse', 'brush', 'palette', 'sketch', 'canvas', 'maker', 'weaver', 'pixel', 'atelier', 'raven'];
  pick    citext;
BEGIN
  LOOP
    pick := tones[1 + floor(random() * cardinality(tones))::int] || '_'
         || artists[1 + floor(random() * cardinality(artists))::int] || '_'
         || lpad(floor(random() * 10000)::int::text, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE handle = pick);
  END LOOP;
  RETURN pick;
END
$$;
REVOKE ALL ON FUNCTION public.random_handle() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.random_handle() TO service_role;

CREATE OR REPLACE FUNCTION public.users_handle_auto() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.handle IS NULL THEN
      NEW.handle := random_handle();
      NEW.handle_auto := true;
    END IF;
  ELSIF NEW.handle IS DISTINCT FROM OLD.handle AND NEW.handle_auto IS NOT DISTINCT FROM OLD.handle_auto THEN
    NEW.handle_auto := false;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS users_handle_auto ON public.users;
CREATE TRIGGER users_handle_auto BEFORE INSERT OR UPDATE OF handle ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_handle_auto();

-- One statement is enough: random_handle() is VOLATILE, and a VOLATILE function sees the changes the statement calling
-- it has made so far (PostgreSQL docs, "Function Volatility Categories"), so each draw sees the names drawn before it.
-- A test keeps it VOLATILE.
UPDATE public.users SET handle = public.random_handle(), handle_auto = true WHERE handle IS NULL AND deleted_at IS NULL;

COMMIT;

-- Read back:
--   SELECT count(*) FILTER (WHERE handle IS NULL) AS without, count(*) FILTER (WHERE handle_auto) AS auto
--     FROM public.users WHERE deleted_at IS NULL;   -- without = 0, auto = the 30 that had none
--   SELECT tgname FROM pg_trigger WHERE tgname = 'users_handle_auto';
--   SELECT has_function_privilege('anon', 'public.random_handle()', 'execute');   -- false

-- Rollback (as before this file: the names Enki picked go again and their owners see the picker as before; a name
-- its owner chose stays):
--   DROP TRIGGER IF EXISTS users_handle_auto ON public.users;
--   DROP FUNCTION IF EXISTS public.users_handle_auto();
--   DROP FUNCTION IF EXISTS public.random_handle();
--   UPDATE public.users SET handle = NULL WHERE handle_auto;
--   ALTER TABLE public.users DROP COLUMN IF EXISTS handle_auto;
