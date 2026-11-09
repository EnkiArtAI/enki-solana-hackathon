-- Delete a message request, and following someone takes theirs in (Kev, 2026-10-29: "the decline button for message
-- requests, just add a delete button, no decline button"; "following someone accepts their messages request
-- automatically, yes that fits"). Read and written by app/api/messages (lib/dm.ts clearColFor). Runs after
-- migrations/2026-10-29-dm-requests.sql (SQL 42) and 2026-10-29-follows.sql.
--
--   a_cleared_at / b_cleared_at  up to when each member deleted the conversation: what was written until then leaves
--                  their view only, the other member keeps all of it. A message after it brings the conversation back,
--                  as a request with only the new messages.
--   dm_overview(p_user)  as SQL 42, over what is after my cleared time only: the last message, and the unread count
--                  after the later of my read and my cleared time. A request with no message I can see (deleted, or
--                  nobody wrote) is left out here, before the LIMIT 200, as app/api/messages left it out after it.
--                  Accepted also when I follow the other member (so only where there is a message I can see);
--                  nothing is stored, so it follows the follow.
--
-- VERIFIED live 2026-10-29 by Claude, read-only (GET): dm_threads has a_accepted_at / b_accepted_at and no
-- a_cleared_at / b_cleared_at (42703); dm_overview(p_user) returns accepted; follows has (follower_id, followee_id) as
-- its primary key; dm_threads, dm_messages and follows have 0 rows. The return type stays, so CREATE OR REPLACE.
-- Service role only. Re-runnable.
BEGIN;

ALTER TABLE public.dm_threads ADD COLUMN IF NOT EXISTS a_cleared_at timestamptz;
ALTER TABLE public.dm_threads ADD COLUMN IF NOT EXISTS b_cleared_at timestamptz;

CREATE OR REPLACE FUNCTION public.dm_overview(p_user uuid)
RETURNS TABLE (
  thread_id uuid, peer_id uuid, peer_handle text, peer_name text, peer_avatar text,
  last_at timestamptz, last_body text, last_sender uuid, last_has_image boolean,
  unread bigint, accepted boolean
)
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT t.id, u.id, u.handle::text, u.display_name, u.avatar_url,
         m.created_at, m.body, m.sender_id, (m.image_path IS NOT NULL),
         (SELECT count(*) FROM dm_messages x
            WHERE x.thread_id = t.id AND x.sender_id <> p_user
              AND x.created_at > COALESCE(greatest(me.read_at, me.cleared_at), 'epoch'::timestamptz)),
         me.accepted_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = p_user AND f.followee_id = u.id)
  FROM dm_threads t
  CROSS JOIN LATERAL (
    SELECT CASE WHEN t.user_a = p_user THEN t.a_last_read_at ELSE t.b_last_read_at END AS read_at,
           CASE WHEN t.user_a = p_user THEN t.a_accepted_at ELSE t.b_accepted_at END AS accepted_at,
           CASE WHEN t.user_a = p_user THEN t.a_cleared_at ELSE t.b_cleared_at END AS cleared_at
  ) me
  JOIN users u ON u.id = CASE WHEN t.user_a = p_user THEN t.user_b ELSE t.user_a END
             AND u.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT m.created_at, m.body, m.sender_id, m.image_path
    FROM dm_messages m WHERE m.thread_id = t.id AND m.created_at > COALESCE(me.cleared_at, 'epoch'::timestamptz)
    ORDER BY m.created_at DESC LIMIT 1
  ) m ON true
  WHERE (t.user_a = p_user OR t.user_b = p_user)
    -- A request with nothing to see (deleted, or nobody wrote) is not shown, so it takes no place in the 200.
    AND (me.accepted_at IS NOT NULL OR m.created_at IS NOT NULL)
  ORDER BY COALESCE(m.created_at, t.created_at) DESC
  LIMIT 200;
$$;
REVOKE ALL ON FUNCTION public.dm_overview(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dm_overview(uuid) TO service_role;

COMMIT;

-- Read back:
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'dm_threads' AND column_name LIKE '%cleared_at';
--   SELECT pg_get_functiondef('public.dm_overview(uuid)'::regprocedure) LIKE '%cleared_at%follows%';

-- Rollback (a deleted request shows in full again and following takes nothing in): run
-- migrations/2026-10-29-dm-requests.sql again first (the overview as SQL 42 made it; it changes no request), then:
--   ALTER TABLE public.dm_threads DROP COLUMN IF EXISTS a_cleared_at, DROP COLUMN IF EXISTS b_cleared_at;
