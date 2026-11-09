-- The Settings table of actions that ask for the second factor (Kev,
-- 2026-10-17): upload, publish, render, delete. Holds only what the account
-- chose ({"render": true}); the rest keeps its default from
-- lib/stepup-actions.ts (all on except render). Switching one off takes a
-- factor, or a fresh login without one (scope stepup-settings). Until this
-- runs every account reads as the defaults and saving a switch answers
-- "This setting is not available yet".
--
-- Probed live 2026-10-17 via PostgREST with the service role (read-only):
--   GET /rest/v1/users?select=stepup_actions&limit=0 -> 42703 (absent)
-- Replaces the never-run 2026-10-17-confirm-new-prompts.sql (one switch).
-- Run once in the Supabase SQL editor; runs twice without harm.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS stepup_actions jsonb NOT NULL DEFAULT '{}'::jsonb;

-- A change is merged in one statement, so two at once cannot undo each other
-- (review 2026-10-17). Called by PATCH /api/auth/stepup with the service role
-- only; the route checks the keys and values before it calls.
CREATE OR REPLACE FUNCTION public.merge_stepup_actions(p_user uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE sql
SET search_path = public
AS $$
  UPDATE public.users SET stepup_actions = stepup_actions || p_patch WHERE id = p_user RETURNING stepup_actions;
$$;
REVOKE ALL ON FUNCTION public.merge_stepup_actions(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- Rollback:
--   DROP FUNCTION IF EXISTS public.merge_stepup_actions(uuid, jsonb);
--   ALTER TABLE public.users DROP COLUMN stepup_actions;
