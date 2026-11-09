-- Views by day, for prompts and images (Kev, 2026-10-29: "views by day, i feel like this is needed as views for posts
-- are also being recorded. find a slim and efficient way to do that, would be great to know what prompts and images
-- have been watched so that we know who gets most attention"). Until now a prompt had two counters without time
-- (prompts.views = the card was seen in the feed, prompts.opens = somebody opened it) and an image had none
-- (VERIFIED live 2026-10-29: no view column or table for generated_images).
--
--   view_days    one row per kind, day (UTC) and prompt or image, with how often: 'prompt_view' (a card seen in the
--                feed), 'prompt_open' (a prompt opened), 'image_open' (an image opened large: on the stage, in the
--                viewer, in the gallery). A period is one range of days; a day's opens are one row. Both prompt
--                counters are copied in once, without a day: they sit on 1970-01-01, "before 2026-10-29", so all
--                time includes them and no period does.
--   increment_prompt_views_batch  the feed's function of 2026-07-12, same arguments: now writes the day's row ONLY.
--                prompts.views stops counting here and goes with 2026-10-29-dead-tables.sql (SQL 50).
--   increment_prompt_opens  writes the day's row and still the prompts.opens counter: search ranks by that counter
--                (search_prompts, 2026-10-08-search-hide-deleted-creators.sql:31), so it is the one count kept twice.
--   count_image_opens(p_images, p_viewer)  counts an open of a public image that is not an upload, not deleted and
--                not the viewer's own.
--   enki_stats   moves here from 2026-10-29-enki-stats.sql (its 3-argument version is dropped first) and gains p_chain:
--                revenue in the money of the chain the deployment pays on (artist_earnings, SQL 45).
--                'views' = prompts and images opened, by the owner, per period and today (UTC), ranked like the other
--                columns; 'watched' = the ten prompts and ten images opened most in the period, listed prompts and
--                public images only, never 18+, never of a hidden or opted-out account.
-- The three functions were callable by anyone (2026-07-12 set no grants; PUBLIC has EXECUTE by default): now the
-- service role only, like every function since. VERIFIED live 2026-10-29 by Claude, read-only: prompts.views sum 484,
-- prompts.opens sum 174 (105 on prompts not deleted); the columns read here exist. Requires 2026-10-29-artist-earnings.sql
-- (artist_earnings). Re-runnable.
BEGIN;

CREATE TABLE IF NOT EXISTS public.view_days (
  kind      text   NOT NULL CHECK (kind IN ('prompt_view', 'prompt_open', 'image_open')),
  day       date   NOT NULL,
  target_id uuid   NOT NULL,
  n         bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, day, target_id)
);
CREATE INDEX IF NOT EXISTS view_days_target_idx ON public.view_days (target_id, kind);
ALTER TABLE public.view_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.view_days FROM PUBLIC, anon, authenticated;

-- Both counters as they stand, under "before 2026-10-29": once, while the table is still empty.
INSERT INTO public.view_days (kind, day, target_id, n)
SELECT c.kind, DATE '1970-01-01', c.id, c.n
FROM (SELECT 'prompt_view' AS kind, id, views AS n FROM public.prompts
      UNION ALL SELECT 'prompt_open', id, opens FROM public.prompts) c
WHERE c.n > 0 AND NOT EXISTS (SELECT 1 FROM public.view_days)
ON CONFLICT (kind, day, target_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.increment_prompt_views_batch(p_prompts text[]) RETURNS void
LANGUAGE sql SET search_path = public
AS $$
  INSERT INTO view_days (kind, day, target_id, n)
  SELECT 'prompt_view', (now() AT TIME ZONE 'utc')::date, p.id, 1 FROM prompts p WHERE p.id::text = ANY(p_prompts)
  ON CONFLICT (kind, day, target_id) DO UPDATE SET n = view_days.n + 1;
$$;
REVOKE ALL ON FUNCTION public.increment_prompt_views_batch(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_prompt_views_batch(text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.increment_prompt_opens(p_prompt text) RETURNS void
LANGUAGE sql SET search_path = public
AS $$
  WITH hit AS (UPDATE prompts SET opens = opens + 1 WHERE id::text = p_prompt RETURNING id)
  INSERT INTO view_days (kind, day, target_id, n)
  SELECT 'prompt_open', (now() AT TIME ZONE 'utc')::date, id, 1 FROM hit
  ON CONFLICT (kind, day, target_id) DO UPDATE SET n = view_days.n + 1;
$$;
REVOKE ALL ON FUNCTION public.increment_prompt_opens(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_prompt_opens(text) TO service_role;

CREATE OR REPLACE FUNCTION public.count_image_opens(p_images uuid[], p_viewer uuid DEFAULT NULL) RETURNS integer
LANGUAGE sql SET search_path = public
AS $$
  WITH hit AS (
    INSERT INTO view_days (kind, day, target_id, n)
    SELECT 'image_open', (now() AT TIME ZONE 'utc')::date, g.id, 1
    FROM generated_images g
    WHERE g.id = ANY(p_images) AND g.visibility = 'public' AND NOT coalesce(g.is_uploaded, false) AND g.deleted_at IS NULL
      AND (p_viewer IS NULL OR g.user_id <> p_viewer)
    ON CONFLICT (kind, day, target_id) DO UPDATE SET n = view_days.n + 1
    RETURNING 1
  )
  SELECT count(*)::int FROM hit;
$$;
REVOKE ALL ON FUNCTION public.count_image_opens(uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_image_opens(uuid[], uuid) TO service_role;

DROP FUNCTION IF EXISTS public.enki_stats(timestamptz, text, integer);
CREATE OR REPLACE FUNCTION public.enki_stats(p_since timestamptz, p_sort text DEFAULT 'revenue', p_limit integer DEFAULT 25, p_chain text DEFAULT 'solana')
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH seen AS (
    SELECT u.id, u.handle::text AS handle, coalesce(u.hide_from_leaderboard, false) AS off_board, u.created_at
    FROM users u
    WHERE u.deleted_at IS NULL AND coalesce(u.account_status, 'active') = 'active'
      AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.user_id = u.id AND b.lifted_at IS NULL
                        AND (b.expires_at IS NULL OR b.expires_at > now()))
  ),
  -- Opens by day, with the owner: a prompt's creator, an image's maker. A day counts from its UTC midnight.
  opened AS (
    -- A view day is UTC's: its midnight there, whatever the session's time zone (Kev, 2026-11-01: today's views read 0 after 23:00 UTC).
    SELECT v.kind, v.target_id, v.n, v.day::timestamp AT TIME ZONE 'utc' AS at, coalesce(p.creator_id, g.user_id) AS uid
    FROM view_days v
    LEFT JOIN prompts p ON v.kind = 'prompt_open' AND p.id = v.target_id AND p.deleted_at IS NULL
    LEFT JOIN generated_images g ON v.kind = 'image_open' AND g.id = v.target_id AND g.deleted_at IS NULL
  ),
  ev AS (
    SELECT 'users' AS m, s.id AS uid, s.created_at AS at, 1::numeric AS n FROM seen s
    UNION ALL
    SELECT 'prompts', p.creator_id, p.published_at, 1 FROM prompts p
    WHERE p.is_listed AND p.listing_status = 'active' AND p.deleted_at IS NULL
    UNION ALL
    SELECT 'posts', g.user_id, g.published_at, 1 FROM generated_images g
    WHERE g.visibility = 'public' AND NOT coalesce(g.is_uploaded, false) AND g.deleted_at IS NULL
    UNION ALL
    SELECT 'images', g.user_id, g.created_at, 1 FROM generated_images g
    WHERE NOT coalesce(g.is_uploaded, false) AND g.deleted_at IS NULL
    UNION ALL
    SELECT 'revenue', e.creator_id, e.earned_at, e.micro FROM artist_earnings(NULL, NULL, p_chain) e
    UNION ALL
    SELECT 'views', o.uid, o.at, o.n FROM opened o
    UNION ALL
    SELECT 'likes', coalesce(p.creator_id, g.user_id), r.created_at, 1
    FROM reactions r
    LEFT JOIN prompts p ON r.target_type = 'prompt' AND p.id = r.target_uuid AND p.deleted_at IS NULL
    LEFT JOIN generated_images g ON r.target_type = 'generated_image' AND g.id = r.target_uuid AND g.deleted_at IS NULL
    WHERE r.reaction_type = 'like'
    UNION ALL
    SELECT 'comments', c.user_id, c.created_at, 1
    FROM prompt_comments c JOIN prompts p ON p.id::text = c.prompt_id AND p.deleted_at IS NULL
    UNION ALL
    SELECT 'followers', f.followee_id, f.created_at, 1 FROM follows f
  ),
  counted AS (SELECT ev.* FROM ev JOIN seen s ON s.id = ev.uid),
  totals AS (
    SELECT m, coalesce(sum(n) FILTER (WHERE p_since IS NULL OR at >= p_since), 0) AS period,
              coalesce(sum(n) FILTER (WHERE at >= now() - interval '24 hours'), 0) AS day
    FROM counted GROUP BY m
  ),
  board AS (
    SELECT s.handle,
      sum(c.n) FILTER (WHERE c.m = 'prompts') AS prompts, sum(c.n) FILTER (WHERE c.m = 'posts') AS posts,
      sum(c.n) FILTER (WHERE c.m = 'revenue') AS revenue, sum(c.n) FILTER (WHERE c.m = 'views') AS views,
      sum(c.n) FILTER (WHERE c.m = 'likes') AS likes, sum(c.n) FILTER (WHERE c.m = 'comments') AS comments,
      sum(c.n) FILTER (WHERE c.m = 'followers') AS followers
    FROM seen s
    JOIN counted c ON c.uid = s.id AND c.m NOT IN ('users', 'images') AND (p_since IS NULL OR c.at >= p_since)
    WHERE NOT s.off_board
    GROUP BY s.id, s.handle
  ),
  ranked AS (
    SELECT handle, coalesce(prompts, 0) AS prompts, coalesce(posts, 0) AS posts, coalesce(revenue, 0) AS revenue,
      coalesce(views, 0) AS views, coalesce(likes, 0) AS likes, coalesce(comments, 0) AS comments,
      coalesce(followers, 0) AS followers
    FROM board
  ),
  top AS (
    SELECT ranked.*, row_number() OVER (
      ORDER BY CASE p_sort WHEN 'prompts' THEN prompts WHEN 'posts' THEN posts WHEN 'views' THEN views
                 WHEN 'likes' THEN likes WHEN 'comments' THEN comments WHEN 'followers' THEN followers ELSE revenue END DESC,
               revenue DESC, posts DESC, prompts DESC, handle) AS rank
    FROM ranked
  ),
  -- What was opened most in the period: listed prompts and public images, never 18+, of accounts on the board.
  watched_prompts AS (
    SELECT p.id, p.title, s.handle, sum(o.n) AS n
    FROM opened o JOIN prompts p ON o.kind = 'prompt_open' AND p.id = o.target_id
    JOIN seen s ON s.id = p.creator_id AND NOT s.off_board
    WHERE p.is_listed AND p.listing_status = 'active' AND NOT coalesce(p.is_adult, false)
      AND (p_since IS NULL OR o.at >= p_since)
    GROUP BY p.id, p.title, s.handle ORDER BY n DESC, p.title LIMIT 10
  ),
  watched_images AS (
    SELECT g.id, coalesce(g.thumbnail_url, g.preview_url, g.storage_url) AS thumb, s.handle, sum(o.n) AS n
    FROM opened o JOIN generated_images g ON o.kind = 'image_open' AND g.id = o.target_id
    JOIN seen s ON s.id = g.user_id AND NOT s.off_board
    WHERE g.visibility = 'public' AND NOT coalesce(g.is_uploaded, false) AND NOT coalesce(g.is_adult, false)
      AND (p_since IS NULL OR o.at >= p_since)
    GROUP BY g.id, g.thumbnail_url, g.preview_url, g.storage_url, s.handle ORDER BY n DESC, g.id LIMIT 10
  )
  SELECT jsonb_build_object(
    'totals', coalesce((SELECT jsonb_object_agg(m, jsonb_build_array(period, day)) FROM totals), '{}'::jsonb),
    'board', coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.rank) FROM top t
                       WHERE t.rank <= greatest(1, least(coalesce(p_limit, 25), 100))), '[]'::jsonb),
    'watched', jsonb_build_object(
      'prompts', coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.n DESC, w.title) FROM watched_prompts w), '[]'::jsonb),
      'images', coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.n DESC, w.id) FROM watched_images w), '[]'::jsonb))
  );
$$;
REVOKE ALL ON FUNCTION public.enki_stats(timestamptz, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enki_stats(timestamptz, text, integer, text) TO service_role;

COMMIT;

-- Read back:
--   SELECT kind, count(*), sum(n) FROM public.view_days GROUP BY kind;
--   SELECT public.enki_stats(NULL) -> 'totals' -> 'views', jsonb_array_length(public.enki_stats(NULL) -> 'watched' -> 'prompts');

-- Rollback (roll back SQL 50 first; the feed views counted since go back onto prompts.views; the days are forgotten):
--   UPDATE public.prompts p SET views = p.views + v.n FROM (SELECT target_id, sum(n) AS n FROM public.view_days
--     WHERE kind = 'prompt_view' AND day > DATE '1970-01-01' GROUP BY target_id) v WHERE v.target_id = p.id;
--   DROP FUNCTION IF EXISTS public.enki_stats(timestamptz, text, integer, text);
--   DROP FUNCTION IF EXISTS public.count_image_opens(uuid[], uuid);
--   DROP TABLE IF EXISTS public.view_days;
--   CREATE OR REPLACE FUNCTION public.increment_prompt_views_batch(p_prompts text[]) RETURNS void LANGUAGE sql AS $$ UPDATE prompts SET views = views + 1 WHERE id::text = ANY(p_prompts); $$;
--   CREATE OR REPLACE FUNCTION public.increment_prompt_opens(p_prompt text) RETURNS void LANGUAGE sql AS $$ UPDATE prompts SET opens = opens + 1 WHERE id::text = p_prompt; $$;
-- then run migrations/2026-10-29-enki-stats.sql again for its enki_stats.
