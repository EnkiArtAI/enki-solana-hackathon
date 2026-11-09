-- One source for every earnings figure (Kev, 2026-10-29, "go 1": point the Mine tab, the Hall of Fame and the creator
-- profile at the revenue the Enki view counts). Until now those read prompt_purchases, which nothing writes
-- (VERIFIED live 2026-10-29: 0 rows, readers only in the code), so every creator earned $0 everywhere.
--
--   artist_earnings(p_since, p_creators, p_chain)  one row per paid render the artist earned from: the artist's share
--                in micro-USDC, when it was earned, the creator and the prompt. The earn CTE of enki_stats
--                (2026-10-29-enki-stats.sql), unchanged in what it counts: licence credits owed to artists (x402 sales,
--                withheld intent shares), intent captures paid directly (no credit row, a render on p_chain), escrow
--                settlements (the delivered units at the original share). Never a voided, released or undelivered
--                payment, nor a creator paying for renders of their own prompt. p_creators narrows it to some
--                creators; null means everyone.
--   p_chain      the chain the deployment pays on (Kev, 2026-10-29: "wir nutzen doch intents erstmal" on devnet):
--                'solana' counts mainnet USDC, 'solana-devnet' the devnet test USDC, so a devnet checkout shows its
--                test money and production shows mainnet money only. The routes pass solanaChainKey().
--   leaderboard_earnings, leaderboard_earn_series  read artist_earnings and take p_chain last, with the default
--                'solana', so a caller naming the old arguments (production today) still works. leaderboard_earn_series and
--                leaderboard_gen_series were never run live (VERIFIED: 404 PGRST202 for both), so the Hall of Fame's
--                trend column was blank; both exist after this file. Do NOT run 2026-07-20-leaderboard-trend.sql after
--                this one: its two-argument leaderboard_earn_series would make the call ambiguous.
--   enki_stats reads artist_earnings too, from 2026-10-29-view-days.sql (SQL 49), which needs this file first.
--   Postgres cannot add an argument with CREATE OR REPLACE: the old leaderboard_earnings is dropped first (same name,
--   one more argument). SECURITY INVOKER for all, as 2026-07-20 hardened them: only the service role may call them
--   and it reads every table. prompt_purchases stays until 2026-10-29-dead-tables.sql (SQL 50, after the deploy):
--   production's code still reads it.
-- VERIFIED live 2026-10-29 by Claude, read-only: generations carry chain_key 'solana' (3 x402 renders) and
-- 'solana-devnet'; user_wallets(user_id, address); every column read here exists. Re-runnable.
BEGIN;

CREATE OR REPLACE FUNCTION public.artist_earnings(p_since timestamptz, p_creators uuid[] DEFAULT NULL, p_chain text DEFAULT 'solana')
RETURNS TABLE (creator_id uuid, prompt_id uuid, micro bigint, earned_at timestamptz)
LANGUAGE sql STABLE SET search_path = public
AS $$
  WITH chain AS (
    SELECT CASE p_chain WHEN 'solana-devnet' THEN '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
                        ELSE 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' END AS mint
  )
  SELECT coalesce(lc.user_id, p.creator_id), lc.prompt_id, lc.micro, lc.created_at
  FROM licence_credits lc LEFT JOIN prompts p ON p.id = lc.prompt_id, chain
  WHERE lc.role = 'artist' AND lc.mint = chain.mint
    AND (p_since IS NULL OR lc.created_at >= p_since)
    AND (p_creators IS NULL OR coalesce(lc.user_id, p.creator_id) = ANY (p_creators))
    AND NOT EXISTS (SELECT 1 FROM generations g WHERE g.user_id = coalesce(lc.user_id, p.creator_id)
                      AND (lc.source = 'x402:' || g.transaction_hash OR lc.source = 'intent:' || g.payment_intent_id))
  UNION ALL
  SELECT p.creator_id, p.id, i.artist_amount_micro, i.captured_at
  FROM generation_payment_intents i JOIN prompts p ON p.id::text = i.prompt_id
  WHERE i.status = 'captured' AND i.captured_at IS NOT NULL AND i.fulfilled_at IS NOT NULL AND i.artist_amount_micro > 0
    AND (p_since IS NULL OR i.captured_at >= p_since)
    AND (p_creators IS NULL OR p.creator_id = ANY (p_creators))
    AND NOT EXISTS (SELECT 1 FROM licence_credits lc WHERE lc.source = 'intent:' || i.id AND lc.role = 'artist')
    AND EXISTS (SELECT 1 FROM generations g WHERE g.payment_intent_id = i.id AND g.chain_key = p_chain)
    AND NOT EXISTS (SELECT 1 FROM user_wallets w WHERE w.user_id = p.creator_id AND lower(w.address) = lower(i.buyer_wallet))
  UNION ALL
  SELECT p.creator_id, p.id, r.delivered_units * r.original_artist_unit_micro, r.confirmed_at
  FROM generation_escrow_recovery r
  JOIN generation_payment_intents i ON i.id = r.intent_id
  JOIN prompts p ON p.id::text = i.prompt_id, chain
  -- Only a confirmed settlement has delivered units (the table's CHECK): reserved and released rows have none.
  WHERE r.mint = chain.mint AND r.delivered_units > 0
    AND (p_since IS NULL OR r.confirmed_at >= p_since)
    AND (p_creators IS NULL OR p.creator_id = ANY (p_creators))
    AND NOT EXISTS (SELECT 1 FROM user_wallets w WHERE w.user_id = p.creator_id AND lower(w.address) = lower(i.buyer_wallet))
$$;
REVOKE ALL ON FUNCTION public.artist_earnings(timestamptz, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.artist_earnings(timestamptz, uuid[], text) TO service_role;

-- The Hall of Fame: the same shape 2026-07-14 gave it, read from artist_earnings. Cents are rounded once per creator.
DROP FUNCTION IF EXISTS public.leaderboard_earnings(timestamptz, int);
CREATE OR REPLACE FUNCTION public.leaderboard_earnings(p_since timestamptz, p_limit int DEFAULT 20, p_chain text DEFAULT 'solana')
RETURNS TABLE (creator_id uuid, handle text, total_cents bigint, best_prompt_id uuid, best_prompt_title text)
LANGUAGE sql STABLE SET search_path = public
AS $$
  WITH earn AS (
    SELECT e.creator_id, e.prompt_id, sum(e.micro) AS micro
    FROM artist_earnings(p_since, NULL, p_chain) e GROUP BY e.creator_id, e.prompt_id
  ),
  per_creator AS (SELECT earn.creator_id, sum(earn.micro) AS micro FROM earn GROUP BY earn.creator_id),
  best AS (
    SELECT DISTINCT ON (earn.creator_id) earn.creator_id, earn.prompt_id
    FROM earn ORDER BY earn.creator_id, earn.micro DESC, earn.prompt_id
  )
  SELECT pc.creator_id, u.handle::text, round(pc.micro / 10000)::bigint, b.prompt_id, pr.title
  FROM per_creator pc
  JOIN users u ON u.id = pc.creator_id AND NOT coalesce(u.hide_from_leaderboard, false)
  LEFT JOIN best b ON b.creator_id = pc.creator_id
  LEFT JOIN prompts pr ON pr.id = b.prompt_id
  ORDER BY pc.micro DESC, u.handle
  LIMIT greatest(1, least(p_limit, 100));
$$;
REVOKE ALL ON FUNCTION public.leaderboard_earnings(timestamptz, int, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_earnings(timestamptz, int, text) TO service_role;

-- The trend lines of 2026-07-20, which never ran live. A null p_since gives no rows, as there.
DROP FUNCTION IF EXISTS public.leaderboard_earn_series(uuid[], timestamptz);
CREATE OR REPLACE FUNCTION public.leaderboard_earn_series(p_creators uuid[], p_since timestamptz, p_chain text DEFAULT 'solana')
RETURNS TABLE (creator_id uuid, day date, cents bigint)
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT e.creator_id, e.earned_at::date, round(sum(e.micro) / 10000)::bigint
  FROM artist_earnings(p_since, coalesce(p_creators, '{}'), p_chain) e
  WHERE p_since IS NOT NULL
  GROUP BY 1, 2;
$$;
REVOKE ALL ON FUNCTION public.leaderboard_earn_series(uuid[], timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_earn_series(uuid[], timestamptz, text) TO service_role;

CREATE OR REPLACE FUNCTION public.leaderboard_gen_series(p_creators uuid[], p_since timestamptz)
RETURNS TABLE (creator_id uuid, day date, n bigint)
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT p.creator_id, g.created_at::date, count(*)::bigint
  FROM generations g
  JOIN prompts p ON p.id = g.prompt_id
  WHERE g.deleted_at IS NULL
    AND g.created_at >= p_since
    AND p.creator_id = ANY(p_creators)
  GROUP BY 1, 2;
$$;
REVOKE ALL ON FUNCTION public.leaderboard_gen_series(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_gen_series(uuid[], timestamptz) TO service_role;

COMMIT;

-- Read back:
--   SELECT proname, pg_get_function_identity_arguments(oid), prosecdef FROM pg_proc
--   WHERE proname IN ('artist_earnings', 'leaderboard_earnings', 'leaderboard_earn_series', 'leaderboard_gen_series');
--   SELECT count(*), coalesce(sum(micro), 0) FROM public.artist_earnings(NULL, NULL, 'solana-devnet');

-- Rollback (roll back SQL 49 first; the Hall of Fame reads prompt_purchases again; the trend lines go blank again):
--   DROP FUNCTION IF EXISTS public.leaderboard_gen_series(uuid[], timestamptz);
--   DROP FUNCTION IF EXISTS public.leaderboard_earn_series(uuid[], timestamptz, text);
--   DROP FUNCTION IF EXISTS public.leaderboard_earnings(timestamptz, int, text);
--   DROP FUNCTION IF EXISTS public.artist_earnings(timestamptz, uuid[], text);
-- then run migrations/2026-07-14-hall-of-fame.sql again (re-runnable).
