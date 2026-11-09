-- SQL 59: how a creator's finds are cut (Kev, 2026-11-01: "i now want a \"manual\" and an \"auto\" mode ... or can we set
-- up the algorithm beforehand how the prompt is being set up for a creator, and then it is being applied by cutting
-- automatically?"). lib/hunter/recipe.ts reads both columns; before this runs every creator is "auto" and the panel says
-- to run it before a mode is saved.
--   mode:   auto (heuristics and the model cut and name, the checks judge), recipe (the admin's markers cut, no model, no
--           check), manual (the post's whole text and the author's replies, no model, no check).
--   recipe: { from: "text" | "reply", after: text, before: text, titleLine: 0..10 } (lib/hunter/recipe parseRecipe).
-- Links waiting for a Play need no column: hunter_posts rows with outcome 'waiting' (outcome has no CHECK).

ALTER TABLE public.hunter_accounts
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'recipe', 'manual')),
  ADD COLUMN IF NOT EXISTS recipe jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(recipe) = 'object');

-- Check:
--   SELECT handle, mode, recipe FROM public.hunter_accounts;

-- Rollback:
--   ALTER TABLE public.hunter_accounts DROP COLUMN IF EXISTS mode, DROP COLUMN IF EXISTS recipe;
