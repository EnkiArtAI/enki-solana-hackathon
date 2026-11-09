-- Every prompt has a real title (Kev, 2026-10-17: "jeder prompt soll einen titel zwangsweise haben"): no NULL, no
-- blank, no "Untitled" / "Untitled prompt" in any case. The app refuses them since commit 31247155 (lib/prompt-title.ts);
-- this makes any other writer refuse them too. The database check is looser than the app's only at the edges (btrim
-- strips spaces, the app trims all whitespace), never stricter, so nothing the app saves is refused here.
--
-- ORDER: 1. deploy the code that names Quick Create prompts (lib/generation/auto-title.ts); before it, every Quick
-- Create render would fail its prompt insert and lose its record. 2. run `node scripts/backfill-prompt-titles.mjs
-- --apply` once more for rows the old code made meanwhile. 3. run this. It fails, changing nothing, while any row
-- still breaks the rule.
-- Re-runnable.

ALTER TABLE public.prompts DROP CONSTRAINT IF EXISTS prompts_title_real;
ALTER TABLE public.prompts ADD CONSTRAINT prompts_title_real
  CHECK (title IS NOT NULL AND btrim(title) <> '' AND lower(btrim(title)) !~ '^untitled(\s+prompt)?$');

-- Rollback:
--   ALTER TABLE public.prompts DROP CONSTRAINT IF EXISTS prompts_title_real;
