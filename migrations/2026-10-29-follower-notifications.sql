-- New-post notifications for followers (Kev, 2026-10-29: "with a new post (prompt creation or post of an image) i want
-- to be notified with the preview image visible in the notification and with the notification saying what was being
-- done there"; "go B"). Written by lib/notifications.ts notifyFollowers(): when a prompt is first released
-- (app/api/prompt/route.ts) and when an image is made public (app/api/images/[id]/route.ts).
--
--   kinds        new_prompt, new_image (target_type prompt / image), next to the five of 2026-07-13-notifications.sql.
--                VERIFIED live 2026-10-29 by Claude with inserts that can never land (a made-up user): the five kinds
--                and prompt/guardian pass the CHECK (23503 from the FK), new_prompt, new_image and image are refused
--                (23514). NOT VALID as before: existing rows are not re-checked.
--   notify_followers(...)  one statement for every follower whose bell is on (notify_on_new_prompt for a prompt,
--                notify_on_new_post for an image), not deleted; at most one row per follower, post and day (the
--                coalesce index of 2026-07-13: a post published, hidden and published again the same day notifies
--                once). Returns how many it wrote. Service role only.
-- Requires follows (live) and notifications as 2026-07-13 left it. Re-runnable.
BEGIN;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('comment', 'rating', 'generation', 'guardian_confirmed', 'guardian_declined', 'new_prompt', 'new_image')) NOT VALID;
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_target_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_target_type_check
  CHECK (target_type IS NULL OR target_type IN ('prompt', 'guardian', 'image')) NOT VALID;

CREATE OR REPLACE FUNCTION public.notify_followers(
  p_actor uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_target_type text,
  p_target uuid,
  p_meta jsonb DEFAULT '{}'::jsonb
) RETURNS integer
LANGUAGE sql
SET search_path = public
AS $$
  WITH sent AS (
    INSERT INTO notifications (user_id, kind, title, body, target_type, target_uuid, actor_user_id, metadata)
    SELECT f.follower_id, p_kind, p_title, p_body, p_target_type, p_target, p_actor, coalesce(p_meta, '{}'::jsonb)
    FROM follows f
    JOIN users u ON u.id = f.follower_id AND u.deleted_at IS NULL
    WHERE f.followee_id = p_actor
      AND CASE p_kind WHEN 'new_prompt' THEN f.notify_on_new_prompt WHEN 'new_image' THEN f.notify_on_new_post ELSE false END
    ON CONFLICT (user_id, kind, target_uuid, day) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int FROM sent;
$$;
REVOKE ALL ON FUNCTION public.notify_followers(uuid, text, text, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_followers(uuid, text, text, text, text, uuid, jsonb) TO service_role;

COMMIT;

-- Read back:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('notifications_kind_check', 'notifications_target_type_check');
--   SELECT to_regprocedure('public.notify_followers(uuid, text, text, text, text, uuid, jsonb)');

-- Rollback (deletes the new-post notifications, then restores the checks of 2026-07-13):
--   DROP FUNCTION IF EXISTS public.notify_followers(uuid, text, text, text, text, uuid, jsonb);
--   DELETE FROM public.notifications WHERE kind IN ('new_prompt', 'new_image');
--   ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
--   ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('comment', 'rating', 'generation', 'guardian_confirmed', 'guardian_declined')) NOT VALID;
--   ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_target_type_check;
--   ALTER TABLE public.notifications ADD CONSTRAINT notifications_target_type_check CHECK (target_type IS NULL OR target_type IN ('prompt', 'guardian')) NOT VALID;
