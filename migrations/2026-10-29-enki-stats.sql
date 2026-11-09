-- Enki-wide analytics (Kev, 2026-10-29: "wir brauchen auch bei den analytics auch Enki-global analytics, wie users,
-- posted images, generated images, generated revenue for artists, views, halt genauso wie hier:
-- https://hup.social/leaderboard"). Read by app/api/analytics/enki/route.ts for the Analytics panel's Enki view.
--
--   generated_images.published_at  when the image was first made public, set by a trigger for every writer; making it
--                private and public again keeps the first time. The images public before this file get their
--                created_at, the only time known for them.
--   enki_stats(p_since, p_sort, p_limit)  every figure in the period (p_since null = all time) and in the last 24 hours,
--                and the creators ranked by one column. One call, every count in the database.
--
-- What counts:
--   users      accounts not deleted, active and not banned (the rule of lib/hidden-owners.ts); every figure below
--              leaves out what such an account made or earned, and the ranking also who hid themselves from it.
--   prompts    released (listed, active, not deleted), at published_at (the first listing, app/api/prompt/route.ts).
--   posts      public images, not uploads, not deleted, at published_at. images: every render not deleted, at created_at.
--   revenue    the artist's share of each delivered paid render, in mainnet USDC (micro-USDC), at the time it was earned:
--              licence credits owed to artists (x402 sales and withheld intent shares, lib/payments/licence-credits.ts),
--              intent captures that paid the artist directly (no credit row, a mainnet generation), and escrow
--              settlements (the delivered units at the artist's original share). Devnet test money, voided, released
--              and undelivered payments never count, nor a creator paying for renders of their own prompt (the account
--              that rendered, for a credit; the wallet that paid, for an intent).
--   views      prompts.views: a counter without time, so all time only.
--   likes      likes on a creator's prompts and images (reactions) that are not deleted. comments: on prompts not
--              deleted, by their author. followers: follows.
--   ranking    public activity only (prompts, posts, revenue, views, likes, comments, followers): how many images
--              someone rendered privately is theirs, so it is an Enki total and never a person's column.
--
-- VERIFIED live 2026-10-29 by Claude, read-only: generated_images has no published_at; the columns read here exist on
-- users, bans, prompts, generated_images, generations (chain_key, payment_intent_id), reactions (target_type prompt /
-- generated_image, reaction_type like), prompt_comments, follows, licence_credits, generation_payment_intents,
-- generation_escrow_recovery and user_wallets (address); every escrow row is devnet USDC, no licence credit exists,
-- artist revenue is $0; the 3 likes and the 1 comment are on deleted prompts.
-- Service role only. Re-runnable.
BEGIN;

ALTER TABLE public.generated_images ADD COLUMN IF NOT EXISTS published_at timestamptz;
UPDATE public.generated_images SET published_at = created_at WHERE visibility = 'public' AND published_at IS NULL;

CREATE OR REPLACE FUNCTION public.generated_images_published_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.visibility = 'public' THEN
    NEW.published_at := coalesce(NEW.published_at, now());
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS generated_images_published_at ON public.generated_images;
CREATE TRIGGER generated_images_published_at BEFORE INSERT OR UPDATE OF visibility ON public.generated_images
  FOR EACH ROW EXECUTE FUNCTION public.generated_images_published_at();

CREATE OR REPLACE FUNCTION public.enki_stats(p_since timestamptz, p_sort text DEFAULT 'revenue', p_limit integer DEFAULT 25)
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
  earn AS (
    SELECT coalesce(lc.user_id, p.creator_id) AS uid, lc.micro AS n, lc.created_at AS at
    FROM licence_credits lc LEFT JOIN prompts p ON p.id = lc.prompt_id
    WHERE lc.role = 'artist' AND lc.mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      AND NOT EXISTS (SELECT 1 FROM generations g WHERE g.user_id = coalesce(lc.user_id, p.creator_id)
                        AND (lc.source = 'x402:' || g.transaction_hash OR lc.source = 'intent:' || g.payment_intent_id))
    UNION ALL
    SELECT p.creator_id, i.artist_amount_micro, i.captured_at
    FROM generation_payment_intents i JOIN prompts p ON p.id::text = i.prompt_id
    WHERE i.status = 'captured' AND i.captured_at IS NOT NULL AND i.fulfilled_at IS NOT NULL AND i.artist_amount_micro > 0
      AND NOT EXISTS (SELECT 1 FROM licence_credits lc WHERE lc.source = 'intent:' || i.id AND lc.role = 'artist')
      AND EXISTS (SELECT 1 FROM generations g WHERE g.payment_intent_id = i.id AND g.chain_key = 'solana')
      AND NOT EXISTS (SELECT 1 FROM user_wallets w WHERE w.user_id = p.creator_id AND lower(w.address) = lower(i.buyer_wallet))
    UNION ALL
    SELECT p.creator_id, r.delivered_units * r.original_artist_unit_micro, r.confirmed_at
    FROM generation_escrow_recovery r
    JOIN generation_payment_intents i ON i.id = r.intent_id
    JOIN prompts p ON p.id::text = i.prompt_id
    -- Only a confirmed settlement has delivered units (the table's CHECK): reserved and released rows have none.
    WHERE r.mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' AND r.delivered_units > 0
      AND NOT EXISTS (SELECT 1 FROM user_wallets w WHERE w.user_id = p.creator_id AND lower(w.address) = lower(i.buyer_wallet))
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
    SELECT 'revenue', e.uid, e.at, e.n FROM earn e
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
  views AS (
    SELECT p.creator_id AS uid, sum(coalesce(p.views, 0)) AS n
    FROM prompts p JOIN seen s ON s.id = p.creator_id
    WHERE p.deleted_at IS NULL GROUP BY p.creator_id
  ),
  board AS (
    SELECT s.handle,
      sum(c.n) FILTER (WHERE c.m = 'prompts') AS prompts, sum(c.n) FILTER (WHERE c.m = 'posts') AS posts,
      sum(c.n) FILTER (WHERE c.m = 'revenue') AS revenue, sum(c.n) FILTER (WHERE c.m = 'likes') AS likes,
      sum(c.n) FILTER (WHERE c.m = 'comments') AS comments, sum(c.n) FILTER (WHERE c.m = 'followers') AS followers,
      max(v.n) AS views
    FROM seen s
    JOIN counted c ON c.uid = s.id AND c.m NOT IN ('users', 'images') AND (p_since IS NULL OR c.at >= p_since)
    LEFT JOIN views v ON v.uid = s.id
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
  )
  SELECT jsonb_build_object(
    'totals', coalesce((SELECT jsonb_object_agg(m, jsonb_build_array(period, day)) FROM totals), '{}'::jsonb),
    'views', coalesce((SELECT sum(n) FROM views), 0),
    'board', coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.rank) FROM top t
                       WHERE t.rank <= greatest(1, least(coalesce(p_limit, 25), 100))), '[]'::jsonb)
  );
$$;
REVOKE ALL ON FUNCTION public.enki_stats(timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enki_stats(timestamptz, text, integer) TO service_role;

COMMIT;

-- Read back:
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'generated_images' AND column_name = 'published_at';
--   SELECT tgname FROM pg_trigger WHERE tgname = 'generated_images_published_at';
--   SELECT public.enki_stats(NULL) -> 'totals';

-- Rollback (the Enki view answers "Could not load" again; when images were posted is forgotten):
--   DROP FUNCTION IF EXISTS public.enki_stats(timestamptz, text, integer);
--   DROP TRIGGER IF EXISTS generated_images_published_at ON public.generated_images;
--   DROP FUNCTION IF EXISTS public.generated_images_published_at();
--   ALTER TABLE public.generated_images DROP COLUMN IF EXISTS published_at;
