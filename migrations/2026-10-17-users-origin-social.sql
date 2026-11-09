-- Sign in with Google and X (Kev, 2026-10-17: "mach social login nun via gmail & X"): an account made at a
-- first Google or X login says so in users.origin, like email, wallet and agent accounts
-- (2026-10-14-users-origin-generations-rail.sql). The column's CHECK only took those three.
--
-- Probed live 2026-10-17 with an insert built to fail (a duplicate id, so no row could be written):
--   origin 'google' -> 23514 new row for relation "users" violates check constraint "users_origin_check"
-- RUN THIS BEFORE setting GOOGLE_OAUTH_* / X_OAUTH_*: until then a first social login cannot make its account.
-- Re-runnable.

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_origin_check;
ALTER TABLE public.users ADD CONSTRAINT users_origin_check CHECK (origin IN ('email', 'wallet', 'agent', 'google', 'x'));

-- Rollback (only while no google or x row exists):
--   ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_origin_check;
--   ALTER TABLE public.users ADD CONSTRAINT users_origin_check CHECK (origin IN ('email', 'wallet', 'agent'));
