-- Drops what nothing writes or reads any more (Kev, 2026-10-29: "yes, drop all six if they are redundant ... i dont
-- want redundant shit in there"). RUN THIS ONLY AFTER feat/trial-codes IS DEPLOYED: production's code before it still
-- reads prompt_purchases, and its Mine and Payment tabs would answer 500 without it. Requires SQL 45 and SQL 49.
--
--   prompt_purchases, insert_prompt_purchase  the ledger of a prompt-unlock sale that no longer exists: 0 rows,
--                nothing writes it, no code calls the function; earnings come from artist_earnings (SQL 45). Four
--                columns point at it and were never set (generations.purchase_id 0 of 65, payment_verifications.purchase_id
--                0 of 32, referral_commissions.source_purchase_id and content_access_logs.purchase_id in empty tables):
--                their foreign keys go, the columns stay.
--   prompt_analytics_events  an event log nobody ever wrote (0 rows); views by day live in view_days (SQL 49).
--   prompts.views  the feed's counter: copied into view_days by SQL 49, which stops counting it; nothing reads it.
--   platform_analytics  one marker row of an old migration, never read or written.
--   prompt_reviews  0 rows, never written; ratings live in prompt_comments.
--   NOT dropped: prompts.opens, search ranks by it (search_prompts, 2026-10-08-search-hide-deleted-creators.sql:31).
-- A guard refuses to run while a function in public still names one of them: a function body is no dependency
-- Postgres tracks, so it would only fail when called. A view still reading one makes its DROP fail and nothing changes.
-- VERIFIED live 2026-10-29 by Claude, read-only: the row counts above, the four foreign keys onto prompt_purchases
-- (OpenAPI), no other foreign key onto the four tables. Re-runnable.
BEGIN;

DO $$
DECLARE still text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO still
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname <> 'insert_prompt_purchase'
    AND (p.prosrc ~* '\m(prompt_purchases|prompt_analytics_events|platform_analytics|prompt_reviews)\M'
      OR p.prosrc ~* '\m(p|prompts)\.views\M|\mset\s+views\M|\mviews\s*=\s*views\M');
  IF still IS NOT NULL THEN
    RAISE EXCEPTION 'Not dropped: these functions still read them: %. Run SQL 45 and 49 first.', still;
  END IF;
END
$$;

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
           WHERE contype = 'f' AND confrelid = to_regclass('public.prompt_purchases') LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END
$$;

DROP FUNCTION IF EXISTS public.insert_prompt_purchase;
DROP TABLE IF EXISTS public.prompt_purchases;
DROP TABLE IF EXISTS public.prompt_analytics_events;
DROP TABLE IF EXISTS public.platform_analytics;
DROP TABLE IF EXISTS public.prompt_reviews;
ALTER TABLE public.prompts DROP COLUMN IF EXISTS views;

COMMIT;

-- Read back:
--   SELECT to_regclass('public.prompt_purchases'), to_regclass('public.prompt_analytics_events'),
--          to_regclass('public.platform_analytics'), to_regclass('public.prompt_reviews');
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'prompts' AND column_name IN ('views', 'opens');

-- Rollback (the tables come back empty, with their columns but without the indexes, checks, policies and foreign keys
-- they had; insert_prompt_purchase does not come back, nothing called it; prompts.views comes back from view_days):
--   ALTER TABLE public.prompts ADD COLUMN IF NOT EXISTS views bigint NOT NULL DEFAULT 0;
--   UPDATE public.prompts p SET views = v.n FROM (SELECT target_id, sum(n) AS n FROM public.view_days WHERE kind = 'prompt_view' GROUP BY target_id) v WHERE v.target_id = p.id;
--   CREATE TABLE IF NOT EXISTS public.prompt_purchases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), prompt_id uuid NOT NULL,
--     buyer_id uuid NOT NULL, seller_id uuid NOT NULL, amount_usd_cents bigint NOT NULL, platform_fee_cents bigint NOT NULL,
--     creator_earnings_cents bigint NOT NULL, transaction_hash text, chain_key text, payment_scheme text NOT NULL DEFAULT 'exact',
--     status text NOT NULL DEFAULT 'pending', prompt_title_snapshot text, prompt_preview_image_url text, request_ip_hash text,
--     request_ua_hash text, purchased_at timestamptz, completed_at timestamptz, refunded_at timestamptz, refund_reason text,
--     created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
--   CREATE TABLE IF NOT EXISTS public.prompt_analytics_events (id uuid NOT NULL DEFAULT gen_random_uuid(), event_type text NOT NULL,
--     user_id uuid, session_id text, prompt_id uuid, creator_id uuid, referrer text, source text NOT NULL DEFAULT 'marketplace',
--     campaign text, device_type text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
--     PRIMARY KEY (id, created_at));
--   CREATE TABLE IF NOT EXISTS public.platform_analytics (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), metric_type text NOT NULL,
--     metric_value numeric NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', recorded_at timestamptz NOT NULL DEFAULT now());
--   CREATE TABLE IF NOT EXISTS public.prompt_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), prompt_id uuid NOT NULL,
--     reviewer_user_id uuid NOT NULL, rating smallint NOT NULL, title text, content text NOT NULL, pros text[] NOT NULL DEFAULT '{}',
--     cons text[] NOT NULL DEFAULT '{}', verified_purchase boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'pending',
--     moderator_id uuid, moderation_notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
--     moderated_at timestamptz, deleted_at timestamptz);
--   ALTER TABLE public.prompt_purchases ENABLE ROW LEVEL SECURITY; ALTER TABLE public.prompt_analytics_events ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.platform_analytics ENABLE ROW LEVEL SECURITY; ALTER TABLE public.prompt_reviews ENABLE ROW LEVEL SECURITY;
