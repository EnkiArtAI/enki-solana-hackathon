-- Message requests (Kev, 2026-10-29: "messages shall contain: normal messages and requests ... click on 'accept
-- message' and then it gets moved to normal chat and i can chat with him with the chat eingabefeld being
-- freigeschaltet"; "go C"). Read and written by app/api/messages (lib/dm.ts acceptColFor).
--
--   a_accepted_at / b_accepted_at  when each member took the conversation in: by writing in it or by Accept. A
--                  conversation the other member wrote in and I have not taken in is a request to me. Threads that
--                  existed before this file stay conversations for both: the backfill runs only when the columns are
--                  added (live 2026-10-29: 0 threads, VERIFIED read-only).
--   dm_overview(p_user)  as 2026-07-18-dm-messages.sql, plus accepted (have I taken it in). Its return type changes,
--                  so it is dropped and made again in the same transaction.
-- Re-runnable: a second run neither backfills nor changes a request.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'dm_threads' AND column_name = 'a_accepted_at') THEN
    ALTER TABLE public.dm_threads ADD COLUMN a_accepted_at timestamptz, ADD COLUMN b_accepted_at timestamptz;
    UPDATE public.dm_threads SET a_accepted_at = created_at, b_accepted_at = created_at;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.dm_overview(uuid);
CREATE FUNCTION public.dm_overview(p_user uuid)
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
              AND x.created_at > COALESCE(
                CASE WHEN t.user_a = p_user THEN t.a_last_read_at ELSE t.b_last_read_at END,
                'epoch'::timestamptz)),
         (CASE WHEN t.user_a = p_user THEN t.a_accepted_at ELSE t.b_accepted_at END) IS NOT NULL
  FROM dm_threads t
  JOIN users u ON u.id = CASE WHEN t.user_a = p_user THEN t.user_b ELSE t.user_a END
             AND u.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT m.created_at, m.body, m.sender_id, m.image_path
    FROM dm_messages m WHERE m.thread_id = t.id
    ORDER BY m.created_at DESC LIMIT 1
  ) m ON true
  WHERE t.user_a = p_user OR t.user_b = p_user
  ORDER BY COALESCE(m.created_at, t.created_at) DESC
  LIMIT 200;
$$;
REVOKE ALL ON FUNCTION public.dm_overview(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dm_overview(uuid) TO service_role;

COMMIT;

-- Read back:
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'dm_threads' AND column_name LIKE '%accepted_at';
--   SELECT pg_get_function_result('public.dm_overview(uuid)'::regprocedure);

-- Rollback (every open request becomes a plain conversation again; the overview as 2026-07-18 made it):
--   DROP FUNCTION IF EXISTS public.dm_overview(uuid);
--   ALTER TABLE public.dm_threads DROP COLUMN IF EXISTS a_accepted_at, DROP COLUMN IF EXISTS b_accepted_at;
-- then run the CREATE FUNCTION dm_overview block of migrations/2026-07-18-dm-messages.sql again.
