-- Likes that scale (Kev, 2026-10-15: "jeder user wird ne unlimited amount of likes sammeln, und nen bild auch").
--
-- One row per like stays in public.reactions (probed live 2026-10-15: id, target_type, target_uuid, user_id,
-- reaction_type, created_at; CHECK target_type accepts prompt|comment|generated_image|review, reaction_type
-- accepts like|bookmark; user_id references users; 3 rows, no duplicates). This adds what makes it scale:
--   1. a unique index per (user, target, reaction): "did I like it" is one index lookup and a double click
--      cannot store a second like;
--   2. an index per target: every like of one image or prompt without a scan;
--   3. like_count on prompts and generated_images, kept by a trigger in the same transaction as the like,
--      so a card reads one number instead of counting rows.
-- Images use the target_type the live CHECK already accepts, 'generated_image'; no constraint changes.
-- Idempotent: safe to run twice. Read back at the end.

CREATE UNIQUE INDEX IF NOT EXISTS reactions_one_per_user
  ON public.reactions (user_id, target_type, target_uuid, reaction_type);
CREATE INDEX IF NOT EXISTS reactions_by_target
  ON public.reactions (target_type, target_uuid, reaction_type);

ALTER TABLE public.prompts ADD COLUMN IF NOT EXISTS like_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.generated_images ADD COLUMN IF NOT EXISTS like_count integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE public.prompts ADD CONSTRAINT prompts_like_count_nonnegative CHECK (like_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE public.generated_images ADD CONSTRAINT generated_images_like_count_nonnegative CHECK (like_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The count follows every like row: +1 on insert, -1 on delete, both on an update that moves a row. Never below 0.
-- SECURITY DEFINER with an empty search path: the like's writer needs no right on the counted tables.
CREATE OR REPLACE FUNCTION public.reactions_like_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') AND OLD.reaction_type = 'like' THEN
    IF OLD.target_type = 'prompt' THEN
      UPDATE public.prompts SET like_count = greatest(like_count - 1, 0) WHERE id = OLD.target_uuid;
    ELSIF OLD.target_type = 'generated_image' THEN
      UPDATE public.generated_images SET like_count = greatest(like_count - 1, 0) WHERE id = OLD.target_uuid;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.reaction_type = 'like' THEN
    IF NEW.target_type = 'prompt' THEN
      UPDATE public.prompts SET like_count = like_count + 1 WHERE id = NEW.target_uuid;
    ELSIF NEW.target_type = 'generated_image' THEN
      UPDATE public.generated_images SET like_count = like_count + 1 WHERE id = NEW.target_uuid;
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.reactions_like_count() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS reactions_like_count ON public.reactions;
CREATE TRIGGER reactions_like_count
  AFTER INSERT OR DELETE OR UPDATE OF reaction_type, target_type, target_uuid ON public.reactions
  FOR EACH ROW EXECUTE FUNCTION public.reactions_like_count();

-- The likes stored before the trigger existed, counted once.
UPDATE public.prompts p SET like_count = c.n
  FROM (SELECT target_uuid, count(*)::integer AS n FROM public.reactions
        WHERE target_type = 'prompt' AND reaction_type = 'like' GROUP BY target_uuid) c
  WHERE p.id = c.target_uuid AND p.like_count IS DISTINCT FROM c.n;
UPDATE public.generated_images g SET like_count = c.n
  FROM (SELECT target_uuid, count(*)::integer AS n FROM public.reactions
        WHERE target_type = 'generated_image' AND reaction_type = 'like' GROUP BY target_uuid) c
  WHERE g.id = c.target_uuid AND g.like_count IS DISTINCT FROM c.n;

-- Read back:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'reactions';
--   SELECT id, like_count FROM public.prompts WHERE like_count > 0;
-- Rollback:
--   DROP TRIGGER IF EXISTS reactions_like_count ON public.reactions;
--   DROP FUNCTION IF EXISTS public.reactions_like_count();
--   ALTER TABLE public.prompts DROP COLUMN IF EXISTS like_count;
--   ALTER TABLE public.generated_images DROP COLUMN IF EXISTS like_count;
--   DROP INDEX IF EXISTS public.reactions_one_per_user; DROP INDEX IF EXISTS public.reactions_by_target;
