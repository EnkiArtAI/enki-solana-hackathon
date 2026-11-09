-- SQL 71: a creator's share style on their account (Kev, 2026-11-03: a creator sets their style once, every later share is one
-- press; 2026-11-04: "bau auch nun the mockups for the share-UI ein"). share_style holds places, fonts, colours, ratios and
-- reference ids, never a prompt's text: lib/share/style.ts parseStyle is the only way in. A column on an existing table, so no new
-- table, no new RLS and no new grant: the service role reaches it through its table grant, anon reads no row of users.
--
-- VERIFIED live 2026-11-04 by Claude, read-only: `users?select=share_style` answers `400 42703`; OpenAPI lists no share_style on
-- users; `users?select=id` as anon answers `200 */0 rows 0`.
--
-- Any time, before or after the deploy. Until it runs GET /api/users/share-style answers 200 {style:null, run:"71-share-style.sql"}
-- and PUT answers 503 with the same run: the popup offers its templates, Share works, and Done keeps the style for the tab and says
-- once that it was not saved to the account. Re-runnable.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS share_style jsonb;

-- Check (every user, and 0 styles until a creator presses Done):
--   SELECT count(*), count(share_style) FROM public.users;

-- Rollback (every saved style goes; the popup falls back to its templates and the routes answer as before this file):
--   ALTER TABLE public.users DROP COLUMN IF EXISTS share_style;
