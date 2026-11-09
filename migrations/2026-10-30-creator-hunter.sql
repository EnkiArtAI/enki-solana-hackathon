-- The Creator Hunter (Kev, 2026-10-30: "da will ich iwann einen creator reinpacken, such kriterien einstellen, und
-- go"; "ja go ... und ja 1 und 2"): the Prompt Hunter's list becomes a list of creators, each with its own search,
-- its own preferred generator, its own Play and caps, and an Enki account for each X author, so the prompts are theirs
-- ("account fürn creator angelegt werden, damit generierungen auf seinen namen ihm später guthaben generieren können").
-- What their renders earn follows the X id to the author vault, claimed by connecting that X account
-- (lib/referral/shares.ts, docs/ESCROW-V2-SHARES.md); nothing here changes shares, claims or escrow.
--
-- Probed live 2026-10-30 (read-only, PostgREST): hunter_config has the FIRST draft's columns (daily_posts, accounts,
-- account_ids, last_post_ids) and lacks posts_per_run and dry_after, because 2026-10-14-prompt-hunter.sql changed them
-- behind CREATE TABLE IF NOT EXISTS after the table existed; hunter_accounts, hunter_runs, hunter_posts 0 rows;
-- users.origin takes email, wallet, agent, google, x (SQL 32); no users.imported_x_id; no x_creators table.
-- Additive and idempotent, one transaction. Service role only, as the hunter's tables are.
BEGIN;

-- 1. Repair: the live hunter_config kept the first draft's shape. The legacy run reads both columns.
ALTER TABLE public.hunter_config
  ADD COLUMN IF NOT EXISTS posts_per_run integer NOT NULL DEFAULT 500 CHECK (posts_per_run BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS dry_after integer NOT NULL DEFAULT 30 CHECK (dry_after BETWEEN 0 AND 1000);

-- 2. An imported creator's Enki account: one per X author, keyed by X's numeric id (handles change hands); nobody can
--    sign in to it (no email, password, wallet or auth_identities row). IS NOT DISTINCT FROM: a NULL origin would
--    otherwise pass the CHECK (NULL = 'imported' is unknown, and a CHECK lets unknown through).
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS imported_x_id text;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_origin_check;
ALTER TABLE public.users ADD CONSTRAINT users_origin_check
  CHECK (origin IN ('email', 'wallet', 'agent', 'google', 'x', 'imported'));
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_imported_x_id_check;
ALTER TABLE public.users ADD CONSTRAINT users_imported_x_id_check
  CHECK (imported_x_id IS NULL OR (imported_x_id ~ '^[0-9]{1,20}$' AND origin IS NOT DISTINCT FROM 'imported'));
CREATE UNIQUE INDEX IF NOT EXISTS users_imported_x_id_key ON public.users (imported_x_id) WHERE imported_x_id IS NOT NULL;

-- 3. Each creator's own search, generator, caps and spend (lib/hunter/creator-types.ts CreatorConfig, CREATOR_LIMITS).
ALTER TABLE public.hunter_accounts
  ADD COLUMN IF NOT EXISTS words text[] NOT NULL DEFAULT ARRAY['prompt', 'prompts']::text[] CHECK (cardinality(words) <= 10),
  ADD COLUMN IF NOT EXISTS media text NOT NULL DEFAULT 'images' CHECK (media IN ('images', 'media', 'any')),
  ADD COLUMN IF NOT EXISTS min_likes integer NOT NULL DEFAULT 0 CHECK (min_likes BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS since_days integer NOT NULL DEFAULT 365 CHECK (since_days BETWEEN 0 AND 7300),
  ADD COLUMN IF NOT EXISTS preferred_generator text CHECK (preferred_generator IS NULL OR length(preferred_generator) BETWEEN 1 AND 80),
  -- At least a search page and one replies read (lib/hunter/creator-types PLAY_MIN_POSTS).
  ADD COLUMN IF NOT EXISTS posts_per_play integer NOT NULL DEFAULT 100 CHECK (posts_per_play BETWEEN 20 AND 1000),
  ADD COLUMN IF NOT EXISTS spend_cap_usd numeric(8,2) NOT NULL DEFAULT 5 CHECK (spend_cap_usd BETWEEN 0 AND 1000),
  ADD COLUMN IF NOT EXISTS spent_usd numeric(10,4) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  ADD COLUMN IF NOT EXISTS dry_after integer NOT NULL DEFAULT 30 CHECK (dry_after BETWEEN 0 AND 1000),
  -- A Play holds the creator while it runs; one older than five minutes is a crashed round's and is taken over.
  ADD COLUMN IF NOT EXISTS playing_since timestamptz,
  -- What is new since newest_id is read from the top down; a Play cut short there keeps the newest id it read
  -- (gap_top) and the lowest it took (gap_low), and the next one reads on below gap_low, so a creator who posted more
  -- than a Play reads is caught up over several Plays. newest_id moves to gap_top once the gap is closed.
  ADD COLUMN IF NOT EXISTS gap_top text,
  ADD COLUMN IF NOT EXISTS gap_low text;

-- 4. A Play per creator: which one, what it counted (HuntUsage and why it stopped), what that cost (estimated).
ALTER TABLE public.hunter_runs
  ADD COLUMN IF NOT EXISTS handle text,
  ADD COLUMN IF NOT EXISTS usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS est_usd numeric(10,4) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS hunter_runs_handle_idx ON public.hunter_runs (handle, started_at DESC) WHERE handle IS NOT NULL;

COMMIT;

-- Read back: SELECT posts_per_run, dry_after FROM public.hunter_config;
--   SELECT handle, words, media, posts_per_play, spend_cap_usd FROM public.hunter_accounts;
--   SELECT count(*) FROM public.users WHERE origin = 'imported';
-- Rollback (only while no 'imported' user exists; hunter_config's two columns stay, the legacy run needs them):
--   DROP INDEX IF EXISTS public.hunter_runs_handle_idx;
--   ALTER TABLE public.hunter_runs DROP COLUMN IF EXISTS handle, DROP COLUMN IF EXISTS usage, DROP COLUMN IF EXISTS est_usd;
--   ALTER TABLE public.hunter_accounts DROP COLUMN IF EXISTS words, DROP COLUMN IF EXISTS media, DROP COLUMN IF EXISTS min_likes, DROP COLUMN IF EXISTS since_days, DROP COLUMN IF EXISTS preferred_generator, DROP COLUMN IF EXISTS posts_per_play, DROP COLUMN IF EXISTS spend_cap_usd, DROP COLUMN IF EXISTS spent_usd, DROP COLUMN IF EXISTS dry_after, DROP COLUMN IF EXISTS playing_since, DROP COLUMN IF EXISTS gap_top, DROP COLUMN IF EXISTS gap_low;
--   DROP INDEX IF EXISTS public.users_imported_x_id_key;
--   ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_imported_x_id_check;
--   ALTER TABLE public.users DROP COLUMN IF EXISTS imported_x_id;
--   ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_origin_check;
--   ALTER TABLE public.users ADD CONSTRAINT users_origin_check CHECK (origin IN ('email', 'wallet', 'agent', 'google', 'x'));
