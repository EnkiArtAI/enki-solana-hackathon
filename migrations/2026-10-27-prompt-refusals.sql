-- Prompt refusals (Kev, 2026-10-27: "ja go" on the artist-text refusals sketch, DEC-145/266). A paid prompt refused for
-- its OWN text, by our moderation or by an image provider, no longer counts against the buyer, who never sees that
-- text: the unit is Enki's, the refusal is recorded here, and the prompt leaves the marketplace for an admin to release
-- or delist. Read and written by lib/moderation/prompt-pause.ts.
--
--   prompt_refusals  one per refused render of an artist's text: why (our moderation, a provider, or the render
--                    spelling out the hidden text, which may be lettering the artist meant to show), whose order it was,
--                    whether it took the prompt off sale, and how an admin decided. Never the text itself.
--
-- A prompt is paused while it has an open refusal that paused it (paused, reviewed_at null). Pausing sets
-- prompts.is_listed = false, so every listing filter (marketplace, search, x402, the quote) already leaves it out.
-- Not probed live: the table name is new. Requires prompts and users. Re-runnable: IF NOT EXISTS throughout.
BEGIN;

CREATE TABLE IF NOT EXISTS public.prompt_refusals (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id     uuid        NOT NULL REFERENCES public.prompts(id) ON DELETE CASCADE,
  cause         text        NOT NULL CHECK (cause IN ('moderation', 'provider', 'render')),
  -- A moderation category or a provider's name, never prompt text.
  detail        text        NOT NULL DEFAULT '' CHECK (char_length(detail) <= 120),
  buyer_user_id uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  paused        boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz,
  reviewed_by   uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  decision      text        CHECK (decision IN ('released', 'delisted')),
  CHECK ((reviewed_at IS NULL) = (decision IS NULL))
);

-- The open refusals of a prompt, newest first: the pause check, the two-buyer window and the admin's list.
CREATE INDEX IF NOT EXISTS prompt_refusals_open_idx
  ON public.prompt_refusals (prompt_id, cause, created_at DESC) WHERE reviewed_at IS NULL;

ALTER TABLE public.prompt_refusals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prompt_refusals FROM PUBLIC, anon, authenticated;

COMMIT;

-- Read back:
--   SELECT to_regclass('public.prompt_refusals');
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'prompt_refusals';

-- Rollback (drops every recorded refusal; paused prompts stay unlisted until released by hand):
--   DROP TABLE IF EXISTS public.prompt_refusals;
