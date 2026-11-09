-- Every admin and mod action, who, what, on what, when (Kev, 2026-10-17:
-- "brauchen protokoll der admin aktionen"). Written by POST /api/admin after
-- an action went through (lib/admin/audit.ts), one row per action; read in
-- the admin panel's "Admin log" tab, admins only.
--
-- What it keeps: the actor, their role, "<resource>.<action>", the target
-- (ids or a handle as sent; an email or wallet address only as a keyed hash),
-- whitelisted settings and the outcome. Never free text, emails, prompt text
-- or raw IPs: those stay on the target rows, and this log cannot be erased.
--
-- Append-only like artist_text_reveals: a log an admin could edit proves
-- nothing. actor_id has no foreign key on purpose: its ON DELETE action would
-- have to change this table, which the trigger refuses.
--
-- Probed live 2026-10-17 (read-only): admin_actions absent (PGRST205).
-- Re-runnable: IF NOT EXISTS / DROP ... IF EXISTS before each CREATE.

CREATE TABLE IF NOT EXISTS admin_actions (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid        NOT NULL,
  actor_role  text        NOT NULL,
  action      text        NOT NULL,
  target      text,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip_hash     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_actions_created_idx ON admin_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_actions_actor_idx ON admin_actions (actor_id, created_at DESC);

-- Only the server's service role reads or writes it; no policy grants anyone else.
ALTER TABLE admin_actions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION admin_actions_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'admin_actions is append-only: % is not permitted on the admin log',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS admin_actions_no_change ON admin_actions;
CREATE TRIGGER admin_actions_no_change
  BEFORE UPDATE OR DELETE ON admin_actions
  FOR EACH ROW EXECUTE FUNCTION admin_actions_append_only();

-- TRUNCATE bypasses row-level triggers entirely, so it needs its own.
DROP TRIGGER IF EXISTS admin_actions_no_truncate ON admin_actions;
CREATE TRIGGER admin_actions_no_truncate
  BEFORE TRUNCATE ON admin_actions
  FOR EACH STATEMENT EXECUTE FUNCTION admin_actions_append_only();

COMMENT ON TABLE admin_actions IS
  'Append-only log of every admin and mod action: who, what, on what, when.';

-- Rollback (drops the log with its rows; the trigger allows DROP TABLE):
--   DROP TABLE IF EXISTS admin_actions; DROP FUNCTION IF EXISTS admin_actions_append_only();
