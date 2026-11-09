-- The Prompt Hunter (Kev, 2026-10-14): an admin drops X accounts into the
-- panel and starts a run; the run reads each account's posts through X's
-- paid API, newest first and ever older across runs, finds the prompts in
-- them the way "Refer a prompt" does, judges them, and puts them into the
-- admin queue ("Pending imports"), or publishes them at once once Kev flips
-- the mode. No schedule: a run is pressed, and goes on round by round until
-- every account is read or it is stopped. Main posts only, no replies; an
-- account is left once dry_after posts in a row carry no prompt (it stopped
-- making them). Every post read is recorded with its outcome, so the panel
-- can say what was read and continue with the rest (accounts have thousands
-- of posts; X's timeline without replies reaches the newest 800).
--
-- One config row; one row per account with how far it was read; one row per
-- post read; a log row per run; and on hunt_submissions the sealed preview an
-- approval publishes from, plus the prompt's hash for duplicates. Probed live
-- 2026-10-14: none of these exist. Additive and idempotent. Service role only.
BEGIN;

CREATE TABLE IF NOT EXISTS public.hunter_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode text NOT NULL DEFAULT 'queue' CHECK (mode IN ('queue', 'publish')),
  -- Posts read per round of a run; X bills about $0.005 each (pay-per-use).
  posts_per_run integer NOT NULL DEFAULT 500 CHECK (posts_per_run BETWEEN 0 AND 10000),
  min_likes integer NOT NULL DEFAULT 20 CHECK (min_likes >= 0),
  -- Prompts taken from one author per day; 0 = no cap (a run reads whole accounts).
  per_author_daily integer NOT NULL DEFAULT 0 CHECK (per_author_daily BETWEEN 0 AND 1000),
  -- Posts in a row without a prompt after which an account is left; 0 = never.
  dry_after integer NOT NULL DEFAULT 30 CHECK (dry_after BETWEEN 0 AND 1000),
  -- The account the hunted prompts are published under ("Enki Hunter"); without a Solana wallet, so no referrer leg.
  publisher_user_id uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
INSERT INTO public.hunter_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One row per X account on the list, and how far it was read.
CREATE TABLE IF NOT EXISTS public.hunter_accounts (
  -- Lower case, without the @.
  handle text PRIMARY KEY,
  -- Cached after one user lookup ($0.01).
  x_user_id text,
  -- The newest and the oldest post id read so far: a run reads older than oldest_id until X has
  -- nothing older (exhausted), then newer than newest_id.
  newest_id text,
  oldest_id text,
  exhausted boolean NOT NULL DEFAULT false,
  -- Left because dry_after posts in a row carried no prompt (exhausted too); the streak carries over rounds.
  dry boolean NOT NULL DEFAULT false,
  dry_streak integer NOT NULL DEFAULT 0,
  posts_read integer NOT NULL DEFAULT 0,
  found integer NOT NULL DEFAULT 0,
  error text,
  last_run_at timestamptz,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid
);

-- Every post read, once, with what became of it. Removing an account forgets its posts.
CREATE TABLE IF NOT EXISTS public.hunter_posts (
  post_id text PRIMARY KEY,
  handle text NOT NULL REFERENCES public.hunter_accounts(handle) ON DELETE CASCADE,
  author_id text,
  likes integer NOT NULL DEFAULT 0,
  -- reply, no_prompt, below_likes, duplicate, author_cap, refused, unchecked, not_saved, queued, published, publish_failed.
  outcome text NOT NULL,
  submission_id uuid,
  read_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hunter_posts_handle_idx ON public.hunter_posts (handle, read_at DESC);

CREATE TABLE IF NOT EXISTS public.hunter_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  posts_read integer NOT NULL DEFAULT 0,
  found integer NOT NULL DEFAULT 0,
  queued integer NOT NULL DEFAULT 0,
  published integer NOT NULL DEFAULT 0,
  -- reason -> count: below_likes, no_prompt, duplicate, author_cap, refused, unchecked, publish_failed, budget, time_cap.
  skipped jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);

ALTER TABLE public.hunt_submissions
  ADD COLUMN IF NOT EXISTS preview_token text,
  ADD COLUMN IF NOT EXISTS preview jsonb,
  ADD COLUMN IF NOT EXISTS prompt_hash text;
CREATE INDEX IF NOT EXISTS hunt_submissions_prompt_hash_idx ON public.hunt_submissions (prompt_hash) WHERE prompt_hash IS NOT NULL;

ALTER TABLE public.hunter_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hunter_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hunter_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hunter_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hunter_config, public.hunter_accounts, public.hunter_posts, public.hunter_runs FROM PUBLIC, anon, authenticated;

COMMIT;

-- Read back: SELECT mode, posts_per_run FROM public.hunter_config; SELECT handle, posts_read, exhausted FROM public.hunter_accounts;
-- Rollback: DROP TABLE IF EXISTS public.hunter_posts; DROP TABLE IF EXISTS public.hunter_accounts;
--   DROP TABLE IF EXISTS public.hunter_runs; DROP TABLE IF EXISTS public.hunter_config;
--   ALTER TABLE public.hunt_submissions DROP COLUMN IF EXISTS preview_token, DROP COLUMN IF EXISTS preview, DROP COLUMN IF EXISTS prompt_hash;
